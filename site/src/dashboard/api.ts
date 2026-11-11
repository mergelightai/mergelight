// The dashboard's sign-in and its calls to the Mergelight server.
//
// Sign-in is GitHub's, the same as on the setup page. The page shows the Mergelight server the GitHub
// token once, gets a session of the server's own back, and forgets the GitHub token. Nothing here
// can change anything on GitHub.

const CLIENT_ID = 'Iv23liSVH2xajWoG53R0';
const TOKEN_SERVER = 'https://api.mergelight.dev';
/** Where the numbers live. A build for a server you host yourself sets VITE_MERGELIGHT_SERVER. */
export const SERVER: string = (import.meta.env.VITE_MERGELIGHT_SERVER as string | undefined) ?? 'https://mergelight-server.onrender.com';

/** Where a person adds an org or a repository to what the dashboard can show them. */
export const ADD_REPOS_URL = 'https://github.com/apps/mergelight-setup/installations/new';

const STATE_KEY = 'mergelight.dashboard.state';
const SESSION_KEY = 'mergelight.dashboard.session';
const TIMEOUT_MS = 30_000;

export interface Org {
  id: number;
  login: string;
  /** Whether this org has turned the dashboard on. */
  connected: boolean;
  /** How many of its repositories you can see. */
  repos: number;
}

export interface Session {
  /** Null when the sign-in has nothing to show: the server keeps no session then. */
  token: string | null;
  expires_at: string | null;
  user: { id: number; login: string };
  orgs: Org[];
}

export type Light = 'green' | 'yellow' | 'red';

export interface Review {
  repo_id: number;
  repo: string;
  pr: number;
  sha: string;
  light: Light;
  bugs: number;
  risks: number;
  hardening: number;
  major: number;
  provider: 'codex' | 'claude';
  model: string | null;
  duration_ms: number;
  created_at: string;
}

export interface Overview {
  org: { id: number; login: string };
  repos: { id: number; name: string; last_review_at: string | null; reviews: number }[];
  reviews: Review[];
}

/** A finding the team chose not to fix, and why. Mergelight leaves it out of later reviews of that file. */
export interface Decision {
  id: number;
  repo_id: number;
  repo: string;
  title: string;
  file: string;
  line: number;
  end_line: number | null;
  reason: string;
  by: string;
  pr: number;
  created_at: string;
  last_used_at: string | null;
  uses: number;
  /** Whether this person can make Mergelight forget it: they can push to that repository. */
  can_forget: boolean;
}

/** A rule the team set. rule: a line every review follows. needs_human: files that never go green by themselves. */
export interface Rule {
  id: number;
  kind: 'rule' | 'needs_human';
  text: string;
  paths: string[];
  by: string;
  created_at: string;
  /** Null for a rule of the whole org. */
  repo_id: number | null;
  repo: string | null;
  can_remove: boolean;
}

export interface Rules {
  rules: Rule[];
  /** Whether this person may set rules for the whole org: they own it. */
  can_set_org_rules: boolean;
  repos: { id: number; name: string; can_set_rules: boolean }[];
}

export interface NewRule {
  kind: Rule['kind'];
  text: string;
  paths: string[];
  repo_id: number | null;
}

/** A skill folder in a repository that the team picked for its reviews. The skill's text stays in the repository. */
export interface Skill {
  id: number;
  repo_id: number;
  repo: string;
  path: string;
  by: string;
  created_at: string;
  can_remove: boolean;
}

export interface Skills {
  skills: Skill[];
  /** Picking a skill takes an admin of that repository. */
  repos: { id: number; name: string; can_pick_skills: boolean }[];
}

/** A check the team wrote in plain words. Each review asks it as a question of its own and posts a pass or fail check. */
export interface Check {
  id: number;
  repo_id: number;
  repo: string;
  name: string;
  text: string;
  paths: string[];
  by: string;
  created_at: string;
  can_remove: boolean;
}

export interface Checks {
  checks: Check[];
  /** Setting a check takes an admin of that repository. */
  repos: { id: number; name: string; can_set_checks: boolean }[];
}

export interface NewCheck {
  repo_id: number;
  name: string;
  text: string;
  paths: string[];
}

/** Thrown when the session ran out or the server restarted. The page then asks for a new sign-in. */
export class SignedOut extends Error {}
/** Thrown when the org hasn't turned the dashboard on. */
export class NotConnected extends Error {}

/**
 * The link to GitHub's sign-in. The state starts with "dash." so the setup page, where GitHub sends
 * every sign-in back to, knows to pass this one on to the dashboard.
 */
export function signInUrl(): string {
  let state = `dash.${crypto.randomUUID()}`;
  try {
    const existing = sessionStorage.getItem(STATE_KEY);
    if (existing) state = existing;
    else sessionStorage.setItem(STATE_KEY, state);
  } catch {
    /* Without storage the sign-in can't be matched on the way back, and the page asks again. */
  }
  return `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${state}`;
}

/** Takes the sign-in code out of the address bar, so a reload or a shared link never carries it. */
export function tidyAddress(): void {
  const url = new URL(window.location.href);
  for (const key of ['code', 'state', 'iss', 'error', 'error_description', 'error_uri']) url.searchParams.delete(key);
  window.history.replaceState(null, '', url.pathname + url.search);
}

async function serverSession(githubToken: string): Promise<Session> {
  const res = await fetch(`${SERVER}/v1/session`, { method: 'POST', headers: { authorization: `Bearer ${githubToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`The Mergelight server answered ${res.status}.`);
  return (await res.json()) as Session;
}

/**
 * Finishes a sign-in if GitHub just sent the person back. A code only counts with the state this tab
 * sent out. Returns null if there's nothing to finish, and throws if it failed.
 */
export async function finishSignIn(params: URLSearchParams): Promise<Session | null> {
  const code = params.get('code');
  if (!code) return null;
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
  } catch {
    /* No storage, no state to compare: treated as not signed in. */
  }
  if (!expected || params.get('state') !== expected) return null;
  const res = await fetch(`${TOKEN_SERVER}/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}).`);
  // The GitHub token lives in this one variable, for this one call.
  const { token } = (await res.json()) as { token: string };
  const session = await serverSession(token);
  if (session.token) remember(session);
  return session;
}

/** Keeps the session for this tab, so a reload doesn't mean a trip to GitHub. It holds no GitHub token. */
function remember(session: Session | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* Without storage a reload asks for a new sign-in. */
  }
}

export function rememberedSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const session = raw ? (JSON.parse(raw) as Session) : null;
    if (!session || typeof session.token !== 'string' || typeof session.expires_at !== 'string' || !Array.isArray(session.orgs) || Date.parse(session.expires_at) <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

const RENEWED_KEY = 'mergelight.dashboard.renewed';

/**
 * Whether the page may send the person to GitHub by itself to sign in again. A session lasts 15
 * minutes, and GitHub sends an already signed-in person straight back, so this is how the page
 * stays signed in without a click. Once in a while only, so a sign-in that keeps failing can't
 * turn into a loop.
 */
export function mayRenew(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RENEWED_KEY) ?? 0);
    if (Date.now() - last < 2 * 60_000) return false;
    sessionStorage.setItem(RENEWED_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

export async function loadOverview(session: Session, orgId: number): Promise<Overview> {
  const res = await fetch(`${SERVER}/v1/orgs/${orgId}/overview`, { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401) {
    remember(null);
    throw new SignedOut();
  }
  if (res.status === 404 && ((await res.json()) as { error?: string }).error === 'not_connected') throw new NotConnected();
  if (!res.ok) throw new Error(`The Mergelight server answered ${res.status}.`);
  return (await res.json()) as Overview;
}

export async function loadDecisions(session: Session, orgId: number): Promise<{ decisions: Decision[]; total: number }> {
  const res = await fetch(`${SERVER}/v1/orgs/${orgId}/memories`, { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401) {
    remember(null);
    throw new SignedOut();
  }
  if (res.status === 404 && ((await res.json()) as { error?: string }).error === 'not_connected') throw new NotConnected();
  if (!res.ok) throw new Error(`The Mergelight server answered ${res.status}.`);
  const { memories, total } = (await res.json()) as { memories: Decision[]; total?: number };
  return { decisions: memories, total: total ?? memories.length };
}

/** Makes Mergelight forget one decision. Later reviews may raise that finding again. */
export async function forgetDecision(session: Session, orgId: number, id: number): Promise<void> {
  const res = await fetch(`${SERVER}/v1/orgs/${orgId}/memories/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401) {
    remember(null);
    throw new SignedOut();
  }
  // Already gone counts as done.
  if (!res.ok && res.status !== 404) throw new Error(`The Mergelight server answered ${res.status}.`);
}

export async function call(session: Session, path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
  const res = await fetch(`${SERVER}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${session.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) {
    remember(null);
    throw new SignedOut();
  }
  return res;
}

export async function loadRules(session: Session, orgId: number): Promise<Rules> {
  const res = await call(session, `/v1/orgs/${orgId}/rules`);
  if (res.status === 404 && ((await res.json()) as { error?: string }).error === 'not_connected') throw new NotConnected();
  if (!res.ok) throw new Error(`The Mergelight server answered ${res.status}.`);
  return (await res.json()) as Rules;
}

/** Adds a rule. Throws with the server's own words when it says no, so the person sees why. */
export async function addRule(session: Session, orgId: number, rule: NewRule): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/rules`, { method: 'POST', body: JSON.stringify(rule) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `The Mergelight server answered ${res.status}.`);
}

export async function removeRule(session: Session, orgId: number, id: number): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/rules/${id}`, { method: 'DELETE' });
  // Already gone counts as done.
  if (!res.ok && res.status !== 404) throw new Error(`The Mergelight server answered ${res.status}.`);
}

export async function loadSkills(session: Session, orgId: number): Promise<Skills> {
  const res = await call(session, `/v1/orgs/${orgId}/skills`);
  if (res.status === 404 && ((await res.json()) as { error?: string }).error === 'not_connected') throw new NotConnected();
  if (!res.ok) throw new Error(`The Mergelight server answered ${res.status}.`);
  return (await res.json()) as Skills;
}

/** Picks a skill folder for a repository's reviews. Throws with the server's own words when it says no. */
export async function addSkill(session: Session, orgId: number, skill: { repo_id: number; path: string }): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/skills`, { method: 'POST', body: JSON.stringify(skill) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `The Mergelight server answered ${res.status}.`);
}

export async function removeSkill(session: Session, orgId: number, id: number): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/skills/${id}`, { method: 'DELETE' });
  // Already gone counts as done.
  if (!res.ok && res.status !== 404) throw new Error(`The Mergelight server answered ${res.status}.`);
}

export async function loadChecks(session: Session, orgId: number): Promise<Checks> {
  const res = await call(session, `/v1/orgs/${orgId}/checks`);
  if (res.status === 404 && ((await res.json()) as { error?: string }).error === 'not_connected') throw new NotConnected();
  if (!res.ok) throw new Error(`The Mergelight server answered ${res.status}.`);
  return (await res.json()) as Checks;
}

/** Adds a check to a repository. Throws with the server's own words when it says no. */
export async function addCheck(session: Session, orgId: number, check: NewCheck): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/checks`, { method: 'POST', body: JSON.stringify(check) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `The Mergelight server answered ${res.status}.`);
}

export async function removeCheck(session: Session, orgId: number, id: number): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/checks/${id}`, { method: 'DELETE' });
  // Already gone counts as done.
  if (!res.ok && res.status !== 404) throw new Error(`The Mergelight server answered ${res.status}.`);
}

export async function signOut(session: Session): Promise<void> {
  remember(null);
  if (!session.token) return;
  await fetch(`${SERVER}/v1/session`, { method: 'DELETE', headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
}
