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
import { maskLogin } from "./mask-login.mjs";

const HOUR = 3_600_000;
/**
 * Longer than a review's 45 minute job limit, so Codex won't need to refresh during one. And as long as
 * the jobs wait for (action.yml): a login the jobs leave alone, as it runs out too soon, is one the
 * review refreshes in the same run.
 */
export const REVIEW_WITHIN = 2.5 * HOUR;
/**
 * A review that lost the race needs its token to outlast it, because Codex would try the used refresh
 * token in the token's last 5 minutes. Most reviews finish well inside this.
 */
const CARRY_ON_ABOVE = 20 * 60_000;

/** The command that saves a ChatGPT login of its own as this repository's secret, as setup's codexLogin() makes one. */
export function ownLoginCommand(secret = "CODEX_AUTH_JSON", repo = "OWNER/REPO") {
  return `d="$(mktemp -d)" && echo 'cli_auth_credentials_store = "file"' > "$d/config.toml" && CODEX_HOME="$d" codex login && gh secret set ${secret} --repo ${repo} < "$d/auth.json"; rm -rf "$d"`;
}

/**
 * The GitHub environment this job runs in, from GitHub's signed pass for the run: "" for none, and null
 * when it can't be told, as without "id-token: write". An environment's secret wins over the repository's
 * of the same name, so the login may be the environment's.
 */
export async function jobEnvironment({ env = process.env, fetchImpl = fetch } = {}) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return null;
  try {
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set("audience", "mergelight-login-check");
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    if (res.status !== 200) return null;
    const { value } = await res.json();
    const claims = JSON.parse(Buffer.from(String(value).split(".")[1], "base64url").toString("utf8"));
    return typeof claims.environment === "string" ? claims.environment : "";
  } catch {
    return null;
  }
}

/**
 * Whether the login this run has is this repository's own secret, as last saved. For a job in no GitHub
 * environment: an environment's secret would win over the repository's.
 * - "no": the repository has no secret of that name, so the login comes from elsewhere, such as an
 *   organization's secret. A refresh saved here would leave that secret holding a spent refresh token,
 *   and sign out every repository that shares it.
 * - "newer": the secret was saved again after this run read it (MERGELIGHT_LOGIN_READ_AT, in seconds),
 *   by another run or a person, so what this run has may not be what the repository holds.
 * - "unknown": GitHub didn't answer plainly.
 */
export async function secretHeld({ env = process.env, token, fetchImpl = fetch } = {}) {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const name = encodeURIComponent(env.SECRET_NAME || "CODEX_AUTH_JSON");
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
  try {
    const res = await fetchImpl(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/secrets/${name}`, { headers });
    if (res.status === 404) return "no";
    if (res.status !== 200) return "unknown";
    const since = Number(env.MERGELIGHT_LOGIN_READ_AT);
    if (!since) return "yes";
    const updated = Date.parse((await res.json())?.updated_at ?? "");
    if (!Number.isFinite(updated)) return "unknown";
    return updated / 1000 > since ? "newer" : "yes";
  } catch {
    return "unknown";
  }
}

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
  held = (token) => secretHeld({ env, token }),
  environment = () => jobEnvironment({ env }),
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

  // A login other repositories share is never refreshed here: the new one could only be saved to this
  // repository, and the shared secret would keep a spent refresh token.
  // Refreshed only once known to be the repository's own, as last saved. Otherwise the refresh could spend
  // a token that other repositories or an environment's other jobs share, or the save replace a newer
  // login. Such a login isn't used either, even with time left: Codex refreshes a login by itself in its
  // last minutes, which a long job can reach. No sign-in waits on it.
  const secret = env.SECRET_NAME || "CODEX_AUTH_JSON";
  // An environment's secret of the same name wins over the repository's, and can't be read with the
  // token that saves the login: a job in an environment, or one that can't be told, isn't refreshed.
  const where = await environment();
  const owned = where === null ? "blind" : where ? "environment" : await held(token);
  if (owned !== "yes") {
    const message = {
      no: `This repository reads its ChatGPT login from a ${secret} secret it doesn't hold itself, such as an organization's. Mergelight doesn't refresh a login other repositories share, as that would sign them out. Save a login of its own as this repository's secret, then push: ${ownLoginCommand(secret, env.GITHUB_REPOSITORY)}`,
      environment: `This job runs in the GitHub environment "${where}", whose own ${secret} secret would win over the repository's, so Mergelight can't tell whose ChatGPT login this is and doesn't refresh it, as that could sign out the environment's other jobs. Remove environment: from the Mergelight job, and keep the login as the repository's own secret.`,
      blind: `Mergelight can't tell whether this job runs in a GitHub environment, whose secret would win over the repository's, so it doesn't refresh the ChatGPT login. Add "id-token: write" to the job's permissions, then push.`,
      newer: `The ${secret} secret was saved again after this run read it, so this run doesn't refresh or use the ChatGPT login it has. Run the Mergelight job again: it reads the secret as it is now.`,
      unknown: `GitHub couldn't say whether this repository holds the ${secret} secret itself, so this run doesn't refresh or use the ChatGPT login. Nothing is wrong with the login: run the Mergelight job again.`,
    }[owned];
    if (event === "schedule" || event === "workflow_dispatch") {
      // A newer one is there already: nothing for the job to do.
      if (owned === "newer") {
        log(message);
        return 0;
      }
      log(`::error::${message}`);
      return 1;
    }
    log(`::error::${message}`);
    // The review says the same. A login it may share is called that when it only checks.
    const shared = owned === "no" || owned === "environment" ? "MERGELIGHT_LOGIN_SHARED=1\n" : "";
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `${shared}MERGELIGHT_LOGIN_SHORT=1\nMERGELIGHT_LOGIN_LOST=1\nMERGELIGHT_LOGIN_NOTE=${message}\n`);
    return 0;
  }

  const reason = await refresh();
  const after = read()?.tokens;
  if (after?.refresh_token && after.access_token && after.access_token !== before.tokens.access_token) {
    maskLogin({ env, log });
    log("Refreshed the Codex login.");
    // A refresh that failed earlier in this run no longer stops the review, nor holds a sign-in back.
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, "MERGELIGHT_LOGIN_LOST=0\nMERGELIGHT_LOGIN_SHORT=0\n");
    if (save(token) !== 0) log("::warning::Couldn't save the refreshed Codex login yet. This run tries again when it ends.");
    // Saved by this run: the secret is this run's own again, as of now.
    else if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `MERGELIGHT_LOGIN_READ_AT=${Math.floor(now() / 1000)}\n`);
    return 0;
  }

  if (event === "schedule" || event === "workflow_dispatch") {
    log(`::error::Couldn't refresh the Codex login${reason ? ` (${reason})` : ""}. If this keeps failing, it has stopped working: delete the ${env.SECRET_NAME} secret, and the next pull request shows a code to connect ChatGPT again.`);
    return 1;
  }
  // Probably another run refreshed it a while ago. The access token still works, so use what's left of it.
  if (expiry !== null && expiry - now() > CARRY_ON_ABOVE) {
    log(`::warning::Couldn't refresh the Codex login${reason ? ` (${reason})` : ""}, so another run may have done it already. This review carries on, since the login is good for another ${left(expiry - now())}.`);
    // What's left is for the review: nothing else in this run may wait on it, as the checker's sign-in would.
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, "MERGELIGHT_LOGIN_SHORT=1\n");
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
