# Advoget V0 — Indian Legal AI Assistant

V0 of an Indian legal information assistant built for lawyers (`lawyer` mode: dense, citation-forward) and citizens (`citizen` mode: plain language, practical next steps). Supports English, Hindi, and Hinglish.

- **Scope guard**: Answers **only** Indian legal and judiciary-related questions; politely refuses off-topic requests or gibberish.
- **Text-based PDF RAG**: Upload selectable-text PDFs and ask questions grounded with page-level citations (`[S1]`, `[S2]`). Scanned/image PDFs without a text layer are cleanly rejected with a notice (OCR seam reserved for V1).
- **Tool calling**: Hybrid retrieval (vector + keyword RRF) across user documents, an Indian statute database, and Tavily web search restricted to trusted legal domains.
- **Mandatory citation verification**: Every `[S#]` citation and statutory/case reference is checked before completing a response.

---

## Architecture & Repository Layout

```text
.
├── frontend/              # React 18 + Vite + TypeScript + Tailwind CSS (Static build for Cloudflare Pages / Netlify)
├── backend/               # Node.js + Express API (Auth check, conversations, uploads, rate limits, SSE proxy)
├── ai-service/            # Python + FastAPI (Scope guard, tool loop, PDF parsing, chunking, embeddings, OpenRouter)
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── llm.py
│   │   ├── embeddings.py
│   │   ├── scope.py
│   │   ├── prompts.py
│   │   ├── agent.py
│   │   ├── tools/
│   │   └── ingest/
│   └── scripts/
├── supabase/migrations/   # Postgres + pgvector (halfvec) + RLS migrations
├── evals/                 # Scope and answer evaluation suites (cases.jsonl)
└── data/statutes/         # Official India Code PDFs (gitignored)
```

---

## Running Locally (All Three Services)

### 1. Environment & Database Setup

Copy `.env.example` to `.env` in each service directory and populate your keys:

```bash
cp ai-service/.env.example ai-service/.env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Ensure `INTERNAL_API_KEY` matches in both `backend/.env` and `ai-service/.env`.

#### Apply Supabase Migration (`supabase/migrations/001_initial_schema.sql`)
1. Open the **SQL Editor** in your Supabase project dashboard (or run `supabase db push` via the Supabase CLI).
2. Verify pgvector 0.7+ is available for `halfvec`:
   ```sql
   select extversion from pg_extension where extname = 'vector';
   ```
3. Run [`supabase/migrations/001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql) to create all tables (`profiles`, `conversations`, `messages`, `documents`, `document_chunks`, `statute_chunks`, `usage_daily`), HNSW `halfvec(1024)` + GIN `tsvector` indexes, hybrid search functions (`match_document_chunks`, `keyword_document_chunks`, `match_statute_chunks`, `keyword_statute_chunks`), Row Level Security policies, and the private `documents` Storage bucket.

### 2. Start Python AI Service (`ai-service` on port `8000`)

```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Health check:
```bash
curl http://localhost:8000/health
```

### 3. Start Node.js API (`backend` on port `4000`)

```bash
cd backend
npm install
npm run dev
```

Health check:
```bash
curl http://localhost:4000/api/health
```

### 4. Start React Frontend (`frontend` on port `5173`)

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

---

## Free-Tier Limits & Operational Warnings (Read Carefully)

### 1. OpenRouter Request Budget & Privacy
- **Requests, not tokens, are the bottleneck**: On an OpenRouter account with **under \$10 of lifetime credits**, `:free` models allow **20 requests/min and 50 requests/day in total** — roughly **a dozen user messages** (since 1 user message can take up to 4 requests: 1 scope gate + 1–2 tool rounds + 1 query embedding).
- **Buying \$10 of credits once** raises the `:free` tier limit to **1,000 requests/day**.
- **Model rotation**: Free models rotate without warning. Never hardcode model IDs; configure `MODEL_GATE`, `MODEL_CHAT`, and 2–3 tool-capable fallback models in `MODEL_FALLBACKS`.
- **Data privacy**: Free OpenRouter endpoints may log or train on prompts. Enable OpenRouter's data-privacy settings to block training endpoints, and only use free embedding endpoints (`nvidia/nemotron-3.5-embed-1b:free`) for **public statutes and development data** — use a local model (`EMBEDDINGS_PROVIDER=local`) or a paid zero-retention endpoint for real client documents.

### 2. Supabase Free Tier (500 MB DB + 7-Day Idle Pause)
- **7-day inactivity pause**: Supabase pauses free projects after 7 days of inactivity. If paused, restore the project from the Supabase dashboard (`Project Settings -> General -> Restore project`). During development, a weekly scheduled query (e.g., via a GitHub Actions cron hitting `/api/health` + a lightweight DB ping) prevents pausing. Plan to upgrade to Pro before onboarding real users.
- **No automatic backups**: Free tier does not include automated backups. Run periodic `pg_dump` exports of your schema and statute chunks.
- **500 MB database budget**: We use pgvector 0.7+ `halfvec(1024)` (truncating 2048-dim embeddings to 1024 and storing as 16-bit floats) to cut vector index storage in half. Keep initial statutes focused (`BNS`, `BNSS`, `BSA`, `IPC`, `CrPC`, `Constitution`, `Motor Vehicles Act`) and monitor DB size.
- **Connection string**: Always use the **Supabase Session/Transaction Pooler** connection string (`DATABASE_URL`) in `ai-service` because it is IPv4-compatible.

### 3. Render Free Web Services
- **Cold starts**: Free Render services spin down after 15 minutes of idle time and take ~1 minute to wake up. The frontend surfaces a visible `"Waking up the server..."` indicator.
- **Ephemeral filesystem**: Never store uploaded PDFs on local disk; all files go directly to the private Supabase Storage bucket `documents`.
- **No private network on free tier**: Node calls the Python `ai-service` over its public HTTPS URL authenticated by the `X-Internal-Key` header.
- **750 free hours/month**: Shared across all free web services in a Render workspace (2 services = ~1,440 hours/month if awake 24/7, but spin-down keeps usage lower; if needed, the documented fallback is merging Node's routes into FastAPI).

### 4. Tavily Web Search
- **1,000 credits/month** on the free plan with low concurrency (~2 concurrent requests).
- Searches are restricted to `trusted_domains.json`, capped per user per day (`DAILY_WEB_SEARCH_CAP=10`), and identical queries are cached for 24 hours.

### 5. Frontend Hosting
- Host the static Vite build on **Cloudflare Pages** or **Netlify** free tier. Do **not** use Vercel Hobby for any commercial use (Vercel Hobby terms restrict usage to personal, non-commercial projects).

