#!/usr/bin/env node
// Turns the dashboard on or off for an org, from a terminal on the server's host.
// It stands in until sign-in exists. It needs DATABASE_URL, so only someone who runs the server can use it.
//
//   node dist/admin.js connect <github-account-id> <login>
//   node dist/admin.js delete <github-account-id>      Removes everything stored for that org.
//
// The id is GitHub's number for the account: gh api users/<login> --jq .id

import { assertRowRulesHold, connectOrg, createPool, deleteOrg, isId, migrate } from "./db.js";

function usage(): never {
  console.error("Usage: node dist/admin.js connect <github-account-id> <login> | delete <github-account-id>");
  process.exit(2);
}

const [command, rawId, login] = process.argv.slice(2);
const id = /^\d{1,18}$/.test(rawId ?? "") ? Number(rawId) : NaN;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL isn't set.");
  process.exit(1);
}
if (!isId(id)) usage();
if (command !== "connect" && command !== "delete") usage();
if (command === "connect" && !/^[\w.-]{1,100}$/.test(login ?? "")) usage();

const pool = createPool(url);
try {
  // The same check as the server: a superuser would create the tables as their owner and skip the row rules.
  await assertRowRulesHold(pool);
  await migrate(pool);
  if (command === "connect") {
    await connectOrg(pool, id, login!);
    console.log(`The dashboard is on for ${login} (${id}).`);
  } else {
    console.log((await deleteOrg(pool, id)) ? `Removed everything stored for ${id}.` : `Nothing was stored for ${id}.`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
