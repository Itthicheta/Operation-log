-- Allow the area manager to close a problem directly from 'open' (without the
-- branch ticking it first) — e.g. she verified it herself on a visit, or the
-- task is no longer needed. Requested by the owner for the task-window flow:
-- an on-going task's window shows a "Solved" button.
--
-- Everything else in the transition rules is unchanged.

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
    elsif old.status = 'open' and new.status = 'closed' then
      -- NEW: manager closes an open problem directly (verified herself)
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
