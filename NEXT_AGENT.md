# NEXT_AGENT.md - Complete Build Handoff

You are the implementation agent for the NCLEX app backend.
This file is your single source of truth.
Read it fully before writing any code, then execute the phases in order.
Do exactly what is written here.

---

## 0. How To Use This Document

You only write code.
The system design, architecture, file layout, and task breakdown are all defined here.
Work phase by phase (Phase 1 first, then 2, 3, 4).
Do not skip ahead, and do not redesign anything.
If a file is marked CREATE, create it.
If a file is marked UPDATE, edit the existing file.
If a file is marked DONE, do not touch it unless a later phase explicitly says so.

### Hard rules (from AGENTS.md - non-negotiable)
- Never use the em dash character.
Use a plain dash "-" instead.
- When writing or substantially editing long Markdown files, put each full sentence on its own line.
- When making technical decisions, do not optimize for development cost.
Prefer quality, simplicity, robustness, scalability, and long-term maintainability.
- When fixing a bug, first reproduce it end to end the way a real user hits it, then fix the real cause.
- If you see a lint failure, test failure, or flakiness, fix it even if it is not what you are working on.
- Never add an agent name as a commit co-author.
- Never hand-edit auto-generated files.

---

## 1. Product Context (why this exists)

We are building an AI study app for the NCLEX (the US/Canada nursing licensure exam, roughly 300,000 candidates per year).
The product turns any uploaded PDF into accurate, non-bloated flashcards, and later adds Next-Generation NCLEX (NGN) clinical-judgment practice questions that plain flashcard apps cannot generate.

The strategic wedge is two things competitors miss:
1. Accuracy over volume - "20 cards that matter, not 200 you delete".
Every card is fact-checked by a separate AI pass and carries a confidence score.
2. NGN coverage - clinical-judgment question formats, added in a later phase.

The first business goal is the no-signup demo: a visitor pastes a PDF and gets flashcards without creating an account.
This is what drives the first 100 users.
The whole Phase 1 backend exists to make that demo real.

Supporting documents in the repo root, for background only (do not edit them):
- `02_BUSINESS_PLAN.md` - market, monetization, go-to-market.
- `03_WHY_IT_WILL_WORK.md` - strategic reasoning.
- `04_ARCHITECTURE.md` - the long-form architecture this file condenses into tasks.
- `01_ACTION_PLAN_100_USERS.md` - user acquisition plan.

---

## 2. System Design

### 2.1 Shape of the system

The backend is a modular monolith API plus a separate AI worker service, sharing Postgres, Redis, and object storage.

```
Client (web, later mobile)
  |  HTTPS / WSS
  v
API service  (TypeScript, Fastify)          apps/api
  - Identity module   (anonymous sessions, magic-link upgrade)
  - Content module    (PDF upload, decks, cards, job progress WebSocket)
  - Infra layer       (pg pool, Redis, S3, repositories)
  |
  |  enqueue job (Redis list)        subscribe progress (Redis pub/sub)
  v                                   ^
AI worker  (Python, FastAPI)         apps/ai-worker
  - 7-stage pipeline: parse -> chunk -> embed -> dedup -> generate -> verify -> rank -> persist
  |
  v
Postgres (+ pgvector)   Redis   Object storage (S3 / MinIO)
```

### 2.2 The core async flow (Phase 1 demo path)

1. Visitor lands, the Identity session hook creates an anonymous user and sets a signed cookie.
2. Visitor uploads a PDF to `POST /api/decks`.
3. The API stores the PDF in object storage, creates a `source` row and a `deck` row in status `generating`, then enqueues a generation job onto a Redis list.
4. The API responds immediately with the deck and a `jobId`.
5. The client opens a WebSocket to `GET /api/jobs/:jobId/progress`.
6. The AI worker pops the job, runs the pipeline, and publishes `JobProgress` events to a Redis pub/sub channel after each stage.
7. The API relays those events to the client WebSocket.
8. When the pipeline finishes, it writes cards to Postgres and marks the deck `ready`.
9. The client fetches `GET /api/decks/:id` to show the finished deck of cards.

### 2.3 Key design decisions (do not violate these)

- Generation and verification are two separate model calls.
The generator drafts cards and never assigns confidence.
A separate verifier fact-checks each card against its source text and assigns confidence.
This separation is the accuracy safeguard for medical content.
Never merge them.
- Every card stores provenance: its source chunk id, a model version string, and a confidence score.
- Low-confidence cards are surfaced with a marker, never silently dropped or hidden.
- Anonymous users are first-class user rows.
Upgrading to a registered account keeps the same user id, so decks stay attached with no data migration.
- Application services are stateless.
All durable state lives in Postgres, Redis, and object storage, so we can scale horizontally during exam-season and viral spikes.
- The API and clients share types from `packages/domain`.
The Python worker mirrors those shapes in `apps/ai-worker/app/schemas.py`.
Change a contract in both places in lockstep.

---

## 3. Technology Stack (already chosen - do not change)

| Layer | Choice |
|-------|--------|
| API | TypeScript, Fastify 5, Node 22+ |
| AI worker | Python 3.12, FastAPI, Anthropic SDK |
| Database | PostgreSQL 16 with pgvector |
| Cache / queue / pubsub | Redis 7 |
| Object storage | S3-compatible (MinIO in dev) |
| Shared types | `@nclex/domain` (TypeScript, Zod) |
| LLM (generate + verify) | claude-opus-4-8 |
| LLM (cheap classify) | claude-haiku-4-5-20251001 |
| Spaced repetition | FSRS (Phase 3) |
| Payments | Stripe web, RevenueCat mobile (Phase 4) |

Local infrastructure is defined in `docker-compose.yml` (Postgres, Redis, MinIO).
Environment variables are documented in `.env.example`.

---

## 4. Current File Structure And Status

Legend: DONE = complete and verified, PARTIAL = exists but must be finished, STUB = placeholder to replace, CREATE = does not exist yet.

```
Beta/
  docker-compose.yml                         DONE  (Postgres + Redis + MinIO)
  package.json                               DONE  (npm workspaces root)
  .env.example                               DONE
  README.md                                  DONE
  AGENTS.md                                  DONE  (follow it)
  infra/db/
    schema.sql                               DONE  (users, sources, decks, cards, source_chunks, generation_jobs)
    migrations/                              CREATE (Phase 3+ tables go here as numbered migrations)

  packages/domain/
    package.json                             DONE
    tsconfig.json                            DONE
    src/index.ts                             DONE  (shared Zod contracts - the source of truth)

  apps/api/
    package.json                             DONE
    tsconfig.json                            DONE
    src/config.ts                            DONE  (env parsing, Redis key + channel names)
    src/server.ts                            DONE  (Fastify bootstrap, registers identity + content routes)
    src/infra/
      index.ts                               DONE  (clients + repositories, re-exported)
      db.ts                                  DONE  (pg Pool singleton + query helper)
      redis.ts                               DONE  (ioredis client + createSubscriber)
      storage.ts                             DONE  (S3 putObject)
      mappers.ts                             DONE  (row -> domain type mappers)
      mappers.test.ts                        DONE  (vitest)
      users.repo.ts                          DONE
      sources.repo.ts                        DONE
      decks.repo.ts                          DONE
      cards.repo.ts                          DONE
      jobs.repo.ts                           DONE  (enqueue + subscribeProgress)
    src/modules/identity/
      routes.ts                              DONE  (registerIdentityRoutes, global session, /api/me)
      session.ts                             DONE  (currentUser decorator, cookie, authGuard)
      magic-link.ts                          DONE  (POST /api/auth/magic-link, /api/auth/verify)
      tokens.ts                              DONE  (Redis-backed magic tokens)
      tokens.test.ts                         DONE
    src/modules/content/
      upload.ts                              DONE  (pure PDF validators, title-from-filename, storage key)
      routes.ts                              STUB  (still the placeholder - Phase 1 replaces it)
      decks.controller.ts                    CREATE (Phase 1)
      progress.ws.ts                         CREATE (Phase 1)
      upload.test.ts                         CREATE (Phase 1)

  apps/ai-worker/
    requirements.txt                         DONE  (add asyncpg or psycopg in Phase 1 for persist)
    app/
      main.py                                DONE  (FastAPI health check)
      config.py                              DONE  (Settings)
      schemas.py                             DONE  (Pydantic mirror of domain contracts)
      llm.py                                 DONE  (Anthropic wrapper: complete / complete_json)
      parse.py                               DONE  (stage 1: S3 download + pypdf)
      chunk.py                               DONE  (stage 2a: paragraph-aware chunking)
      embed.py                               DONE  (stage 2b: embedding seam + hash fake)
      dedup.py                               DONE  (stage 3: cosine dedup + topic tagging)
      generate.py                            DONE  (stage 4: draft cards via Claude)
      verify.py                              DONE  (stage 5: separate fact-check pass)
      rank.py                                CREATE (stage 6)
      persist.py                             CREATE (stage 7: write chunks + cards, mark deck ready)
      pipeline.py                            CREATE (orchestrate stages, publish progress)
      worker.py                              CREATE (Redis queue consumer loop)
      tests/                                 CREATE (pytest: chunk, dedup, rank, pipeline with mocks)
```

### 4.1 What is already correct and reusable

Read these before writing new code so your additions match their style and signatures.

Infra repositories, in `apps/api/src/infra/`, expose:
- `clients.pool()`, `clients.redis()`, `clients.putObject(key, body, contentType)`.
- `users.createAnonymous()`, `users.findById(id)`, `users.upgradeToRegistered(id, email, kind)`.
- `sources.create(userId, filename, storageKey)`.
- `decks.create(userId, sourceId, title)`, `decks.findById(id)`, `decks.listByUser(userId)`, `decks.markReady(id, cardCount)`.
- `cards.listByDeck(deckId)`, `cards.flag(cardId)`.
- `jobs.enqueue(deckId, sourceId, storageKey) -> jobId`, `jobs.subscribeProgress(jobId, onEvent) -> unsubscribe`.

Identity, in `apps/api/src/modules/identity/`:
- The session hook runs globally (it opts out of Fastify encapsulation), so `request.currentUser` is set on every request in every module.
- Import `authGuard` or `requireUser` from the identity module to require a session.

Content, in `apps/api/src/modules/content/upload.ts`, exposes pure helpers:
- `validatePdfUploadMetadata({ filename, mimetype })` throws `UploadValidationError` on bad input.
- `assertPdfSizeWithinLimit(byteLength)`.
- `titleFromFilename(filename)`.
- `buildSourceStorageKey(userId)`.
- Constants `MAX_PDF_BYTES`, `ALLOWED_PDF_MIMETYPES`.

AI worker stage entrypoints already implemented:
- `parse(storage_key, store=None) -> list[ParsedPage]`.
- `chunk_pages(pages) -> list[SourceChunk]`.
- `embed_texts(texts, embedder=None) -> list[list[float]]`.
- `dedup_chunks(chunks, embeddings, threshold=None) -> (kept_chunks, kept_embeddings)` and `tag_chunks(chunks, tagger=heuristic_tag)`.
- `generate(chunks, client=None) -> list[DraftCard]`.
- `verify(cards, chunks, client=None) -> list[VerifiedCard]`.
- `llm.default_client`, `LLMClient.complete(...)`, `LLMClient.complete_json(...)`.
- Config on `settings` in `config.py`, including `job_queue_key = "job:generation:queue"` and `job_progress_channel = "job:progress"`.

The API side uses the same names via `apps/api/src/config.ts`: `JOB_QUEUE_KEY` and `JOB_PROGRESS_CHANNEL`.
These MUST stay identical across both services.

---

## 5. The Shared Contract (memorize this)

Defined in `packages/domain/src/index.ts` (TypeScript, Zod) and mirrored in `apps/ai-worker/app/schemas.py` (Pydantic).
Payloads that cross the wire use camelCase JSON.

- `GenerationJobRequest`: `{ jobId, deckId, sourceId, storageKey, targetCardCount=25 }`.
The API pushes this onto the Redis list `JOB_QUEUE_KEY`.
The worker pops and parses it.
- `JobProgress`: `{ jobId, stage, progress (0..1), message? }`.
The worker publishes this on the Redis channel `JOB_PROGRESS_CHANNEL` after each stage.
The API relays it to the client WebSocket.
- `JobStage`: `queued, parsing, chunking, generating, verifying, ranking, persisting, done, failed`.
- `SourceChunk`: `{ id, text, page?, topic? }`.
- `DraftCard`: `{ front, back, topic?, sourceChunkId }`.
- `VerifiedCard`: DraftCard plus `{ confidence (0..1), correctedBack? }`.
- `Card` (persisted): `{ id, deckId, front, back, topic?, confidence, sourceChunkId?, modelVersion, flagged, createdAt }`.
- Constants: `LOW_CONFIDENCE_THRESHOLD = 0.6`, `MODEL_VERSION = "claude-opus-4-8+haiku-4-5/v1"`.

---

## 6. PHASE 1 - Finish The No-Signup Demo (do this first)

Goal: a visitor can upload a PDF and receive a finished deck of verified flashcards, watching live progress.
This is the whole reason the project exists right now.
When Phase 1 is done, the demo works end to end against local Docker infra.

### 6.1 Content module - CREATE and UPDATE

Files:
- UPDATE `apps/api/src/modules/content/routes.ts` (replace the stub `registerContentRoutes`).
- CREATE `apps/api/src/modules/content/decks.controller.ts`.
- CREATE `apps/api/src/modules/content/progress.ws.ts`.
- CREATE `apps/api/src/modules/content/upload.test.ts`.

Endpoints to implement (all scoped to `request.currentUser`, 404 or 403 when a resource is not owned by the current user):

1. `POST /api/decks` - multipart PDF upload.
Read the file part.
Call `validatePdfUploadMetadata` on filename and mimetype, buffer the bytes, call `assertPdfSizeWithinLimit`.
Build the storage key with `buildSourceStorageKey(userId)`, upload with `clients.putObject`.
Create the source with `sources.create`, then the deck with `decks.create` titled via `titleFromFilename`.
Call `jobs.enqueue(deck.id, source.id, storageKey)`.
Respond `{ deck, jobId }`.
Map `UploadValidationError` to its `statusCode`.

2. `GET /api/decks` - return `decks.listByUser(userId)`.

3. `GET /api/decks/:id` - return `{ deck, cards }` using `decks.findById` and `cards.listByDeck`.
Return 404 if the deck does not exist or is not owned by the current user.

4. `POST /api/cards/:id/flag` - call `cards.flag(id)` after confirming the card belongs to a deck the user owns.
This is the entry point of the flag-and-fix loop.

5. `GET /api/jobs/:jobId/progress` - a WebSocket route (the server already registered `@fastify/websocket`).
On connect, call `jobs.subscribeProgress(jobId, onEvent)` and forward each `JobProgress` to the socket as JSON.
Close the subscription when the socket closes, and when a terminal stage (`done` or `failed`) arrives.
Put the socket-forwarding logic in `progress.ws.ts`.

Tests: `upload.test.ts` covers the pure validators and `titleFromFilename` edge cases (no extension, path prefixes, empty, overlong).
Keep controller logic thin so most logic stays in the already-tested pure helpers.

Verification for this module:
- `npx tsc -p apps/api/tsconfig.json --noEmit` is clean.
- `npm --workspace apps/api run test` passes.

### 6.2 AI worker - CREATE the remaining stages

Files:
- CREATE `apps/ai-worker/app/rank.py` (stage 6).
- CREATE `apps/ai-worker/app/persist.py` (stage 7).
- CREATE `apps/ai-worker/app/pipeline.py` (orchestrator).
- CREATE `apps/ai-worker/app/worker.py` (queue consumer).
- CREATE `apps/ai-worker/app/tests/` with pytest files.
- UPDATE `apps/ai-worker/requirements.txt` to add a Postgres driver (`asyncpg` preferred, or `psycopg[binary]`).

`rank.py`:
- `rank(cards: list[VerifiedCard], target_card_count: int) -> list[VerifiedCard]`.
- Keep the best `target_card_count` cards.
Prefer higher confidence, then spread across topics so one topic does not dominate ("cards that matter, not 200 to delete").
- Pure and deterministic given its inputs, so it is unit-testable.

`persist.py`:
- Write kept `source_chunks` (with embeddings) and `cards` to Postgres.
- Each card row sets `front`, effective `back` (use `VerifiedCard.effective_back`), `topic`, `confidence`, `source_chunk_id`, `model_version = MODEL_VERSION`, `flagged = false`.
- Update the deck: set `status = 'ready'` and `card_count`.
- Keep all SQL parameterized.
- Put the DB connection behind a small seam so tests can pass a fake.

`pipeline.py`:
- `run_pipeline(request: GenerationJobRequest, deps=...) -> None`.
- Call the stages in order: parse, chunk, embed, dedup + tag, generate, verify, rank, persist.
- After each stage, publish a `JobProgress` to `settings.job_progress_channel` via Redis, with a rising `progress` value and the matching `JobStage`.
- On success, publish `done` at progress 1.0.
- On any exception, publish `failed`, record the error on the `generation_jobs` row, and mark the deck `failed`.
- Inject dependencies (LLM client, embedder, Redis, DB, object store) so the whole pipeline is testable offline with fakes.

`worker.py`:
- A loop that BRPOPs from `settings.job_queue_key`, parses the JSON into `GenerationJobRequest`, and calls `run_pipeline`.
- Runnable via `python -m app.worker`.
- Handle malformed queue payloads by logging and skipping, never crashing the loop.

Tests under `app/tests/`:
- `test_chunk.py`, `test_dedup.py` (cosine math and greedy dedup), `test_rank.py` (selection and topic spread).
- `test_pipeline.py` runs the full pipeline with a fake LLM, fake embedder, in-memory object store, fake Redis, and a fake DB, asserting cards are produced and progress events are published in order.
- All tests run offline with no network, no API key, no live DB.

Verification for the worker:
- Create a venv, install `requirements.txt`, run `pytest`, report pass or fail.
- If install is blocked in the sandbox, at minimum `python -m py_compile` every module and note what could not be run.

### 6.3 Cross-cutting Phase 1 verification (end to end)

Follow the AGENTS.md rule: exercise it the way a user would.
1. `docker compose up -d`, then apply `infra/db/schema.sql` to Postgres.
2. Create the MinIO bucket named in `.env`.
3. Start the API and the worker.
4. `curl` `GET /api/me` to get an anonymous session cookie.
5. `POST /api/decks` with a real sample PDF using that cookie.
6. Connect to the progress WebSocket and confirm stages stream through to `done`.
7. `GET /api/decks/:id` and confirm verified cards exist with confidence and provenance.
8. Confirm low-confidence cards are present and marked, not dropped.
Document any step you could not run locally.

### 6.4 Repo hygiene owed from setup (do in Phase 1)

- CREATE `eslint.config.js` at the repo root (ESLint v9 flat config for TypeScript).
`npm run lint` currently fails repo-wide because this file is missing.
Fix it so lint passes, per the engineering-excellence rule.

---

## 7. PHASE 2 - Harden And Make It Production-Shaped

Goal: the demo path is not just working but robust, observable, and safe under load.

- Rate limiting and abuse controls on anonymous sessions, especially `POST /api/decks`, to protect LLM spend during viral spikes.
Use Redis counters keyed by session and IP.
- Idempotency and retries: if the worker dies mid-job, the job can be re-dispatched safely.
Make persist idempotent per deck.
- Structured logging, request tracing, and metrics across the API and the pipeline.
Track generation latency, card acceptance rate, flag rate, and verification rejection rate as first-class metrics.
- A small AI evaluation set under `evals/` that runs known PDFs through generate and verify and checks card quality thresholds.
Wire it into CI so a prompt or model change that regresses quality blocks merge.
- Real magic-link email delivery behind a provider seam (dev still logs the token).
- Object-storage lifecycle: purge source PDFs on a schedule after generation, with a retention window.
- CI pipeline: lint, typecheck, unit tests, and the eval set on every change.
- Replace the hashing embedder with a real embedding provider behind the existing `Embedder` seam.

Files likely touched or created:
- CREATE `apps/api/src/modules/content/rate-limit.ts`.
- CREATE `evals/` with fixtures and a runner.
- CREATE `.github/workflows/ci.yml` (or the chosen CI).
- UPDATE `apps/ai-worker/app/embed.py` to add the real provider implementation.
- UPDATE logging across API and worker.

---

## 8. PHASE 3 - Study Loop (FSRS) And Anki Export

Goal: retention features that turn a generated deck into daily study.
This is the retention differentiator over free tools.

- New Study module in the API: `apps/api/src/modules/study/`.
- FSRS scheduler with per-user parameters.
- Event-sourced reviews: every review writes an immutable event row (card, rating, timestamp, elapsed interval).
Scheduling state is derived from those events so history can be replayed and parameters re-optimized.
- Endpoints: get the due queue for a deck, submit a review rating, get retention and streak stats.
- One-click Anki export: a background job that reads cards and FSRS state, maps to Anki's `.apkg` schema, preserves review progress, and writes the package to object storage for download.
Preserving progress on export is a deliberate trust feature.
- New tables via numbered migrations under `infra/db/migrations/`: `reviews`, `fsrs_params`, and study-related indexes.

Files likely created:
- `infra/db/migrations/0002_study.sql`.
- `apps/api/src/modules/study/routes.ts`, `scheduler.ts` (FSRS), `reviews.repo.ts`, `export.controller.ts`.
- `apps/api/src/infra/reviews.repo.ts`.

---

## 9. PHASE 4 - NGN Practice, Billing, Referral, Mobile

Goal: the full product and its monetization.

NGN practice (the strategic moat):
- Extend the AI worker with schema-constrained generators per NGN question type: matrix, case study, trend analysis.
Each type has its own generator and validator so outputs are valid and gradable, not free-form text.
- New tables for NGN question sets and attempts.
- API endpoints to fetch and grade NGN items.

Billing:
- Billing module wrapping Stripe (web) and RevenueCat (mobile) behind one internal entitlement interface.
- All entitlement checks flow through a single function so paywall logic never drifts.
- Free tier limits plus paid unlock at the price point in the business plan.

Referral:
- Referral module: share links, attribution of new signups to referrers, credits to both sides.
- Public shared decks carry a watermark and a referral code, turning each shared deck into a growth channel.

Mobile:
- React Native (Expo) app reusing the `packages/domain` types.
Build this only after web retention is proven.

Files likely created:
- `apps/ai-worker/app/ngn/` generators and validators.
- `apps/api/src/modules/billing/`, `apps/api/src/modules/referral/`.
- `infra/db/migrations/0003_ngn.sql`, `0004_billing_referral.sql`.
- `apps/mobile/` (later).

---

## 10. Definition Of Done Per Phase

Phase 1: the end-to-end demo in section 6.3 works locally, all TypeScript typechecks, all unit tests pass in both services, and `npm run lint` passes.
Phase 2: rate limiting is enforced, metrics are visible, the eval set runs in CI, and a job can survive a worker restart.
Phase 3: a user can study a due queue, ratings reschedule via FSRS, and an Anki export downloads with progress preserved.
Phase 4: NGN items generate and grade, billing gates the paid tier through one entitlement path, referral credits apply, and the mobile app runs against the same API.

---

## 11. Guardrails (read before every phase)

- Do not change the shared contract in only one language.
Update `packages/domain/src/index.ts` and `apps/ai-worker/app/schemas.py` together.
- Do not merge generation and verification.
- Do not hide or drop low-confidence cards.
Mark them.
- Keep all SQL parameterized.
- Keep application services stateless.
- Keep new pure logic in small, testable functions with tests alongside.
- Every card must keep its provenance and confidence.
- Medical content is a safety liability.
When unsure, prefer surfacing uncertainty to the user over hiding it.
- Follow AGENTS.md at all times.
