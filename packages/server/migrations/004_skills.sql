-- Skill folders a team picked for reviews. A skill is a how-to that already lives in the team's
-- repository, for Claude Code or Codex. Only its path is kept here. Its text stays in the repository,
-- and a review reads it from the base branch.

create table skills (
  id bigint generated always as identity primary key,
  org_id bigint not null references orgs (id) on delete cascade,
  repo_id bigint not null,
  path text not null,
  added_by text not null,
  added_by_id bigint not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, repo_id) references repos (org_id, id) on delete cascade,
  unique (org_id, repo_id, path)
);

alter table skills enable row level security;
alter table skills force row level security;
create policy own_org on skills using (org_id = current_org()) with check (org_id = current_org());
