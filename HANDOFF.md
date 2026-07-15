# Operation Log — handoff

## Current state (2026-07-15)

**The app is live:** https://qtpwrwapbefczvqdfzes.supabase.co/functions/v1/oplog-app
(short link for sharing with branches: https://bit.ly/3STWZWi)

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
| Web app + API | Edge function `oplog-app` (`supabase/functions/oplog-app/index.ts`), verify_jwt off — it serves the public login page and enforces bearer-token auth itself on every data endpoint |
| Auth | Supabase Auth email/password users, mapped to roles via `operation_log.profiles` |

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
