# System Architecture - NCLEX AI Flashcard & Practice App

*Draft v1 - July 2026*

This document describes the technical architecture for the product defined in `02_BUSINESS_PLAN.md`.
Design choices favor quality, simplicity, robustness, scalability, and long-term maintainability over short-term development cost.

---

## 1. Guiding Principles

**Correctness before features.**
Medical content is a safety liability, so accuracy checks and the flag-and-fix loop are core architecture, not add-ons.

**Web-first, mobile-ready.**
The no-signup demo lives on the web because short-form video links and SEO drive the first users there.
The domain logic is isolated so a React Native app can reuse it later without a rewrite.

**Modular monolith, not premature microservices.**
Start with one deployable API with clear internal module boundaries.
Split a module into its own service only when scale or team structure demands it.

**Async by default for AI work.**
PDF-to-cards can take tens of seconds, so generation runs as background jobs with progress streamed to the client.

**Stateless services, managed state.**
Application servers hold no session state.
All durable state lives in Postgres, Redis, and object storage so we can scale horizontally during exam-season spikes.

---

## 2. High-Level System Diagram

```
                        ┌──────────────────────────────┐
                        │         Clients               │
                        │  Web (Next.js PWA)            │
                        │  Mobile (React Native, later) │
                        └───────────────┬──────────────┘
                                        │ HTTPS / WSS
                                        ▼
                        ┌──────────────────────────────┐
                        │        API Gateway            │
                        │  (TypeScript, Fastify)        │
                        │  auth · rate limit · routing  │
                        └───────────────┬──────────────┘
             ┌──────────────┬───────────┼───────────────┬───────────────┐
             ▼              ▼           ▼               ▼               ▼
      ┌───────────┐ ┌────────────┐ ┌──────────┐ ┌────────────┐ ┌─────────────┐
      │  Study    │ │  Content   │ │  Billing │ │  Referral  │ │  Identity   │
      │  module   │ │  module    │ │  module  │ │  module    │ │  module     │
      │ (FSRS)    │ │ (decks)    │ │ (Stripe) │ │ (credits)  │ │ (auth)      │
      └─────┬─────┘ └─────┬──────┘ └────┬─────┘ └─────┬──────┘ └──────┬──────┘
            │             │             │             │               │
            └─────────────┴──────┬──────┴─────────────┴───────────────┘
                                 ▼
                    ┌────────────────────────┐        ┌────────────────────┐
                    │   Postgres + pgvector  │        │  Redis             │
                    │  users · decks · cards │        │  cache · job queue │
                    │  reviews · embeddings  │        │  rate limits       │
                    └────────────────────────┘        └─────────┬──────────┘
                                                                 │ jobs
                                                                 ▼
                                              ┌──────────────────────────────┐
                                              │   AI Worker (Python, FastAPI) │
                                              │  PDF parse · chunk · embed    │
                                              │  card gen · NGN gen · verify  │
                                              └───────────────┬──────────────┘
                                          ┌───────────────────┴───────────────┐
                                          ▼                                   ▼
                                 ┌─────────────────┐               ┌────────────────────┐
                                 │ Object storage  │               │  Claude API        │
                                 │ (S3-compatible) │               │  Opus 4.8 / Haiku  │
                                 │ uploaded PDFs   │               │  4.5               │
                                 └─────────────────┘               └────────────────────┘
```

---

## 3. Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Web client | Next.js (React, TypeScript), PWA | SSR for SEO on "NCLEX flashcards", installable, fast demo path |
| Mobile (later) | React Native (Expo) | Reuses TypeScript domain logic and types from web |
| API gateway | TypeScript + Fastify | Shared types with frontend, high throughput, small surface |
| AI worker | Python + FastAPI | Best ecosystem for document parsing, embeddings, LLM orchestration |
| Primary DB | PostgreSQL 16 + pgvector | Relational integrity plus vector search for dedup and retrieval |
| Cache / queue | Redis | Job queue, rate limiting, hot-path caching |
| Object storage | S3-compatible | Durable storage for uploaded PDFs and generated exports |
| LLM | Claude Opus 4.8 + Haiku 4.5 | Opus for hard generation and verification, Haiku for cheap high-volume steps |
| Spaced repetition | FSRS algorithm | Modern, evidence-based scheduling; the retention differentiator |
| Payments (web) | Stripe | Subscriptions and one-time credit packs |
| Payments (mobile) | RevenueCat | Unifies App Store and Play Store IAP |
| Auth | Magic link + OAuth, anonymous sessions | Frictionless demo, low-friction upgrade to a real account |

We standardize on TypeScript and Python only.
The API and clients share one language and generated types, and the AI worker is the single Python surface where that ecosystem earns its place.

---

## 4. Core Modules

### 4.1 Identity module
Handles anonymous demo sessions, magic-link and OAuth sign-in, and account upgrade.
An anonymous session is a first-class user record with a signed cookie so demo work is never lost.
When a visitor signs up, their anonymous decks migrate to the permanent account atomically.

### 4.2 Content module
Owns decks, cards, sources (uploaded PDFs), and NGN question sets.
Exposes generation as async jobs and streams progress to the client over WebSocket.
Stores every card's provenance (source chunk plus model version) so we can audit and regenerate.

### 4.3 Study module
Implements the FSRS scheduler and records every review event.
Computes due queues, retention estimates, and streak state.
This module is deliberately isolated because it is the retention differentiator and must stay correct and testable.

### 4.4 Billing module
Wraps Stripe and RevenueCat behind one internal interface.
Tracks plan state, credit balances, and entitlement checks used by the rest of the system.
All entitlement decisions flow through one function so paywall logic never drifts.

### 4.5 Referral module
Issues share links, attributes new signups to referrers, and grants credits to both sides.
Public shared decks carry a watermark and a referral code, turning each shared deck into a growth channel.

---

## 5. The AI Pipeline (the heart of the product)

This is where quality and safety are won or lost, so it is designed as an explicit, auditable pipeline rather than a single prompt.

```
Upload PDF
   │
   ▼
[1] Parse & normalize      -> extract text, tables, layout (Python)
   │
   ▼
[2] Chunk & embed          -> semantic chunks, store vectors in pgvector
   │
   ▼
[3] Dedup & scope          -> drop near-duplicate content, tag NCLEX topics
   │
   ▼
[4] Generate               -> Claude drafts flashcards + NGN questions per chunk
   │
   ▼
[5] Verify (separate pass) -> a second Claude call fact-checks each card,
   │                          flags low-confidence items, trims bloat
   ▼
[6] Score & rank           -> keep the ~20 cards that matter, not 200 to delete
   │
   ▼
[7] Persist                -> cards + confidence + provenance saved to Postgres
```

**Key design decisions:**

Generation and verification are separate model calls.
The drafting pass optimizes for coverage, and the verification pass adversarially checks each card, which catches errors a single pass would keep.

Every card stores a confidence score and its source chunk.
Low-confidence cards are surfaced to the user with a visible marker rather than hidden, and users can flag any card.

Flagged cards enter a regeneration queue.
The flag-and-fix loop feeds a lightweight evaluation set that we use to catch quality regressions when prompts or models change.

Model tiering controls cost without hurting quality.
Haiku 4.5 handles cheap high-volume steps such as chunk classification, and Opus 4.8 handles generation and verification where accuracy matters most.

NGN generation is templated per question type.
Matrix, case-study, and trend-analysis items each have a schema-constrained generator so outputs are valid and gradable, not free-form text.

---

## 6. Spaced Repetition (FSRS)

The Study module implements FSRS with per-user parameter optimization.
Each review writes an immutable event row (card, rating, timestamp, elapsed interval).
Scheduling state is derived from those events so we can replay history and re-optimize parameters as data grows.
This event-sourced design makes the scheduler auditable and lets us export a user's full history to Anki without loss.

---

## 7. Anki Export

One-click export produces a standard `.apkg` file.
Export runs as a background job that reads cards and FSRS state, maps them to Anki's schema, and writes the package to object storage for download.
Preserving review progress on export is a deliberate trust feature that Knowt refuses to offer, so it is a first-class path, not an afterthought.

---

## 8. No-Signup Demo Flow

```
Visitor lands from TikTok/Reddit link
   │
   ▼
Anonymous session created (signed cookie, real user row)
   │
   ▼
Paste PDF  ->  generation job  ->  live progress  ->  deck appears
   │
   ▼
"Save this deck" prompt  ->  magic link  ->  anonymous decks migrate to account
```

The visitor experiences full value before any signup ask.
Rate limits and abuse controls apply to anonymous sessions to protect LLM cost during viral spikes.

---

## 9. Infrastructure & Deployment

Containerized services (API, AI worker) run on a managed container platform behind a CDN.
Postgres, Redis, and object storage are managed services to reduce operational surface.
Autoscaling is driven by queue depth and request latency so the system absorbs exam-season and viral-video spikes.
Infrastructure is defined as code so environments are reproducible.

CI runs lint, type checks, unit tests, and the AI evaluation set on every change.
A failing lint, test, or eval blocks merge, in line with the engineering-excellence standard in `AGENTS.md`.

---

## 10. Security, Privacy & Compliance

Uploaded PDFs may contain personal study notes, so they are encrypted at rest and access-scoped to the owning user.
PDFs are retained only as long as needed to generate and support regeneration, then purged on a schedule.
Secrets are managed outside the codebase and rotated.
All entitlement and auth checks are centralized to avoid drift.
Medical content carries a clear disclaimer, and low-confidence cards are always marked, because accuracy is a safety issue and not just a quality metric.

---

## 11. Observability

Structured logs, metrics, and distributed traces cover the request path and the AI pipeline.
We track generation latency, card acceptance rate, flag rate, and verification rejection rate as first-class product-quality metrics.
A rising flag rate is treated as an incident signal, not a vanity number.

---

## 12. Scalability Path

The modular monolith scales horizontally first, which covers early growth cleanly.
When a single module becomes a bottleneck, it can be extracted into its own service because module boundaries and contracts already exist.
The AI worker scales independently of the API because it is already a separate service behind the queue.
pgvector covers dedup and retrieval at current scale, and can move to a dedicated vector store only if data volume demands it.

---

## 13. Repository Structure

```
/apps
  /web            Next.js web client (PWA)
  /mobile         React Native app (later phase)
  /api            Fastify TypeScript API (modular monolith)
  /ai-worker      Python FastAPI AI pipeline service
/packages
  /domain         Shared TypeScript domain types and logic
  /ui             Shared React components
  /config         Shared lint, tsconfig, and build config
/infra            Infrastructure as code
/evals            AI evaluation sets and quality gates
```

A shared `domain` package holds types and business rules used by web, mobile, and API, so a rule is defined once and reused everywhere.

---

## 14. Build Order (aligned with the 90-day milestones)

1. Anonymous session + PDF upload + core generation and verification pipeline (the demo).
2. FSRS study loop + deck management + accounts.
3. Anki export + flag-and-fix loop.
4. Billing (Stripe) + referral credits.
5. NGN question generation (matrix and case studies first).
6. Mobile app once web retention is proven.

This order ships the demo that drives the first 100 users before anything that does not directly serve that goal.
