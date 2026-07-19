-- Comments on items + creator editing.
--
-- 1. operation_log.item_comments: append-only comment thread on any item,
--    visible to whoever can see the item; commenting allowed only while the
--    item is still active (closed items stay frozen, comments included).
-- 2. Profiles become readable by all authenticated users (display names only
--    ever contain the manager's name and branch names) so comments can show
--    the author's name on both sides.
-- 3. Edit rule relaxed: the creator may edit title/details/deadline until the
--    item is closed (previously only while it was still 'open').

create table operation_log.item_comments (
  id         bigint generated always as identity primary key,
  item_id    uuid not null references operation_log.items (id) on delete cascade,
  author     uuid not null default auth.uid() references operation_log.profiles (user_id),
  body       text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index item_comments_item_idx on operation_log.item_comments (item_id);

alter table operation_log.item_comments enable row level security;

-- Visibility mirrors item visibility (subquery runs under the caller's items RLS).
create policy item_comments_select on operation_log.item_comments
  for select to authenticated
  using (
    exists (select 1 from operation_log.items i where i.id = item_comments.item_id)
  );

create policy item_comments_insert on operation_log.item_comments
  for insert to authenticated
  with check (
    author = auth.uid()
    and exists (
      select 1 from operation_log.items i
      where i.id = item_comments.item_id and i.status <> 'closed'
    )
  );

grant select, insert on operation_log.item_comments to authenticated;

-- Display names are needed on both sides to label comments.
drop policy profiles_select on operation_log.profiles;
create policy profiles_select on operation_log.profiles
  for select to authenticated
  using (true);

-- Relax the content-edit rule: creator may edit until the item is closed.
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
    if uid <> old.created_by then
      raise exception 'only the creator can edit an item';
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
    elsif old.status = 'open' and new.status = 'closed' then
      -- manager closes an open problem directly (verified herself)
      if old.kind = 'problem' and r = 'area_manager' then
        new.closed_at := now();
        new.closed_by := uid;
      else
        raise exception 'not allowed to close this item';
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
      -- verifying side rejects
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
