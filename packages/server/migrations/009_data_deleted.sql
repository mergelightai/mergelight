-- When an owner last deleted the org's data, for an org that keeps its dashboard because it pays.
-- The next review of an open pull request sends the decisions written in its threads again, and a
-- decision written before the delete must not come back: the owner deleted it.
alter table orgs add column data_deleted_at timestamptz;
