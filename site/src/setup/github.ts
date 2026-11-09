/** What the setup page reads from GitHub, in the browser, with the person's own token. */

const API = 'https://api.github.com';
/** Mergelight Setup. It has no private key anywhere, so it only ever acts for the person signed in here. */
const CLIENT_ID = 'Iv23liSVH2xajWoG53R0';
const ACTION_REPO = 'mergelightai/mergelight';
const TOKEN_SERVER = 'https://api.mergelight.dev';
const STATE_KEY = 'mergelight.setup.state';
const REPO_KEY = 'mergelight.setup.repo';
/** A sleeping server can take about a minute to wake up, so this is generous. */
const SIGN_IN_TIMEOUT_MS = 120_000;

export const INSTALL_URL = 'https://github.com/apps/mergelight-setup/installations/new';
/**
 * Mergelight AI, which posts the reviews. It can't commit, so a leak of its key on our server can't reach anyone's
 * code or workflows. This address opens GitHub's install screen with the account and repo already selected.
 */
export const reviewAppUrl = (repo: Repo) => `https://github.com/apps/mergelight-ai/installations/new/permissions?suggested_target_id=${repo.accountId}&repository_ids[]=${repo.id}`;

/** Branches that hold releases or shared work. PRs from these are promotions, not new code. */
const LONG_LIVED = /^(main|master|staging|stage|production|prod|development|develop|dev)$/;

export interface Repo {
  id: number;
  fullName: string;
  account: string;
  accountId: number;
  avatarUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Where to change which repos this install can reach. */
  accessUrl: string;
}

/** A release of the Action. Pinning uses the commit, because a tag can be moved. */
export interface Release {
  tag: string;
  sha: string;
}

/** The workflow a repo already has, and which version of the Action it runs. */
export interface Installed {
  /** A commit, or a tag like v0. */
  ref: string;
  /** The version noted beside a pinned commit, if there is one. */
  version: string | null;
  content: string;
}

export interface RepoDetails {
  branches: string[];
  /** The branch most recent PRs went to. */
  base: string;
  /** Long-lived branches, whose PRs usually don't need a review. */
  skip: string[];
  hasLogin: boolean;
  /** An API key or a Claude login needs no refreshing, so such a repo doesn't need the refresh workflow. */
  hasApiKey: boolean;
  /** What's on the base branch already, if anything. */
  installed: Installed | null;
  /** The refresh workflow on the base branch, if it's there. */
  refresh: string | null;
  /** The latest release. Only a pinned repo needs it, so failing to read it doesn't stop a setup. */
  release: Release | null;
  /** If the app that posts reviews is on this repo. Null if that can't be told, which doesn't stop a setup. */
  reviewApp: boolean | null;
}

/** A workflow file the setup pull request should end up with. */
export interface WorkflowFile {
  name: string;
  content: string;
}

/** Only a real step counts, so a pin line someone left in a comment isn't mistaken for what runs. */
const ACTION_USE = /^([ \t]*(?:-[ \t]+)?uses:[ \t]*)["']?mergelightai\/mergelight@([^\s#"']+)["']?(?:[ \t]*#[ \t]*(\S+))?/m;
/** The note in a new workflow saying why it isn't pinned, which stops being true once it is. */
const NOT_PINNED_NOTE = /^[ \t]*# Not pinned, on purpose[^\n]*\n(?:[ \t]*#[^\n]*\n)*(?=[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?mergelightai\/mergelight@)/gm;

export function readInstalled(content: string): Installed | null {
  const m = content.match(ACTION_USE);
  return m ? { ref: m[2]!, version: m[3] ?? null, content } : null;
}

/** A moving tag like v0 gets each release by itself. Only a pinned commit has anything to update. */
export const isPinned = (installed: Installed) => /^[0-9a-f]{40}$/i.test(installed.ref);

/** Says why a workflow is pinned, in place of the note that said why it wasn't. */
const pinnedNote = (note: string) => {
  const indent = note.match(/^[ \t]*/)![0];
  return `${indent}# Pinned to a release, so new code only runs here once you merge an update.\n${indent}# Mergelight says on your pull requests when a new version is out.\n`;
};

/** Points every use of the Action at this release's commit. The only other change is the note about pinning. */
export function pinned(content: string, release: Release): string {
  return content.replace(NOT_PINNED_NOTE, pinnedNote).replace(new RegExp(ACTION_USE, 'gm'), (_, before: string) => `${before}mergelightai/mergelight@${release.sha} # ${release.tag}`);
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

/** The link and code for connecting ChatGPT, as the Action posted them on the pull request. */
export interface ConnectCode {
  url: string;
  code: string;
}

/**
 * Who can post for Mergelight. Anyone can comment on a public pull request, and entering someone else's
 * code would sign them in on your plan, so nobody else's comment counts.
 */
const OWN_COMMENTERS = ['mergelight-ai[bot]', 'github-actions[bot]'];

/**
 * Finds the code in Mergelight's comment, if that comment is still asking for one. It has to be in the
 * exact shape the Action writes, because a finished review's comment can quote text from the pull request.
 */
export function readConnectCode(comments: { user: { login: string } | null; body?: string | null }[]): ConnectCode | null {
  const body = comments.filter((c) => OWN_COMMENTERS.includes(c.user?.login ?? '') && c.body?.includes('<!-- mergelight:summary -->')).at(-1)?.body;
  if (!body?.includes('<!-- mergelight:pending -->')) return null;
  const url = body.match(/^1\. Open (https:\/\/auth\.openai\.com\/\S+)$/m)?.[1];
  const code = body.match(/^2\. Enter this code: `([A-Z0-9]{4}-[A-Z0-9]{4,})`$/m)?.[1];
  return url && code ? { url, code } : null;
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
  /**
   * Opens a pull request that adds or updates the workflow. A setup pull request that's open already gets
   * brought up to date instead of a second one. Null if the branch already has exactly this file.
   * `update` is the release a pinned repo is moving to, when that's what this is.
   */
  proposeWorkflows(repo: Repo, branch: string, files: WorkflowFile[], update: Release | null): Promise<SetupPr | null>;
  /** The open pull request that adds the workflow, once someone has made it. */
  findSetupPr(repo: Repo): Promise<SetupPr | null>;
  hasWorkflow(repo: Repo, branch: string): Promise<boolean>;
  hasLogin(repo: Repo): Promise<boolean>;
  /** The Mergelight check on this commit, if a review has started. */
  checkStatus(repo: Repo, sha: string): Promise<CheckStatus | null>;
  /** The code for connecting ChatGPT, while the pull request is waiting for someone to enter it. */
  connectCode(repo: Repo, number: number): Promise<ConnectCode | null>;
  /** Whether it's merged, and the commit it's on now. */
  prState(repo: Repo, number: number): Promise<{ merged: boolean; headSha: string }>;
}

const WORKFLOWS = '.github/workflows';
const WORKFLOW_PATH = `${WORKFLOWS}/mergelight.yml`;
export const REFRESH_FILE = 'mergelight-refresh.yml';
/** The secrets that can run a review. Only a ChatGPT login has to be refreshed. */
const NO_REFRESH_SECRETS = ['OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const LOGIN_SECRETS = ['CODEX_AUTH_JSON', ...NO_REFRESH_SECRETS];
const SETUP_TITLE = 'Add Mergelight code review';
const SETUP_BODY = [
  'Adds what [Mergelight](https://mergelight.dev) needs to review your pull requests: the review itself, and a small job that keeps a ChatGPT login fresh.',
  '',
  "It runs in your own GitHub Actions, on your AI plan. This pull request reviews itself, so you can see what you'll get. Merge it to keep reviews on.",
].join('\n');

const SETUP_CHANGED = 'Update the Mergelight workflow';
const updateTitle = (release: Release) => `Update Mergelight to ${release.tag}`;
const updateBody = (release: Release, addsRefresh: boolean) =>
  `Moves the workflow to [${release.tag}](https://github.com/mergelightai/mergelight/releases/tag/${release.tag}), pinned to its exact commit. Only that line changes.${addsRefresh ? ' It also adds a small job that keeps a ChatGPT login fresh.' : ''} This pull request reviews itself with the new version.`;

const toBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBase64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

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

/** Remembers the repo for the trip to GitHub, so nobody has to pick it again when they come back. */
export function rememberRepo(fullName: string): void {
  try {
    sessionStorage.setItem(REPO_KEY, fullName);
  } catch {
    /* Without storage they just pick it again. */
  }
}

export function takeRememberedRepo(): string | null {
  try {
    const name = sessionStorage.getItem(REPO_KEY);
    sessionStorage.removeItem(REPO_KEY);
    return name;
  } catch {
    return null;
  }
}

/** Takes the code out of the address bar, so it can't be copied or reused. */
export function cleanUrl(): void {
  const url = new URL(window.location.href);
  for (const key of ['code', 'state', 'iss']) url.searchParams.delete(key);
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
      // GitHub lets browsers reuse an answer for 60 seconds, which would keep the page on a status that's out of date.
      cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new GitHubError(res.status);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
  const get = <T,>(path: string) => call<T>('GET', path);
  /** The workflow file on a branch, if it's there. Only a missing file counts as missing: any other failure stops whoever asked. */
  const workflowOn = async (repo: Repo, branch: string, name = 'mergelight.yml'): Promise<{ sha: string; content: string } | null> => {
    try {
      const file = await get<{ sha: string; content: string }>(`/repos/${repo.fullName}/contents/${WORKFLOWS}/${name}?ref=${encodeURIComponent(branch)}`);
      return { sha: file.sha, content: fromBase64(file.content) };
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  };
  const hasWorkflow = (repo: Repo, branch: string) => workflowOn(repo, branch).then(Boolean, () => false);
  const latestRelease = async (): Promise<Release> => {
    const { tag_name: tag } = await get<{ tag_name: string }>(`/repos/${ACTION_REPO}/releases/latest`);
    const { sha } = await get<{ sha: string }>(`/repos/${ACTION_REPO}/commits/${encodeURIComponent(tag)}`);
    return { tag, sha };
  };
  const openSetupPull = async (repo: Repo) => {
    const pulls = await get<{ number: number; html_url: string; head: { sha: string; ref: string; repo: { full_name: string } | null } }[]>(`/repos/${repo.fullName}/pulls?state=open&sort=created&direction=desc&per_page=5`);
    for (const pull of pulls) {
      // A fork's pull request isn't ours to update.
      if (pull.head.repo?.full_name !== repo.fullName) continue;
      const files = await get<{ filename: string }[]>(`/repos/${repo.fullName}/pulls/${pull.number}/files?per_page=30`).catch(() => []);
      if (files.some((f) => f.filename === WORKFLOW_PATH)) return pull;
    }
    return null;
  };
  const findSetupPr = async (repo: Repo): Promise<SetupPr | null> => {
    const pull = await openSetupPull(repo);
    return pull && { number: pull.number, url: pull.html_url, headSha: pull.head.sha };
  };
  /** Only our server can ask GitHub this, and it needs the person's token to show they can see the repo. */
  const reviewAppInstalled = async (repo: Repo) => {
    const res = await fetch(`${TOKEN_SERVER}/review-app?repo=${encodeURIComponent(repo.fullName)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Couldn't check for the review app (${res.status}).`);
    return ((await res.json()) as { installed: boolean }).installed;
  };
  const secretNames = async (repo: Repo) => {
    const { secrets } = await get<{ secrets: { name: string }[] }>(`/repos/${repo.fullName}/actions/secrets?per_page=100`).catch(() => ({ secrets: [] as { name: string }[] }));
    return secrets.map((s) => s.name);
  };
  const hasLogin = async (repo: Repo) => {
    return (await secretNames(repo)).some((n) => LOGIN_SECRETS.includes(n));
  };

  return {
    repos: async () => {
      const { installations } = await get<{ installations: { id: number; html_url: string; account: { id: number; login: string; avatar_url: string } }[] }>('/user/installations?per_page=100');
      const lists = await Promise.all(
        installations.map(async (install) => {
          const { repositories } = await get<{ repositories: { id: number; full_name: string; private: boolean; default_branch: string; archived: boolean }[] }>(`/user/installations/${install.id}/repositories?per_page=100`);
          return repositories
            .filter((r) => !r.archived)
            .map((r): Repo => ({ id: r.id, fullName: r.full_name, account: install.account.login, accountId: install.account.id, avatarUrl: install.account.avatar_url, isPrivate: r.private, defaultBranch: r.default_branch, accessUrl: install.html_url }));
        }),
      );
      return lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
    },
    details: async (repo) => {
      const [branches, pulls, secrets, release, reviewApp] = await Promise.all([
        get<{ name: string }[]>(`/repos/${repo.fullName}/branches?per_page=100`),
        get<{ base: { ref: string }; head: { ref: string } }[]>(`/repos/${repo.fullName}/pulls?state=all&per_page=50`).catch(() => []),
        secretNames(repo),
        latestRelease().catch(() => null),
        reviewAppInstalled(repo).catch(() => null),
      ]);
      const names = branches.map((b) => b.name);
      const base = pickBase(pulls.map((p) => ({ base: p.base.ref, head: p.head.ref })), repo.defaultBranch);
      const [onBase, refresh] = await Promise.all([workflowOn(repo, base), workflowOn(repo, base, REFRESH_FILE)]);
      return {
        branches: names.includes(base) ? names : [base, ...names],
        base,
        skip: pickSkip(names),
        hasLogin: secrets.some((n) => LOGIN_SECRETS.includes(n)),
        hasApiKey: secrets.some((n) => NO_REFRESH_SECRETS.includes(n)),
        installed: onBase && readInstalled(onBase.content),
        refresh: refresh?.content ?? null,
        release,
        reviewApp,
      };
    },
    proposeWorkflows: async (repo, branch, files, update) => {
      const r = `/repos/${repo.fullName}`;
      /** Writes the files that differ on this branch. Returns the last commit, if anything changed. */
      const write = async (head: string, message: string): Promise<string | null> => {
        let commit: string | null = null;
        for (const file of files) {
          const current = await workflowOn(repo, head, file.name);
          if (current?.content === file.content) continue;
          const done = await call<{ commit: { sha: string } }>('PUT', `${r}/contents/${WORKFLOWS}/${file.name}`, {
            message,
            content: toBase64(file.content),
            branch: head,
            ...(current ? { sha: current.sha } : {}),
          });
          commit = done.commit.sha;
        }
        return commit;
      };

      // One that's open already gets brought up to date, however old the version it was opened with.
      const open = await openSetupPull(repo);
      if (open) {
        const commit = await write(open.head.ref, update ? updateTitle(update) : SETUP_CHANGED);
        return { number: open.number, url: open.html_url, headSha: commit ?? open.head.sha };
      }

      const onBranch = await Promise.all(files.map((f) => workflowOn(repo, branch, f.name)));
      if (onBranch.every((current, i) => current?.content === files[i]!.content)) return null;
      const title = update ? updateTitle(update) : SETUP_TITLE;
      const base = await get<{ object: { sha: string } }>(`${r}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      const head = `mergelight-setup-${Date.now().toString(36)}`;
      await call('POST', `${r}/git/refs`, { ref: `refs/heads/${head}`, sha: base.object.sha });
      try {
        await write(head, title);
        const pull = await call<{ number: number; html_url: string; head: { sha: string } }>('POST', `${r}/pulls`, { title, head, base: branch, body: update ? updateBody(update, onBranch.some((current) => !current)) : SETUP_BODY });
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
    connectCode: async (repo, number) => readConnectCode(await get<{ user: { login: string } | null; body?: string | null }[]>(`/repos/${repo.fullName}/issues/${number}/comments?per_page=100`)),
    prState: async (repo, number) => {
      const pull = await get<{ merged: boolean; head: { sha: string } }>(`/repos/${repo.fullName}/pulls/${number}`);
      return { merged: pull.merged, headSha: pull.head.sha };
    },
  };
}

/** Local development only: `?mock` runs the whole flow on made-up data. Not in the built site. */
export function mockClient(): GitHubClient {
  const accessUrl = 'https://github.com/organizations/acme/settings/installations/1';
  const avatarUrl = '/logo.png';
  const repo = (name: string, isPrivate = true): Repo => ({ id: name.length, fullName: `acme/${name}`, account: 'acme', accountId: 1, avatarUrl, isPrivate, defaultBranch: 'main', accessUrl });
  let finds = 0;
  let checks = 0;
  const later = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 300));
  const release: Release = { tag: 'v0.2.0', sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' };
  const workflowWith = (use: string) => `name: Mergelight\n\njobs:\n  review:\n    steps:\n      - uses: mergelightai/mergelight@${use}\n`;
  const installedFor = (name: string): Installed | null =>
    name === 'acme/app'
      ? readInstalled(workflowWith(`${release.sha} # ${release.tag}`))
      : name === 'acme/old'
        ? readInstalled(workflowWith('v0'))
        : name === 'acme/behind'
          ? readInstalled(workflowWith('0123456789012345678901234567890123456789 # v0.1.0'))
          : null;
  return {
    repos: () => later([repo('api'), repo('app'), repo('behind'), repo('docs', false), repo('old'), repo('platform'), repo('site')]),
    // acme/docs plays a repo that has only the setup app so far.
    details: (r) =>
      later<RepoDetails>({ reviewApp: r.fullName !== 'acme/docs', ...(
        r.fullName === 'acme/docs'
          ? { branches: ['main'], base: 'main', skip: ['main'], hasLogin: false, hasApiKey: false, installed: null, refresh: null, release }
          : r.fullName === 'acme/site'
          ? { branches: ['main', 'feat/new-landing'], base: 'main', skip: ['main'], hasLogin: false, hasApiKey: false, installed: null, refresh: null, release }
          : {
              branches: ['main', 'staging', 'development', 'feat/billing-export', 'fix/invoice-rounding'],
              base: 'staging',
              skip: ['main', 'staging', 'development'],
              hasLogin: r.fullName === 'acme/platform' || r.fullName === 'acme/old' || r.fullName === 'acme/behind',
              hasApiKey: false,
              installed: installedFor(r.fullName),
              refresh: null,
              release,
            }) }),
    // acme/site plays an install that hasn't approved the access, to show the way around it.
    proposeWorkflows: (r) => (r.fullName === 'acme/site' ? Promise.reject(new GitHubError(403)) : new Promise((done) => setTimeout(() => done({ number: 128, url: 'https://github.com/acme/api/pull/128', headSha: 'abc' }), 900))),
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
    connectCode: () => later(checks < 4 ? { url: 'https://auth.openai.com/codex/device', code: '2ZYY-TEST1' } : null),
    prState: () => later({ merged: checks >= 11, headSha: 'abc' }),
  };
}
