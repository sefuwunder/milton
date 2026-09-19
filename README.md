# Milton

A self-hosted chat bot that orchestrates and automates inside [exec-crm](https://github.com/sefuwunder/exec-crm).

Talk to your CRM in plain English: check the pipeline, move deals, add contacts and tasks, run a morning brief, or sweep for pipeline hygiene issues. Milton asks before anything destructive and disambiguates when a name matches more than one record.

## Footprint

- **Bun + zero npm dependencies + SQLite.** The whole app is ~150 KB of source; with the Bun runtime it runs comfortably in tens of MB — far under 1 GB.
- All data stays on your machine: chat history in `./data/milton.db`, CRM data untouched (Milton only talks to exec-crm over HTTP, never its database file).

## Quick start

```bash
bun install   # no-op: there are no dependencies
MILTON_CRM_URL=http://localhost:3001 bun src/server.ts
# open http://localhost:3009
```

`exec-crm` must be running and reachable at `MILTON_CRM_URL` (default `http://localhost:3001`).

Optional freeform chat via any OpenAI-compatible endpoint (local Ollama, vLLM, etc.):

```bash
MILTON_LLM_URL=http://localhost:11434/v1 MILTON_LLM_MODEL=qwen2.5:7b bun src/server.ts
```

Without it, Milton runs fully offline on its built-in command engine — every CRM operation below works with no model at all.

If the model endpoint is misconfigured (wrong model name, unreachable host), Milton says so in-chat — e.g. `I couldn't reach the language model (404 from …/chat/completions: model '…' not found)` — instead of silently falling back to "I'm not sure what you mean". `GET /api/health` also reports `llm_url` and `llm_model` so you can inspect the configuration.

## What Milton can do

**Look things up** — `show pipeline` · `kpis` · `show deal Acme` · `list deals in negotiation` · `find contacts named jane` · `my tasks` · `recent activity` · `webhooks` · `delivery log`

**Work the pipeline** — `add deal Website redesign for Acme worth 50k close friday` · `move Acme deal to negotiation` · `mark Acme deal as won` · `set Acme deal value to 75k` · `delete deal Old Opp` (asks first)

**People & tasks** — `add contact Jane Doe at Acme jane@acme.com` · `add company Globex` · `add task Call Acme tomorrow` · `remind me to send the proposal friday` · `complete task 3`

**Routines** — `morning brief` (open pipeline, closing this week, overdue/due-today tasks, latest activity) · `pipeline hygiene` (missing close dates, stale deals, deals without contacts, overdue tasks)

**Camera & OCR** — tap the 📷 button to snap a photo of printed text (whiteboard, business card, document); Milton transcribes it automatically. Then `read this`, `analyze handwriting` (geometric analysis: slant, stroke pressure, size consistency, spacing, baseline drift — with raw numbers, not mysticism), or save the transcription as a note on a deal.

The OCR engine is hand-written TypeScript with zero dependencies: PNG + baseline-JPEG decoders, Otsu binarization, deskew, and 5x7 template matching. It's tuned for printed text photographed straight-on — cursive handwriting won't transcribe reliably, which is why handwriting gets the analysis view instead. If `MILTON_LLM_URL` points at a vision-capable model, Milton can also offer a vision-model pass when local confidence is low.

Natural dates (`tomorrow`, `friday`, `in 3 days`, `2026-10-02`) and money (`50k`, `$1.2m`) are parsed inline.

## API

- `POST /api/chat` → `{ session, message, attachments? }` → `{ text, cards?, chips? }`
- `POST /api/upload` → multipart image (JPEG/PNG/WebP, ≤10 MB) → `{ id, url }`
- `GET /api/file/:id` → serves the upload (scoped to its session)
- `GET /api/history?session=…` → recent messages for a session
- `GET /api/health` → `{ ok, crm, crm_url, llm, llm_url, llm_model }`

## Tests

```bash
bun test tests/   # 112 tests: intent parser, brain vs stubbed CRM, OCR engine, uploads, LLM error paths, DOM-stubbed UI
```

## Layout

- `src/server.ts` — Bun server, sessions + chat history in SQLite, static UI
- `src/brain.ts` — intent dispatch, reply cards, confirmations, routines, photo/OCR replies
- `src/intents.ts` — deterministic NL parser (dates, money, stages, commands)
- `src/crm.ts` — exec-crm HTTP client + fuzzy entity resolution
- `src/ocr.ts` — zero-dependency OCR: PNG/JPEG decoders, binarization, segmentation, template matching, handwriting metrics
- `public/` — chat UI (no build step, no dependencies)
