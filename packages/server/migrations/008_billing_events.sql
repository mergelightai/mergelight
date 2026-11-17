-- The payment company's messages this server has taken in, by their id. It sends a message again
-- when it isn't sure the first one arrived, so a message seen before is dropped.
--
-- A message isn't one org's, so this table has no org_id. Only a transaction that says it is taking
-- in a payment message (mergelight.billing) can see or write it, and the server sets that only after
-- the message's signature checked out (billing.ts).

create table billing_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

alter table billing_events enable row level security;
alter table billing_events force row level security;
create policy billing_only on billing_events
  using (current_setting('mergelight.billing', true) = 'on')
  with check (current_setting('mergelight.billing', true) = 'on');
