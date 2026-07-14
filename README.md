# NCLEX App - Backend Monorepo

Backend for the NCLEX AI flashcard and Next-Gen practice app.
See `04_ARCHITECTURE.md` for the full design and `02_BUSINESS_PLAN.md` for product context.

## What is built here (demo-path slice)

The vertical slice that powers the no-signup demo, which is what drives the first 100 users:

1. Anonymous session bootstrap (Identity module).
2. PDF upload and deck/card storage (Content module).
3. The async AI generation and verification pipeline (AI worker).
4. Live job progress over WebSocket.

Study/FSRS, billing, referral, and the mobile app are later phases.

## Layout

```
apps/api          Fastify TypeScript API (modular monolith)
apps/ai-worker    Python FastAPI AI pipeline service
packages/domain   Shared TypeScript domain contracts (source of truth)
infra/db          Database schema and migrations
```

## Prerequisites

- Node 22+
- Python 3.12+
- Docker (for Postgres, Redis, MinIO)

## Getting started

```bash
cp .env.example .env          # fill in ANTHROPIC_API_KEY
npm install
npm run infra:up              # start Postgres + Redis + MinIO
# apply schema
psql "$DATABASE_URL" -f infra/db/schema.sql
npm run dev:api               # API on :3001
npm run dev:worker            # AI worker on :8000
```

## Contracts

`packages/domain` is the single source of truth for shared shapes.
The Python worker mirrors these in Pydantic models under `apps/ai-worker/app/schemas.py`.
Change a shape in one place and update the mirror.
