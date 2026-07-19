-- Allow the creator of an item to delete it while it is still active.
-- Closed items are frozen history and can never be deleted. Deleting an item
-- cascades to its events and comments (both FKs are on delete cascade).

create policy items_delete on operation_log.items
  for delete to authenticated
  using (created_by = auth.uid() and status <> 'closed');

grant delete on operation_log.items to authenticated;
