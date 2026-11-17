/** What the setup page reads from GitHub, in the browser, with the person's own token. */
import { aiName, defaultReviewer, reviewsPullRequests, withInputs, type Logins, type Roles } from './roles';
import { readConnectCode, type ConnectCode } from './connect';
import { hasCommentTrigger } from './comment-trigger';

const API = 'https://api.github.com';
/** Mergelight Setup. It has no private key anywhere, so it only ever acts for the person signed in here. */
const CLIENT_ID = 'Iv23liSVH2xajWoG53R0';
const ACTION_REPO = 'mergelightai/mergelight';
const TOKEN_SERVER = 'https://api.mergelight.dev';
const STATE_KEY = 'mergelight.setup.state';
const REPO_KEY = 'mergelight.setup.repo';
const CONNECT_KEY = 'mergelight.setup.connect';
/** The run looks every few seconds, and the code is spent once it's read. */
const CODE_REF_LIFETIME_MS = 60_000;
/** A sleeping server can take about a minute to wake up, so this is generous. */
const SIGN_IN_TIMEOUT_MS = 120_000;

export const INSTALL_URL = 'https://github.com/apps/mergelight-setup/installations/new';
/**
 * Mergelight AI, which posts the reviews. It can't commit, so a leak of its key on our server can't reach anyone's
 * code or workflows. This address opens GitHub's install screen with the account and repo already selected.
 */
export const reviewAppUrl = (repo: Repo) => `https://github.com/apps/mergelight-ai/installations/new/permissions?suggested_target_id=${repo.accountId}&repository_ids[]=${repo.id}`;

/** Branches that hold releases or shared work. PRs from these are promotions, not new code. */
/** How many pages of open PRs are looked through for the branches they go into, a hundred each. */
const OPEN_PAGES = 10;
/** How many pages of the Action's tags are looked through for a commit's release, a hundred tags each. */
const TAG_PAGES = 20;
export const LONG_LIVED_BRANCHES = ['main', 'master', 'staging', 'stage', 'production', 'prod', 'development', 'develop', 'dev'];
const LONG_LIVED = new RegExp(`^(${LONG_LIVED_BRANCHES.join('|')})$`);

export interface Repo {
  id: number;
  fullName: string;
  account: string;
  accountId: number;
  avatarUrl: string;
  isPrivate: boolean;
  /** Internal is neither: everyone in the enterprise can see it. */
  visibility: 'public' | 'private' | 'internal';
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
  /** The secrets a run gets, the repo's own and those its organization shares with it. Only their names can be read. */
  secretNames: string[];
  /** Those of them that are the organization's, with no secret of the repo's own by the same name. */
  sharedSecrets: string[];
  /**
   * Whether every secret a run gets was seen. One an organization shares with the repo only shows once that list can
   * be read, and without it a login may be missing here that the Action still gets.
   */
  allSecretsSeen: boolean;
  /** An API key or a Claude login needs no refreshing, so such a repo doesn't need the refresh workflow. */
  hasApiKey: boolean;
  /** What's on the base branch already, if anything. */
  installed: Installed | null;
  /** The refresh workflow on the base branch, if it's there. */
  refresh: string | null;
  /** The workflow that turns a "needs a human" check green on an approval, on the base branch, if it's there. */
  approve: string | null;
  /**
   * The other Mergelight reviews a new login would reach, which this page leaves to set by hand: any workflow file with
   * a review step on another branch PRs go into (long-lived ones, the default branch and the bases of open and recent
   * PRs), and one besides mergelight.yml on this branch. `file` is null where the workflows couldn't be read.
   */
  otherReviews: { branch: string; file: string | null }[];
  /**
   * Whether every branch a PR goes into was looked at. A list of PRs that couldn't be read, or had more open PRs than
   * are looked through, may leave one out.
   */
  branchesKnown: boolean;
  /** The release @v0 is on, the newest whose canary passed. Only a pinned repo needs it, so failing to read it doesn't stop a setup. */
  release: Release | null;
  /** If the app that posts reviews is on this repo. Null if that can't be told, which doesn't stop a setup. */
  reviewApp: boolean | null;
}

/** A workflow file the setup pull request should end up with. */
export interface WorkflowFile {
  name: string;
  content: string;
  /**
   * For a change to a file that's there already. The pull request gets this change made to what its branch holds,
   * so nothing else on that branch is lost. Null when the change can't be made there.
   */
  edit?: (current: string) => string | null;
  /** Only added where it's missing. One that's there already stays exactly as it is. */
  keep?: boolean;
  /** With `edit`: a branch without the file gets `content`, rather than the change failing. */
  orAdd?: boolean;
  /**
   * A file the branch doesn't have goes in only if the review workflow this change leaves there passes this, like one
   * that reads the login this job keeps fresh. One an open pull request changed may read another.
   */
  addIf?: (review: string) => boolean;
}

/** What a pull request from this page is for. */
export type Change = { kind: 'setup' } | { kind: 'update'; release: Release } | { kind: 'roles'; roles: Roles } | { kind: 'refresh' };

/**
 * The workflow wasn't there to change, its Mergelight step couldn't be found in it, or it changed since the page read
 * it. Nothing was written.
 */
export class WorkflowEditError extends Error {
  reason: 'no-file' | 'no-step' | 'changed';
  constructor(reason: 'no-file' | 'no-step' | 'changed') {
    super(reason === 'no-file' ? 'The workflow file is missing.' : reason === 'no-step' ? "The workflow's Mergelight step can't be found." : 'The workflow changed since it was read.');
    this.reason = reason;
  }
}

/** How many open pull requests' files are looked through for one that changes the workflow already. */
const PULLS_CHECKED = 150;

/** There were too many open pull requests to look through them all, so a change could go beside one. Nothing was written. */
export class ScanLimitError extends Error {
  constructor() {
    super(`More than ${PULLS_CHECKED} open pull requests to look through.`);
  }
}

/** A pull request that changes the workflow is open already, and this change doesn't go into it. Nothing was written. */
export class OpenPrError extends Error {
  pr: SetupPr;
  constructor(pr: SetupPr) {
    super(`Pull request #${pr.number} changes the workflow already.`);
    this.pr = pr;
  }
}

/** What a file should hold on a branch that holds `current` now. */
function wanted(file: WorkflowFile, current: string | null): string {
  if (file.keep && current !== null) return current;
  if (!file.edit) return file.content;
  if (current === null && file.orAdd) return file.content;
  if (current === null) throw new WorkflowEditError('no-file');
  const next = file.edit(current);
  if (next === null) throw new WorkflowEditError('no-step');
  return next;
}

/** The file a new repo gets. It names the AI that reviews when there's a login to tell, so adding a second login later can't move reviews to the other AI. */
export function withReviewer(content: string, logins: Logins): string {
  if (!logins.claude && !logins.codex) return content;
  return withInputs(content, [['provider', defaultReviewer(logins)]]) ?? content;
}

/**
 * Only a real step counts, so a pin line someone left in a comment isn't mistaken for what runs. A jobs
 * workflow also uses the push step, mergelightai/mergelight/push-jobs, which must move with the review.
 */
const ACTION_USE = /^([ \t]*(?:-[ \t]+)?uses:[ \t]*)["']?mergelightai\/mergelight(\/push-jobs)?@([^\s#"']+)["']?(?:[ \t]*#[ \t]*(\S+))?/m;
/** The note in a new workflow saying why it isn't pinned, which stops being true once it is. */
const NOT_PINNED_NOTE = /^[ \t]*# Not pinned, on purpose[^\n]*\n(?:[ \t]*#[^\n]*\n)*(?=[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?mergelightai\/mergelight(?:\/push-jobs)?@)/gm;

/** The installed version is the review step's. A push-jobs step may come first in the file, and may differ. */
export function readInstalled(content: string): Installed | null {
  const m = [...content.matchAll(new RegExp(ACTION_USE, 'gm'))].find((use) => !use[2]);
  return m ? { ref: m[3]!, version: m[4] ?? null, content } : null;
}

/** Orders releases like v0.1.9 and v0.1.19 by their numbers, not as text. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** A moving tag like v0 gets each release by itself. Only a pinned commit has anything to update. */
export const isPinned = (installed: Installed) => /^[0-9a-f]{40}$/i.test(installed.ref);

/** Says why a workflow is pinned, in place of the note that said why it wasn't. */
const pinnedNote = (note: string) => {
  const indent = note.match(/^[ \t]*/)![0];
  return `${indent}# Pinned to a release, so new code only runs here once you merge an update.\n${indent}# Mergelight says on your pull requests when a new version is out.\n`;
};

/** Points every use of the Action at this ref, like a tag. A tag isn't a pin, so the note about pinning stays. */
export const onRef = (content: string, ref: string) => content.replace(new RegExp(ACTION_USE, 'gm'), (_, before: string, step?: string) => `${before}mergelightai/mergelight${step ?? ''}@${ref}`);

/** Points every use of the Action at this release's commit. The only other change is the note about pinning. */
export function pinned(content: string, release: Release): string {
  return content.replace(NOT_PINNED_NOTE, pinnedNote).replace(new RegExp(ACTION_USE, 'gm'), (_, before: string, step?: string) => `${before}mergelightai/mergelight${step ?? ''}@${release.sha} # ${release.tag}`);
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

export { onlyAi, readConnectCode, type ConnectCode } from './connect';

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
   * `change` says what it's for, which sets its title.
   */
  proposeWorkflows(repo: Repo, branch: string, files: WorkflowFile[], change: Change): Promise<SetupPr | null>;
  /** The open pull request that changes the workflow, once someone has made it. With `base`, only one into that branch. */
  findSetupPr(repo: Repo, base?: string, reviewOnly?: boolean): Promise<SetupPr | null>;
  hasWorkflow(repo: Repo, branch: string): Promise<boolean>;
  /** A workflow at a branch or commit, the review's unless named. Null when it isn't there, and throws when it can't be read. */
  workflowAt(repo: Repo, ref: string, name?: string): Promise<string | null>;
  /**
   * The release of the Action a workflow runs, like v0.1.19: the one its pinned commit or moving tag points at now, or
   * the one it names. Null when that can't be told, like a branch or a commit that's in no release.
   */
  actionVersion(ref: string, comment: string | null): Promise<string | null>;
  /** The commit a release tag of the Action, like v0.1.19, is on now. */
  releaseCommit(tag: string): Promise<string>;
  /**
   * The names of the secrets a run gets, the repo's own and those its organization shares with it. The values can't
   * be read. `complete` is false when a list couldn't be read.
   */
  secrets(repo: Repo): Promise<{ names: string[]; shared: string[]; complete: boolean }>;
  /** The Mergelight check on this commit, if a review has started. */
  checkStatus(repo: Repo, sha: string): Promise<CheckStatus | null>;
  /** The code for connecting ChatGPT and the link for Claude, while the pull request is waiting for someone to use them. */
  connectCode(repo: Repo, number: number): Promise<ConnectCode | null>;
  /** Leaves the code from Claude's page where the waiting run looks for it, out of sight of the pull request. */
  sendClaudeCode(repo: Repo, claudeUrl: string, code: string): Promise<void>;
  /** Removes the sign-in code this page left in the repository, once the run has connected. */
  clearClaudeCode(repo: Repo): Promise<void>;
  /** Whether it's merged, and the commit it's on now. */
  /** Where a PR is: merged or closed, its newest commit, and the branch it goes into. */
  prState(repo: Repo, number: number): Promise<{ merged: boolean; closed: boolean; headSha: string; base: string }>;
}

const WORKFLOWS = '.github/workflows';
const WORKFLOW_PATH = `${WORKFLOWS}/mergelight.yml`;
export const REFRESH_FILE = 'mergelight-refresh.yml';
export const APPROVE_FILE = 'mergelight-approve.yml';
const REFRESH_PATH = `${WORKFLOWS}/${REFRESH_FILE}`;
/** The secrets that can run a review. Only a ChatGPT login has to be refreshed. */
const NO_REFRESH_SECRETS = ['OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const LOGIN_SECRETS = ['CODEX_AUTH_JSON', ...NO_REFRESH_SECRETS];
const SETUP_TITLE = 'Add Mergelight code review';
const SETUP_BODY = [
  'Adds what [Mergelight](https://mergelight.dev) needs to review your pull requests: the review itself, a small job that keeps a ChatGPT login fresh, and one that turns a "needs a human" check green when someone approves the pull request.',
  '',
  "It runs in your own GitHub Actions, on your AI plan. This pull request reviews itself, so you can see what you'll get. Merge it to keep reviews on.",
].join('\n');

const SETUP_CHANGED = 'Update the Mergelight workflow';
const updateTitle = (release: Release) => `Update Mergelight to ${release.tag}`;
/** Scheduled jobs only run from the default branch, so a job added to another branch says so. */
const refreshNote = (repo: Repo, branch: string) => ` It also adds a small job that keeps a ChatGPT login fresh.${branch === repo.defaultBranch ? '' : ` That job only runs on a schedule from ${repo.defaultBranch}, so merge it there too.`}`;
/** A job an update adds where it was missing. */
const APPROVE_NOTE = ' It also adds a small job that turns a "needs a human" check green when someone approves the pull request.';
/** What an update changes in the review workflow besides its version lines. */
const COMMENTS_NOTE =
  ' The review workflow also gets the trigger that lets a pull request comment that mentions @mergelight-ai answer the findings, which reviews it again: one more event, its part of the condition, and a concurrency group per comment.';
const updateBody = (release: Release, notes: { refresh: string; approve: string; comments: string }) =>
  `Moves the workflow to [${release.tag}](https://github.com/mergelightai/mergelight/releases/tag/${release.tag}), pinned to its exact commit. ${notes.comments ? 'Besides the Mergelight version lines, one thing changes.' : 'Only the Mergelight version lines change.'}${notes.comments}${notes.refresh}${notes.approve} This pull request reviews itself with the new version.`;
/** Says nothing about which AI, so it stays true when a second change lands on the same pull request. */
const ROLES_TITLE = 'Set who reviews and who checks in Mergelight';
const rolesBody = (refresh: string) =>
  [
    `Sets which AI reviews your pull requests in [Mergelight](https://mergelight.dev), and which AI checks what the review found. Only the \`provider\` and \`verify-with\` lines in the workflow change.${refresh}`,
    '',
    'This pull request is reviewed the new way, so you can see it work. Merge it to keep it.',
  ].join('\n');
/** The commit says which AI, since each change is its own commit. */
const rolesCommit = (roles: Roles) => (roles.reviewer === roles.checker ? `Review and check with ${aiName(roles.reviewer)}` : `Review with ${aiName(roles.reviewer)}, check with ${aiName(roles.checker)}`);
/** For roles that are set already, whose ChatGPT login has no job to keep it fresh yet. */
const REFRESH_TITLE = 'Keep the ChatGPT login fresh for Mergelight';
const refreshBody = (repo: Repo, branch: string) =>
  [
    `Adds a small job that keeps the ChatGPT login [Mergelight](https://mergelight.dev) uses fresh, so reviews don't have to. The review workflow doesn't change.${branch === repo.defaultBranch ? '' : ` That job only runs on a schedule from ${repo.defaultBranch}, so merge it there too.`}`,
    '',
    'Merge it to keep it.',
  ].join('\n');
const commitFor = (change: Change) => (change.kind === 'update' ? updateTitle(change.release) : change.kind === 'roles' ? rolesCommit(change.roles) : change.kind === 'refresh' ? REFRESH_TITLE : SETUP_CHANGED);

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

/** A link from a pull request that's waiting for Claude. It only says where to go: the page still needs that repo in the person's own list. */
export interface ConnectLink {
  repo: string;
  pr: number;
}

export function readConnectLink(params: URLSearchParams): ConnectLink | null {
  const repo = params.get('repo') ?? '';
  const pr = Number(params.get('pr'));
  return params.get('connect') === 'claude' && /^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isInteger(pr) && pr > 0 ? { repo, pr } : null;
}

/** Keeps the link for the trip to GitHub, which only hands back the sign-in. */
export function rememberConnect(link: ConnectLink): void {
  try {
    sessionStorage.setItem(CONNECT_KEY, JSON.stringify(link));
  } catch {
    /* Without storage they just pick the repo themselves. */
  }
}

export function takeRememberedConnect(): ConnectLink | null {
  try {
    const raw = sessionStorage.getItem(CONNECT_KEY);
    sessionStorage.removeItem(CONNECT_KEY);
    return raw ? (JSON.parse(raw) as ConnectLink) : null;
  } catch {
    return null;
  }
}

/** Must name the same place as `claudeCodeRef` in the Action. The browser test holds the two together. */
function claudeCodeRef(claudeUrl: string): string | null {
  try {
    const state = new URL(claudeUrl).searchParams.get('state') ?? '';
    return /^[\w-]{20,200}$/.test(state) ? `mergelight/claude-code/s${state}` : null;
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
  /** The sign-in code this page left in each repository, until it's removed. */
  const ownCodes = new Map<string, string>();
  /** Removes that code, and only that one: someone else may be connecting the same repository right now. */
  const clearClaudeCode = async (repo: Repo): Promise<void> => {
    const name = ownCodes.get(repo.fullName);
    if (!name) return;
    ownCodes.delete(repo.fullName);
    await call('DELETE', `/repos/${repo.fullName}/git/refs/${name}`).catch(() => undefined);
  };
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
  /** The Action's tags, a page at a time, each read once: they say which release a commit or a moving tag is. */
  const tagPages: Promise<{ name: string; commit: { sha: string } }[]>[] = [];
  const tagPage = (n: number) =>
    (tagPages[n] ??= get<{ name: string; commit: { sha: string } }[]>(`/repos/${ACTION_REPO}/tags?per_page=100&page=${n + 1}`).catch((err) => {
      // A page that couldn't be read is asked for again next time.
      delete tagPages[n];
      throw err;
    }));
  /** The tags on a commit, a page further each time none is, until one is or there are no more. */
  const tagsAt = async (sha: string) => {
    for (let n = 0; n < TAG_PAGES; n++) {
      const page = await tagPage(n).catch(() => []);
      const names = page.filter((t) => t.commit.sha === sha).map((t) => t.name);
      if (names.length || page.length < 100) return names;
    }
    return [];
  };
  const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
  /** The newest release among these tags. */
  const newest = (names: string[]) => names.filter((n) => RELEASE_TAG.test(n)).sort(compareVersions).at(-1) ?? null;
  const actionVersion = async (ref: string, comment: string | null): Promise<string | null> => {
    if (RELEASE_TAG.test(ref)) return ref;
    // A pinned commit is the release whose tag points at it. Its comment can be left over from another pin.
    if (/^[0-9a-f]{40}$/i.test(ref)) return newest(await tagsAt(ref));
    // A moving tag is the release it points at now.
    if (/^v\d+$/.test(ref)) {
      const sha = await get<{ sha: string }>(`/repos/${ACTION_REPO}/commits/${encodeURIComponent(ref)}`).then((c) => c.sha, () => null);
      return sha ? newest(await tagsAt(sha)) : null;
    }
    return null;
  };
  const releaseCommit = async (tag: string) => (await get<{ sha: string }>(`/repos/${ACTION_REPO}/commits/${encodeURIComponent(tag)}`)).sha;
  /**
   * The release @v0 is on. A new release first runs its canary, and roll-out.yml moves @v0 to it only once that passed,
   * so this is the newest release cleared for everyone. A newer one is skipped: its canary is still running, or failed.
   * New repos are pinned to this one, and an update moves a repo to it, the same as `mergelight setup` does.
   */
  const rolledOutRelease = async (): Promise<Release> => {
    const { sha } = await get<{ sha: string }>(`/repos/${ACTION_REPO}/commits/v0`);
    const tag = newest(await tagsAt(sha));
    if (!tag) throw new Error("No release tag is on @v0's commit.");
    return { tag, sha };
  };
  /** With `base`, only one into that branch: a change made on one into another branch would never reach this one. */
  /** Whether a pull request changes a Mergelight workflow, looking through all its files a page at a time. */
  /** Which Mergelight workflows a pull request changes, looking through all its files a page at a time. */
  const workflowsChanged = async (repo: Repo, number: number) => {
    const changed = { review: false, refresh: false };
    for (let page = 1; ; page++) {
      // A list that can't be read stops whoever asked: an unread PR may change the workflow already.
      const files = await get<{ filename: string }[]>(`/repos/${repo.fullName}/pulls/${number}/files?per_page=100&page=${page}`);
      for (const f of files) {
        if (f.filename === WORKFLOW_PATH) changed.review = true;
        if (f.filename === REFRESH_PATH) changed.refresh = true;
      }
      if (files.length < 100) return changed;
    }
  };
  /** Which workflows each pull request changes, by its number and commits. */
  const changedAt = new Map<string, { review: boolean; refresh: boolean }>();
  /**
   * Every open pull request, a page at a time, so one far down the list is still found. Each one's files cost a request,
   * so past PULLS_CHECKED of them the scan stops: a repo with that many open PRs is told so, rather than having its
   * hourly GitHub requests used up.
   */
  const openSetupPull = async (repo: Repo, base?: string, reviewOnly = false) => {
    const into = base ? `&base=${encodeURIComponent(base)}` : '';
    let checked = 0;
    for (let page = 1; ; page++) {
      const pulls = await get<{ number: number; html_url: string; title: string; base: { ref: string; sha?: string }; head: { sha: string; ref: string; repo: { full_name: string } | null } }[]>(`/repos/${repo.fullName}/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page}${into}`);
      for (const pull of pulls) {
        // A fork's pull request isn't ours to update.
        if (pull.head.repo?.full_name !== repo.fullName) continue;
        if (base && pull.base?.ref !== base) continue;
        if (++checked > PULLS_CHECKED) throw new ScanLimitError();
        // The same commits change the same files, so a look made again, like each check while setup waits, reads only
        // the PRs that are new or have new commits.
        const key = `${repo.fullName}#${pull.number} ${pull.head.sha} ${pull.base.sha ?? ''}`;
        const changed = changedAt.get(key) ?? (await workflowsChanged(repo, pull.number));
        changedAt.set(key, changed);
        // One that changes only the refresh job is told apart by its files, whatever it's called.
        // `reviewOnly` is for finding the PR that installs the review: one with only the refresh job doesn't.
        if (changed.review || (!reviewOnly && changed.refresh)) return { ...pull, refreshOnly: changed.refresh && !changed.review };
      }
      if (pulls.length < 100) return null;
    }
  };
  const findSetupPr = async (repo: Repo, base?: string, reviewOnly = false): Promise<SetupPr | null> => {
    const pull = await openSetupPull(repo, base, reviewOnly);
    return pull && { number: pull.number, url: pull.html_url, headSha: pull.head.sha };
  };
  /** Each workflow file's text, by its id, so a copy on many branches is read once. */
  const blobs = new Map<string, Promise<string>>();
  /**
   * The workflow files on a branch that run the Mergelight review, the refresh job aside. None on a branch that isn't
   * there or has no workflows. A list or a file that couldn't be read stops whoever asked.
   */
  const reviewFilesOn = async (repo: Repo, branch: string): Promise<string[]> => {
    let entries: { name: string; sha: string; type: string }[];
    try {
      entries = await get(`/repos/${repo.fullName}/contents/${WORKFLOWS}?ref=${encodeURIComponent(branch)}`);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return [];
      throw err;
    }
    if (!Array.isArray(entries)) return [];
    const files = entries.filter((e) => e.type === 'file' && /\.ya?ml$/i.test(e.name) && e.name !== REFRESH_FILE);
    const runs = await Promise.all(
      files.map(async ({ name, sha }) => {
        const text = blobs.get(sha) ?? get<{ content: string }>(`/repos/${repo.fullName}/git/blobs/${sha}`).then((b) => fromBase64(b.content));
        blobs.set(sha, text);
        text.catch(() => blobs.delete(sha));
        const content = await text;
        // The approval workflow uses the Action too, but only when someone approves, never to review.
        return readInstalled(content) && reviewsPullRequests(content) ? name : null;
      }),
    );
    return runs.filter((name): name is string => name !== null);
  };
  /** The branches open PRs go into, a page at a time. Null past OPEN_PAGES pages, which may leave one out. */
  const openBases = async (repo: Repo): Promise<string[] | null> => {
    const bases = new Set<string>();
    for (let page = 1; page <= OPEN_PAGES; page++) {
      const pulls = await get<{ base: { ref: string } }[]>(`/repos/${repo.fullName}/pulls?state=open&per_page=100&page=${page}`);
      for (const pull of pulls) bases.add(pull.base.ref);
      if (pulls.length < 100) return [...bases];
    }
    return null;
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
  /**
   * The names of the secrets a run gets: the repo's own, and those its organization shares with it. `complete` is
   * false when a list couldn't be read. GitHub answers 422 for the organization's list on a repo a person owns.
   */
  const secretNames = async (repo: Repo): Promise<{ names: string[]; shared: string[]; complete: boolean }> => {
    const names = (path: string) => get<{ secrets: { name: string }[] }>(`/repos/${repo.fullName}/actions/${path}?per_page=100`).then(({ secrets }) => secrets.map((s) => s.name));
    const [own, org] = await Promise.all([names('secrets').catch(() => null), names('organization-secrets').catch((err) => (err instanceof GitHubError && err.status === 422 ? [] : null))]);
    // A secret of the repo's own wins over the organization's of the same name.
    const shared = (org ?? []).filter((n) => !own?.includes(n));
    return { names: [...(own ?? []), ...shared], shared, complete: own !== null && org !== null };
  };

  return {
    repos: async () => {
      const { installations } = await get<{ installations: { id: number; html_url: string; account: { id: number; login: string; avatar_url: string } }[] }>('/user/installations?per_page=100');
      const lists = await Promise.all(
        installations.map(async (install) => {
          const { repositories } = await get<{ repositories: { id: number; full_name: string; private: boolean; visibility?: string; default_branch: string; archived: boolean }[] }>(`/user/installations/${install.id}/repositories?per_page=100`);
          return repositories
            .filter((r) => !r.archived)
            .map((r): Repo => ({ id: r.id, fullName: r.full_name, account: install.account.login, accountId: install.account.id, avatarUrl: install.account.avatar_url, isPrivate: r.private, visibility: r.visibility === 'internal' || r.visibility === 'public' || r.visibility === 'private' ? r.visibility : r.private ? 'private' : 'public', defaultBranch: r.default_branch, accessUrl: install.html_url }));
        }),
      );
      return lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
    },
    details: async (repo) => {
      const [branches, recent, open, seen, release, reviewApp] = await Promise.all([
        get<{ name: string }[]>(`/repos/${repo.fullName}/branches?per_page=100`),
        get<{ base: { ref: string }; head: { ref: string } }[]>(`/repos/${repo.fullName}/pulls?state=all&per_page=50`).catch(() => null),
        openBases(repo).catch(() => null),
        secretNames(repo),
        rolledOutRelease().catch(() => null),
        reviewAppInstalled(repo).catch(() => null),
      ]);
      const names = branches.map((b) => b.name);
      const pulls = recent ?? [];
      const base = pickBase(pulls.map((p) => ({ base: p.base.ref, head: p.head.ref })), repo.defaultBranch);
      // Branches PRs go into: the long-lived ones, and the base of each open or recent PR, like a release branch or a
      // stacked PR's. A feature branch that only holds a copy of the workflow has no PRs into it, so it never counts.
      const others = [...new Set([...LONG_LIVED_BRANCHES, repo.defaultBranch, ...pulls.map((p) => p.base.ref), ...(open ?? [])])].filter((b) => b !== base);
      const [onBase, refresh, approve, elsewhere] = await Promise.all([
        workflowOn(repo, base),
        workflowOn(repo, base, REFRESH_FILE),
        workflowOn(repo, base, APPROVE_FILE),
        // Each branch is asked for by itself, so a big repo's branches past the first page count too. Workflows that
        // couldn't be read may have a review.
        Promise.all(
          [base, ...others].map((branch) =>
            reviewFilesOn(repo, branch).then(
              (files) => files.filter((file) => branch !== base || file !== 'mergelight.yml').map((file) => ({ branch, file })),
              () => [{ branch, file: null }],
            ),
          ),
        ),
      ]);
      const secrets = seen.names;
      const installed = onBase && readInstalled(onBase.content);
      return {
        branches: names.includes(base) ? names : [base, ...names],
        base,
        skip: pickSkip(names),
        hasLogin: secrets.some((n) => LOGIN_SECRETS.includes(n)),
        secretNames: secrets,
        sharedSecrets: seen.shared,
        allSecretsSeen: seen.complete,
        hasApiKey: secrets.some((n) => NO_REFRESH_SECRETS.includes(n)),
        installed,
        refresh: refresh?.content ?? null,
        approve: approve?.content ?? null,
        otherReviews: elsewhere.flat(),
        branchesKnown: recent !== null && open !== null,
        release,
        reviewApp,
      };
    },
    proposeWorkflows: async (repo, branch, files, change) => {
      const r = `/repos/${repo.fullName}`;
      const update = change.kind === 'update' ? change.release : null;
      /**
       * What each file should hold on this branch, all worked out before anything is written, so a change that can't be
       * made writes nothing at all.
       */
      const plan = async (head: string) => {
        const current = await Promise.all(files.map((f) => workflowOn(repo, head, f.name)));
        const planned = files.map((file, i) => ({ file, current: current[i] ?? null, content: wanted(file, current[i]?.content ?? null) }));
        const review = planned.find(({ file }) => file.name === 'mergelight.yml')?.content;
        return planned.filter(({ file, current }) => !(file.addIf && !current && review !== undefined && !file.addIf(review)));
      };
      type Plan = Awaited<ReturnType<typeof plan>>;
      /** Writes the files that differ on this branch. Returns the last commit, if anything changed. */
      const write = async (head: string, message: string, planned: Plan): Promise<string | null> => {
        let commit: string | null = null;
        for (const { file, current, content } of planned) {
          if (current?.content === content) continue;
          const done = await call<{ commit: { sha: string } }>('PUT', `${r}/contents/${WORKFLOWS}/${file.name}`, {
            message,
            content: toBase64(content),
            branch: head,
            ...(current ? { sha: current.sha } : {}),
          });
          commit = done.commit.sha;
        }
        return commit;
      };

      // One that's open already gets brought up to date, however old the version it was opened with.
      const open = await openSetupPull(repo, branch);
      if (open) {
        // A change of AI is a pull request of its own, and an update never goes into one: each says only what it changes.
        if (change.kind === 'roles' || change.kind === 'refresh' || (change.kind === 'update' && (open.refreshOnly || open.title === ROLES_TITLE || open.title === REFRESH_TITLE))) throw new OpenPrError({ number: open.number, url: open.html_url, headSha: open.head.sha });
        const planned = await plan(open.head.ref);
        const commit = await write(open.head.ref, commitFor(change), planned);
        return { number: open.number, url: open.html_url, headSha: commit ?? open.head.sha };
      }

      // A change that can't be made stops here, before there's a branch to clean up. A new branch starts with what this one holds.
      // The commit the new branch starts from is the one checked, so a change pushed in between can't slip past.
      const base = await get<{ object: { sha: string } }>(`${r}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      const planned = await plan(base.object.sha);
      if (planned.every(({ current, content }) => current?.content === content)) return null;
      const title = update ? updateTitle(update) : change.kind === 'roles' ? ROLES_TITLE : change.kind === 'refresh' ? REFRESH_TITLE : SETUP_TITLE;
      const head = `mergelight-setup-${Date.now().toString(36)}`;
      await call('POST', `${r}/git/refs`, { ref: `refs/heads/${head}`, sha: base.object.sha });
      try {
        await write(head, change.kind === 'roles' || change.kind === 'refresh' ? commitFor(change) : title, planned);
        // A file the branch doesn't have yet is one this pull request adds.
        const adds = (name: string) => planned.some(({ file, current }) => file.name === name && !current);
        const refresh = adds(REFRESH_FILE) ? refreshNote(repo, branch) : '';
        const review = planned.find(({ file }) => file.name === 'mergelight.yml');
        // GitHub runs a comment's workflow from the default branch, so on another branch the trigger waits for that.
        const comments = review?.current && !hasCommentTrigger(review.current.content) && hasCommentTrigger(review.content) ? `${COMMENTS_NOTE}${branch === repo.defaultBranch ? '' : ` GitHub runs that trigger from ${repo.defaultBranch}, so it works once this change is there too.`}` : '';
        const notes = { refresh, approve: adds(APPROVE_FILE) ? APPROVE_NOTE : '', comments };
        const body = update ? updateBody(update, notes) : change.kind === 'roles' ? rolesBody(refresh) : change.kind === 'refresh' ? refreshBody(repo, branch) : SETUP_BODY;
        const pull = await call<{ number: number; html_url: string; head: { sha: string } }>('POST', `${r}/pulls`, { title, head, base: branch, body });
        return { number: pull.number, url: pull.html_url, headSha: pull.head.sha };
      } catch (err) {
        // Don't leave an empty branch behind in their repo.
        await call('DELETE', `${r}/git/refs/heads/${head}`).catch(() => undefined);
        throw err;
      }
    },
    findSetupPr,
    hasWorkflow,
    workflowAt: async (repo, ref, name) => (await workflowOn(repo, ref, name))?.content ?? null,
    actionVersion,
    releaseCommit,
    secrets: secretNames,
    checkStatus: async (repo, sha) => {
      const { check_runs } = await get<{ check_runs: { status: string; conclusion: string | null; output: { title: string | null } }[] }>(`/repos/${repo.fullName}/commits/${sha}/check-runs?check_name=Mergelight`);
      const latest = check_runs[0];
      return latest ? { status: latest.status, conclusion: latest.conclusion, title: latest.output.title } : null;
    },
    sendClaudeCode: async (repo, claudeUrl, code) => {
      const name = claudeCodeRef(claudeUrl);
      if (!name) throw new GitHubError(422);
      const git = `/repos/${repo.fullName}/git`;
      // Anything left from an earlier sign-in is spent, so a tab closed early never leaves more than one behind.
      const left = await get<{ ref: string }[]>(`${git}/matching-refs/mergelight/claude-code/`).catch(() => []);
      await Promise.all(left.map((r) => call('DELETE', `${git}/${r.ref}`).catch(() => undefined)));
      const { sha } = await call<{ sha: string }>('POST', `${git}/blobs`, { content: code, encoding: 'utf-8' });
      await call('POST', `${git}/refs`, { ref: `refs/${name}`, sha });
      ownCodes.set(repo.fullName, name);
      // A newer code for the same repository has its own timer, so this one only removes what it left.
      setTimeout(() => void (ownCodes.get(repo.fullName) === name && clearClaudeCode(repo)), CODE_REF_LIFETIME_MS);
    },
    clearClaudeCode,
    connectCode: async (repo, number) => readConnectCode(await get<{ user: { login: string } | null; body?: string | null }[]>(`/repos/${repo.fullName}/issues/${number}/comments?per_page=100`)),
    prState: async (repo, number) => {
      const pull = await get<{ merged: boolean; state?: string; head: { sha: string }; base: { ref: string } }>(`/repos/${repo.fullName}/pulls/${number}`);
      return { merged: pull.merged, closed: pull.state === 'closed' && !pull.merged, headSha: pull.head.sha, base: pull.base.ref };
    },
  };
}

/** Local development only: `?mock` runs the whole flow on made-up data. Not in the built site. */
export function mockClient(): GitHubClient {
  const accessUrl = 'https://github.com/organizations/acme/settings/installations/1';
  const avatarUrl = '/logo.png';
  const repo = (name: string, isPrivate = true): Repo => ({ id: name.length, fullName: `acme/${name}`, account: 'acme', accountId: 1, avatarUrl, isPrivate, visibility: isPrivate ? 'private' : 'public', defaultBranch: 'main', accessUrl });
  let finds = 0;
  let checks = 0;
  /** The branch the demo's PR goes into: the one it was opened into here. */
  let prBase = 'main';
  const later = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 300));
  const release: Release = { tag: 'v0.2.0', sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' };
  // Both logins' inputs, as setup writes them, so a repo with both secrets can try every change of AI.
  const workflowWith = (use: string, inputs = '') => `name: Mergelight\n\njobs:\n  review:\n    steps:\n      - uses: mergelightai/mergelight@${use}\n        with:\n          codex-auth-json: \${{ secrets.CODEX_AUTH_JSON }}\n          claude-code-oauth-token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n${inputs}`;
  const installedFor = (name: string): Installed | null =>
    name === 'acme/app'
      ? readInstalled(workflowWith(`${release.sha} # ${release.tag}`))
      : name === 'acme/old' || name === 'acme/claude'
        ? readInstalled(workflowWith('v0'))
        : name === 'acme/both'
          ? readInstalled(workflowWith('v0', '          provider: claude\n'))
          : name === 'acme/behind'
            ? readInstalled(workflowWith('0123456789012345678901234567890123456789 # v0.1.0'))
            : null;
  // acme/claude is live with only a Claude login, and acme/both is live with both.
  const loginsOf = (name: string): Logins => ({ claude: name === 'acme/claude' || name === 'acme/both', codex: ['acme/platform', 'acme/old', 'acme/behind', 'acme/both'].includes(name) });
  const namesOf = (name: string, more: string[] = []) => [...(loginsOf(name).claude ? ['CLAUDE_CODE_OAUTH_TOKEN'] : []), ...(loginsOf(name).codex ? ['CODEX_AUTH_JSON'] : []), ...more];
  return {
    repos: () => later([repo('api'), repo('app'), repo('behind'), repo('both'), repo('claude'), repo('docs', false), repo('old'), repo('platform'), repo('site')]),
    // acme/docs plays a repo that has only the setup app so far.
    details: (r) =>
      later<RepoDetails>({ reviewApp: r.fullName !== 'acme/docs', ...(
        r.fullName === 'acme/docs'
          ? { branches: ['main'], base: 'main', skip: ['main'], hasLogin: false, secretNames: namesOf(r.fullName), sharedSecrets: [], otherReviews: [], branchesKnown: true, allSecretsSeen: true, hasApiKey: false, installed: null, refresh: null, approve: null, release }
          : r.fullName === 'acme/site'
          ? { branches: ['main', 'feat/new-landing'], base: 'main', skip: ['main'], hasLogin: false, secretNames: namesOf(r.fullName), sharedSecrets: [], otherReviews: [], branchesKnown: true, allSecretsSeen: true, hasApiKey: false, installed: null, refresh: null, approve: null, release }
          : {
              branches: ['main', 'staging', 'development', 'feat/billing-export', 'fix/invoice-rounding'],
              base: 'staging',
              skip: ['main', 'staging', 'development'],
              hasLogin: loginsOf(r.fullName).claude || loginsOf(r.fullName).codex,
              hasApiKey: loginsOf(r.fullName).claude,
              secretNames: namesOf(r.fullName),
              sharedSecrets: [],
              otherReviews: [],
              branchesKnown: true,
              allSecretsSeen: true,
              installed: installedFor(r.fullName),
              refresh: null,
              approve: null,
              release,
            }) }),
    // acme/site plays an install that hasn't approved the access, to show the way around it.
    proposeWorkflows: (r, branch) => {
      prBase = branch;
      return r.fullName === 'acme/site' ? Promise.reject(new GitHubError(403)) : new Promise((done) => setTimeout(() => done({ number: 128, url: 'https://github.com/acme/api/pull/128', headSha: 'abc' }), 900));
    },
    findSetupPr: (_, base) => later(!base && ++finds > 1 ? { number: 128, url: 'https://github.com/acme/api/pull/128', headSha: 'abc' } : null),
    hasWorkflow: () => later(false),
    workflowAt: (r, _, name) => later(name ? null : (installedFor(r.fullName)?.content ?? null)),
    actionVersion: (ref, comment) => later(comment ?? (ref === 'v0' ? release.tag : null)),
    releaseCommit: () => later(release.sha),
    // ChatGPT shows up on acme/claude once its code has been used, like a run saving the login.
    secrets: (r) => later({ names: namesOf(r.fullName, r.fullName === 'acme/claude' && checks >= 4 ? ['CODEX_AUTH_JSON'] : []), shared: [], complete: true }),
    checkStatus: () => {
      checks += 1;
      if (checks < 2) return later(null);
      if (checks < 4) return later({ status: 'in_progress', conclusion: null, title: 'Waiting for you to connect ChatGPT' });
      if (checks < 7) return later({ status: 'in_progress', conclusion: null, title: 'Reviewing' });
      return later({ status: 'completed', conclusion: 'neutral', title: '🔴 Blocked: 2 bugs, 1 risk to fix' });
    },
    sendClaudeCode: () => later(undefined),
    clearClaudeCode: () => later(undefined),
    connectCode: () => later(checks < 4 ? { url: 'https://auth.openai.com/codex/device', code: '2ZYY-TEST1', claudeUrl: 'https://claude.com/cai/oauth/authorize?code_challenge=x', purpose: 'review' } : null),
    prState: () => later({ merged: checks >= 11, closed: false, headSha: 'abc', base: prBase }),
  };
}
