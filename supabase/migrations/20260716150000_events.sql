-- Work schedule (ตารางงาน): events assigned by the area manager to branches.
-- Categories are a fixed list; the manager creates and cancels events, branches
-- see only their own. Canceled events stay in the table as history (the UI
-- shows active ones only).

create table operation_log.events (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references operation_log.branches (id),
  category    text not null check (category in
                ('marketing', 'preorder', 'event', 'repair', 'pest', 'other')),
  title       text not null check (length(trim(title)) > 0),
  details     text,
  event_date  date not null,
  status      text not null default 'active' check (status in ('active', 'canceled')),
  created_by  uuid not null default auth.uid() references operation_log.profiles (user_id),
  created_at  timestamptz not null default now(),
  canceled_at timestamptz,
  canceled_by uuid references operation_log.profiles (user_id)
);

create index events_date_idx on operation_log.events (event_date);
create index events_branch_idx on operation_log.events (branch_id);

create or replace function operation_log.events_before_update()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  -- No JWT context => direct admin/maintenance access.
  if uid is null then
    return new;
  end if;
  if operation_log.my_role() <> 'area_manager' then
    raise exception 'only the area manager can change events';
  end if;
  if new.id is distinct from old.id
     or new.branch_id is distinct from old.branch_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'immutable field';
  end if;
  if old.status = 'canceled' then
    raise exception 'canceled events are read-only';
  end if;
  if new.status = 'canceled' then
    new.canceled_at := now();
    new.canceled_by := uid;
  end if;
  return new;
end;
$$;

create trigger events_before_update
before update on operation_log.events
for each row execute function operation_log.events_before_update();

alter table operation_log.events enable row level security;

create policy events_select on operation_log.events
  for select to authenticated
  using (
    operation_log.my_role() = 'area_manager'
    or branch_id = operation_log.my_branch()
  );

create policy events_insert on operation_log.events
  for insert to authenticated
  with check (
    operation_log.my_role() = 'area_manager'
    and created_by = auth.uid()
  );

create policy events_update on operation_log.events
  for update to authenticated
  using (operation_log.my_role() = 'area_manager');

grant select, insert, update on operation_log.events to authenticated;
