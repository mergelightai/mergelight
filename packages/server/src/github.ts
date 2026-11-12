// What the server asks GitHub about a person who signs in to the dashboard.
//
// The person's own GitHub token makes these calls, so GitHub decides what they can see: the server
// learns nothing GitHub wouldn't show that person. The token is used for these calls and then
// dropped. It is never stored and never logged.

import { HttpError } from "../../token-server/dist/token.js";
import { isId } from "./db.js";

const API = "https://api.github.com";
/** A GitHub App's token for a person, like the one "Sign in with GitHub" on mergelight.dev hands out. Personal tokens and OAuth app tokens start differently. */
const PERSON_TOKEN = /^ghu_[A-Za-z0-9_]{20,255}$/;
/** The GitHub App people sign in to the dashboard with. A server someone else hosts names its own. */
/**
 * The GitHub Apps people sign in to the dashboard with, by the name in their address. The dashboard
 * signs in to Mergelight AI, the app that posts reviews, so it shows the repositories that have
 * reviews. Mergelight Setup was the sign-in app before, and a session started with it still works.
 */
export const DEFAULT_SIGN_IN_APP = "mergelight-ai,mergelight-setup";
/** Everything asked about one sign-in must fit in this. */
const DEADLINE_MS = 20_000;
const MAX_ORGS = 30;
const MAX_REPO_PAGES = 10;

export interface Person {
  id: number;
  login: string;
}

/** One account the person can reach through the app, and their repositories in it. */
export interface Reach {
  id: number;
  login: string;
  /** Whether the person runs this account: it is their own, or GitHub says they are an owner of the org. */
  admin: boolean;
  repos: Map<number, RepoReach>;
}

export interface RepoReach {
  /** owner/name */
  name: string;
  /** Whether GitHub lets the person push to it. People who can are the ones who may change what the team decided there. */
  write: boolean;
  /** Whether the person administers it. They are the ones who may set its rules. */
  admin: boolean;
}

const isLogin = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,100}$/.test(v);
const isRepoName = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(v);

export function looksLikePersonToken(token: string): boolean {
  return PERSON_TOKEN.test(token);
}

async function ask(fetchImpl: typeof fetch, token: string, path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetchImpl(`${API}${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "mergelight-server", "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal,
  });
  if (res.status === 401) throw new HttpError(401, "sign_in_failed", "GitHub didn't accept this sign-in. Sign in again.");
  // GitHub is limiting this person's token. The caller makes this sign-in wait, and nobody else.
  if (res.status === 429 || (res.status === 403 && (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"))) {
    throw new HttpError(429, "github_limited", "GitHub is limiting this account right now. Try again in a minute.");
  }
  if (!res.ok) throw new HttpError(502, "github_error", `GitHub answered ${res.status}.`);
  return res.json();
}

/**
 * Whether the person runs an account: it is their own, or they are an owner of the org. GitHub only
 * answers the second for an app that may read an org's members. When it doesn't, the answer is no.
 */
async function runsAccount(fetchImpl: typeof fetch, token: string, personId: number, account: { id?: unknown; login?: unknown; type?: unknown }, signal: AbortSignal): Promise<boolean> {
  if (account.type === "User") return account.id === personId;
  try {
    const membership = (await ask(fetchImpl, token, `/user/memberships/orgs/${encodeURIComponent(String(account.login))}`, signal)) as { state?: unknown; role?: unknown };
    return membership.state === "active" && membership.role === "admin";
  } catch (err) {
    if (err instanceof HttpError && err.code === "github_error") return false;
    throw err;
  }
}

/**
 * Who the token belongs to, and which accounts and repositories they reach through the app they
 * signed in with. Everything GitHub returns is checked before it is used.
 */
export async function lookUp(token: string, fetchImpl: typeof fetch = fetch, app = DEFAULT_SIGN_IN_APP): Promise<{ person: Person; reach: Reach[] }> {
  if (!looksLikePersonToken(token)) throw new HttpError(401, "sign_in_failed", "That isn't a GitHub sign-in.");
  const signal = AbortSignal.timeout(DEADLINE_MS);
  try {
    const user = (await ask(fetchImpl, token, "/user", signal)) as { id?: unknown; login?: unknown };
    if (!isId(user.id) || !isLogin(user.login)) throw new HttpError(502, "github_error", "GitHub's answer about the person couldn't be read.");

    const { installations } = (await ask(fetchImpl, token, "/user/installations?per_page=100", signal)) as { installations?: unknown };
    // GitHub lists the installs of the app that made the token. A token made for any other app is not
    // a sign-in here: otherwise every app a person ever authorized could read their dashboard.
    const all = (Array.isArray(installations) ? installations : []) as { app_slug?: unknown }[];
    const apps = app.split(",").map((a) => a.trim()).filter(Boolean);
    const ours = all.filter((i) => typeof i.app_slug === "string" && apps.includes(i.app_slug));
    if (all.length && !ours.length) throw new HttpError(401, "sign_in_failed", "That sign-in isn't Mergelight's.");
    const reach: Reach[] = [];
    for (const installation of ours.slice(0, MAX_ORGS)) {
      const { id, account } = installation as { id?: unknown; account?: { id?: unknown; login?: unknown; type?: unknown } | null };
      if (!isId(id) || !account || !isId(account.id) || !isLogin(account.login)) continue;
      const repos = new Map<number, RepoReach>();
      try {
        for (let page = 1; page <= MAX_REPO_PAGES; page++) {
          const { repositories } = (await ask(fetchImpl, token, `/user/installations/${id}/repositories?per_page=100&page=${page}`, signal)) as { repositories?: unknown };
          const list = Array.isArray(repositories) ? repositories : [];
          for (const repo of list as { id?: unknown; full_name?: unknown; permissions?: { push?: unknown; admin?: unknown } | null }[]) {
            if (isId(repo.id) && isRepoName(repo.full_name)) repos.set(repo.id, { name: repo.full_name, write: repo.permissions?.push === true, admin: repo.permissions?.admin === true });
          }
          if (list.length < 100) break;
        }
      } catch (err) {
        // One install GitHub won't list, a suspended one for example, leaves the person's other orgs showing.
        if (!(err instanceof HttpError && err.code === "github_error")) throw err;
        continue;
      }
      reach.push({ id: account.id, login: account.login, admin: await runsAccount(fetchImpl, token, user.id, account, signal), repos });
    }
    return { person: { id: user.id, login: user.login }, reach };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "github_error", signal.aborted ? "GitHub took too long to answer." : "GitHub couldn't be reached.");
  }
}
