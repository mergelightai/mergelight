-- What an org pays for: one row per org, written from the payment company's messages.
--
-- It is a table of its own, with no link to orgs. Deleting an org's data on the dashboard removes
-- orgs and everything that hangs from it, and a running subscription must not go with it: the org
-- would keep paying for a plan this server had forgotten.
--
-- No row means the org pays for nothing. The operator can still give an org the dashboard
-- (CONNECT_ORGS) or Jobs (JOBS_ORGS) for free; those grants live in the server's settings, not here.

create table billing (
  org_id bigint primary key,
  provider text not null check (provider in ('paddle')),
  -- The payment company's own ids, to change seats or open its customer portal.
  customer_id text,
  subscription_id text unique,
  plan text not null check (plan in ('light', 'pro')),
  -- The number of developers the buyer pays for.
  seats integer not null check (seats between 1 and 10000),
  -- The payment company's words for the subscription. Only some of them keep a plan working: see plan.ts.
  status text not null check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled')),
  current_period_end timestamptz,
  -- When the payment company wrote the message this row came from. Its messages can arrive out of
  -- order, so an older one that comes late changes nothing.
  event_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table billing enable row level security;
alter table billing force row level security;
create policy own_org on billing using (org_id = current_org()) with check (org_id = current_org());
