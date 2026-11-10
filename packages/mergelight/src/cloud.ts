import { randomUUID } from "node:crypto";
import type { Review } from "./types.js";

/**
 * The Mergelight server, for teams that use the dashboard. Off unless MERGELIGHT_SERVER is set.
 *
 * This program talks to the server, before the reviewing model starts and after it has finished.
 * The model never does: it has no network, no tool for it and no token.
 *
 * A run proves which repository it is with GitHub's OIDC token, so there is no key to store. Each
 * token is made for the one server it goes to, so no other server accepts it, and it is used once.
 *
 * Whatever goes wrong here must not stop or change the review. A server that is down, slow or
 * hostile costs a review a few seconds at most.
 */

/** Everything one question to the server may take: asking GitHub for tokens, both tries, and reading the answer. */
const DEADLINE_MS = 10_000;
/** The answers are a few hundred bytes. Anything far past that isn't one, and isn't read. */
const MAX_ANSWER = 64 * 1024;

export interface CloudDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Hides a value in the run's log. */
  mask?: (value: string) => void;
  /** For tests. */
  deadlineMs?: number;
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

/** The server checks a model's name against the same alphabet. */
const MODEL_NAME = /^[\w.:/[\]-]{1,100}$/;

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
    // The brackets are for names like "sonnet[1m]".
    model: model && MODEL_NAME.test(model) ? model : null,
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

/**
 * Who the OIDC token is made for: the server's own address, with its path if it's mounted under one.
 * Another Mergelight server refuses it, and so does the token server, so a token can't be passed on
 * to get anything anywhere else.
 */
export function audienceFor(server: URL): string {
  return server.origin + server.pathname.replace(/\/+$/, "");
}

function defaults(deps: CloudDeps) {
  const env = deps.env ?? process.env;
  return {
    env,
    fetchImpl: deps.fetchImpl ?? fetch,
    log: deps.log ?? (() => {}),
    // To stderr, where GitHub reads commands too, so it never lands in the review's JSON on stdout.
    mask: deps.mask ?? ((value: string) => void (env.GITHUB_ACTIONS === "true" && process.stderr.write(`::add-mask::${value}\n`))),
    deadlineMs: deps.deadlineMs ?? DEADLINE_MS,
  };
}

type Deps = ReturnType<typeof defaults>;

/** A new OIDC token from GitHub. The server takes each one once, so every request asks for its own. */
async function oidcToken(d: Deps, server: URL, signal: AbortSignal): Promise<string> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: at, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = d.env;
  if (!at || !bearer) throw new Error('the workflow needs "id-token: write" in its permissions');
  const url = new URL(at);
  url.searchParams.set("audience", audienceFor(server));
  const res = await d.fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` }, signal });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the OIDC token`);
  const { value } = (await res.json()) as { value?: string };
  if (!value) throw new Error("GitHub returned no OIDC token");
  d.mask(value);
  return value;
}

/** Reads a small JSON answer. A larger one is dropped unread, so a server can't fill this process's memory. */
async function readAnswer(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ANSWER) {
      await reader.cancel().catch(() => {});
      throw new Error("its answer is too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const drop = (res: Response) => res.body?.cancel().catch(() => {});

/** Keeps a path in the server's address, for a server mounted under one, like https://example.com/mergelight. */
export function endpoint(server: URL, path: string): URL {
  return new URL(server.pathname.replace(/\/+$/, "") + path, server.origin);
}

/** The server is off without a word when it isn't set. A setting that can't be used gets a line, or a typo would look like "on". */
function serverOrSay(d: Deps): URL | null {
  const server = serverUrl(d.env);
  if (!server && d.env.MERGELIGHT_SERVER?.trim()) d.log("The Mergelight server setting isn't an https:// address, so the server is off for this review.");
  return server;
}

/**
 * One question to the server, tried twice, each try with its own token, all inside one deadline.
 * A redirect is an error: the token is for this server and goes nowhere else.
 */
async function call(d: Deps, server: URL, path: string, init: { method: string; body?: string }): Promise<{ status: number; ok: boolean; answer: unknown }> {
  const signal = AbortSignal.timeout(d.deadlineMs);
  const late = () => new Error(`no answer within ${Math.round(d.deadlineMs / 1000)} seconds`);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await d.fetchImpl(endpoint(server, path), {
        method: init.method,
        headers: { authorization: `Bearer ${await oidcToken(d, server, signal)}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body,
        redirect: "error",
        signal,
      });
      if (res.status >= 500 && attempt === 1) {
        await drop(res);
        continue;
      }
      if (!res.ok) await drop(res);
      return { status: res.status, ok: res.ok, answer: res.ok ? await readAnswer(res) : null };
    } catch (err) {
      if (signal.aborted) throw late();
      if (attempt === 2) throw err;
    }
  }
}

/** True when this repository's org uses the dashboard. False for everyone else, and whenever the server can't be asked. */
export async function cloudConnected(deps: CloudDeps = {}): Promise<boolean> {
  const d = defaults(deps);
  const server = serverOrSay(d);
  if (!server) return false;
  try {
    const res = await call(d, server, "/v1/context", { method: "GET" });
    if (!res.ok) {
      d.log(`The Mergelight server answered ${res.status}. The review runs without it.`);
      return false;
    }
    return (res.answer as { connected?: unknown } | null)?.connected === true;
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
    // One id for this report, the same on both tries, so the server keeps it once.
    const body = JSON.stringify({ ...reviewNumbers(review), report_id: randomUUID() });
    const res = await call(d, server, "/v1/reviews", { method: "POST", body });
    if (!res.ok) d.log(`The Mergelight server answered ${res.status} to the review's numbers. The review itself is posted.`);
    return res.ok;
  } catch (err) {
    d.log(`Couldn't send the review's numbers to the Mergelight server (${(err as Error).message}). The review itself is posted.`);
    return false;
  }
}
