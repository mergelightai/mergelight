#!/usr/bin/env node
// Turns the dashboard on or off for an org, from a terminal on the server's host.
// It stands in until sign-in exists. It needs DATABASE_URL, so only someone who runs the server can use it.
//
//   node src/admin.js connect <github-account-id> <login>
//   node src/admin.js delete <github-account-id>      Removes everything stored for that org.
//
// The id is GitHub's number for the account: gh api users/<login> --jq .id

import { connectOrg, createPool, deleteOrg, isId, migrate } from "./db.js";

const [command, rawId, login] = process.argv.slice(2);
const id = /^\d{1,18}$/.test(rawId ?? "") ? Number(rawId) : NaN;
const usage = () => {
  console.error("Usage: node src/admin.js connect <github-account-id> <login> | delete <github-account-id>");
  process.exit(2);
};
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL isn't set.");
  process.exit(1);
}
if (!isId(id)) usage();
if (command === "connect" && !/^[\w.-]{1,100}$/.test(login ?? "")) usage();
if (command !== "connect" && command !== "delete") usage();

const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  if (command === "connect") {
    await connectOrg(pool, id, login);
    console.log(`The dashboard is on for ${login} (${id}).`);
  } else {
    console.log((await deleteOrg(pool, id)) ? `Removed everything stored for ${id}.` : `Nothing was stored for ${id}.`);
  }
} finally {
  await pool.end();
}
