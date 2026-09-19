# Milton

A self-hosted chat bot that orchestrates and automates inside [exec-crm](https://github.com/sefuwunder/exec-crm).

Talk to your CRM in plain English: check the pipeline, move deals, add contacts and tasks, run a morning brief, or sweep for pipeline hygiene issues. Milton asks before anything destructive and disambiguates when a name matches more than one record.

## Footprint

- **Bun + zero npm dependencies + SQLite.** The whole app is ~150 KB of source; with the Bun runtime it runs comfortably in tens of MB — far under 1 GB.
- All data stays on your machine: chat history in `./data/milton.db`, CRM data untouched (Milton only talks to exec-crm over HTTP, never its database file).

## Quick start

```bash
bun install   # no-op: there are no dependencies
EXEC_CRM_URL=http://localhost:3001 bun src/server.ts
# open http://localhost:3009
```

`exec-crm` must be running and reachable at `EXEC_CRM_URL` (falls back to `MILTON_CRM_URL`, then `http://localhost:3001`).

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

### Automations — routines, schedules, triggers

Save your own multi-step routines, run them on a schedule, or fire them from exec-crm webhooks. Everything is manageable from chat or the ⚙️ Automations panel (Routines / Schedules / Triggers / Runs tabs, with a 🔔 bell for run history and live toasts over SSE).

**Routines** — named command sequences, steps separated by `;`:
- `save routine EOD: my tasks; kpis` · `run EOD` · `list routines` · `show routine EOD` · `delete routine EOD`
- Steps run in order through the normal chat pipeline; a failing step is reported and the rest continue. `run <name>` inside a routine calls another routine (recursion is guarded).
- Destructive steps (`delete deal/task`, `mark … as lost`) ask once up front in chat; unattended runs (schedules, triggers) skip them and say so.

**Schedules** — `schedule EOD daily at 6pm` · `schedule morning brief every weekday at 8am` · `schedule sync every monday at 9am` · `schedule pulse every 30 minutes`. Also `list schedules`, `pause schedule 3`, `resume schedule 3`, `unschedule 3`. A scheduler sweep runs every 30s (server-local time).

**Triggers** — `when deal won run celebrate` · `when task completed run EOD` · `when deal.stage_changed where stage=negotiation run notify`. Supported exec-crm events: `deal.created`, `deal.stage_changed`, `deal.updated`, `contact.created`, `campaign.created`, `campaign.updated`, `campaign.deleted`, `task.created`, `task.completed`, `task.deleted`. Aliases: `deal won` / `deal lost` (stage filters), `new deal`, `task completed`, etc. `list triggers` · `delete trigger 4` · `trigger help`.

**Runs** — `automation runs` (or the Runs tab) shows the last 50 runs with per-step detail; every run is also pushed live over `GET /api/events` (SSE).

**Wiring exec-crm**: point an outgoing webhook at `POST /api/hooks/exec-crm` with header `X-Milton-Secret` set to your `MILTON_HOOK_SECRET`. Payload shape: `{ event, sent_at, data }`. exec-crm's webhook sender supports custom headers (Automations → Add webhook → Custom headers), so direct wiring works with no proxy.

### Meridian recon

Milton reads Meridian's recon sprints (`MERIDIAN_URL`, default `http://localhost:3005`) and can also ask Meridian for **new** runs through its run-request router (`POST /api/runs`):

- `meridian recons` — list recon sprints, newest first
- `meridian dossier Austin` — analyst summary of one sprint
- `meridian entities Austin` — its companies and orgs (`meridian entities austin company` filters by type)
- `meridian recon Austin` (or `meridian run Austin`) — request a **new** recon run from Meridian

**Request flow.** Milton POSTs `{ city, callback_url, callback_headers }` to `MERIDIAN_URL/api/runs` and answers immediately with the run id and its status (`running`/`queued` — router runs execute one at a time, FIFO). The request is pinned to your chat session's workspace and saved in SQLite until Meridian reports back.

**Completion callbacks.** Set `MILTON_HOOK_SECRET` and tell Meridian where Milton lives:

- `MILTON_BASE_URL` (default `http://localhost:3009`) — Meridian must be able to reach this address; the same-machine default just works.
- `MILTON_HOOK_SECRET` — sent as `X-Milton-Secret` on the run request and verified (constant-time) on `POST /api/hooks/meridian`, the same pattern as the exec-crm webhook ingress: 503 when unset, 401 on a bad secret.

When Meridian finishes, it POSTs `{ run_id, city, label, status, nodes, edges, result_url, export_url }` to `/api/hooks/meridian`. Milton records it as an automation run (kind `meridian`): it appears in the Runs tab with city, status, node/edge counts and a link to the Meridian result, and it fires the 🔔 bell and the live SSE toast. A callback for an unknown `run_id` is still recorded (marked unknown) — never dropped.

Without `MILTON_HOOK_SECRET` Milton requests the run with no callback and tells you to check back with `meridian recons`.

Example:

```
you:    meridian recon Austin
Milton: Run requested: recon of **Austin** is now `running` (run `a3f9c21b`). I'll report back here when it finishes.
   … Meridian finishes, callbacks land …
🔔      ⚡ Recon: Austin (meridian): ready — 214 nodes · 318 edges
```

### Workspaces

Milton can work inside any exec-crm workspace, not just the default one. Every exec-crm request carries the session's workspace via exec-crm's `?workspace=<id>` scoping (which wins over the `X-Workspace` header).

- `workspaces` — list exec-crm's workspaces with ids
- `switch to Acme` / `use workspace Acme` — fuzzy name match; ambiguous names get a numbered pick-list, a bare id works too, `switch to default` goes back
- `current workspace` — where this chat session is working
- The topbar has a workspace switcher dropdown showing the current workspace; it stays in sync when you switch from chat.
- The choice is per chat session and persists across restarts (stored server-side, `session_workspaces` table).
- **Schedules and triggers pin the workspace they were created in**: `schedule EOD daily at 6pm` while in Acme runs in Acme forever, even if you later switch the chat elsewhere. `list schedules` / `list triggers` show the pinned workspace; unattended runs skip destructive steps as before.
- If exec-crm is unreachable, Milton says so and keeps the current (or default) workspace rather than guessing.

**Camera & OCR** — tap the 📷 button to snap a photo of printed text (whiteboard, business card, document); Milton transcribes it automatically. Then `read this`, `analyze handwriting` (geometric analysis: slant, stroke pressure, size consistency, spacing, baseline drift — with raw numbers, not mysticism), or save the transcription as a note on a deal.

The OCR engine is hand-written TypeScript with zero dependencies: PNG + baseline-JPEG decoders, Otsu binarization, deskew, and 5x7 template matching. It's tuned for printed text photographed straight-on — cursive handwriting won't transcribe reliably, which is why handwriting gets the analysis view instead. If `MILTON_LLM_URL` points at a vision-capable model, Milton can also offer a vision-model pass when local confidence is low.

Natural dates (`tomorrow`, `friday`, `in 3 days`, `2026-10-02`) and money (`50k`, `$1.2m`) are parsed inline.

## API

- `POST /api/chat` → `{ session, message, attachments? }` → `{ text, cards?, chips? }`
- `POST /api/upload` → multipart image (JPEG/PNG/WebP, ≤10 MB) → `{ id, url }`
- `GET /api/file/:id` → serves the upload (scoped to its session)
- `GET /api/history?session=…` → recent messages for a session
- `GET /api/health` → `{ ok, crm, crm_url, llm, llm_url, llm_model }`
- `GET /api/routines` · `POST /api/routines` / `DELETE /api/routines/:name`
- `GET /api/schedules` · `POST /api/schedules` (`{ routine, when }`) · `PATCH /api/schedules/:id` (`{ active }`) · `DELETE /api/schedules/:id`
- `GET /api/triggers` (includes supported `events`) · `POST /api/triggers` (`{ event, routine }`) · `DELETE /api/triggers/:id`
- `GET /api/automation-runs?limit=50`
- `GET /api/events` → SSE stream of automation runs
- `POST /api/hooks/exec-crm` → exec-crm webhook ingress (requires `X-Milton-Secret: $MILTON_HOOK_SECRET`)
- `POST /api/hooks/meridian` → Meridian run-completion ingress (requires `X-Milton-Secret: $MILTON_HOOK_SECRET`)

## Tests

```bash
bun test tests/   # 248 tests: intent parser, brain vs stubbed CRM, OCR engine, uploads, LLM error paths, DOM-stubbed UI, routines/schedules/triggers, webhook + scheduler, Meridian read + run-request intents
```

## Layout

- `src/server.ts` — Bun server, sessions + chat history in SQLite, static UI, automation REST + SSE + webhook ingress, 30s scheduler
- `src/brain.ts` — intent dispatch, reply cards, confirmations, routines, photo/OCR replies, unattended routine runs
- `src/automation.ts` — routines/schedules/triggers storage, schedule parser + next-run math, webhook event matching, run history, SSE fan-out
- `src/meridian.ts` — Meridian HTTP client: recon reads + run-request router calls
- `src/recon_runs.ts` — pending Meridian run-request store (workspace-pinned)
- `src/hookauth.ts` — shared `X-Milton-Secret` verification for webhook ingress
- `src/intents.ts` — deterministic NL parser (dates, money, stages, commands)
- `src/crm.ts` — exec-crm HTTP client + fuzzy entity resolution
- `src/ocr.ts` — zero-dependency OCR: PNG/JPEG decoders, binarization, segmentation, template matching, handwriting metrics
- `public/` — chat UI (no build step, no dependencies)
