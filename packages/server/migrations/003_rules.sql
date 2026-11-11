-- The rules a team sets on the dashboard, and a log of who changed what.

-- rule: a line every review of the org, or of one repository, follows.
-- needs_human: files that never go green by themselves.
create table rules (
  id bigint generated always as identity primary key,
  org_id bigint not null references orgs (id) on delete cascade,
  -- Empty for a rule of the whole org.
  repo_id bigint,
  kind text not null check (kind in ('rule', 'needs_human')),
  text text not null,
  -- Patterns like "src/billing/**". None means everywhere.
  paths text[] not null default '{}',
  created_by text not null,
  created_by_id bigint not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, repo_id) references repos (org_id, id) on delete cascade
);
create index rules_org on rules (org_id, repo_id);

alter table rules enable row level security;
alter table rules force row level security;
create policy own_org on rules using (org_id = current_org()) with check (org_id = current_org());

-- Every change a person makes on the dashboard: who, when and what. Rows are only ever added.
create table audit_log (
  id bigint generated always as identity primary key,
  org_id bigint not null references orgs (id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null,
  actor_id bigint not null,
  action text not null,
  detail jsonb not null default '{}'
);
create index audit_org_time on audit_log (org_id, at desc);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy own_org_reads on audit_log for select using (org_id = current_org());
create policy own_org_adds on audit_log for insert with check (org_id = current_org());
