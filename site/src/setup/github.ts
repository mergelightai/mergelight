/** What the setup page reads from GitHub, in the browser, with the person's own token. */

const API = 'https://api.github.com';
const CLIENT_ID = 'Iv23liM8BL5MwWeDmXHV';
const TOKEN_SERVER = 'https://api.mergelight.dev';
const STATE_KEY = 'mergelight.setup.state';
/** A sleeping server can take about a minute to wake up, so this is generous. */
const SIGN_IN_TIMEOUT_MS = 120_000;

export const INSTALL_URL = 'https://github.com/apps/mergelight-ai/installations/new';

/** Branches that hold releases or shared work. PRs from these are promotions, not new code. */
const LONG_LIVED = /^(main|master|staging|stage|production|prod|development|develop|dev)$/;

export interface Repo {
  fullName: string;
  account: string;
  avatarUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Where to change which repos this install can reach. */
  accessUrl: string;
}

export interface RepoDetails {
  branches: string[];
  /** The branch most recent PRs went to. */
  base: string;
  /** Long-lived branches, whose PRs usually don't need a review. */
  skip: string[];
  hasLogin: boolean;
  hasWorkflow: boolean;
}

export interface SetupPr {
  number: number;
  url: string;
  headSha: string;
}

export interface CheckStatus {
  status: string;
  conclusion: string | null;
  title: string | null;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number) {
    super(`GitHub answered ${status}.`);
    this.status = status;
  }
}

export interface GitHubClient {
  repos(): Promise<Repo[]>;
  details(repo: Repo): Promise<RepoDetails>;
  /** Opens a pull request that adds the workflow, unless one is open already. Null if the branch already has the file. */
  addWorkflow(repo: Repo, branch: string, content: string): Promise<SetupPr | null>;
  /** The open pull request that adds the workflow, once someone has made it. */
  findSetupPr(repo: Repo): Promise<SetupPr | null>;
  hasWorkflow(repo: Repo, branch: string): Promise<boolean>;
  hasLogin(repo: Repo): Promise<boolean>;
  /** The Mergelight check on this commit, if a review has started. */
  checkStatus(repo: Repo, sha: string): Promise<CheckStatus | null>;
  isMerged(repo: Repo, number: number): Promise<boolean>;
}

const WORKFLOW_PATH = '.github/workflows/mergelight.yml';
const SETUP_TITLE = 'Add Mergelight code review';
const SETUP_BODY = [
  'Adds the one file [Mergelight](https://mergelight.dev) needs to review your pull requests.',
  '',
  "It runs in your own GitHub Actions, on your AI plan. This pull request reviews itself, so you can see what you'll get. Merge it to keep reviews on.",
].join('\n');

const toBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

function stateValue(): string {
  try {
    const existing = sessionStorage.getItem(STATE_KEY);
    if (existing) return existing;
    const state = crypto.randomUUID();
    sessionStorage.setItem(STATE_KEY, state);
    return state;
  } catch {
    return crypto.randomUUID();
  }
}

export const signInUrl = () => `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${stateValue()}`;

/** The token server sleeps when idle, so this wakes it before the person needs it. Sends nothing. */
export function wakeTokenServer(): void {
  void fetch(TOKEN_SERVER, { mode: 'no-cors' }).catch(() => undefined);
}

/**
 * Finishes a sign-in if GitHub just sent the person back here. A code only counts with the state this
 * tab sent out, so another site can't sign someone in to the wrong account. Returns null if there's
 * nothing to finish, and throws if it failed.
 */
export async function finishSignIn(params: URLSearchParams): Promise<string | null> {
  const code = params.get('code');
  if (!code) return null;
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
  } catch {
    /* Without storage there's no state to compare, so it's treated as not signed in. */
  }
  if (!expected || params.get('state') !== expected) return null;
  const res = await fetch(`${TOKEN_SERVER}/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}).`);
  return ((await res.json()) as { token: string }).token;
}

/** Takes the code out of the address bar, so it can't be copied or reused. */
export function cleanUrl(): void {
  const url = new URL(window.location.href);
  for (const key of ['code', 'state']) url.searchParams.delete(key);
  window.history.replaceState(null, '', url);
}

/** The branch that gets the most new work. PRs between long-lived branches don't count when others exist. */
export function pickBase(pulls: { base: string; head: string }[], defaultBranch: string): string {
  const counts = new Map<string, number>();
  for (const { base, head } of pulls) {
    if (!LONG_LIVED.test(head)) counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? defaultBranch;
}

export const pickSkip = (branches: string[]) => branches.filter((b) => LONG_LIVED.test(b));

export function realClient(token: string): GitHubClient {
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new GitHubError(res.status);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
  const get = <T,>(path: string) => call<T>('GET', path);
  const hasWorkflow = (repo: Repo, branch: string) => get(`/repos/${repo.fullName}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(branch)}`).then(() => true, () => false);
  const findSetupPr = async (repo: Repo): Promise<SetupPr | null> => {
    const pulls = await get<{ number: number; html_url: string; head: { sha: string } }[]>(`/repos/${repo.fullName}/pulls?state=open&sort=created&direction=desc&per_page=5`);
    for (const pull of pulls) {
      const files = await get<{ filename: string }[]>(`/repos/${repo.fullName}/pulls/${pull.number}/files?per_page=30`).catch(() => []);
      if (files.some((f) => f.filename === WORKFLOW_PATH)) return { number: pull.number, url: pull.html_url, headSha: pull.head.sha };
    }
    return null;
  };
  const hasLogin = async (repo: Repo) => {
    const { secrets } = await get<{ secrets: { name: string }[] }>(`/repos/${repo.fullName}/actions/secrets?per_page=100`).catch(() => ({ secrets: [] as { name: string }[] }));
    return secrets.some((s) => s.name === 'CODEX_AUTH_JSON' || s.name === 'OPENAI_API_KEY');
  };

  return {
    repos: async () => {
      const { installations } = await get<{ installations: { id: number; html_url: string; account: { login: string; avatar_url: string } }[] }>('/user/installations?per_page=100');
      const lists = await Promise.all(
        installations.map(async (install) => {
          const { repositories } = await get<{ repositories: { full_name: string; private: boolean; default_branch: string; archived: boolean }[] }>(`/user/installations/${install.id}/repositories?per_page=100`);
          return repositories
            .filter((r) => !r.archived)
            .map((r): Repo => ({ fullName: r.full_name, account: install.account.login, avatarUrl: install.account.avatar_url, isPrivate: r.private, defaultBranch: r.default_branch, accessUrl: install.html_url }));
        }),
      );
      return lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
    },
    details: async (repo) => {
      const [branches, pulls, login] = await Promise.all([
        get<{ name: string }[]>(`/repos/${repo.fullName}/branches?per_page=100`),
        get<{ base: { ref: string }; head: { ref: string } }[]>(`/repos/${repo.fullName}/pulls?state=all&per_page=50`).catch(() => []),
        hasLogin(repo),
      ]);
      const names = branches.map((b) => b.name);
      const base = pickBase(pulls.map((p) => ({ base: p.base.ref, head: p.head.ref })), repo.defaultBranch);
      return {
        branches: names.includes(base) ? names : [base, ...names],
        base,
        skip: pickSkip(names),
        hasLogin: login,
        hasWorkflow: await hasWorkflow(repo, base),
      };
    },
    addWorkflow: async (repo, branch, content) => {
      const existing = await findSetupPr(repo);
      if (existing) return existing;
      if (await hasWorkflow(repo, branch)) return null;
      const r = `/repos/${repo.fullName}`;
      const base = await get<{ object: { sha: string } }>(`${r}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      const head = `mergelight-setup-${Date.now().toString(36)}`;
      await call('POST', `${r}/git/refs`, { ref: `refs/heads/${head}`, sha: base.object.sha });
      try {
        await call('PUT', `${r}/contents/${WORKFLOW_PATH}`, { message: SETUP_TITLE, content: toBase64(content), branch: head });
        const pull = await call<{ number: number; html_url: string; head: { sha: string } }>('POST', `${r}/pulls`, { title: SETUP_TITLE, head, base: branch, body: SETUP_BODY });
        return { number: pull.number, url: pull.html_url, headSha: pull.head.sha };
      } catch (err) {
        // Don't leave an empty branch behind in their repo.
        await call('DELETE', `${r}/git/refs/heads/${head}`).catch(() => undefined);
        throw err;
      }
    },
    findSetupPr,
    hasWorkflow,
    hasLogin,
    checkStatus: async (repo, sha) => {
      const { check_runs } = await get<{ check_runs: { status: string; conclusion: string | null; output: { title: string | null } }[] }>(`/repos/${repo.fullName}/commits/${sha}/check-runs?check_name=Mergelight`);
      const latest = check_runs[0];
      return latest ? { status: latest.status, conclusion: latest.conclusion, title: latest.output.title } : null;
    },
    isMerged: async (repo, number) => (await get<{ merged: boolean }>(`/repos/${repo.fullName}/pulls/${number}`)).merged,
  };
}

/** Local development only: `?mock` runs the whole flow on made-up data. Not in the built site. */
export function mockClient(): GitHubClient {
  const accessUrl = 'https://github.com/organizations/acme/settings/installations/1';
  const avatarUrl = '/logo.png';
  const repo = (name: string, isPrivate = true): Repo => ({ fullName: `acme/${name}`, account: 'acme', avatarUrl, isPrivate, defaultBranch: 'main', accessUrl });
  let finds = 0;
  let checks = 0;
  const later = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 300));
  return {
    repos: () => later([repo('api'), repo('app'), repo('docs', false), repo('platform'), repo('site')]),
    details: (r) =>
      later(
        r.fullName === 'acme/docs'
          ? { branches: ['main'], base: 'main', skip: ['main'], hasLogin: false, hasWorkflow: false }
          : r.fullName === 'acme/site'
          ? { branches: ['main', 'feat/new-landing'], base: 'main', skip: ['main'], hasLogin: false, hasWorkflow: false }
          : {
              branches: ['main', 'staging', 'development', 'feat/billing-export', 'fix/invoice-rounding'],
              base: 'staging',
              skip: ['main', 'staging', 'development'],
              hasLogin: r.fullName === 'acme/platform',
              hasWorkflow: r.fullName === 'acme/app',
            },
      ),
    // acme/site plays an install that hasn't approved the access, to show the way around it.
    addWorkflow: (r) => (r.fullName === 'acme/site' ? Promise.reject(new GitHubError(403)) : new Promise((done) => setTimeout(() => done({ number: 128, url: 'https://github.com/acme/api/pull/128', headSha: 'abc' }), 900))),
    findSetupPr: () => later(++finds > 1 ? { number: 128, url: 'https://github.com/acme/api/pull/128', headSha: 'abc' } : null),
    hasWorkflow: () => later(false),
    hasLogin: (r) => later(r.fullName === 'acme/platform'),
    checkStatus: () => {
      checks += 1;
      if (checks < 2) return later(null);
      if (checks < 4) return later({ status: 'in_progress', conclusion: null, title: 'Waiting for you to connect ChatGPT' });
      if (checks < 7) return later({ status: 'in_progress', conclusion: null, title: 'Reviewing' });
      return later({ status: 'completed', conclusion: 'failure', title: '🔴 Blocked: 2 bugs, 1 risk to fix' });
    },
    isMerged: () => later(checks >= 11),
  };
}
