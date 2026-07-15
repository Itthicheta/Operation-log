# Operation Log — handoff

## Current state (2026-07-15)

**Frontend:** static single page in `web/index.html`, to be hosted on **Cloudflare
Pages** connected to this GitHub repo (expected URL: https://mamapook-oplog.pages.dev —
if the Pages project ends up with a different name, update `FRONTEND_URL` in the edge
function and the Bitly link). Short link for sharing with branches:
https://bit.ly/3STWZWi (points at the edge function, which 302-redirects to the
frontend, so it keeps working).

**Login** is standard Supabase Auth done client-side with supabase-js
(signInWithPassword / updateUser / signOut); the publishable key
`sb_publishable_qd7z…` is embedded in the page (public by design).

First-time setup has NOT been done yet — the first person to open the URL will be asked
to create the **area manager account** (name, email, password). After logging in, the
manager adds branches in the "Branches" tab; each branch gets one shared login
(email + password) that the manager creates and shares with them.

### What it does

Two-way checklist between the area manager and branches:

- **Problems** (manager → branch): manager posts a problem with an optional deadline;
  the branch ticks "Done"; the manager re-checks on the next visit and either marks it
  **Solved** (goes to the Solved log) or sends it back.
- **Requests** (branch → manager): branch asks for something; manager ticks "Provided";
  branch confirms "Received" → **Completed** log (or "Not received" to send it back).

Both sides must tick before anything closes. Nothing is deleted — closed items stay in
the logs, and every status change is recorded in an append-only audit table.

Logins: one **area manager** account; one **shared login per branch**. Each branch sees
only its own items; the manager sees everything.

### Components

| Piece | Where |
|---|---|
| Database schema | `operation_log.*` only: `branches`, `profiles`, `items`, `item_events` + RLS policies and transition triggers |
| Migration | `supabase/migrations/20260715120000_init_operation_log.sql` (applied 2026-07-15) |
| Frontend | `web/index.html` — static page for Cloudflare Pages; supabase-js for auth, calls the API with the session bearer token |
| API | Edge function `oplog-app` (`supabase/functions/oplog-app/index.ts`), JSON only + CORS; verify_jwt off because the two setup endpoints must work before any account exists — every other endpoint validates the bearer token itself |
| Auth | Supabase Auth email/password users (client-side supabase-js), mapped to roles via `operation_log.profiles` |

### How access control works (important for future changes)

The `operation_log` schema is **not** exposed to the Supabase API. The edge function
connects to Postgres directly (`SUPABASE_DB_URL`) and runs every user query inside a
transaction with `set local role authenticated` + `request.jwt.claims` set to the
caller's user id — so the RLS policies and the `items_before_update` trigger in the
database are the real security layer (verified with a 20-assertion SQL test on
2026-07-15: role restrictions, cross-branch invisibility, status transitions, closed
items read-only, audit trail).

Status model, same for both kinds: `open → done → closed` (with `done → open` when the
verifying side rejects). Who may perform which transition is enforced by the trigger,
per kind and role.

## Blocked on owner

Nothing is blocking right now. Optional, only if ever wanted:

- **Direct browser → database access** (e.g. a future SPA without the edge function, or
  realtime subscriptions): add `operation_log` to Settings → API → Exposed schemas in
  the Supabase dashboard. Not needed for the current app.
- **`pg_net` extension**: not installed; was not installed by this project (shared
  infrastructure — owner's call). Not needed for the current app.

## Boundaries respected

Everything created lives in the `operation_log` schema, plus Supabase Auth users
(created via the app's admin API at runtime) and the `oplog-app` edge function. No
`raw`/`core`/`marts`/`ops`/`public` objects, no cron jobs, no project-level settings
were touched. See `CLAUDE.md` for the rules.

## Change log (append-only)

- **2026-07-15** — Initial build. Applied migration `init_operation_log` (schema:
  `branches`, `profiles`, `items`, `item_events`; RLS; transition + audit triggers).
  Deployed edge function `oplog-app` v1 (login, first-time setup, manager/branch views,
  branch admin, password change). Ran 20-assertion RLS/trigger test suite (all passed,
  test data rolled back/cleaned). Created Bitly short link https://bit.ly/3STWZWi.
  First-time setup (creating the real manager account) left for the owner.
- **2026-07-15 (later)** — Owner reported the function-served HTML displayed as raw
  code in their browser and asked for Cloudflare hosting + client-side Supabase Auth.
  Split the app: frontend moved to `web/index.html` (static, for Cloudflare Pages;
  supabase-js auth), edge function `oplog-app` v2 is now JSON-API-only with CORS and
  302-redirects browser visits to the frontend. Owner still needs to: connect the repo
  to Cloudflare Pages (project name `mamapook-oplog`, output dir `web`), then do
  first-time setup in the app.
