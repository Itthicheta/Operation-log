-- Tighten deletion: once the other side has acted (branch ticked a task /
-- manager provided a request), the item can no longer be deleted — it must
-- finish its flow (Solved/Completed) or be sent back. Delete is now only for
-- items still in their first phase ('open').

drop policy items_delete on operation_log.items;
create policy items_delete on operation_log.items
  for delete to authenticated
  using (created_by = auth.uid() and status = 'open');
