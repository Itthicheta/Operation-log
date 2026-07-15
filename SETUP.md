# One-time setup for the Operation Log project (5 minutes)

1. Create a new GitHub repository, e.g. `Itthicheta/operation-log`.
2. Copy `CLAUDE.md` from this folder into the repo root (this is the guardrail —
   every Claude Code session in that repo reads it automatically).
3. Start a new Claude Code session **selecting the operation-log repo** (not Marketing).
   That session will only see that repo's files and will follow CLAUDE.md's schema
   boundary. Tell it what the Operation Log should do, and it builds inside the
   `operation_log` schema, which already exists in Supabase.
4. If the Operation Log ever gets its own web app reading Supabase directly from a
   browser, add `operation_log` to Settings → API → Exposed schemas in the Supabase
   dashboard (one checkbox — not needed until then).
