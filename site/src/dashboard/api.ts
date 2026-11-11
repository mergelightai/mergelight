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

export async function signOut(session: Session): Promise<void> {
  remember(null);
  if (!session.token) return;
  await fetch(`${SERVER}/v1/session`, { method: 'DELETE', headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
}
