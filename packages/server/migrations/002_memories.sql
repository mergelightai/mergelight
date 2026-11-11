-- What a team decided not to fix, and why, so later pull requests don't raise it again.
-- This is the first text about a customer's code the server holds: a finding's title, the file it
-- was in and the reason someone gave. Never the code itself.

create table memories (
  id bigint generated always as identity primary key,
  org_id bigint not null references orgs (id) on delete cascade,
  repo_id bigint not null,
  -- The review's own id for the finding: the file plus the code it pointed at.
  finding_id text not null,
  title text not null,
  file text not null,
  line integer not null,
  end_line integer,
  reason text not null,
  -- Who declined it, as the run that reported it said. The pull request is where to check.
  by_login text not null,
  pr integer not null,
  -- When the person wrote the decision on GitHub. Only a later decision about the same finding
  -- replaces this one, so the same pull request reviewed again changes nothing.
  decided_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A decision nobody needed for 90 days is dropped. Each use starts the 90 days again.
  last_used_at timestamptz,
  uses integer not null default 0,
  -- Set when someone made Mergelight forget it. The text is wiped and the row stays, so the old
  -- pull request it came from can't bring it back. Only a newer decision can.
  forgotten_at timestamptz,
  foreign key (org_id, repo_id) references repos (org_id, id) on delete cascade,
  unique (org_id, repo_id, finding_id)
);
create index memories_repo on memories (org_id, repo_id);

alter table memories enable row level security;
alter table memories force row level security;
create policy own_org on memories using (org_id = current_org()) with check (org_id = current_org());

-- Clearing out what ran out, for every org at once. A transaction that sets mergelight.purge sees
-- exactly the rows that are past their 90 days and nothing else, and can only delete them. It can't
-- read a decision that is still in use, and it can't write.
create function memory_ran_out(last_used_at timestamptz, updated_at timestamptz, forgotten_at timestamptz) returns boolean
  language sql stable
  as $$ select forgotten_at is null and coalesce(last_used_at, updated_at) <= now() - interval '90 days' $$;
create policy purge_sees on memories for select
  using (current_setting('mergelight.purge', true) = 'on' and memory_ran_out(last_used_at, updated_at, forgotten_at));
create policy purge_deletes on memories for delete
  using (current_setting('mergelight.purge', true) = 'on' and memory_ran_out(last_used_at, updated_at, forgotten_at));
