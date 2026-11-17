-- Light is free for public repositories. An owner turns that on for an org on the dashboard, and the
-- org's row says so: reviews of its public repositories then use the dashboard, and reviews of its
-- private ones don't, until the org pays for a plan. The marker goes with the row when the org's data
-- is deleted, so a delete turns the free plan off too.
alter table orgs add column public_only boolean not null default false;
