// oplog-app — Operation Log web app + API (single edge function)
//
// Serves the SPA at GET / and a JSON API under /api/*. The operation_log schema
// is NOT exposed through PostgREST, so this function talks to Postgres directly
// (SUPABASE_DB_URL) and runs every user query inside a transaction with
// `set local role authenticated` + request.jwt.claims set to the caller's user
// id — i.e. the RLS policies and transition triggers in the operation_log
// schema are the security layer, exactly as if PostgREST served it.
//
// Auth: Supabase Auth (email/password). verify_jwt is disabled so the HTML and
// login endpoint are reachable; every data endpoint validates the bearer token
// via the Auth API before touching the database.

import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;

const sql = postgres(DB_URL, { prepare: false });
const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// deno-lint-ignore no-explicit-any
type Json = any;

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

  // --- public endpoints ------------------------------------------------------

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

  if (method === "POST" && path === "/api/login") {
    const { email, password } = await req.json();
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) return json({ error: "Wrong email or password." }, 401);
    const profile = await getProfile(data.session.user.id);
    if (!profile) return json({ error: "This account has no Operation Log profile." }, 403);
    return json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      profile,
    });
  }

  if (method === "POST" && path === "/api/refresh") {
    const { refresh_token } = await req.json();
    const { data, error } = await anon.auth.refreshSession({ refresh_token });
    if (error || !data.session) return json({ error: "Session expired. Please log in again." }, 401);
    return json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
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
      return { branches, items };
    });
    return json({ profile, ...result });
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

  if (method === "POST" && path === "/api/password") {
    const { password } = await req.json();
    if (!password || password.length < 8) {
      return json({ error: "The new password must be at least 8 characters." }, 400);
    }
    const { error } = await admin.auth.admin.updateUserById(caller.id, { password });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
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
  try {
    if (path.startsWith("/api/")) return await handleApi(req, path);
    if (req.method === "GET") {
      return new Response(PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return json({ error: "Not found." }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Unexpected server error." }, 500);
  }
});

// ---------------------------------------------------------------------------
// Frontend (vanilla JS, no external dependencies). NOTE: the embedded script
// deliberately avoids backticks/template literals so it can live inside this
// TypeScript template string.
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operation Log</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --ink:#1c2733; --muted:#68737f; --line:#e3e7ec;
          --brand:#0f6b4f; --brand-ink:#fff; --warn:#b3261e; --amber:#8a6100; --chipbg:#eef1f4; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:var(--bg); color:var(--ink); font-size:16px; }
  .wrap { max-width:760px; margin:0 auto; padding:16px 12px 64px; }
  header.app { display:flex; align-items:center; justify-content:space-between; gap:8px;
               padding:14px 4px 10px; }
  header.app h1 { font-size:19px; margin:0; }
  header.app .who { font-size:13px; color:var(--muted); }
  .tabs { display:flex; gap:6px; margin:8px 0 16px; flex-wrap:wrap; }
  .tabs button { flex:1; min-width:130px; padding:10px 8px; border:1px solid var(--line);
                 background:var(--card); border-radius:10px; font-size:14px; cursor:pointer; }
  .tabs button.on { background:var(--brand); color:var(--brand-ink); border-color:var(--brand); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:14px; margin-bottom:10px; }
  .card h3 { margin:0 0 4px; font-size:16px; }
  .card .meta { font-size:13px; color:var(--muted); margin:2px 0 8px; }
  .card .details { font-size:14px; white-space:pre-wrap; margin:0 0 10px; }
  .chip { display:inline-block; font-size:12px; padding:3px 9px; border-radius:99px;
          background:var(--chipbg); color:var(--muted); margin-right:6px; }
  .chip.branch { background:#e7f0fb; color:#1a4e8a; }
  .chip.warn { background:#fdecea; color:var(--warn); font-weight:600; }
  .chip.amber { background:#fff3d6; color:var(--amber); font-weight:600; }
  .chip.ok { background:#e6f4ec; color:var(--brand); font-weight:600; }
  .sec { margin:22px 0 8px; font-size:14px; font-weight:700; color:var(--muted);
         text-transform:uppercase; letter-spacing:.04em; }
  .btn { display:inline-block; padding:10px 16px; border-radius:10px; border:1px solid var(--line);
         background:var(--card); font-size:15px; cursor:pointer; }
  .btn.primary { background:var(--brand); color:var(--brand-ink); border-color:var(--brand); }
  .btn.subtle { font-size:13px; padding:7px 12px; }
  .btn.danger { color:var(--warn); }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  form.panel { background:var(--card); border:1px solid var(--line); border-radius:12px;
               padding:14px; margin-bottom:16px; }
  form.panel label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  form.panel input, form.panel textarea, form.panel select {
    width:100%; padding:10px; border:1px solid var(--line); border-radius:8px;
    font-size:15px; font-family:inherit; background:#fff; color:var(--ink); }
  form.panel textarea { min-height:70px; }
  .login { max-width:380px; margin:10vh auto 0; }
  .login h1 { text-align:center; }
  .error { color:var(--warn); font-size:14px; margin:10px 0; min-height:18px; }
  .empty { color:var(--muted); font-size:14px; padding:8px 4px; }
  .filter { margin-bottom:12px; }
  .filter select { padding:8px 10px; border:1px solid var(--line); border-radius:8px;
                   font-size:14px; background:#fff; color:var(--ink); }
  details.log { margin-top:10px; }
  details.log summary { cursor:pointer; font-size:14px; color:var(--muted); padding:6px 2px; }
  .toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%);
           background:var(--ink); color:#fff; padding:10px 18px; border-radius:10px;
           font-size:14px; opacity:0; transition:opacity .25s; pointer-events:none; max-width:90vw; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
<div id="app" class="wrap"></div>
<div id="toast" class="toast"></div>
<script>
"use strict";
var BASE = location.pathname.replace(/\\/+$/, "");
var state = { profile: null, branches: [], items: [], tab: null, branchFilter: "all" };

function api(path, opts, retried) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  var tok = localStorage.getItem("oplog_access");
  if (tok) opts.headers["Authorization"] = "Bearer " + tok;
  if (opts.body) opts.headers["Content-Type"] = "application/json";
  return fetch(BASE + path, opts).then(function (res) {
    if (res.status === 401 && !retried) {
      return refresh().then(function (ok) {
        if (!ok) { logout(); throw new Error("Please log in again."); }
        return api(path, opts, true);
      });
    }
    return res.json().then(function (body) {
      if (!res.ok) throw new Error(body.error || "Request failed.");
      return body;
    });
  });
}

function refresh() {
  var rt = localStorage.getItem("oplog_refresh");
  if (!rt) return Promise.resolve(false);
  return fetch(BASE + "/api/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt })
  }).then(function (res) {
    if (!res.ok) return false;
    return res.json().then(function (b) {
      localStorage.setItem("oplog_access", b.access_token);
      localStorage.setItem("oplog_refresh", b.refresh_token);
      return true;
    });
  }).catch(function () { return false; });
}

function logout() {
  localStorage.removeItem("oplog_access");
  localStorage.removeItem("oplog_refresh");
  state.profile = null;
  renderLogin();
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function el(id) { return document.getElementById(id); }
function toast(msg) {
  var t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function () { t.classList.remove("show"); }, 2600);
}
function fmtDate(d) { return d ? String(d).substring(0, 10) : ""; }
function isOverdue(d) {
  if (!d) return false;
  return fmtDate(d) < new Date().toISOString().substring(0, 10);
}

// ---------------- login / setup ----------------

function renderLogin() {
  fetch(BASE + "/api/setup-status").then(function (r) { return r.json(); })
    .then(function (s) { s.needsSetup ? renderSetup() : renderLoginForm(); })
    .catch(function () { renderLoginForm(); });
}

function renderLoginForm() {
  el("app").innerHTML =
    '<div class="login">' +
    '<h1>Operation Log</h1>' +
    '<form class="panel" id="loginForm">' +
    '<label>Email</label><input id="email" type="email" autocomplete="username" required>' +
    '<label>Password</label><input id="pw" type="password" autocomplete="current-password" required>' +
    '<div class="error" id="err"></div>' +
    '<button class="btn primary" style="width:100%" type="submit">Log in</button>' +
    "</form></div>";
  el("loginForm").onsubmit = function (e) {
    e.preventDefault();
    fetch(BASE + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: el("email").value.trim(), password: el("pw").value })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { el("err").textContent = res.b.error || "Login failed."; return; }
        localStorage.setItem("oplog_access", res.b.access_token);
        localStorage.setItem("oplog_refresh", res.b.refresh_token);
        loadApp();
      })
      .catch(function () { el("err").textContent = "Network error."; });
  };
}

function renderSetup() {
  el("app").innerHTML =
    '<div class="login">' +
    "<h1>Operation Log</h1>" +
    '<p style="text-align:center;color:var(--muted);font-size:14px">First-time setup: create the area manager account.</p>' +
    '<form class="panel" id="setupForm">' +
    "<label>Your name</label><input id='name' required>" +
    "<label>Email</label><input id='email' type='email' required>" +
    "<label>Password (min 8 characters)</label><input id='pw' type='password' minlength='8' required>" +
    '<div class="error" id="err"></div>' +
    '<button class="btn primary" style="width:100%" type="submit">Create manager account</button>' +
    "</form></div>";
  el("setupForm").onsubmit = function (e) {
    e.preventDefault();
    fetch(BASE + "/api/setup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: el("name").value.trim(),
        email: el("email").value.trim(),
        password: el("pw").value
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { el("err").textContent = res.b.error || "Setup failed."; return; }
        toast("Account created. Please log in.");
        renderLoginForm();
      })
      .catch(function () { el("err").textContent = "Network error."; });
  };
}

// ---------------- app shell ----------------

function loadApp() {
  api("/api/data").then(function (d) {
    state.profile = d.profile;
    state.branches = d.branches;
    state.items = d.items;
    if (!state.tab) state.tab = state.profile.role === "area_manager" ? "problems" : "todo";
    renderApp();
  }).catch(function (e) {
    if (state.profile) toast(e.message); else renderLogin();
  });
}

function changePassword() {
  var pw = prompt("New password (min 8 characters):");
  if (!pw) return;
  api("/api/password", { method: "POST", body: JSON.stringify({ password: pw }) })
    .then(function () { toast("Password changed."); })
    .catch(function (e) { toast(e.message); });
}

function setStatus(id, status, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  api("/api/items/" + id + "/status", { method: "POST", body: JSON.stringify({ status: status }) })
    .then(function () { loadApp(); })
    .catch(function (e) { toast(e.message); });
}

function renderApp() {
  var p = state.profile;
  var isMgr = p.role === "area_manager";
  var tabs = isMgr
    ? [["problems", "Tasks for branches"], ["requests", "Branch requests"], ["branches", "Branches"]]
    : [["todo", "From area manager"], ["asks", "Our requests"]];
  var head =
    '<header class="app"><div><h1>Operation Log</h1>' +
    '<div class="who">' + esc(p.display_name) + (isMgr ? " · Area manager" : " · Branch") + "</div></div>" +
    '<div class="row">' +
    '<button class="btn subtle" id="pwBtn">Password</button>' +
    '<button class="btn subtle" id="outBtn">Log out</button>' +
    "</div></header>";
  var tabHtml = '<div class="tabs">' + tabs.map(function (t) {
    return '<button data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? "on" : "") + '">' + t[1] + "</button>";
  }).join("") + "</div>";
  var body = "";
  if (state.tab === "problems") body = viewMgrProblems();
  if (state.tab === "requests") body = viewMgrRequests();
  if (state.tab === "branches") body = viewMgrBranches();
  if (state.tab === "todo") body = viewBranchTodo();
  if (state.tab === "asks") body = viewBranchAsks();
  el("app").innerHTML = head + tabHtml + body;

  el("pwBtn").onclick = changePassword;
  el("outBtn").onclick = logout;
  Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (b) {
    b.onclick = function () { state.tab = b.getAttribute("data-tab"); renderApp(); };
  });
  bindHandlers();
}

// ---------------- shared card rendering ----------------

function card(item, actionsHtml, extraChips) {
  var chips = "";
  if (state.profile.role === "area_manager") {
    chips += '<span class="chip branch">' + esc(item.branch_name) + "</span>";
  }
  chips += extraChips || "";
  if (item.deadline && item.status === "open") {
    chips += '<span class="chip' + (isOverdue(item.deadline) ? " warn" : "") + '">Deadline ' +
      esc(fmtDate(item.deadline)) + (isOverdue(item.deadline) ? " — overdue" : "") + "</span>";
  }
  var dates = "Posted " + fmtDate(item.created_at);
  if (item.done_at) dates += " · ticked " + fmtDate(item.done_at);
  if (item.closed_at) dates += " · closed " + fmtDate(item.closed_at);
  return '<div class="card"><div>' + chips + "</div><h3>" + esc(item.title) + "</h3>" +
    (item.details ? '<p class="details">' + esc(item.details) + "</p>" : "") +
    '<div class="meta">' + dates + "</div>" +
    (actionsHtml ? '<div class="row">' + actionsHtml + "</div>" : "") +
    "</div>";
}

function actionBtn(item, status, label, cls, confirmMsg) {
  return '<button class="btn ' + (cls || "") + '" data-act="' + item.id + "|" + status +
    (confirmMsg ? "|" + esc(confirmMsg) : "") + '">' + label + "</button>";
}

function bindHandlers() {
  Array.prototype.forEach.call(document.querySelectorAll("[data-act]"), function (b) {
    b.onclick = function () {
      var parts = b.getAttribute("data-act").split("|");
      setStatus(parts[0], parts[1], parts[2]);
    };
  });
  var bf = el("branchFilter");
  if (bf) bf.onchange = function () { state.branchFilter = bf.value; renderApp(); };
  var f;
  if ((f = el("newProblem"))) f.onsubmit = submitNewProblem;
  if ((f = el("newRequest"))) f.onsubmit = submitNewRequest;
  if ((f = el("newBranch"))) f.onsubmit = submitNewBranch;
}

function filtered(kind) {
  return state.items.filter(function (i) {
    if (i.kind !== kind) return false;
    if (state.profile.role === "area_manager" && state.branchFilter !== "all" &&
        i.branch_id !== state.branchFilter) return false;
    return true;
  });
}

function branchFilterHtml() {
  if (state.profile.role !== "area_manager" || state.branches.length === 0) return "";
  return '<div class="filter"><select id="branchFilter">' +
    '<option value="all">All branches</option>' +
    state.branches.map(function (b) {
      return '<option value="' + b.id + '"' + (state.branchFilter === b.id ? " selected" : "") + ">" +
        esc(b.name) + "</option>";
    }).join("") + "</select></div>";
}

function section(title, items, renderOne) {
  return '<div class="sec">' + title + " (" + items.length + ")</div>" +
    (items.length ? items.map(renderOne).join("") : '<div class="empty">Nothing here.</div>');
}

function logSection(title, items, renderOne) {
  return '<details class="log"><summary>' + title + " (" + items.length + ")</summary>" +
    (items.length ? items.map(renderOne).join("") : '<div class="empty">Empty.</div>') +
    "</details>";
}

// ---------------- manager views ----------------

function viewMgrProblems() {
  var items = filtered("problem");
  var toCheck = items.filter(function (i) { return i.status === "done"; });
  var waiting = items.filter(function (i) { return i.status === "open"; });
  var solved = items.filter(function (i) { return i.status === "closed"; });
  var form =
    '<form class="panel" id="newProblem"><strong>Post a problem / task for a branch</strong>' +
    "<label>Branch</label><select id='pBranch' required>" +
    (state.branches.length ? "" : "<option value=''>— add a branch first —</option>") +
    state.branches.map(function (b) { return '<option value="' + b.id + '">' + esc(b.name) + "</option>"; }).join("") +
    "</select>" +
    "<label>What is the problem / what must be done?</label><input id='pTitle' required maxlength='200'>" +
    "<label>Details (optional)</label><textarea id='pDetails'></textarea>" +
    "<label>Deadline (optional)</label><input id='pDeadline' type='date'>" +
    '<div style="margin-top:12px"><button class="btn primary" type="submit">Post to branch</button></div>' +
    "</form>";
  return form + branchFilterHtml() +
    section("Branch ticked — re-check on your next visit", toCheck, function (i) {
      return card(i,
        actionBtn(i, "closed", "Passed — mark solved ✓", "primary") +
        actionBtn(i, "open", "Not fixed — send back", "danger"),
        '<span class="chip amber">Branch says done</span>');
    }) +
    section("Waiting on branch", waiting, function (i) {
      return card(i, "", '<span class="chip">Waiting</span>');
    }) +
    logSection("Solved log", solved, function (i) {
      return card(i, "", '<span class="chip ok">Solved</span>');
    });
}

function viewMgrRequests() {
  var items = filtered("request");
  var open = items.filter(function (i) { return i.status === "open"; });
  var provided = items.filter(function (i) { return i.status === "done"; });
  var closed = items.filter(function (i) { return i.status === "closed"; });
  return branchFilterHtml() +
    section("Branches are asking for", open, function (i) {
      return card(i, actionBtn(i, "done", "Provided ✓", "primary"),
        '<span class="chip amber">Needs you</span>');
    }) +
    section("Provided — waiting for branch to confirm", provided, function (i) {
      return card(i, "", '<span class="chip">Waiting for confirmation</span>');
    }) +
    logSection("Completed log", closed, function (i) {
      return card(i, "", '<span class="chip ok">Completed</span>');
    });
}

function viewMgrBranches() {
  var form =
    '<form class="panel" id="newBranch"><strong>Add a branch</strong>' +
    "<label>Branch name</label><input id='bName' required maxlength='100'>" +
    "<label>Login email for the branch (e.g. branchname@mamapook.local)</label>" +
    "<input id='bEmail' type='email' required>" +
    "<label>Password for the branch (min 8 characters — share it with the branch)</label>" +
    "<input id='bPw' type='text' minlength='8' required>" +
    '<div style="margin-top:12px"><button class="btn primary" type="submit">Create branch + login</button></div>' +
    "</form>";
  var list = state.branches.length
    ? state.branches.map(function (b) {
        var counts = state.items.filter(function (i) {
          return i.branch_id === b.id && i.status !== "closed";
        }).length;
        return '<div class="card"><h3>' + esc(b.name) + '</h3><div class="meta">' +
          counts + " active item(s)</div></div>";
      }).join("")
    : '<div class="empty">No branches yet — add the first one above.</div>';
  return form + '<div class="sec">Branches (' + state.branches.length + ")</div>" + list;
}

// ---------------- branch views ----------------

function viewBranchTodo() {
  var items = filtered("problem");
  var todo = items.filter(function (i) { return i.status === "open"; });
  var waiting = items.filter(function (i) { return i.status === "done"; });
  var solved = items.filter(function (i) { return i.status === "closed"; });
  return section("To do — from the area manager", todo, function (i) {
      return card(i, actionBtn(i, "done", "Done ✓", "primary"),
        '<span class="chip warn">To do</span>');
    }) +
    section("Ticked — waiting for the manager to check", waiting, function (i) {
      return card(i, "", '<span class="chip amber">Waiting for check</span>');
    }) +
    logSection("Solved log", solved, function (i) {
      return card(i, "", '<span class="chip ok">Solved</span>');
    });
}

function viewBranchAsks() {
  var items = filtered("request");
  var open = items.filter(function (i) { return i.status === "open"; });
  var provided = items.filter(function (i) { return i.status === "done"; });
  var closed = items.filter(function (i) { return i.status === "closed"; });
  var form =
    '<form class="panel" id="newRequest"><strong>Ask the area manager for something</strong>' +
    "<label>What do you need?</label><input id='rTitle' required maxlength='200'>" +
    "<label>Details (optional)</label><textarea id='rDetails'></textarea>" +
    "<label>Needed by (optional)</label><input id='rDeadline' type='date'>" +
    '<div style="margin-top:12px"><button class="btn primary" type="submit">Send request</button></div>' +
    "</form>";
  return form +
    section("Waiting for the area manager", open, function (i) {
      return card(i, "", '<span class="chip">Sent</span>');
    }) +
    section("Manager says provided — did you receive it?", provided, function (i) {
      return card(i,
        actionBtn(i, "closed", "Received ✓", "primary") +
        actionBtn(i, "open", "Not received", "danger"),
        '<span class="chip amber">Check</span>');
    }) +
    logSection("Completed log", closed, function (i) {
      return card(i, "", '<span class="chip ok">Completed</span>');
    });
}

// ---------------- form submits ----------------

function submitNewProblem(e) {
  e.preventDefault();
  api("/api/items", {
    method: "POST",
    body: JSON.stringify({
      kind: "problem",
      branch_id: el("pBranch").value,
      title: el("pTitle").value,
      details: el("pDetails").value,
      deadline: el("pDeadline").value || null
    })
  }).then(function () { toast("Posted to the branch."); loadApp(); })
    .catch(function (err) { toast(err.message); });
}

function submitNewRequest(e) {
  e.preventDefault();
  api("/api/items", {
    method: "POST",
    body: JSON.stringify({
      kind: "request",
      branch_id: state.profile.branch_id,
      title: el("rTitle").value,
      details: el("rDetails").value,
      deadline: el("rDeadline").value || null
    })
  }).then(function () { toast("Request sent."); loadApp(); })
    .catch(function (err) { toast(err.message); });
}

function submitNewBranch(e) {
  e.preventDefault();
  api("/api/branches", {
    method: "POST",
    body: JSON.stringify({
      name: el("bName").value,
      email: el("bEmail").value.trim(),
      password: el("bPw").value
    })
  }).then(function () { toast("Branch created."); loadApp(); })
    .catch(function (err) { toast(err.message); });
}

// ---------------- boot ----------------

if (localStorage.getItem("oplog_access")) loadApp();
else renderLogin();
</script>
</body>
</html>`;
