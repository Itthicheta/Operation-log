# Operation Log — project instructions

This project shares a Supabase project with the MamaPook Marketing system, but they are
strictly separated by schema. Read this before doing anything.

## Database

- Supabase project: **Marketing** (`qtpwrwapbefczvqdfzes`, ap-southeast-1)
- This project owns **ONLY the `operation_log` schema**. Create every table, view, and
  function inside `operation_log.*`.

## Hard boundaries — never violate

1. NEVER read, modify, or drop anything in schemas `raw`, `core`, `marts`, `ops`, or
   `public` — those belong to the Marketing system.
2. NEVER touch pg_cron jobs prefixed `marketing-*`. Prefix any new cron jobs `oplog-`.
3. NEVER change project-level settings (API exposed schemas, auth config) without
   asking the owner — they are shared with the Marketing system.
4. Enable RLS on every new table (`alter table ... enable row level security`), matching
   the project convention: public keys get no access unless a policy deliberately grants it.
5. Prefix any Edge Functions `oplog-` and storage buckets `oplog-`.
6. Keep this project's migrations in this repo under `supabase/migrations/` — they must
   only ever contain `operation_log.*` objects.

## Conventions

- Maintain a HANDOFF.md in this repo the same way the Marketing repo does: current state,
  blocked-on-owner list, append-only change log. Update it with every change.
