// oplog-app — Operation Log JSON API (edge function)
//
// The frontend is a static page hosted on Cloudflare Pages (see web/ in the
// repo); it authenticates with Supabase Auth directly via supabase-js and calls
// this API with the session's bearer token.
//
// The operation_log schema is NOT exposed through PostgREST, so this function
// talks to Postgres directly (SUPABASE_DB_URL) and runs every user query inside
// a transaction with `set local role authenticated` + request.jwt.claims set to
// the caller's user id — i.e. the RLS policies and transition triggers in the
// operation_log schema are the security layer, exactly as if PostgREST served it.
//
// verify_jwt is disabled because /api/setup-status and /api/setup must work
// before any account exists; every other endpoint validates the bearer token
// via the Auth API before touching the database.

import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const FRONTEND_URL = "https://mamapook-oplog.pages.dev";

const sql = postgres(DB_URL, { prepare: false });
const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// deno-lint-ignore no-explicit-any
type Json = any;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function getCaller(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id };
}

// Run fn inside a transaction impersonating the given auth user, so RLS and
// the auth.uid()-based triggers apply.
// deno-lint-ignore no-explicit-any
async function asUser<T>(uid: string, fn: (tx: any) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx: Json) => {
    const claims = JSON.stringify({ sub: uid, role: "authenticated" });
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`set local role authenticated`;
    return await fn(tx);
  });
}

async function getProfile(uid: string): Promise<Json | null> {
  const rows = await sql`
    select p.user_id, p.role, p.branch_id, p.display_name, b.name as branch_name
    from operation_log.profiles p
    left join operation_log.branches b on b.id = p.branch_id
    where p.user_id = ${uid}`;
  return rows[0] ?? null;
}

async function handleApi(req: Request, path: string): Promise<Response> {
  const method = req.method;

  // --- public endpoints (needed before any account exists) -------------------

  if (method === "GET" && path === "/api/setup-status") {
    const [{ n }] = await sql`
      select count(*)::int as n from operation_log.profiles where role = 'area_manager'`;
    return json({ needsSetup: n === 0 });
  }

  if (method === "POST" && path === "/api/setup") {
    const { email, password, name } = await req.json();
    if (!email || !password || password.length < 8) {
      return json({ error: "Email and a password of at least 8 characters are required." }, 400);
    }
    const [{ n }] = await sql`
      select count(*)::int as n from operation_log.profiles where role = 'area_manager'`;
    if (n > 0) return json({ error: "Setup has already been completed." }, 403);
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (error || !data.user) return json({ error: error?.message ?? "Could not create user." }, 400);
    try {
      await sql`
        insert into operation_log.profiles (user_id, role, display_name)
        values (${data.user.id}, 'area_manager', ${name || "Area manager"})`;
    } catch (e) {
      await admin.auth.admin.deleteUser(data.user.id);
      return json({ error: String(e) }, 500);
    }
    return json({ ok: true });
  }

  // --- authenticated endpoints ----------------------------------------------

  const caller = await getCaller(req);
  if (!caller) return json({ error: "Not logged in." }, 401);
  const profile = await getProfile(caller.id);
  if (!profile) return json({ error: "This account has no Operation Log profile." }, 403);

  if (method === "GET" && path === "/api/data") {
    const result = await asUser(caller.id, async (tx) => {
      const branches = await tx`
        select id, name from operation_log.branches order by name`;
      const items = await tx`
        select i.*, b.name as branch_name
        from operation_log.items i
        join operation_log.branches b on b.id = i.branch_id
        order by
          case i.status when 'done' then 0 when 'open' then 1 else 2 end,
          i.deadline nulls last, i.created_at desc`;
      const events = await tx`
        select e.*, b.name as branch_name
        from operation_log.events e
        join operation_log.branches b on b.id = e.branch_id
        order by e.event_date, e.created_at`;
      return { branches, items, events };
    });
    return json({ profile, ...result });
  }

  if (method === "POST" && path === "/api/events") {
    const { branch_id, category, title, details, event_date } = await req.json();
    if (!title?.trim()) return json({ error: "A title is required." }, 400);
    if (!event_date) return json({ error: "A date is required." }, 400);
    try {
      const rows = await asUser(caller.id, (tx) => tx`
        insert into operation_log.events (branch_id, category, title, details, event_date)
        values (${branch_id}, ${category}, ${title.trim()}, ${details || null}, ${event_date})
        returning *`);
      return json({ event: rows[0] });
    } catch (e) {
      return json({ error: pgError(e) }, 400);
    }
  }

  const cancelMatch = path.match(/^\/api\/events\/([0-9a-f-]{36})\/cancel$/);
  if (method === "POST" && cancelMatch) {
    try {
      const rows = await asUser(caller.id, (tx) => tx`
        update operation_log.events set status = 'canceled'
        where id = ${cancelMatch[1]}
        returning *`);
      if (rows.length === 0) return json({ error: "Event not found." }, 404);
      return json({ event: rows[0] });
    } catch (e) {
      return json({ error: pgError(e) }, 400);
    }
  }

  if (method === "POST" && path === "/api/items") {
    const { kind, branch_id, title, details, deadline } = await req.json();
    if (!title?.trim()) return json({ error: "A title is required." }, 400);
    try {
      const rows = await asUser(caller.id, (tx) => tx`
        insert into operation_log.items (kind, branch_id, title, details, deadline)
        values (${kind}, ${branch_id}, ${title.trim()}, ${details || null}, ${deadline || null})
        returning *`);
      return json({ item: rows[0] });
    } catch (e) {
      return json({ error: pgError(e) }, 400);
    }
  }

  const statusMatch = path.match(/^\/api\/items\/([0-9a-f-]{36})\/status$/);
  if (method === "POST" && statusMatch) {
    const { status } = await req.json();
    if (!["open", "done", "closed"].includes(status)) {
      return json({ error: "Invalid status." }, 400);
    }
    try {
      const rows = await asUser(caller.id, (tx) => tx`
        update operation_log.items set status = ${status}
        where id = ${statusMatch[1]}
        returning *`);
      if (rows.length === 0) return json({ error: "Item not found." }, 404);
      return json({ item: rows[0] });
    } catch (e) {
      return json({ error: pgError(e) }, 400);
    }
  }

  if (method === "POST" && path === "/api/branches") {
    if (profile.role !== "area_manager") return json({ error: "Managers only." }, 403);
    const { name, email, password } = await req.json();
    if (!name?.trim()) return json({ error: "A branch name is required." }, 400);
    if (!email || !password || password.length < 8) {
      return json({ error: "A login email and a password of at least 8 characters are required." }, 400);
    }
    const branchRows = await sql`
      insert into operation_log.branches (name) values (${name.trim()})
      on conflict (name) do nothing
      returning id`;
    if (branchRows.length === 0) return json({ error: "A branch with this name already exists." }, 400);
    const branchId = branchRows[0].id;
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (error || !data.user) {
      await sql`delete from operation_log.branches where id = ${branchId}`;
      return json({ error: error?.message ?? "Could not create the login." }, 400);
    }
    try {
      await sql`
        insert into operation_log.profiles (user_id, role, branch_id, display_name)
        values (${data.user.id}, 'branch', ${branchId}, ${name.trim()})`;
    } catch (e) {
      await admin.auth.admin.deleteUser(data.user.id);
      await sql`delete from operation_log.branches where id = ${branchId}`;
      return json({ error: String(e) }, 500);
    }
    return json({ ok: true, branch_id: branchId });
  }

  return json({ error: "Not found." }, 404);
}

// Surface the trigger's raise-exception message rather than a raw stack.
function pgError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^.*?ERROR:\s*/i, "").split("\n")[0] || "Database error.";
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/oplog-app/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (path.startsWith("/api/")) return await handleApi(req, path);
    // Anything else (e.g. someone opening the function URL in a browser):
    // send them to the real app.
    return new Response(null, {
      status: 302,
      headers: { Location: FRONTEND_URL, ...CORS },
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Unexpected server error." }, 500);
  }
});
