-- Skills a team writes on the dashboard itself: a name, a line that says when to use it, and its
-- text. Next to the skill folders a team picks from its repository (004_skills.sql), where only the
-- path is stored. Here the text is stored, because there is no file it could stay in.
create table written_skills (
  id bigint generated always as identity primary key,
  org_id bigint not null references orgs (id) on delete cascade,
  repo_id bigint not null,
  name text not null,
  -- One line: when a reviewer should read this skill.
  description text not null,
  body text not null,
  added_by text not null,
  added_by_id bigint not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, repo_id) references repos (org_id, id) on delete cascade
);
-- One skill of a name in a repository, whatever its capitals.
create unique index written_skills_name on written_skills (org_id, repo_id, lower(name));

alter table written_skills enable row level security;
alter table written_skills force row level security;
create policy own_org on written_skills using (org_id = current_org()) with check (org_id = current_org());
