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

**Accounts are pre-created — there is NO self-service sign-up on the web.** People log
in with just their **name** (the page appends `@mamapook.local` to make the account
email; typing a full email also works). Pre-created accounts (2026-07-15):

- Area manager: `mamapook`
- Branches: `Rama9`, `Gaysorn`, `Silom`, `OCC`, `SSQ`, `ASP`

Passwords are held by the owner and were shared out of band — deliberately NOT stored in
this repo. To add/remove a branch or reset a password later, do it on the backend (seed
SQL against `auth.users` + `auth.identities` + `operation_log.profiles`, same pattern as
the 2026-07-15 seed) — the manager can also change their own password in-app. The
"Branches" tab is now a read-only list.

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
  302-redirects browser visits to the frontend.
- **2026-07-15 (later)** — Cloudflare hosting sorted out: merged the branch into `main`,
  added `wrangler.jsonc` (static assets = `./web`, project name `operation-oplog`).
  Cloudflare Workers Builds now serves the site from `main`. NOTE: the live URL is a
  `*.workers.dev` under project `operation-oplog`, not the `mamapook-oplog.pages.dev`
  guessed earlier — `FRONTEND_URL` in the edge function and the Bitly link still need to
  be pointed at the real URL once confirmed.
- **2026-07-15 (later)** — Switched to pre-created accounts (owner's request: no
  self-service sign-up). Seeded 1 area manager (`mamapook`) + 6 branches (`Rama9`,
  `Gaysorn`, `Silom`, `OCC`, `SSQ`, `ASP`) directly into `auth.users` +
  `auth.identities` + `operation_log.profiles` (bcrypt via `crypt`/`gen_salt`; all
  password hashes verified). Removed the manually-created test manager
  (`mamapook@gmail.com`). Frontend: removed the first-time-setup screen and the branch
  create form; login now takes a plain name (appends `@mamapook.local`); Branches tab is
  read-only. `/api/setup` and `/api/branches` endpoints remain in the edge function but
  are no longer reachable from the UI.
- **2026-07-16** — Manager-flow redesign + i18n (owner's spec). Frontend: add-task is
  now a button opening a modal (deadline pre-filled with today); manager's task list got
  per-branch tab pills with ongoing counts (All first) and All/Done/On-going status tabs;
  task cards show green Done / yellow On-going chips; Done cards have a ✓ button opening
  a window with Solved (with Yes/No confirm) and Recheck (back to on-going); On-going
  cards open a window with Solved; all windows have an ✕ close. Whole app is now
  bilingual with a TH/EN toggle (Thai default, stored in localStorage). Migration
  `allow_manager_close_open_problem`: manager may close a problem directly from open
  (branch still cannot) — verified with a rollback SQL test against the real roles.
- **2026-07-16** — Branch requests tab now mirrors the tasks-for-branches format:
  branch tab pills with ongoing counts, All / Needs-you / Provided status tabs,
  clickable cards opening a window ("Provided ✓" action for open requests; provided
  ones are info-only awaiting branch confirmation), completed log below. The old
  branch dropdown filter was removed.
- **2026-07-16** — Branches tab is now a monthly dashboard: month dropdown (defaults to
  current month, filters by item creation date, Thai/English month names via
  toLocaleDateString), per-branch stat tables (tasks + requests × on-going/done/total,
  where done = closed), and a grouped bar chart of monthly totals per branch (tasks
  `#2a78d6`, requests `#008300` — CVD-validated pair; inline SVG, hover tooltips).
  Verified with a mock-data screenshot at phone width.
- **2026-07-16** — Branch side now mirrors the manager format. "From area manager":
  status tabs All/To-do/Done with counts, clickable cards (✓ on to-do items), task
  window with Done ✓ (Yes/No confirm — it's irreversible for the branch) or a
  waiting-for-check note. "Our requests": "+ Add request" modal (needed-by pre-filled
  today), status tabs All/Waiting/Provided, provided cards open a window with
  Received ✓ (confirm) / Not received (sends back). Old inline forms/sections removed;
  verified with mock-data screenshots of both tabs.
- **2026-07-16** — Work schedule (ตารางงาน). New `operation_log.events` table
  (migration `events`): manager-assigned events per branch with fixed categories
  (marketing, preorder, event, repair, pest, other), date, and active/canceled status
  (cancel keeps the row as history; trigger restricts changes to the manager). Edge
  function v3: events included in /api/data, POST /api/events (create), POST
  /api/events/:id/cancel. Frontend: ตารางงาน tab for both roles (manager: after
  requests; branch: after จากผู้จัดการเขต) with month dropdown (current month default),
  calendar/row view tabs, multi-select category filter pills (All first), manager-only
  branch pills + add-event modal + cancel-with-confirm (in event/day windows).
  Category colors are a CVD-validated 6-set (marketing #2a78d6, preorder #008300,
  event #e87ba4, repair #eda100, pest #4a3aa7, other #1baf7a) always paired with the
  category name in text. Verified with mock-data screenshots of both views.
- **2026-07-16** — Comments + editing (owner-approved plan). New
  `operation_log.item_comments` table (append-only; visibility mirrors the item;
  commenting blocked once the item is closed). Profiles select policy widened to all
  authenticated users so comment authors' display names render on both sides. Items
  trigger relaxed: creator may edit title/details/deadline until the item closes
  (previously only while open). Edge function v4: comments in /api/data, POST
  /api/items/:id/comments, POST /api/items/:id/edit. Frontend: every task/request
  window has a named comment thread + input (both roles); manager gets an Edit button
  on her tasks (any active status), branch gets Edit on its own still-waiting
  requests; cards show a 💬 count badge. Verified with a mock-data screenshot.
