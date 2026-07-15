-- Operation Log — initial schema
-- Everything lives in the operation_log schema (shared Supabase project with the
-- Marketing system; see CLAUDE.md for the boundary rules).
--
-- Model: two-way checklist between the area manager and branches.
--   kind = 'problem'  : area manager -> branch  (manager spots it, branch fixes+ticks,
--                       manager verifies+closes => "Solved")
--   kind = 'request'  : branch -> area manager  (branch asks, manager provides+ticks,
--                       branch confirms+closes => "Completed")
-- Shared status flow for both kinds: open -> done -> closed (done can revert to open
-- when the verifying side rejects). Which role may perform each transition is
-- enforced by the items_before_update trigger below.

create schema if not exists operation_log;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table operation_log.branches (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table operation_log.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('area_manager', 'branch')),
  branch_id    uuid references operation_log.branches (id),
  display_name text not null,
  created_at   timestamptz not null default now(),
  constraint branch_role_needs_branch check (
    (role = 'branch' and branch_id is not null)
    or (role = 'area_manager' and branch_id is null)
  )
);

create table operation_log.items (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('problem', 'request')),
  branch_id  uuid not null references operation_log.branches (id),
  title      text not null check (length(trim(title)) > 0),
  details    text,
  deadline   date,
  status     text not null default 'open' check (status in ('open', 'done', 'closed')),
  created_by uuid not null default auth.uid() references operation_log.profiles (user_id),
  created_at timestamptz not null default now(),
  done_at    timestamptz,
  done_by    uuid references operation_log.profiles (user_id),
  closed_at  timestamptz,
  closed_by  uuid references operation_log.profiles (user_id),
  updated_at timestamptz not null default now()
);

create index items_branch_kind_status_idx on operation_log.items (branch_id, kind, status);

create table operation_log.item_events (
  id         bigint generated always as identity primary key,
  item_id    uuid not null references operation_log.items (id) on delete cascade,
  actor      uuid,
  action     text not null,
  note       text,
  created_at timestamptz not null default now()
);

create index item_events_item_idx on operation_log.item_events (item_id);

-- ---------------------------------------------------------------------------
-- Helpers (security definer so RLS policies can look up the caller's profile
-- without recursing into the profiles policies)
-- ---------------------------------------------------------------------------

create or replace function operation_log.my_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select role from operation_log.profiles where user_id = auth.uid()
$$;

create or replace function operation_log.my_branch()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select branch_id from operation_log.profiles where user_id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Transition + audit triggers
-- ---------------------------------------------------------------------------

create or replace function operation_log.items_before_update()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  r   text := operation_log.my_role();
  b   uuid := operation_log.my_branch();
begin
  -- No JWT context => direct admin/maintenance access; leave it alone.
  if uid is null then
    new.updated_at := now();
    return new;
  end if;

  if new.id is distinct from old.id
     or new.kind is distinct from old.kind
     or new.branch_id is distinct from old.branch_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'id, kind, branch and creator are immutable';
  end if;

  if old.status = 'closed' then
    raise exception 'closed items are read-only';
  end if;

  if (new.title, new.details, new.deadline)
     is distinct from (old.title, old.details, old.deadline) then
    if old.status <> 'open' or uid <> old.created_by then
      raise exception 'only the creator can edit an item, and only while it is open';
    end if;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'open' and new.status = 'done' then
      -- problem: branch ticks "we fixed it" / request: manager ticks "provided"
      if (old.kind = 'problem' and r = 'branch' and b = old.branch_id)
         or (old.kind = 'request' and r = 'area_manager') then
        new.done_at := now();
        new.done_by := uid;
      else
        raise exception 'not allowed to mark this item as done';
      end if;
    elsif old.status = 'done' and new.status = 'closed' then
      -- problem: manager verifies "solved" / request: branch confirms "received"
      if (old.kind = 'problem' and r = 'area_manager')
         or (old.kind = 'request' and r = 'branch' and b = old.branch_id) then
        new.closed_at := now();
        new.closed_by := uid;
      else
        raise exception 'not allowed to close this item';
      end if;
    elsif old.status = 'done' and new.status = 'open' then
      -- verifying side rejects: manager says "not actually fixed" /
      -- branch says "we did not receive it"
      if (old.kind = 'problem' and r = 'area_manager')
         or (old.kind = 'request' and r = 'branch' and b = old.branch_id) then
        new.done_at := null;
        new.done_by := null;
      else
        raise exception 'not allowed to reopen this item';
      end if;
    else
      raise exception 'invalid status transition: % -> %', old.status, new.status;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger items_before_update
before update on operation_log.items
for each row execute function operation_log.items_before_update();

create or replace function operation_log.items_log_event()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into operation_log.item_events (item_id, actor, action)
    values (new.id, coalesce(auth.uid(), new.created_by), 'created');
  elsif new.status is distinct from old.status then
    insert into operation_log.item_events (item_id, actor, action)
    values (
      new.id,
      auth.uid(),
      case
        when new.status = 'done'   then 'marked_done'
        when new.status = 'closed' then 'closed'
        when new.status = 'open'   then 'reopened'
      end
    );
  end if;
  return null;
end;
$$;

create trigger items_log_event
after insert or update on operation_log.items
for each row execute function operation_log.items_log_event();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table operation_log.branches    enable row level security;
alter table operation_log.profiles    enable row level security;
alter table operation_log.items       enable row level security;
alter table operation_log.item_events enable row level security;

create policy profiles_select on operation_log.profiles
  for select to authenticated
  using (user_id = auth.uid() or operation_log.my_role() = 'area_manager');

create policy branches_select on operation_log.branches
  for select to authenticated
  using (
    operation_log.my_role() = 'area_manager'
    or id = operation_log.my_branch()
  );

create policy items_select on operation_log.items
  for select to authenticated
  using (
    operation_log.my_role() = 'area_manager'
    or branch_id = operation_log.my_branch()
  );

create policy items_insert_manager on operation_log.items
  for insert to authenticated
  with check (
    operation_log.my_role() = 'area_manager'
    and kind = 'problem'
    and created_by = auth.uid()
  );

create policy items_insert_branch on operation_log.items
  for insert to authenticated
  with check (
    operation_log.my_role() = 'branch'
    and kind = 'request'
    and branch_id = operation_log.my_branch()
    and created_by = auth.uid()
  );

-- Which updates are legal is enforced by the items_before_update trigger.
create policy items_update on operation_log.items
  for update to authenticated
  using (
    operation_log.my_role() = 'area_manager'
    or branch_id = operation_log.my_branch()
  );

-- Event visibility mirrors item visibility (the subquery runs under the
-- caller's items RLS). Inserts happen only via the security-definer trigger.
create policy item_events_select on operation_log.item_events
  for select to authenticated
  using (
    exists (select 1 from operation_log.items i where i.id = item_events.item_id)
  );

-- ---------------------------------------------------------------------------
-- Grants (schema is NOT exposed via the API; access goes through the oplog-app
-- edge function, which runs statements under `set local role authenticated`
-- with request.jwt.claims set, so RLS above applies exactly as with PostgREST)
-- ---------------------------------------------------------------------------

grant usage on schema operation_log to authenticated;
grant select                         on operation_log.branches    to authenticated;
grant select                         on operation_log.profiles    to authenticated;
grant select, insert, update         on operation_log.items       to authenticated;
grant select                         on operation_log.item_events to authenticated;
grant execute on function operation_log.my_role()   to authenticated;
grant execute on function operation_log.my_branch() to authenticated;
