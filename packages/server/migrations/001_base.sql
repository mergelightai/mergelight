-- Every table holds an org_id, and the database itself refuses rows of another org.
-- The server names the org once per request, from GitHub's signed token, with
--   select set_config('mergelight.org_id', '<id>', true)
-- inside a transaction. A query that forgets it sees no rows at all.

create function current_org() returns bigint
  language sql stable
  as $$ select nullif(current_setting('mergelight.org_id', true), '')::bigint $$;

-- An org that turned the dashboard on. The id is GitHub's own number for the account,
-- because a name can be given up and taken by someone else.
create table orgs (
  id bigint primary key,
  login text not null,
  connected_at timestamptz not null default now()
);

-- The key holds the org as well as GitHub's number for the repository. A repository that moves to
-- another account then starts fresh there, and the account it left keeps its own history.
create table repos (
  org_id bigint not null references orgs (id) on delete cascade,
  id bigint not null,
  name text not null,
  first_seen_at timestamptz not null default now(),
  last_review_at timestamptz,
  primary key (org_id, id)
);

-- One row per review run. Numbers only: no code, no finding text, no file paths.
create table reviews (
  id bigint generated always as identity primary key,
  org_id bigint not null references orgs (id) on delete cascade,
  repo_id bigint not null,
  -- GitHub's run, from the signed token, and the review program's own id for this report. Together
  -- they are the row's key: a second try of the same report can't count twice, while two review jobs
  -- in one run each get their row.
  run_id bigint not null,
  run_attempt integer not null,
  report_id uuid not null,
  pr integer not null,
  sha text not null,
  light text not null check (light in ('green', 'yellow', 'red')),
  bugs integer not null,
  risks integer not null,
  hardening integer not null,
  major integer not null,
  -- Findings per tier, as the review sorted them: its top picks, the rest worth fixing, and those for
  -- a human to decide. Not the number of comments posted, which can be lower.
  tier_post integer not null,
  tier_list integer not null,
  tier_decision integer not null,
  provider text not null check (provider in ('codex', 'claude')),
  model text,
  verifier text check (verifier in ('codex', 'claude')),
  duration_ms integer not null,
  files_changed integer not null,
  additions integer not null,
  deletions integer not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, repo_id) references repos (org_id, id) on delete cascade,
  unique (org_id, repo_id, run_id, run_attempt, report_id)
);
create index reviews_org_time on reviews (org_id, created_at desc);
create index reviews_repo_pr on reviews (org_id, repo_id, pr);

-- "force" makes the rules hold for the table's owner too, which is the role the server signs in as.
alter table orgs enable row level security;
alter table orgs force row level security;
create policy own_org on orgs using (id = current_org()) with check (id = current_org());

alter table repos enable row level security;
alter table repos force row level security;
create policy own_org on repos using (org_id = current_org()) with check (org_id = current_org());

alter table reviews enable row level security;
alter table reviews force row level security;
create policy own_org on reviews using (org_id = current_org()) with check (org_id = current_org());
