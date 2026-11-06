/** What the setup page reads from GitHub, in the browser, with the person's own token. */

const API = 'https://api.github.com';
const CLIENT_ID = 'Iv23liM8BL5MwWeDmXHV';
const SIGN_IN_ENDPOINT = 'https://api.mergelight.dev/sign-in';
const STATE_KEY = 'mergelight.setup.state';

export const INSTALL_URL = 'https://github.com/apps/mergelight-ai/installations/new';

/** Branches that hold releases or shared work. PRs from these are promotions, not new code. */
const LONG_LIVED = /^(main|master|staging|stage|production|prod|development|develop|dev)$/;

export interface Repo {
  fullName: string;
  account: string;
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

export interface GitHubClient {
  repos(): Promise<Repo[]>;
  details(repo: Repo): Promise<RepoDetails>;
}

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

export const installUrl = () => `${INSTALL_URL}?state=${stateValue()}`;
export const signInUrl = () => `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${stateValue()}`;

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
  const res = await fetch(SIGN_IN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
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
  const get = async <T,>(path: string): Promise<T> => {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    return (await res.json()) as T;
  };
  const exists = (path: string) => get(path).then(() => true, () => false);

  return {
    repos: async () => {
      const { installations } = await get<{ installations: { id: number; html_url: string; account: { login: string } }[] }>('/user/installations?per_page=100');
      const lists = await Promise.all(
        installations.map(async (install) => {
          const { repositories } = await get<{ repositories: { full_name: string; private: boolean; default_branch: string; archived: boolean }[] }>(`/user/installations/${install.id}/repositories?per_page=100`);
          return repositories
            .filter((r) => !r.archived)
            .map((r): Repo => ({ fullName: r.full_name, account: install.account.login, isPrivate: r.private, defaultBranch: r.default_branch, accessUrl: install.html_url }));
        }),
      );
      return lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
    },
    details: async (repo) => {
      const [branches, pulls, secrets] = await Promise.all([
        get<{ name: string }[]>(`/repos/${repo.fullName}/branches?per_page=100`),
        get<{ base: { ref: string }; head: { ref: string } }[]>(`/repos/${repo.fullName}/pulls?state=all&per_page=50`).catch(() => []),
        get<{ secrets: { name: string }[] }>(`/repos/${repo.fullName}/actions/secrets?per_page=100`).catch(() => ({ secrets: [] })),
      ]);
      const names = branches.map((b) => b.name);
      const base = pickBase(pulls.map((p) => ({ base: p.base.ref, head: p.head.ref })), repo.defaultBranch);
      return {
        branches: names.includes(base) ? names : [base, ...names],
        base,
        skip: pickSkip(names),
        hasLogin: secrets.secrets.some((s) => s.name === 'CODEX_AUTH_JSON' || s.name === 'OPENAI_API_KEY'),
        hasWorkflow: await exists(`/repos/${repo.fullName}/contents/.github/workflows/mergelight.yml?ref=${encodeURIComponent(base)}`),
      };
    },
  };
}

/** Local development only: `?mock` shows the signed-in page without GitHub. Not in the built site. */
export function mockClient(): GitHubClient {
  const accessUrl = 'https://github.com/organizations/acme/settings/installations/1';
  const repo = (name: string, isPrivate = true): Repo => ({ fullName: `acme/${name}`, account: 'acme', isPrivate, defaultBranch: 'main', accessUrl });
  return {
    repos: async () => [repo('api'), repo('app'), repo('docs', false), repo('platform')],
    details: async (r) => ({
      branches: ['main', 'staging', 'development', 'feat/billing-export', 'fix/invoice-rounding'],
      base: 'staging',
      skip: ['main', 'staging', 'development'],
      hasLogin: r.fullName === 'acme/platform',
      hasWorkflow: r.fullName === 'acme/app',
    }),
  };
}
