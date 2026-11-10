import type { Review } from "./types.js";

/**
 * The Mergelight server, for teams that use the dashboard. Off unless MERGELIGHT_SERVER is set.
 *
 * This program talks to the server, before the reviewing model starts and after it has finished.
 * The model never does: it has no network, no tool for it and no token.
 *
 * A run proves which repository it is with GitHub's OIDC token, so there is no key to store. The
 * token is asked for with its own audience, which the token server refuses, and each one is used once.
 *
 * Whatever goes wrong here must not stop or change the review.
 */

/** Who the OIDC token is made for. Not the token server's audience, on purpose. */
export const AUDIENCE = "mergelight-data";

const TIMEOUT_MS = 15_000;

export interface CloudDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Hides a value in the run's log. */
  mask?: (value: string) => void;
}

/** What the server stores about one review: numbers and names from short fixed lists. No code, no finding text, no file paths. */
export interface ReviewNumbers {
  pr: number;
  sha: string;
  light: Review["light"];
  counts: { bug: number; risk: number; hardening: number };
  tiers: { post: number; list: number; decision: number };
  major: number;
  provider: "codex" | "claude";
  model: string | null;
  verifier: "codex" | "claude" | null;
  duration_ms: number;
  files_changed: number;
  additions: number;
  deletions: number;
}

export function reviewNumbers(review: Review): ReviewNumbers {
  const n = (keep: (f: Review["findings"][number]) => boolean) => review.findings.filter(keep).length;
  const model = review.provider.model;
  return {
    pr: review.pr.number,
    sha: review.pr.head_sha,
    light: review.light,
    counts: { bug: n((f) => f.class === "bug"), risk: n((f) => f.class === "risk"), hardening: n((f) => f.class === "hardening") },
    tiers: { post: n((f) => f.tier === "post"), list: n((f) => f.tier === "list"), decision: n((f) => f.tier === "decision") },
    major: n((f) => f.severity === "major"),
    provider: review.provider.name,
    // A model name outside this plain alphabet isn't sent at all, so nothing typed into a setting can travel as text.
    model: model && /^[\w.:/-]{1,100}$/.test(model) ? model : null,
    verifier: review.verifier?.name ?? null,
    duration_ms: Math.round(review.stats.duration_ms),
    files_changed: review.stats.files_changed,
    additions: review.stats.additions,
    deletions: review.stats.deletions,
  };
}

/** The server's address, or null when it's off. Plain http is only for a server on this machine. */
export function serverUrl(env: Record<string, string | undefined>): URL | null {
  const raw = env.MERGELIGHT_SERVER?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || (url.protocol === "http:" && local) ? url : null;
}

function defaults(deps: CloudDeps) {
  const env = deps.env ?? process.env;
  return {
    env,
    fetchImpl: deps.fetchImpl ?? fetch,
    log: deps.log ?? (() => {}),
    mask: deps.mask ?? ((value: string) => void (env.GITHUB_ACTIONS === "true" && process.stdout.write(`::add-mask::${value}\n`))),
  };
}

/** A new OIDC token from GitHub. The server takes each one once, so every request asks for its own. */
async function oidcToken(d: ReturnType<typeof defaults>): Promise<string> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: at, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = d.env;
  if (!at || !bearer) throw new Error('the workflow needs "id-token: write" in its permissions');
  const url = new URL(at);
  url.searchParams.set("audience", AUDIENCE);
  const res = await d.fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the OIDC token`);
  const { value } = (await res.json()) as { value?: string };
  if (!value) throw new Error("GitHub returned no OIDC token");
  d.mask(value);
  return value;
}

/** One request to the server, tried twice. Each try has its own token. */
async function call(d: ReturnType<typeof defaults>, server: URL, path: string, init: { method: string; body?: string }): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await d.fetchImpl(new URL(path, server), {
        method: init.method,
        headers: { authorization: `Bearer ${await oidcToken(d)}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status < 500 || attempt === 2) return res;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

/** True when this repository's org uses the dashboard. False for everyone else, and whenever the server can't be asked. */
export async function cloudConnected(deps: CloudDeps = {}): Promise<boolean> {
  const d = defaults(deps);
  const server = serverUrl(d.env);
  if (!server) return false;
  try {
    const res = await call(d, server, "/v1/context", { method: "GET" });
    if (!res.ok) {
      d.log(`The Mergelight server answered ${res.status}. The review runs without it.`);
      return false;
    }
    return ((await res.json()) as { connected?: unknown }).connected === true;
  } catch (err) {
    d.log(`Couldn't reach the Mergelight server (${(err as Error).message}). The review runs without it.`);
    return false;
  }
}

/** Sends the review's numbers for the dashboard. Returns whether the server took them. */
export async function reportReview(review: Review, deps: CloudDeps = {}): Promise<boolean> {
  const d = defaults(deps);
  const server = serverUrl(d.env);
  if (!server) return false;
  try {
    const res = await call(d, server, "/v1/reviews", { method: "POST", body: JSON.stringify(reviewNumbers(review)) });
    if (!res.ok) d.log(`The Mergelight server answered ${res.status} to the review's numbers. The review itself is posted.`);
    return res.ok;
  } catch (err) {
    d.log(`Couldn't send the review's numbers to the Mergelight server (${(err as Error).message}). The review itself is posted.`);
    return false;
  }
}
