#!/usr/bin/env node
// Lets a run post as the Mergelight AI app: swaps GitHub's OIDC token for a short-lived app token.
//
// Whatever goes wrong here, it must not stop the review. The Action then posts with the workflow's
// own token, as github-actions[bot], and this prints why.

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AUDIENCE = "mergelight";
const SETUP_HINT = "Posting as github-actions[bot].";

// A sleeping server can take about a minute to wake up, so the timeout is generous.
async function fetchWithRetry(fetchImpl, url, init, wait, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(90_000) });
      if (res.status < 500 || attempt === attempts) return res;
    } catch (err) {
      if (attempt === attempts) throw err;
    }
    await wait(1000 * attempt);
  }
}

/**
 * Returns the app token, or null with the reason already printed.
 * log gets the workflow commands, so they reach the run's log and annotations.
 */
export async function getAppToken({ env = process.env, fetchImpl = fetch, log = console.log, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!env.TOKEN_SERVER) return null;
  const scope = env.TOKEN_SCOPE;
  const server = new URL(env.TOKEN_SERVER);
  if (scope) server.searchParams.set("scope", scope);
  const fallback = scope ? "" : ` ${SETUP_HINT}`;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    log(`::notice::Add "id-token: write" to the workflow's permissions to use the Mergelight AI app.${fallback}`);
    return null;
  }

  try {
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set("audience", AUDIENCE);
    const oidc = await fetchWithRetry(fetchImpl, url, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } }, wait);
    if (!oidc.ok) throw new Error(`GitHub answered ${oidc.status} for the OIDC token`);
    const { value } = await oidc.json();
    log(`::add-mask::${value}`);

    const res = await fetchWithRetry(fetchImpl, server, { method: "POST", headers: { authorization: `Bearer ${value}` } }, wait);
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.token) {
      log(`::add-mask::${body.token}`);
      if (!scope) log(`Posting as Mergelight AI, with a token for ${body.repository}.`);
      return body.token;
    }
    // Not installed is a normal choice, not a problem.
    const level = body.error === "not_installed" ? "notice" : "warning";
    log(`::${level}::${body.message ?? `The token server answered ${res.status}.`}${fallback}`);
    return null;
  } catch (err) {
    log(`::warning::Couldn't reach the token server (${err instanceof Error ? err.message : "unknown error"}).${fallback}`);
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = await getAppToken();
  if (token && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `token=${token}\n`);
}
