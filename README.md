# NCLEX App - Backend Monorepo

AI-powered NCLEX flashcard platform.
Upload a PDF, get clinically verified flashcards, study with spaced repetition, export to Anki.

## Architecture

```
apps/api          Fastify TypeScript API  → http://localhost:3001
apps/ai-worker    Python AI pipeline      → Redis queue consumer
packages/domain   Shared TypeScript/Zod contracts
infra/db          Postgres schema + migrations
evals/            Offline card quality evaluations
```

## Prerequisites

- Node.js 22+
- Python 3.12+
- Docker Desktop (for Postgres, Redis, MinIO)

## Getting started

### 1. Install dependencies
```bash
npm ci
cd apps/ai-worker && python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cd ../..
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env - set GEMINI_API_KEY (get a free key at aistudio.google.com)
```

### 3. Start infrastructure
```bash
npm run infra:up   # Postgres + Redis + MinIO via Docker
```

### 4. Apply database migrations
```bash
psql postgres://nclex:nclex@localhost:5432/nclex -f infra/db/schema.sql
psql postgres://nclex:nclex@localhost:5432/nclex -f infra/db/migrations/0002_study.sql
```

### 5. Create MinIO bucket
Open http://localhost:9001 (login: `nclex` / `nclexsecret`) and create a bucket named `nclex-sources`.

### 6. Start services (each in its own terminal)
```bash
npm run dev:api      # API on :3001
npm run dev:queue    # AI worker queue consumer
```

## Auth flow (magic-link, no passwords)

```bash
# 1. Request a magic link
curl -s -c cookies.txt -X POST http://localhost:3001/api/auth/magic-link \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
# Response: {"sent":true,"token":"..."} (token shown in dev mode)

# 2. Verify the token (upgrades anonymous session to registered)
curl -s -b cookies.txt -c cookies.txt -X POST http://localhost:3001/api/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"token": "<token-from-step-1>"}'

# 3. Check session
curl -s -b cookies.txt http://localhost:3001/api/me
```

## Key API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/magic-link` | Request login link |
| `POST` | `/api/auth/verify` | Verify token, get session |
| `GET`  | `/api/me` | Current user |
| `POST` | `/api/decks` | Upload PDF, create deck (multipart) |
| `GET`  | `/api/decks` | List decks |
| `GET`  | `/api/decks/:id` | Deck + cards |
| `GET`  | `/api/decks/:id/due` | Cards due for study |
| `POST` | `/api/cards/:id/review` | Submit rating (1-4) |
| `GET`  | `/api/study/stats` | Streak + retention stats |
| `GET`  | `/api/decks/:id/export` | Download Anki `.apkg` |
| `POST` | `/api/decks/:id/regenerate` | AI prompt-based card editing |

## LLM provider switching

Provider is controlled entirely by env vars - zero code changes needed:

```bash
# Gemini (default, free tier)
LLM_PROVIDER=gemini
GEMINI_API_KEY=AIza-...

# Anthropic via OpenRouter
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
GENERATION_MODEL=anthropic/claude-opus-4-5
CLASSIFY_MODEL=anthropic/claude-3-haiku
```

## Layout

```
apps/
  api/src/modules/
    identity/   Magic-link auth, anonymous sessions
    content/    PDF upload, deck/card CRUD, rate limiting
    study/      FSRS scheduler, review loop, Anki export
  ai-worker/app/
    pipeline.py   Orchestrates all stages
    generate.py   LLM card drafting
    verify.py     Adversarial fact-check
    rank.py       Topic-spread selection
    persist.py    DB writes (idempotent)
    regenerate.py Prompt-based card editing
    worker.py     Redis queue consumer daemon
infra/db/
  schema.sql          Base tables (users, decks, cards, chunks)
  migrations/
    0002_study.sql    FSRS columns, reviews, fsrs_params
evals/
  run_evals.py        Offline card quality evaluations
```
