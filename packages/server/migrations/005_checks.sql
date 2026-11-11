-- A team's own checks. Each one is a line in plain words, like "every new text in en.json has a
-- Danish translation", for the files it names. A review asks the AI that one question in a run of
-- its own and posts the answer as a pass or fail check on the pull request.
create table checks (
  id bigint generated always as identity primary key,
  org_id bigint not null references orgs (id) on delete cascade,
  repo_id bigint not null,
  -- Shown in the name of the check on GitHub.
  name text not null,
  text text not null,
  -- A check is one more AI run on the team's own plan, so it always names the files it is about.
  paths text[] not null check (cardinality(paths) between 1 and 10),
  added_by text not null,
  added_by_id bigint not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, repo_id) references repos (org_id, id) on delete cascade
);
-- One check of a name in a repository, whatever its capitals: two checks on GitHub can't tell "Translations" from "translations" apart.
create unique index checks_name on checks (org_id, repo_id, lower(name));

alter table checks enable row level security;
alter table checks force row level security;
create policy own_org on checks using (org_id = current_org()) with check (org_id = current_org());
