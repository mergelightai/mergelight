#!/usr/bin/env node
// Refreshes the Codex login before Codex would, and saves it straight away.
//
// Each refresh token works once, and a run only has the login that was saved when it started. Codex
// itself refreshes in a token's last 5 minutes and we only save at the end of the run, so a review
// starting during that run would hold a used refresh token and fail. Refreshing here keeps tokens away
// from those 5 minutes and shrinks the gap between refreshing and saving from minutes to seconds.
//
// An access token lasts 10 days and keeps working after a refresh, so a run that loses the race can
// carry on with the one it has, and a refresh doesn't disturb the reviews already running.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAppToken } from "./app-token.mjs";

const HOUR = 3_600_000;
/** Codex refreshes by itself this close to expiry, which is what a run that lost the race must not do. */
const CODEX_REFRESHES_WITHIN = 5 * 60_000;
/** Longer than a review's 45 minute job limit, so Codex won't need to refresh during one. */
const REVIEW_WITHIN = HOUR;
/** The job runs every third day, so one missed run still leaves days to spare. */
const JOB_WITHIN = 5 * 24 * HOUR;

/** When the login's access token expires, in milliseconds, or null if that can't be told. */
export function accessTokenExpiry(auth) {
  try {
    const { exp } = JSON.parse(Buffer.from(auth.tokens.access_token.split(".")[1], "base64url").toString());
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Whether this run should refresh. By hand always, since that's what someone is asking for. A token
 * whose expiry can't be read is left to Codex in a review, and refreshed by the job.
 */
export function isDue(event, expiry, now) {
  if (event === "workflow_dispatch") return true;
  if (event === "schedule") return expiry === null || expiry - now < JOB_WITHIN;
  return expiry !== null && expiry - now < REVIEW_WITHIN;
}

/**
 * Asks Codex's app-server to refresh, which is the one way to force it without calling OpenAI's
 * token endpoint ourselves. It reports a failed refresh only in its logs, so the caller compares tokens.
 */
export function forceRefresh({ env = process.env, spawnImpl = spawn, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.on("error", finish);
    child.on("close", finish);
    child.stdin.on("error", finish);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let id;
        try {
          id = JSON.parse(line).id;
        } catch {
          continue;
        }
        if (id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: true } });
        } else if (id === 2) {
          finish();
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "mergelight", title: null, version: "0" }, capabilities: null } });
  });
}

const left = (ms) => (ms >= 2 * 24 * HOUR ? `${Math.floor(ms / (24 * HOUR))} days` : ms >= 2 * HOUR ? `${Math.floor(ms / HOUR)} hours` : `${Math.max(0, Math.floor(ms / 60_000))} minutes`);

/** Returns the exit code. The default dependencies are the real ones; tests pass their own. */
export async function refreshLogin({
  env = process.env,
  now = Date.now,
  log = console.log,
  refresh = () => forceRefresh({ env }),
  appToken = () => getAppToken({ env: { ...env, TOKEN_SCOPE: "login" }, log }),
  save = (token) => spawnSync("bash", [join(env.GITHUB_ACTION_PATH, "packages/mergelight/scripts/save-login.sh")], { stdio: "inherit", env: { ...env, SECRETS_TOKEN: token } }).status,
} = {}) {
  const file = join(env.CODEX_HOME, "auth.json");
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  let before;
  try {
    before = read();
  } catch {
    log("::warning::The saved Codex login isn't valid JSON, so it can't be refreshed.");
    return 0;
  }
  if (!before.tokens?.refresh_token) {
    log("This Codex login has no refresh token, so there's nothing to refresh.");
    return 0;
  }
  const event = env.GITHUB_EVENT_NAME;
  const expiry = accessTokenExpiry(before);
  if (!isDue(event, expiry, now())) {
    log(expiry === null ? "Leaving the Codex login to Codex: its expiry can't be read." : `The Codex login is good for another ${left(expiry - now())}.`);
    return 0;
  }

  // Refreshing uses up the saved refresh token, so never do it without somewhere to save the new one.
  const token = env.SECRETS_TOKEN || (await appToken());
  if (!token) {
    log(`::warning::The Codex login is due for a refresh, but there's nowhere to save a new one. Install the Mergelight AI app and add "id-token: write".`);
    return 0;
  }

  await refresh();
  const refreshed = read().tokens?.refresh_token !== before.tokens.refresh_token;
  if (refreshed) {
    log("Refreshed the Codex login.");
    if (save(token) !== 0) log("::warning::Couldn't save the refreshed Codex login yet. This run tries again when it ends.");
    return 0;
  }

  if (event === "schedule" || event === "workflow_dispatch") {
    log(`::error::Couldn't refresh the Codex login. If this keeps failing, it has stopped working: delete the ${env.SECRET_NAME} secret, and the next pull request shows a code to connect ChatGPT again.`);
    return 1;
  }
  // Probably another run refreshed it a moment ago. The access token still works, so use what's left of it.
  if (expiry !== null && expiry - now() > CODEX_REFRESHES_WITHIN) {
    log(`::warning::Couldn't refresh the Codex login, so another run may just have done it. This review carries on, since the login is good for another ${left(expiry - now())}.`);
    return 0;
  }
  // Codex would try the same used token, once per reviewer, so don't start it.
  log(`::error::Couldn't refresh the Codex login.`);
  appendFileSync(env.GITHUB_ENV, "MERGELIGHT_LOGIN_LOST=1\n");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await refreshLogin();
}
