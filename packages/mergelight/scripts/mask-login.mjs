#!/usr/bin/env node
// Tells GitHub to hide the Codex login's tokens in this job's logs. GitHub hides a secret as a whole,
// but not the tokens inside it, and refreshed tokens aren't secrets it knows about at all.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKENS = ["access_token", "refresh_token", "id_token"];

/** Prints a hide command for each token in the login file. A missing or broken file has nothing to hide. */
export function maskLogin({ env = process.env, log = console.log } = {}) {
  let tokens;
  try {
    tokens = JSON.parse(readFileSync(join(env.CODEX_HOME, "auth.json"), "utf8")).tokens;
  } catch {
    return;
  }
  for (const name of TOKENS) {
    const value = tokens?.[name];
    // A line break would end the command, and the rest would be read as a new one.
    if (typeof value === "string" && value && !/[\r\n]/.test(value)) log(`::add-mask::${value}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) maskLogin();
