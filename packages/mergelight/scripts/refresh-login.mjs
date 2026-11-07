#!/usr/bin/env node
// Refreshes the Codex login before Codex would, and saves it straight away.
//
// A used refresh token keeps working for a while, then gets refused: it still worked 18 minutes after
// its first use and was refused by 38, in one test. A run only has the login that was saved when it
// started. Codex itself refreshes in a token's last 5 minutes and we only save at the end of the run, so
// a long review could leave others holding a token about to be refused. Refreshing here keeps tokens
// away from those 5 minutes and shrinks the gap between refreshing and saving from minutes to seconds.
//
// An access token lasts 10 days and keeps working after a refresh, so a run that loses the race can
// carry on with the one it has, and a refresh doesn't disturb the reviews already running.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAppToken } from "./app-token.mjs";

const HOUR = 3_600_000;
/** Longer than a review's 45 minute job limit, so Codex won't need to refresh during one. */
const REVIEW_WITHIN = HOUR;
/**
 * A review that lost the race needs its token to outlast it, because Codex would try the used refresh
 * token in the token's last 5 minutes. Most reviews finish well inside this.
 */
const CARRY_ON_ABOVE = 20 * 60_000;

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
 * Whether this run should refresh. The job always does: it also shows a login has stopped working
 * within days, not at the next review. A review only does when its token could run out during it.
 */
export function isDue(event, expiry, now) {
  if (event === "schedule" || event === "workflow_dispatch") return true;
  return expiry !== null && expiry - now < REVIEW_WITHIN;
}

/**
 * Asks Codex's app-server to refresh, which is the one way to force it without calling OpenAI's
 * token endpoint ourselves. A failed refresh still answers normally, so the caller compares tokens.
 * Returns the reason if it can tell that something went wrong. Its logs stay out of ours, since they
 * deal with the login.
 */
export function forceRefresh({ env = process.env, spawnImpl = spawn, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    let done = false;
    const finish = (reason = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(reason);
    };
    const timer = setTimeout(() => finish("Codex didn't answer in time"), timeoutMs);
    child.on("error", (err) => finish(err.message));
    child.on("close", () => finish());
    child.stdin.on("error", (err) => finish(err.message));
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error && (message.id === 1 || message.id === 2)) {
          finish(String(message.error.message).slice(0, 200));
        } else if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: true } });
        } else if (message.id === 2) {
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
  const read = () => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const before = read();
  if (!before) {
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
    const message = `The Codex login is due for a refresh, but there's nowhere to save a new one. Install the Mergelight AI app and add "id-token: write".`;
    // Nobody reads a warning on a green scheduled job, and the login would run out with no sign. A review can still work.
    if (event === "schedule" || event === "workflow_dispatch") {
      log(`::error::${message}`);
      return 1;
    }
    log(`::warning::${message}`);
    return 0;
  }

  const reason = await refresh();
  const after = read()?.tokens;
  if (after?.refresh_token && after.access_token && after.access_token !== before.tokens.access_token) {
    log("Refreshed the Codex login.");
    if (save(token) !== 0) log("::warning::Couldn't save the refreshed Codex login yet. This run tries again when it ends.");
    return 0;
  }

  if (event === "schedule" || event === "workflow_dispatch") {
    log(`::error::Couldn't refresh the Codex login${reason ? ` (${reason})` : ""}. If this keeps failing, it has stopped working: delete the ${env.SECRET_NAME} secret, and the next pull request shows a code to connect ChatGPT again.`);
    return 1;
  }
  // Probably another run refreshed it a while ago. The access token still works, so use what's left of it.
  if (expiry !== null && expiry - now() > CARRY_ON_ABOVE) {
    log(`::warning::Couldn't refresh the Codex login${reason ? ` (${reason})` : ""}, so another run may have done it already. This review carries on, since the login is good for another ${left(expiry - now())}.`);
    return 0;
  }
  // Codex would try the same used token, once per reviewer, so don't start it.
  log(`::error::Couldn't refresh the Codex login${reason ? ` (${reason})` : ""}.`);
  appendFileSync(env.GITHUB_ENV, "MERGELIGHT_LOGIN_LOST=1\n");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await refreshLogin();
}
