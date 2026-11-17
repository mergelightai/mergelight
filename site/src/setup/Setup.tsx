import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { siClaude } from 'simple-icons';
import workflowFile from '../../../examples/mergelight.yml?raw';
import refreshFile from '../../../examples/mergelight-refresh.yml?raw';
import approveFile from '../../../examples/mergelight-approve.yml?raw';
import { hasCommentTrigger, withCommentTrigger } from './comment-trigger';
import { OPENAI_PATH } from '../brandIcons';
import Ambient from '../sections/Ambient';
import { Check, GitHubIcon, SURFACE, WELL } from '../ui';
import type { ConnectLink } from './github';
import { compareVersions, cleanUrl, finishSignIn, GitHubError, INSTALL_URL, onlyAi, onRef, OpenPrError, ScanLimitError, readConnectLink, readInstalled, rememberConnect, rememberRepo, reviewAppUrl, takeRememberedConnect, takeRememberedRepo, isPinned, mockClient, pinned, realClient, APPROVE_FILE, REFRESH_FILE, signInUrl, wakeTokenServer, withReviewer, WorkflowEditError, type CheckStatus, type ConnectCode, type GitHubClient, type Release, type Repo, type RepoDetails, type SetupPr, type WorkflowFile } from './github';
import { aiName, connectsAfterMerge, isStandard, readsPlanLogin, runsOnBase, waitsForBase, LOGIN_INPUTS, LOGIN_SECRET, loginInputs, loginsFrom, loginsIn, otherAi, passesLogin, readRoles, reviewerFixedBy, rolesFor, withInputs, withoutInputs, withRoles, type Ai, type Logins, type Roles } from './roles';

const CHATGPT_SECURITY = 'https://chatgpt.com/settings/security';
/** Where the Action's docs say how provider and verify-with work, for a workflow set by hand. */
const ROLES_DOCS = '/docs/github-action/#two-ais-one-reviews-the-other-checks';
/** The review workflow as it is now, with the trigger for answering in a comment, for one that gets it by hand. */
const EXAMPLE_WORKFLOW = 'https://github.com/mergelightai/mergelight/blob/main/examples/mergelight.yml';
const TYPES_MARKER = 'types: [opened, synchronize, reopened, ready_for_review, edited]';
const SKIP_MARKER = 'github.event.pull_request.head.repo.full_name == github.repository';
const SPRING = { type: 'spring', bounce: 0, duration: 0.45 } as const;
const OPENAI_MARK = { path: OPENAI_PATH, color: '#10A37F' };
const CLAUDE_MARK = { path: siClaude.path, color: '#D97757' };
const AI_MARK: Record<Ai, { path: string; color: string }> = { claude: CLAUDE_MARK, codex: OPENAI_MARK };

/** What gets reviewed. New work is PRs into one branch, without merges from the other long-lived ones. */
type Scope = 'new' | 'all';

function workflowFor(scope: Scope, branch: string, longLived: string[]): string {
  if (scope === 'all') return workflowFile;
  // GitHub reads + and ! in a branch filter as a pattern.
  const filter = JSON.stringify(branch.replace(/[+!]/g, '\\$&'));
  const skip = longLived.filter((b) => b !== branch);
  const scoped = workflowFile.replace(TYPES_MARKER, () => `${TYPES_MARKER}\n    branches: [${filter}]`);
  if (!skip.length) return scoped;
  return scoped.replace(SKIP_MARKER, () => `${SKIP_MARKER} &&\n      !contains(fromJSON('${JSON.stringify(skip)}'), github.head_ref)`);
}

/** A small count in words, as the page's sentences say it. */
const countWord = (n: number) => ['no', 'one', 'two', 'three', 'four'][n] ?? String(n);

/** The commit a review's release tag is on couldn't be read, so no refresh job can be pinned to it. */
class TagError extends Error {}

/** The job that keeps a ChatGPT login fresh, on the same version of the Action as the review. */
const refreshJob = (pin: Release | null) => (pin ? pinned(refreshFile, pin) : refreshFile);

/** The same job, on whichever version this review workflow runs: the same commit, or the same tag. */
function refreshLike(review: string): string {
  const live = readInstalled(review);
  if (!live) return refreshFile;
  return isPinned(live) ? pinned(refreshFile, { sha: live.ref, tag: live.version ?? live.ref.slice(0, 7) }) : onRef(refreshFile, live.ref);
}

/** GitHub's own editor, already filled in. Nothing is written until the person commits it there. */
function newFileUrl(repo: string, branch: string, content: string): string {
  const path = branch.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/new/${path}?filename=.github/workflows/mergelight.yml&value=${encodeURIComponent(content)}`;
}

const WIDE = '(min-width: 1160px)';
/** Whether there's room for the file beside the card. */
function useWide(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(WIDE);
      media.addEventListener('change', changed);
      return () => media.removeEventListener('change', changed);
    },
    () => window.matchMedia(WIDE).matches,
  );
}

type View = 'welcome' | 'settling' | 'repo' | 'review-app' | 'add' | 'finish' | 'connect' | 'live' | 'roles';
const ORDER: View[] = ['welcome', 'settling', 'repo', 'review-app', 'add', 'finish', 'connect', 'live', 'roles'];
/** Where each view sits on the rail. Add and finish are the same step to the person. Choosing the AI is for a repo that's on. */
const RAIL: Record<View, number> = { welcome: 0, settling: 1, repo: 1, 'review-app': 1, add: 2, finish: 2, connect: 3, live: 4, roles: 4 };

/** Why a change of AI didn't open a pull request. */
/** Why the roles can't be changed here: set up its own way, another branch reviews, not all branches or secrets seen, no login, or the version. */
type RolesLock = 'custom' | 'branches' | 'unchecked' | 'secrets' | 'none' | 'checking' | 'old';
type RolesFailure = 'no-file' | 'no-step' | 'changed' | 'scan' | 'refused' | 'tag' | 'other';

/** Why nothing was proposed in a repo with more open PRs than are looked through. */
const SCAN_NOTE = 'This repo has more open PRs than we look through for one that changes your Mergelight workflow, so nothing was changed.';

/**
 * The first release of the Action that has two AIs: a checker that's connected, or stood in for, when it has no login.
 * An older one can't do what choosing who checks here asks of it.
 */
const MIN_ACTION_VERSION = 'v0.1.19';
/** How many times the release a workflow runs is looked up when it can't be told. */
const VERSION_TRIES = 4;

/** No login at all: what counts while the workflow a connection is for is still being read. */
const NO_LOGINS: Logins = { claude: false, codex: false };
/** The secret that holds a ChatGPT plan's login. */
const CHATGPT_SECRET = LOGIN_SECRET[LOGIN_INPUTS.codex[0]]!;
/** Why a repo whose organization shares a ChatGPT login saves one of its own. */
const SHARED_LOGIN_NOTE = "Your organization's ChatGPT login is shared, so this repo gets its own.";
/**
 * Whether a workflow reads the ChatGPT plan's login from CODEX_AUTH_JSON and saves it back there, the login the refresh
 * job keeps fresh. Without a workflow yet, the one setup writes does.
 */
const readsChatgpt = (file: string | null | undefined) => !file || readsPlanLogin(file);

/** Why a ChatGPT login is saved from the person's own computer: no code comes for it on a pull request. */
type CommandWhy = 'public' | 'internal' | 'shared' | 'hold' | 'base';

/** Who could enter a ChatGPT code shown on a pull request of a repo that isn't private. */
const seenBy = (visibility: Repo['visibility']) => (visibility === 'internal' ? 'This repo is internal, so anyone in your enterprise who can see your PR' : 'This repo is public, so anyone who can see your PR');
/**
 * A change of AI matched to the workflow that merged, which someone may have edited on GitHub first: it connects the
 * AIs that workflow uses once they have a login, and passes a login to. Its logins are the ones that workflow reads,
 * from the secrets there now, as an edit can take out the input a secret was read by.
 */
function reconciled(change: RolesChange, merged: string, names: string[], shared: string[]): RolesChange {
  const set = readRoles(merged);
  const logins = loginsIn(merged, names);
  const own = loginsIn(merged, names, shared);
  const uses = (ai: Ai) => {
    if (!set || !passesLogin(merged, ai)) return false;
    const r = rolesFor(set, { ...logins, [ai]: true });
    return r.reviewer === ai || r.checker === ai;
  };
  // Worked out again each time, so an AI an edit names comes in too, like one an earlier commit took out and this
  // one puts back. One only a default would use, once it had a login, isn't needed unless it was chosen.
  const named = (ai: Ai) => change.needs.includes(ai) || set?.provider === ai || set?.verifyWith === ai;
  const missing = (['claude', 'codex'] as const).filter((ai) => !own[ai] && named(ai) && uses(ai));
  const all = { ...logins, ...Object.fromEntries(missing.map((ai) => [ai, true])) } as Logins;
  const roles = set ? rolesFor(set, all) : change.roles;
  // The reviewer first, as a run connects it first.
  const needs = missing.filter((ai) => ai === roles.reviewer).concat(missing.filter((ai) => ai !== roles.reviewer));
  // Merging first holds until the PR is merged, whatever edits it gets. A workflow that leaves the checker to the
  // default has no run that asks for it, so that login comes from the command.
  return { ...change, content: merged, needs, roles, connectFirst: false, implicit: Boolean(set && !set.verifyWith && needs.length) };
}

/** A pull request that changes who reviews and who checks, and the AIs it still needs a login for. */
interface RolesChange {
  roles: Roles;
  content: string;
  /** Every chosen AI without a login of the repo's own, in the order they connect: a run connects one at a time. */
  needs: Ai[];
  /**
   * The pull request opens only once ChatGPT has a login of the repo's own. The organization's can't be refreshed here
   * without signing out the other repos, so nothing this page opens uses it first.
   */
  connectFirst: boolean;
  /** It adds the job that keeps a ChatGPT login fresh. */
  addsRefresh: boolean;
  /** The login waits until the pull request is merged, as one saved before that would move reviews on the branch. */
  hold: boolean;
  /**
   * The AIs whose login waits until the pull request is merged, as its own run can't ask for them: on
   * pull_request_target it runs the workflow the branch has now. The PR keeps every role chosen.
   */
  onBase: Ai[];
  /** The workflow leaves the checker to the default, so no run asks for its login: it comes from the command. */
  implicit: boolean;
  /** What merged was read from the branch, which is what says a held login is safe to save. */
  mergedRead?: boolean;
}

export default function Setup() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const requested = params.get('setup_action') === 'request';
  const backFromInstall = params.has('installation_id') && !params.has('state') && !requested;
  const connectLink = useMemo(() => readConnectLink(params), [params]);
  // One skeleton from here until the right step is known, so steps that get skipped never show.
  const [view, setView] = useState<View>(params.has('code') || backFromInstall || connectLink ? 'settling' : 'welcome');
  const [client, setClient] = useState<GitHubClient | null>(null);
  const [signInFailed, setSignInFailed] = useState(false);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [details, setDetails] = useState<RepoDetails | null>(null);
  const [branch, setBranch] = useState('main');
  const [scope, setScope] = useState<Scope>('all');
  const [fileOpen, setFileOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addFailed, setAddFailed] = useState<'refused' | 'open' | 'scan' | 'no-step' | 'other' | null>(null);
  /** The repo has more open PRs than are looked through for the one added by hand. */
  const [scanCapped, setScanCapped] = useState(false);
  const [pr, setPr] = useState<SetupPr | null>(null);
  const [status, setStatus] = useState<CheckStatus | null>(null);
  const [connectCode, setConnectCode] = useState<ConnectCode | null>(null);
  const [hasLogin, setHasLogin] = useState(false);
  const [merged, setMerged] = useState(false);
  /** Whether the pull request this page follows is merged, however the connect step was reached. */
  const [prMerged, setPrMerged] = useState(false);
  const [detailsFailed, setDetailsFailed] = useState(false);
  const [startOnClaude, setStartOnClaude] = useState(false);
  const [missing, setMissing] = useState<ConnectLink | null>(null);
  /** The secrets a run gets, by name, and whether every list of them could be read. */
  const [secretNames, setSecretNames] = useState<string[]>([]);
  /** Those that are the organization's, not the repo's own. */
  const [sharedSecrets, setSharedSecrets] = useState<string[]>([]);
  const [secretsComplete, setSecretsComplete] = useState(true);
  /**
   * The workflow on the setup or update PR this page opened or added to, which an open PR's other changes can make
   * differ from the branch's: its reviewer is the one to connect, and its inputs the ways in.
   */
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  /** Whether the workflow on a setup or update PR is read, being read again after a commit, or couldn't be. */
  const [pendingRead, setPendingRead] = useState<'known' | 'reading' | 'unknown'>('known');
  /**
   * The reviewer a setup or update PR names connects once it's merged: on pull_request_target the PR's run reads the
   * workflow on the branch, which doesn't use that AI.
   */
  const [setupHold, setSetupHold] = useState(false);
  /** The release an update PR from this page moves to: only that says the repo is on a new version. */
  const [updatePr, setUpdatePr] = useState<string | null>(null);
  /** The release of the Action the live workflow runs. Null when it can't be told, and undefined while it's looked up. */
  const [actionVersion, setActionVersion] = useState<string | null | undefined>(undefined);
  /** A pull request that changes the workflow already, which a change of AI waits for. Undefined while that's being looked up. */
  const [openPr, setOpenPr] = useState<SetupPr | null | undefined>(null);
  /** The pull request that stopped an update: one that changes who reviews, which an update never goes into. */
  const [addBlockedBy, setAddBlockedBy] = useState<SetupPr | null>(null);
  /**
   * The workflow on the pull request whose link sent them here, which its run reads. Unknown while it's read or when
   * it can't be, which is never guessed from another branch.
   */
  const [linkFile, setLinkFile] = useState<{ content: string } | 'reading' | 'unknown' | null>(null);
  /** The workflow on the branch it runs from, as far as this page knows. Only a repo that's on has one. */
  const [liveFile, setLiveFile] = useState<string | null>(null);
  const [rolesChange, setRolesChange] = useState<RolesChange | null>(null);
  const [rolesFrom, setRolesFrom] = useState<View>('live');
  const [changingRoles, setChangingRoles] = useState(false);
  const [rolesFailed, setRolesFailed] = useState<RolesFailure | null>(null);
  /** Whether the branch it runs from has the job that keeps a ChatGPT login fresh. */
  const [refreshLive, setRefreshLive] = useState(false);
  /** The commit whose run gave up on connecting a checker. Its review goes on, but nothing got connected. */
  const [missedSha, setMissedSha] = useState<string | null>(null);
  /**
   * The AI this run asked to connect: Claude, when a pull request's link sent them here, or the checker its comment named.
   * Kept, since that comment goes once the run moves on. A new commit is a new run, which asks again.
   */
  const [askedCheck, setAskedCheck] = useState<Ai | null>(null);
  const wide = useWide();

  const previous = useRef(view);
  const direction = view === 'settling' || previous.current === 'settling' ? 0 : ORDER.indexOf(view) >= ORDER.indexOf(previous.current) ? 1 : -1;
  useEffect(() => {
    previous.current = view;
  }, [view]);

  const start = useCallback((c: GitHubClient) => {
    setClient(c);
    setView('settling');
  }, []);

  // Sign-in needs the token server, so start waking it while the person reads the first screen.
  useEffect(wakeTokenServer, []);

  // Local development: `?mock` runs the whole flow on made-up data. Not in the built site.
  useEffect(() => {
    if (import.meta.env.DEV && params.has('mock')) start(mockClient());
  }, [params, start]);

  // Back from installing the app or changing its repos. The sign-in lives only in this page's memory, so
  // it's gone, but they just used GitHub, so getting a new one needs nothing from them. Replacing this
  // address keeps the back button from landing here and bouncing them forward again. The id itself is
  // never trusted or used: a made-up one only leads to an ordinary sign-in. Someone who hadn't signed in
  // before arrives with a code too, but without the state that proves it was meant for this tab, so that
  // code is never used. The new sign-in has the state.
  useEffect(() => {
    if (backFromInstall) window.location.replace(signInUrl());
  }, [backFromInstall]);

  // From a pull request waiting for Claude. They were just on GitHub, so signing in needs nothing from them.
  useEffect(() => {
    if (!connectLink || backFromInstall || params.has('code')) return;
    rememberConnect(connectLink);
    window.location.replace(signInUrl());
  }, [connectLink, backFromInstall, params]);

  // Coming back from GitHub with a sign-in code.
  useEffect(() => {
    if (!params.has('code') || backFromInstall) return;
    finishSignIn(params)
      .then((token) => {
        if (token) start(realClient(token));
        else setView('welcome');
      })
      .catch(() => {
        setSignInFailed(true);
        setView('welcome');
      })
      .finally(cleanUrl);
  }, [params, start, backFromInstall]);

  const loadRepos = useCallback(() => {
    client?.repos().then(setRepos, () => {
      setSignInFailed(true);
      setView((v) => (v === 'settling' ? 'repo' : v));
    });
  }, [client]);
  useEffect(loadRepos, [loadRepos]);

  // After giving access in another tab, the new repo should just be there.
  useEffect(() => {
    window.addEventListener('focus', loadRepos);
    return () => window.removeEventListener('focus', loadRepos);
  }, [loadRepos]);

  /** Each read of a linked PR's workflow, and each lookup of an open workflow PR, so only the newest answer counts. */
  const linkRead = useRef(0);
  const openPrLookup = useRef(0);
  const rolesRead = useRef(0);
  /** A change of AI on its way, known at once rather than at the next render. */
  const changingNow = useRef(false);
  /** The logins there were when a run that offers both AIs was first seen, so only a new one counts as connecting it. */
  const loginsBefore = useRef<Logins | null>(null);
  /** A retry of a linked PR's workflow is on its way, so the next poll doesn't start another. */
  const linkRetrying = useRef(false);
  const rolesRetrying = useRef(false);
  /**
   * Whether the workflow on a role PR is the one this page wrote, or was read after a new commit. While it's being read,
   * or can't be, no login is counted against an old copy of it.
   */
  const [rolesFile, setRolesFile] = useState<'known' | 'reading' | 'unknown'>('known');
  const pendingReads = useRef(0);
  const pendingRetrying = useRef(false);
  const pendingReadNow = useRef(pendingRead);
  pendingReadNow.current = pendingRead;
  /**
   * Reads the workflow on a setup or update PR at this commit, which an open PR can have changed in other ways, like
   * who reviews. Null when it isn't there. Undefined when it couldn't be read, which is tried again rather than going
   * by the live one.
   */
  const readPendingFile = (c: GitHubClient, r: Repo, sha: string, again = false): Promise<string | null | undefined> => {
    const read = ++pendingReads.current;
    const forRepo = picked.current;
    if (!again) setPendingRead('reading');
    const current = () => read === pendingReads.current && forRepo === picked.current;
    return c.workflowAt(r, sha).then(
      (content) => {
        if (!current()) return undefined;
        setPendingFile(content);
        setPendingRead('known');
        return content;
      },
      () => void (current() && setPendingRead('unknown')),
    );
  };
  const rolesFileNow = useRef(rolesFile);
  rolesFileNow.current = rolesFile;
  /** Reads a role PR's workflow at its merge commit, as its run does, and follows the roles and AIs it has now. */
  const readRolesFile = (c: GitHubClient, r: Repo, number: number, again = false) => {
    const read = ++rolesRead.current;
    const forRepo = picked.current;
    if (!again) setRolesFile('reading');
    // A new commit restarts the polling, so only a newer read or another repo makes this one old.
    const current = () => read === rolesRead.current && forRepo === picked.current;
    return c.workflowAt(r, `refs/pull/${number}/merge`).then(
      (content) => {
        if (!current()) return;
        if (!content) return setRolesFile('unknown');
        setRolesFile('known');
        setRolesChange((rc) => rc && reconciled(rc, content, secretsNow.current.names, secretsNow.current.shared));
      },
      () => current() && setRolesFile('unknown'),
    );
  };
  /** The repo picked, counted, so an answer for one picked before is never applied to this one. */
  const picked = useRef(0);
  /** The branch a setup or update PR is for, so one moved to another branch is no longer followed. */
  const setupBase = useRef<string | null>(null);
  /** The branch the linked PR goes into, which can be another one than the branch picked here. */
  const linkBase = useRef('');
  /**
   * A pull_request run reads the workflow at the PR's merge commit, which may take other logins than the branch's or
   * the PR's own head. A pull_request_target run reads the one on the PR's own base branch. `again` is a retry after a
   * read that failed, which keeps showing that until one works.
   */
  const readLinkFile = (c: GitHubClient, r: Repo, number: number, again = false) => {
    const read = ++linkRead.current;
    if (!again) setLinkFile('reading');
    return c
      .workflowAt(r, linkBase.current)
      .then((onBase) => (runsOnBase(onBase) ? onBase : c.workflowAt(r, `refs/pull/${number}/merge`)))
      .then(
        (content) => read === linkRead.current && setLinkFile(content === null ? 'unknown' : { content }),
        () => read === linkRead.current && setLinkFile('unknown'),
      );
  };

  /** `waitingPr` is the pull request whose comment sent them here, which skips straight to connecting it. */
  const choose = (r: Repo, waitingPr?: number) => {
    picked.current++;
    changingNow.current = false;
    loginsBefore.current = null;
    setupBase.current = null;
    openPrLookup.current++;
    linkRead.current++;
    rolesRead.current++;
    setChangingRoles(false);
    setRepo(r);
    setStartOnClaude(false);
    setDetailsFailed(false);
    setDetails(null);
    setPr(null);
    setStatus(null);
    setConnectCode(null);
    setHasLogin(false);
    setSecretNames([]);
    setSharedSecrets([]);
    setSecretsComplete(true);
    setOpenPr(null);
    setAddBlockedBy(null);
    setLinkFile(null);
    setPendingFile(null);
    setPendingRead('known');
    setSetupHold(false);
    pendingReads.current++;
    setUpdatePr(null);
    setRolesFile('known');
    setLiveFile(null);
    setRefreshLive(false);
    setMissedSha(null);
    setAskedCheck(null);
    setRolesChange(null);
    setRolesFailed(null);
    setMerged(false);
    setPrMerged(false);
    setFileOpen(false);
    setAddFailed(null);
    setScanCapped(false);
    setView('settling');
    client?.details(r).then((d) => {
      setDetails(d);
      setBranch(d.base);
      setScope(d.skip.length > 1 ? 'new' : 'all');
      // A login counts only where the workflow reads it, and a ChatGPT plan's login only when it's the repo's own.
      const working = loginsIn(d.installed?.content ?? null, d.secretNames, d.sharedSecrets);
      setHasLogin(working.claude || working.codex);
      setSecretNames(d.secretNames);
      setSharedSecrets(d.sharedSecrets);
      setSecretsComplete(d.allSecretsSeen);
      setLiveFile(d.installed?.content ?? null);
      setRefreshLive(Boolean(d.refresh));
      const next = d.reviewApp === false ? 'review-app' : 'add';
      if (!waitingPr) {
        setView(next);
        return;
      }
      client.prState(r, waitingPr).then(({ headSha, base }) => {
        setPr({ number: waitingPr, url: `https://github.com/${r.fullName}/pull/${waitingPr}`, headSha });
        setStartOnClaude(true);
        // The link is for Claude, so only Claude's login ends this step, even once the run's comment is gone.
        setAskedCheck('claude');
        linkBase.current = base;
        readLinkFile(client, r, waitingPr);
        setView('connect');
      }, () => setView(next));
    }, () => {
      setDetailsFailed(true);
      setView('add');
    });
  };

  // Nobody should pick the same repo twice: not when there's only one, and not after a trip to GitHub for the review app.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (!repos || autoPicked.current) return;
    autoPicked.current = true;
    const waiting = takeRememberedConnect();
    if (waiting) {
      // A pull request's link opens that repo and no other, even if some other repo is the only one on the list.
      const asked = repos.find((r) => r.fullName === waiting.repo);
      if (asked) {
        choose(asked, waiting.pr);
      } else {
        setMissing(waiting);
        setView('repo');
      }
      return;
    }
    const remembered = takeRememberedRepo();
    const target = repos.find((r) => r.fullName === remembered) ?? (repos.length === 1 ? repos[0] : null);
    if (target) choose(target);
    else setView('repo');
    // Only the first list counts, so `choose` doesn't need to be here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos]);

  /**
   * A pinned repo only moves when someone asks, and anything else in its file stays theirs. Only forward: a repo pinned
   * to a release newer than @v0's, as this page did before it went by @v0, isn't offered an older one as an update.
   */
  const pinnedVersion = details?.installed?.version ?? '';
  const ahead = Boolean(details?.release && /^v\d+\.\d+\.\d+$/.test(pinnedVersion) && compareVersions(pinnedVersion, details.release.tag) >= 0);
  const update = details?.installed && details.release && isPinned(details.installed) && details.installed.ref !== details.release.sha && !ahead ? details.release : null;
  /**
   * New repos are pinned to the release @v0 is on, the newest whose canary passed, so a bad release can't reach them by itself. If the release can't be
   * read, they follow the moving tag instead, which still works.
   */
  const pinTo = update ?? (details && !details.installed ? details.release : null);
  const workflow = useMemo(() => {
    if (!details) return workflowFile;
    // An update also adds the trigger for answering the findings in a comment, where the workflow's shape is known.
    if (update && details.installed) return pinned(withCommentTrigger(details.installed.content) ?? details.installed.content, update);
    // A repo with a login already gets its reviewer written down, so a second login added later doesn't change it. Only
    // when every secret a run gets was seen: one its organization shares may be a login the Action would review with.
    const scoped = workflowFor(scope, branch, details.skip);
    const fresh = details.allSecretsSeen ? withReviewer(scoped, loginsFrom(details.secretNames)) : scoped;
    return pinTo ? pinned(fresh, pinTo) : fresh;
  }, [scope, branch, details, update, pinTo]);
  /**
   * The review, and the job that keeps a ChatGPT login fresh. Without that job reviews refresh the login themselves,
   * and one that starts during another's refresh can fail. An API key needs no refreshing.
   */
  /**
   * `files` is what the page shows, and `prFiles` what the PR gets: for an update, also the refresh job, so one an open
   * PR has gets its version moved whatever main's workflow reads.
   */
  const { files, prFiles } = useMemo<{ files: WorkflowFile[]; prFiles: WorkflowFile[] }>(() => {
    // An update moves the version lines of what the pull request's branch holds, so a change of AI waiting there stays.
    // One whose Mergelight step is gone has no version to move, so it stops the update rather than claiming it worked.
    const moves = update ? { edit: (current: string) => (readInstalled(current) ? pinned(withCommentTrigger(current) ?? current, update) : null) } : {};
    const list: WorkflowFile[] = [{ name: 'mergelight.yml', content: workflow, ...moves }];
    if (!details || !repo) return { files: list, prFiles: list };
    const version = (content: string) => (pinTo ? pinned(content, pinTo) : content);
    // The job that turns a "needs a human" check green when someone approves. A setup adds it where it's missing and leaves
    // one that's there as it is. An update moves its version lines too, and adds it where it's missing, so a repo this
    // page set up before it added the job gets it.
    list.push(update ? { name: APPROVE_FILE, content: version(approveFile), edit: version, orAdd: true } : { name: APPROVE_FILE, content: version(approveFile), keep: true });
    // A refresh job an open PR has already, edited or not, only gets its version lines moved. Where the branch has one,
    // a PR that took it out stops the change rather than getting it back. Where it has none, it goes in only where the
    // PR has none either.
    if (details.refresh) {
      list.push({ name: REFRESH_FILE, content: version(details.refresh), edit: version });
      return { files: list, prFiles: list };
    }
    // A ChatGPT plan's login gets it whatever key another AI has. A repo with only keys or a Claude login doesn't. It goes
    // in only where the workflow the PR ends up with reads the plan's login: another tool's login of that name isn't
    // the review's to refresh, and an open PR may have changed which one it reads.
    const wanted = details.secretNames.includes(CHATGPT_SECRET) || !details.hasApiKey;
    const job: WorkflowFile = { name: REFRESH_FILE, content: refreshJob(pinTo), edit: version, orAdd: true, addIf: (review) => wanted && readsPlanLogin(review) };
    const shown = wanted && readsChatgpt(details.installed?.content) ? [...list, job] : list;
    return { files: shown, prFiles: update ? [...list, job] : shown };
  }, [workflow, details, repo, pinTo, update]);
  const fileUrl = repo ? newFileUrl(repo.fullName, branch, workflow) : '#';
  // A repo that's on, whose secrets couldn't all be read, may well have a login, so it isn't sent to connect one.
  // A workflow that names its reviewer needs that AI's own login: another one being there doesn't make reviews work.
  // `pending` is the workflow on the PR just opened, which is what decides the AI to connect once it's merged.
  const afterAdding = useCallback(
    (pending: string | null = null, unknown = false) => {
      // The PR's workflow couldn't be read, so its reviewer can't be told ready: connecting waits for the read, or its run.
      if (unknown) return setView('connect');
      const file = pending ?? liveFile;
      // A workflow set up its own way may read its logins from secrets of its own, so it's never sent to connect one.
      if (file && !isStandard(file)) return setView('live');
      const named = readRoles(file ?? workflow)?.provider ?? null;
      const ready = named ? loginsIn(file, secretNames, sharedSecrets)[named] : hasLogin;
      setSetupHold(Boolean(pending && named && liveFile && !ready && waitsForBase(liveFile, loginsIn(liveFile, secretNames), named)));
      setView(ready || (!secretsComplete && Boolean(details?.installed)) ? 'live' : 'connect');
    },
    [hasLogin, secretsComplete, details, liveFile, workflow, secretNames, sharedSecrets],
  );

  /** Opens the pull request right here, with the person's own sign-in. Nothing goes through Mergelight. */
  const addToRepo = async () => {
    if (!client || !repo || !details || adding) return;
    setAdding(true);
    setAddFailed(null);
    setFileOpen(false);
    try {
      const opened = await client.proposeWorkflows(repo, branch, prFiles, update ? { kind: 'update', release: update } : { kind: 'setup' });
      setPr(opened);
      setupBase.current = branch;
      setUpdatePr(opened && update ? update.tag : null);
      // What the PR holds, which an open one can have changed in other ways, like who reviews.
      setPendingFile(null);
      const pending = opened ? await readPendingFile(client, repo, opened.headSha) : null;
      afterAdding(pending ?? null, pending === undefined);
    } catch (err) {
      setAddBlockedBy(err instanceof OpenPrError ? err.pr : null);
      setAddFailed(err instanceof OpenPrError ? 'open' : err instanceof ScanLimitError ? 'scan' : err instanceof WorkflowEditError && err.reason === 'no-step' ? 'no-step' : err instanceof GitHubError && (err.status === 403 || err.status === 404) ? 'refused' : 'other');
    } finally {
      setAdding(false);
    }
  };

  // Waiting for the pull request to show up on GitHub.
  useEffect(() => {
    if (view !== 'finish' || !client || !repo) return;
    const forRepo = picked.current;
    return poll(async () => {
      // The branch first: once the workflow is there, setup is done, however many PRs the repo has. It's what runs
      // now, so the page goes on with it, and with whether the refresh job is there too.
      const onBranch = await client.workflowAt(repo, branch).catch(() => null);
      if (onBranch) {
        const job = await client.workflowAt(repo, branch, REFRESH_FILE).then(Boolean, () => null);
        if (forRepo !== picked.current) return true;
        setLiveFile(onBranch);
        setDetails((d) => d && { ...d, installed: readInstalled(onBranch) });
        if (job !== null) setRefreshLive(job);
        setTimeout(() => afterAdding(onBranch), 900);
        return true;
      }
      // A repo with more open PRs than are looked through is never looked through again: only the branch can tell.
      if (scanCapped) return false;
      // Only one that installs the review counts here: a PR with only the refresh job turns nothing on.
      const found = await client.findSetupPr(repo, undefined, true).catch((err) => {
        if (!(err instanceof ScanLimitError)) throw err;
        if (forRepo === picked.current) setScanCapped(true);
        return null;
      });
      if (found) {
        setPr(found);
        // It was made by hand, into whichever branch they picked there: the first one seen is the one it's for.
        setupBase.current = null;
        setTimeout(afterAdding, 900);
        return true;
      }
      return false;
    });
  }, [view, client, repo, branch, afterAdding, scanCapped]);

  /** Which AIs have a login the workflow that runs now hands on to the Action. */
  // The release the live workflow runs, looked up again when it changes, like after an update merges.
  useEffect(() => {
    if (!client || !liveFile) return;
    const live = readInstalled(liveFile);
    if (!live) {
      setActionVersion(null);
      return;
    }
    const forRepo = picked.current;
    let standing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setActionVersion(undefined);
    // A lookup that failed, or found no release, is tried again a few times, further apart each time: GitHub may only
    // have failed for a moment. A version that's too old stays as it is.
    const look = (tries: number) =>
      client.actionVersion(live.ref, live.version).then(
        (version) => version,
        () => null,
      ).then((version) => {
        if (!standing || forRepo !== picked.current) return;
        setActionVersion(version);
        if (version === null && tries < VERSION_TRIES) timer = setTimeout(() => void look(tries + 1), 4000 * 2 ** tries);
      });
    void look(1);
    return () => {
      standing = false;
      clearTimeout(timer);
    };
  }, [client, liveFile]);

  /** Which AIs have a login the live workflow hands the Action, the organization's included: they say who reviews now. */
  const logins = useMemo(() => loginsIn(liveFile, secretNames), [liveFile, secretNames]);
  /** Which of them count as connected here: a ChatGPT plan's login the repo only gets from its organization doesn't. */
  const ownLogins = useMemo(() => loginsIn(liveFile, secretNames, sharedSecrets), [liveFile, secretNames, sharedSecrets]);
  /**
   * The workflow a connection is for: the one on the pull request whose link sent them here, or the one a change of AI
   * writes. Its logins say whether the connection worked, while the live ones say who reviews now.
   */
  const linkContent = typeof linkFile === 'object' && linkFile ? linkFile.content : null;
  const linkFileNow = useRef(linkFile);
  linkFileNow.current = linkFile;
  /**
   * The workflow a connection is for is being read, or couldn't be: never swapped for the live one. Until it's read, no
   * secret counts as its login, as one it doesn't read would look like one. Only its run saying so does.
   */
  // An open PR on pull_request_target runs the workflow on the branch, not its own, until it's merged: that one says
  // which logins its run takes. Its own still says who it asks for.
  const prRunsBase = Boolean(pr && !prMerged && !startOnClaude && liveFile && runsOnBase(liveFile));
  const pendingUnknown = !startOnClaude && !rolesChange && pendingRead !== 'known';
  const connectUnknown = startOnClaude ? !linkContent : prRunsBase ? false : rolesChange ? rolesFile !== 'known' : pendingUnknown;
  const connectUnknownNow = useRef(connectUnknown);
  connectUnknownNow.current = connectUnknown;
  const connectFile = connectUnknown ? null : startOnClaude ? linkContent : prRunsBase ? liveFile : (rolesChange?.content ?? pendingFile ?? liveFile);
  const connectLogins = useMemo(() => (connectUnknown ? NO_LOGINS : loginsIn(connectFile, secretNames, sharedSecrets)), [connectUnknown, connectFile, secretNames, sharedSecrets]);
  // Each read of the secrets makes a new list, so the polling reads this without restarting on it.
  const connectLoginsNow = useRef(connectLogins);
  connectLoginsNow.current = connectLogins;
  /** The repo's own ChatGPT login, from a complete read: what a PR waiting for it waits for. */
  const ownPlan = secretsComplete && secretNames.includes(CHATGPT_SECRET) && !sharedSecrets.includes(CHATGPT_SECRET);
  const ownPlanNow = useRef(ownPlan);
  ownPlanNow.current = ownPlan;
  /** The reviewer the workflow names, while it has no login of the repo's own. Setup isn't done until it has. */
  const reviewerFile = connectUnknown || pendingUnknown ? null : (pendingFile ?? liveFile ?? workflow);
  const namedReviewer = reviewerFile && isStandard(reviewerFile) ? (readRoles(reviewerFile)?.provider ?? null) : null;
  const setupNeed = !rolesChange && !startOnClaude && namedReviewer && !connectLogins[namedReviewer] ? namedReviewer : null;
  const setupNeedNow = useRef(setupNeed);
  setupNeedNow.current = setupNeed;
  /** The secrets there are now, which a PR's edited workflow is matched against. */
  const secretsNow = useRef({ names: secretNames, shared: sharedSecrets });
  secretsNow.current = { names: secretNames, shared: sharedSecrets };

  // Following the first review and the merge once the pull request exists. A failed read just waits for the next one.
  useEffect(() => {
    if ((view !== 'connect' && view !== 'live') || !client || !repo) return;
    // Answers that come after another repo was picked, or after this poll was replaced, are for a screen that's gone.
    const forRepo = picked.current;
    let standing = true;
    const gone = () => !standing || forRepo !== picked.current;
    const stop = poll(async () => {
      const current = pr ? await client.prState(repo, pr.number).catch(() => null) : null;
      if (gone()) return true;
      // A change of AI whose PR was closed without merging has nothing left to wait for. Nor has one moved to another
      // branch: merged there, it leaves this branch as it was, so a login saved then could still move its reviews.
      if (rolesChange && pr && current && (current.closed || current.base !== branch)) {
        // A read of its workflow still on its way is for a PR that's gone.
        rolesRead.current++;
        setRolesChange(null);
        setPr(null);
        if (view === 'connect') setView('live');
        return true;
      }
      // So with a setup or update PR moved to another branch than the one it was for: merged there, it releases nothing.
      if (!rolesChange && !startOnClaude && pr && current) {
        setupBase.current ??= current.base;
        if (current.base !== setupBase.current) {
          pendingReads.current++;
          setPr(null);
          setPendingFile(null);
          setPendingRead('known');
          setSetupHold(false);
          setUpdatePr(null);
          if (view === 'connect') setView('live');
          return true;
        }
      }
      // A new commit is a new run, like the one that gets a new code after the last one ran out. This starts over on it.
      if (pr && current && current.headSha !== pr.headSha) {
        setStatus(null);
        setConnectCode(null);
        // What the old run asked for, and the logins its workflow took, may not be the new one's.
        setAskedCheck(null);
        loginsBefore.current = null;
        if (startOnClaude) {
          linkBase.current = current.base;
          readLinkFile(client, repo, pr.number);
        }
        // A role PR's new commit can change the logins its workflow takes: its run reads the PR's merge commit.
        else if (rolesChange) void readRolesFile(client, repo, pr.number);
        // So can a setup or update PR's.
        else void readPendingFile(client, repo, current.headSha);
        setPr({ ...pr, headSha: current.headSha });
        return true;
      }
      // A linked PR moved to another branch, on the same commit, runs that branch's workflow or its new merge commit's.
      if (startOnClaude && pr && current && current.base !== linkBase.current) {
        linkBase.current = current.base;
        void readLinkFile(client, repo, pr.number);
      }
      // A role PR's workflow that couldn't be read is tried again the same way, until it's merged.
      if (rolesChange && pr && !current?.merged && rolesFileNow.current === 'unknown' && !rolesRetrying.current) {
        rolesRetrying.current = true;
        void readRolesFile(client, repo, pr.number, true).finally(() => {
          rolesRetrying.current = false;
        });
      }
      // So is a setup or update PR's.
      if (!startOnClaude && !rolesChange && pr && pendingReadNow.current === 'unknown' && !pendingRetrying.current) {
        pendingRetrying.current = true;
        void readPendingFile(client, repo, pr.headSha, true).finally(() => {
          pendingRetrying.current = false;
        });
      }
      // A linked PR's workflow that couldn't be read is tried again, one try at a time, so a slow one can finish.
      if (startOnClaude && pr && linkFileNow.current === 'unknown' && !linkRetrying.current) {
        linkRetrying.current = true;
        void readLinkFile(client, repo, pr.number, true).finally(() => {
          linkRetrying.current = false;
        });
      }
      const check = pr ? await client.checkStatus(repo, pr.headSha).catch(() => null) : null;
      const names = view === 'connect' || !check || rolesChange ? await client.secrets(repo) : null;
      const unknown = connectUnknownNow.current;
      const seen = names && (unknown ? NO_LOGINS : loginsIn(connectFile, names.names, names.shared));
      const login = seen ? seen.claude || seen.codex : true;
      const code = view === 'connect' && pr ? await client.connectCode(repo, pr.number).catch(() => null) : null;
      if (gone()) return true;
      // A change of AI can wait for its merge before it connects, so that counts while connecting too.
      const done = Boolean(current?.merged) && (view === 'live' || Boolean(rolesChange));
      if (check) setStatus(check);
      setConnectCode(code);
      if (!unknown) setHasLogin(login);
      if (names) {
        setSecretNames(names.names);
        setSharedSecrets(names.shared);
        setSecretsComplete(names.complete);
      }
      setMerged(done);
      setPrMerged(Boolean(current?.merged));
      // Once it's merged, the branch has what merged, which someone may have edited on GitHub before merging.
      let mergedUnread = false;
      if (done && rolesChange) {
        // Null is a workflow that's gone from the branch, and undefined one that couldn't be read.
        const onBranch = await client.workflowAt(repo, branch).catch(() => undefined);
        // Whether the refresh job is there, as someone may have taken it out of the PR before merging.
        const job = await client.workflowAt(repo, branch, REFRESH_FILE).then(Boolean, () => null);
        if (gone()) return true;
        // Someone took the review out before merging: reviews are off, so the page starts over on adding it.
        if (onBranch === null) {
          rolesRead.current++;
          setRolesChange(null);
          setPr(null);
          setLiveFile(null);
          setDetails((d) => d && { ...d, installed: null });
          setView('add');
          return true;
        }
        if (job !== null) setRefreshLive(job);
        else if (rolesChange.addsRefresh) setRefreshLive(true);
        mergedUnread = onBranch === undefined;
        // One that couldn't be read is tried again on the next check. Until what merged is read, nothing says a held
        // login is safe to save: the proposal isn't what merged.
        if (onBranch !== undefined) {
          // A read of the PR's merge commit still on its way, or one that failed, is for a PR that's merged now.
          rolesRead.current++;
          setRolesFile('known');
          setLiveFile(onBranch);
          const { names, shared } = secretsNow.current;
          // Merged without naming the reviewer chosen, a held login would still move its reviews: this change is over,
          // and nothing is offered to save.
          const set = readRoles(onBranch);
          if (rolesChange.hold && set && rolesChange.needs.some((ai) => connectsAfterMerge(set, loginsIn(onBranch, names), rolesChange.roles, ai))) {
            setRolesChange(null);
            setPr(null);
            if (view === 'connect') setView('live');
            return true;
          }
          // An AI the merged workflow won't use, even once it has a login, isn't one to connect any more.
          if (!rolesChange.mergedRead || onBranch !== rolesChange.content) setRolesChange({ ...reconciled(rolesChange, onBranch, names, shared), mergedRead: true });
        }
      } else if (done && !startOnClaude) {
        // What was merged, which an update that kept other changes on its pull request can differ from.
        const onBranch = await client.workflowAt(repo, branch).catch(() => null);
        // Whether the refresh job is there, as someone may have taken it out of the PR before merging.
        const job = await client.workflowAt(repo, branch, REFRESH_FILE).then(Boolean, () => null);
        if (gone()) return true;
        setLiveFile((known) => onBranch ?? known ?? workflow);
        if (job !== null) setRefreshLive(job);
        else if (files.some((f) => f.name === REFRESH_FILE)) setRefreshLive(true);
      }
      // A checker nobody connected lets the review go on, so that run going ahead doesn't mean it connected. The check
      // says so while the review goes on, so only for a moment.
      const missed = Boolean(pr) && (missedSha === pr?.headSha || /wasn't connected$/i.test(check?.title ?? ''));
      if (missed && pr && missedSha !== pr.headSha) setMissedSha(pr.headSha);
      // A run that's still asking comes first, even if the repo has some other login saved. Someone sent here by a
      // pull request is connecting that run, so only that run going ahead ends this step, not a login from before.
      const movedOn = isReviewing(check) && !couldntFinish(check) && !missed;
      // A run asking for a checker goes on without it after a while, so only that AI's login ends this step.
      const asked = code?.purpose === 'check' ? onlyAi(code) : null;
      if (asked && asked !== askedCheck) setAskedCheck(asked);
      // A link's run that offers both AIs lets either connect, so Claude's login is no longer the only one that counts.
      const both = Boolean(startOnClaude && code && code.purpose === 'review' && code.code && code.claudeUrl);
      if (both && askedCheck) setAskedCheck(null);
      // A change of AI waits for the login of the AI it connects now. Its run can be reviewing with the other AI before it asks.
      // While a PR waits for ChatGPT's own login, only a complete read that shows the repo's own counts: not a partial
      // one, and not an API key the organization's login would win over.
      const ownPlanSeen = Boolean(names?.complete && names.names.includes(CHATGPT_SECRET) && !names.shared.includes(CHATGPT_SECRET));
      const has = (ai: Ai, logins: Logins | null) => (rolesChange?.connectFirst && ai === 'codex' ? ownPlanSeen : Boolean(logins?.[ai]));
      const need = rolesChange?.needs.find((ai) => !(rolesChange.connectFirst && ai === 'codex' ? ownPlanNow.current : connectLoginsNow.current[ai])) ?? asked ?? (both ? null : askedCheck) ?? setupNeedNow.current;
      const title = /^connected/i.test(check?.title ?? '');
      // A run that offers both AIs is done once either gets a login it didn't have when the page first looked, or the
      // run goes on. One saved before doesn't count: a run that asks has no login it can use.
      if (both && seen && !unknown && !loginsBefore.current) loginsBefore.current = seen;
      const before = loginsBefore.current;
      const newLogin = Boolean(seen && before && ((seen.claude && !before.claude) || (seen.codex && !before.codex)));
      const connected = need ? has(need, seen) || title : both ? newLogin || title || movedOn : movedOn;
      if (view === 'connect' && (need || both ? connected : (login && !code && !startOnClaude) || movedOn)) {
        // Only once this run has moved on: it has read the code then, and the next screen can send them back to GitHub at
        // once. A login another run saved doesn't say this one has, so the code stays for its own timer to remove.
        if (connected && (/^connected/i.test(check?.title ?? '') || isReviewing(check))) void client.clearClaudeCode(repo).catch(() => undefined);
        setView('live');
      }
      // A change of AI that still needs a login keeps being followed, so Resume goes once they're all there. So does
      // one whose merged workflow couldn't be read yet.
      const waiting = Boolean(rolesChange?.needs.some((ai) => !has(ai, seen))) || mergedUnread;
      return view === 'live' && (done || !pr) && !waiting;
    });
    return () => {
      standing = false;
      stop();
    };
    // readLinkFile only sets state, so it isn't one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, client, repo, pr, startOnClaude, rolesChange, workflow, files, missedSha, askedCheck, connectFile, branch]);

  // A pull request's link can be any pull request. Only one on a repo without the workflow is the one that sets it up.
  // A change of AI is on a repo that's already on, so it never shows as a setup either.
  const shownPr = (startOnClaude && details?.installed) || rolesChange ? null : pr;
  const currentSet = liveFile ? readRoles(liveFile) : null;
  /**
   * Why the page can't change who reviews here: the workflow is set up its own way, not every secret could be read, so
   * the Action's defaults can't be worked out, or no AI has a login yet, which connecting one comes before. Null when it can.
   */
  const versionOk = typeof actionVersion === 'string' && compareVersions(actionVersion, MIN_ACTION_VERSION) >= 0;
  // A login is the whole repo's, so where Mergelight reviews another branch too, a change here would move that one's
  // reviews as well. Each is set by hand there.
  const rolesLocked: RolesLock | null = !liveFile || !currentSet ? null : !isStandard(liveFile) ? 'custom' : details?.otherReviews.length ? 'branches' : details && !details.branchesKnown ? 'unchecked' : !secretsComplete ? 'secrets' : !logins.claude && !logins.codex ? 'none' : actionVersion === undefined ? 'checking' : !versionOk ? 'old' : null;
  /** Who reviews and who checks, only where that's sure: with the Action's defaults, or written out in full. */
  // Another branch with a review, or one that may have one, stops a change, but with every secret seen the roles here
  // can still be told.
  const rolesKnown = !rolesLocked || rolesLocked === 'checking' || rolesLocked === 'old' || ((rolesLocked === 'branches' || rolesLocked === 'unchecked') && secretsComplete);
  const currentRoles = currentSet && (rolesKnown ? rolesFor(currentSet, logins) : currentSet.provider && currentSet.verifyWith ? { reviewer: currentSet.provider, checker: currentSet.verifyWith } : null);
  /** An update that brings a release new enough, which the page's Update button already offers. */
  const updateOk = Boolean(update && compareVersions(update.tag, MIN_ACTION_VERSION) >= 0);
  const liveUse = liveFile ? readInstalled(liveFile) : null;
  /** Why the choice of AI waits for a newer Action, and how that comes. */
  const oldNote = `Choosing your AI here needs Mergelight ${MIN_ACTION_VERSION} or newer.${
    liveUse && /^v\d+$/.test(liveUse.ref) ? ` It arrives by itself once ${liveUse.ref} moves to ${MIN_ACTION_VERSION}.` : actionVersion === null ? " We can't tell which version this workflow runs." : updateOk ? '' : " Update once it's out."
  }`;
  /** The AI a change of AI connects now: the first of its AIs still without a login. */
  const rolesNeed = rolesChange?.needs.find((ai) => !(rolesChange.connectFirst && ai === 'codex' ? ownPlan : connectLogins[ai])) ?? null;
  /** The AI this connect step is for, when it's one: a change of AI's, or a checker a run asked for. */
  const need = rolesNeed ?? askedCheck;
  /**
   * A run that went past asking without connecting the AI it needed: it finished, it's reviewing already, or it says
   * the checker wasn't connected. A new commit gets a new one. While its workflow is unknown, that can't be told.
   */
  const runEnded = Boolean(need && status && !connectUnknown && !connectLogins[need] && !/^connected/i.test(status.title ?? '') && (status.status === 'completed' || /^review/i.test(status.title ?? '') || /wasn't connected$/i.test(status.title ?? '')));
  /** What a change of AI asks the run for: one AI, for the review or for checking another AI's review. */
  const rolesAsk = rolesChange && rolesNeed ? { ai: rolesNeed, forCheck: rolesNeed === rolesChange.roles.checker && rolesNeed !== rolesChange.roles.reviewer } : null;
  /** The organization shares the ChatGPT plan's login this workflow reads, so the repo saves one of its own. */
  const sharedChatgpt = sharedSecrets.includes(CHATGPT_SECRET) && readsChatgpt(connectFile);
  /**
   * Why a ChatGPT login comes from their own computer, when it does. A run sees the organization's login and asks for
   * none. Only a private repo's run shows a code for a checker: anyone else who can see the PR could enter it. And a
   * change that leaves the checker to the Action's default has no run that asks.
   */
  /** What the connect step is for: a change of AI's AI, or the reviewer the workflow names. */
  const connectAsk = rolesAsk ?? (setupNeed ? { ai: setupNeed, forCheck: false } : null);
  // A merged PR starts no run, so where none ran on it, or none showed a code, a code can't come: the command is the way.
  const noRun = prMerged && Boolean(pr) && !status && !connectCode?.code;
  const commandWhy: CommandWhy | null = connectAsk && connectAsk.ai !== 'codex' ? null : sharedChatgpt ? 'shared' : rolesAsk && repo && rolesAsk.forCheck && repo.visibility !== 'private' ? repo.visibility : rolesAsk?.forCheck && rolesChange?.implicit ? 'hold' : noRun ? 'base' : null;

  const openRoles = () => {
    // An update's pull request on its way could end up as a second one beside this change.
    if (adding || !client || !repo) return;
    setRolesFrom(view);
    setRolesFailed(null);
    // Each pull request from here says only what it changes, so one that changes the workflow already comes first. It's
    // looked up each time: one this page opened may have been closed since.
    // A lookup that answers after another one started, or after they left, is for a choice no longer on screen.
    const lookup = ++openPrLookup.current;
    setOpenPr(undefined);
    client.findSetupPr(repo, branch).then(
      (found) => lookup === openPrLookup.current && setOpenPr(found),
      (err) => {
        if (lookup !== openPrLookup.current) return;
        setOpenPr(null);
        if (err instanceof ScanLimitError) setRolesFailed('scan');
      },
    );
    setView('roles');
  };

  /** Opens a pull request that sets who reviews and who checks, the same way a setup or an update does. */
  const changeRoles = async (want: Roles) => {
    // The ref is set at once, so a second click in the same moment, before the page draws again, finds it busy too.
    if (!client || !repo || !liveFile || changingRoles || changingNow.current || adding) return;
    // Another repo picked while this waits on GitHub makes its answer one for a repo no longer on screen.
    const forRepo = picked.current;
    const full = withRoles(liveFile, want);
    if (full === null) {
      setRolesFailed('no-step');
      return;
    }
    // Busy from the first read on, so a second click can't start a second change.
    changingNow.current = true;
    setChangingRoles(true);
    setRolesFailed(null);
    try {
      // Every chosen AI without a login of the repo's own, the reviewer first, as a run connects it first.
      let needs = [...new Set([want.reviewer, want.checker])].filter((ai) => !ownLogins[ai]);
      const set = readRoles(liveFile);
      // The branch doesn't name its reviewer, and a new login would move its reviews. The pull request then names only
      // the reviewer, and takes out a checker the branch sets: with no checker set, its own run has none to ask for, so
      // no login can be saved before it's merged. Once there is one, the Action's default makes the other AI check, the
      // choice. One AI for both is written out in full, as the default would make the other AI check.
      const hold = Boolean(set && needs.some((ai) => connectsAfterMerge(set, logins, want, ai)));
      const onBase = needs.filter((ai) => waitsForBase(liveFile, logins, ai));
      const leaveChecker = hold && want.checker !== want.reviewer;
      const named = withInputs(liveFile, [['provider', want.reviewer]]);
      const content = leaveChecker && named ? (withoutInputs(named, ['verify-with']) ?? full) : full;
      // A ChatGPT login needs refreshing, also one saved before that nothing used: the same job a setup adds. With only
      // an API key, the job has nothing to do and does nothing. A workflow that doesn't read the plan's login gets none.
      // It's added also where the roles are set already, as a PR of its own.
      const usesPlan = (want.reviewer === 'codex' || want.checker === 'codex') && readsChatgpt(liveFile);
      const addsRefresh = !refreshLive && usesPlan;
      const changes = content !== liveFile || addsRefresh;
      // The organization's ChatGPT login can't be refreshed here, so ChatGPT gets the repo's own before any PR uses it.
      const connectFirst = changes && needs.includes('codex') && sharedSecrets.includes(CHATGPT_SECRET) && readsChatgpt(liveFile);
      if (connectFirst) needs = ['codex', ...needs.filter((ai) => ai !== 'codex')];
      const begin = (opened: SetupPr | null, addsRefresh: boolean) => {
        setStartOnClaude(false);
        setAskedCheck(null);
        setStatus(null);
        setConnectCode(null);
        setMerged(false);
        setPrMerged(false);
        setPr(opened);
        setRolesChange({ roles: want, content, needs, connectFirst: connectFirst && !opened, addsRefresh, hold, onBase, implicit: leaveChecker });
        setUpdatePr(null);
        setPendingFile(null);
        setPendingRead('known');
        setSetupHold(false);
        pendingReads.current++;
        // A read for an earlier proposal's PR is for one that's gone.
        rolesRead.current++;
        setRolesFile('known');
        setView(needs.length ? 'connect' : 'live');
      };
      // Set like this already, with an AI still to connect: nothing to change, only that to do.
      if (!changes || connectFirst) {
        if (needs.length) begin(null, false);
        else {
          setRolesChange(null);
          setView('live');
        }
        return;
      }
      // Everything this page checked was in the file it read, so a branch that has changed since gets nothing.
      const edit = (current: string) => {
        if (current !== liveFile) throw new WorkflowEditError('changed');
        return content;
      };
      // The review workflow is always checked, also when only the refresh job is added and it stays as it is.
      const list: WorkflowFile[] = [{ name: 'mergelight.yml', content, edit }];
      // On the same version as the review: the same commit, or the same moving tag. A release tag can be moved, so a new
      // job runs on the commit it's on now, written the way an update writes it. Without that commit, nothing is changed.
      const review = readInstalled(content);
      const tagged = review && /^v\d+\.\d+\.\d+$/.test(review.ref) ? review.ref : null;
      const job = usesPlan && tagged ? pinned(refreshFile, { sha: await client.releaseCommit(tagged).catch(() => { throw new TagError(); }), tag: tagged }) : refreshLike(content);
      if (forRepo !== picked.current) return;
      // Always there for the plan's login: a job that's there stays as it is, and one taken away since the page read the
      // branch comes back.
      if (usesPlan) list.push({ name: REFRESH_FILE, content: job, keep: true });
      const opened = await client.proposeWorkflows(repo, branch, list, content !== liveFile ? { kind: 'roles', roles: want } : { kind: 'refresh' });
      if (forRepo !== picked.current) return;
      // Null means the branch already has all of it, like a refresh job someone else added since. A login still missing
      // is still to connect.
      if (opened) begin(opened, addsRefresh);
      else {
        // The refresh job was in the list, so the branch has it now, and it isn't offered again.
        if (usesPlan) setRefreshLive(true);
        if (needs.length) begin(null, false);
        else {
          setRolesChange(null);
          setView('live');
        }
      }
    } catch (err) {
      if (forRepo !== picked.current) return;
      if (err instanceof OpenPrError) setOpenPr(err.pr);
      else setRolesFailed(err instanceof WorkflowEditError ? err.reason : err instanceof TagError ? 'tag' : err instanceof ScanLimitError ? 'scan' : err instanceof GitHubError && (err.status === 403 || err.status === 404) ? 'refused' : 'other');
      // A PR that opens by itself, after a login, shows why it didn't on the choice.
      setView('roles');
    } finally {
      if (forRepo === picked.current) {
        changingNow.current = false;
        setChangingRoles(false);
      }
    }
  };

  /** The AI a change of AI connects next, so its connection can be picked up again after leaving it. */
  const resume = rolesNeed;

  // Once ChatGPT has the repo's own login, the pull request that was waiting for it opens. Only once: it's cleared first.
  useEffect(() => {
    // Only a complete read that shows the repo's own ChatGPT login: a partial one, or an API key, isn't that.
    if (!rolesChange?.connectFirst || !ownPlan || changingRoles) return;
    setRolesChange({ ...rolesChange, connectFirst: false });
    void changeRoles(rolesChange.roles);
    // changeRoles reads the state of this render, which is what it should go by.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolesChange, secretsComplete, secretNames, sharedSecrets, changingRoles]);
  // Why another review stops a change: the first one in a file of another name, which says where to look.
  const elsewhere = details?.otherReviews ?? [];
  const otherFile = elsewhere.find((r) => r.file && r.file !== 'mergelight.yml');
  const unread = elsewhere.find((r) => !r.file);
  const branchesNote = otherFile
    ? `Mergelight also runs from ${otherFile.file} on ${otherFile.branch}, so you set provider and verify-with in each workflow by hand.`
    : elsewhere.some((r) => r.file)
      ? 'Mergelight reviews more than one branch here, so you set provider and verify-with in each by hand.'
      : `We couldn't read every workflow on ${unread?.branch ?? branch}, so you set provider and verify-with in your workflow by hand.`;
  const yourAi = liveFile && <YourAi roles={currentRoles} logins={ownLogins} locked={rolesLocked} branchesNote={branchesNote} oldNote={oldNote} onUpdate={updateOk && update && view !== 'add' ? { tag: update.tag, go: () => setView('add') } : null} pending={rolesChange && pr && !merged ? { pr, roles: rolesChange.roles } : null} resume={resume} busy={adding} onChange={openRoles} onConnect={() => setView('connect')} />;
  /** The login inputs the workflow a connection is for has, when the page can tell. Null offers every way. */
  const accepts = connectUnknown ? null : connectFile && isStandard(connectFile) ? loginInputs(connectFile) : null;

  const anotherRepo = () => {
    picked.current++;
    changingNow.current = false;
    setChangingRoles(false);
    setRepo(null);
    setDetails(null);
    setPr(null);
    setStatus(null);
    setConnectCode(null);
    setMerged(false);
    setPrMerged(false);
    setLiveFile(null);
    setAskedCheck(null);
    setRolesChange(null);
    setView('repo');
  };

  const back: Partial<Record<View, () => void>> = {
    'review-app': anotherRepo,
    add: anotherRepo,
    finish: () => setView('add'),
    // A change of AI has nothing to go back to on the add step: the repo is on already.
    connect: () => setView(rolesChange ? 'live' : 'add'),
    roles: () => setView(rolesFrom),
  };

  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-x-clip">
      <Ambient />
      <header className="relative mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <img src="/logo.png" alt="" width={24} height={24} className="size-6 rounded-md" />
          Mergelight
        </a>
        {/* The orb at the end only lights up once reviews are really on. */}
        <Rail at={view === 'live' && shownPr && !merged ? 3 : RAIL[view]} />
      </header>

      <main className="flex flex-1 justify-center px-4 pb-16 pt-[6vh] sm:pt-[9vh]">
        <div className="relative flex w-full items-start justify-center">
          <motion.div layout="position" transition={SPRING} className="z-10 w-full max-w-[460px] shrink-0">
            <Stage viewKey={view} direction={direction}>
              {view === 'welcome' && <Welcome failed={signInFailed} requested={requested} />}
              {view === 'settling' && <SettlingStep />}
              {view === 'repo' && <RepoStep repos={repos} onChoose={choose} failed={signInFailed} missing={missing} />}
              {view === 'review-app' && repo && <ReviewAppStep repo={repo} onCheck={() => choose(repo)} onBack={back['review-app']!} />}
              {view === 'add' && repo && (
                <AddStep repo={repo} details={details} ai={yourAi} fileCount={files.length} addsRefresh={Boolean(details && !details.refresh && files.some((f) => f.name === REFRESH_FILE))} branch={branch} setBranch={setBranch} scope={scope} setScope={setScope} fileOpen={fileOpen} onToggleFile={() => setFileOpen((v) => !v)} adding={adding} failed={addFailed} blockedBy={addBlockedBy} detailsFailed={detailsFailed} onRetry={() => choose(repo)} update={update} onAdd={() => void addToRepo()} fileUrl={fileUrl} onBack={adding ? () => undefined : back.add!} onByHand={() => { setFileOpen(false); setView('finish'); }} onContinue={() => afterAdding()} />
              )}
              {view === 'finish' && repo && <FinishStep repo={repo} branch={branch} fileUrl={fileUrl} pr={pr} capped={scanCapped} onBack={back.finish!} />}
              {/* A new AI to connect, like the reviewer of a workflow read just now, a new PR or a new run starts the step over: what it learned from the last one doesn't hold. */}
              {view === 'connect' && repo && <ConnectStep key={`${rolesNeed ?? setupNeed ?? ''} ${pr?.number ?? ''} ${pr?.headSha ?? ''}`} repo={repo} pr={pr} status={status} code={connectCode} ask={connectAsk} commandWhy={commandWhy} hold={(rolesChange?.hold && !rolesChange.mergedRead) || (rolesNeed && rolesChange?.onBase.includes(rolesNeed) && !prMerged) || (!rolesChange && setupHold && !prMerged) ? branch : null} holdOnBase={!rolesChange?.hold} merged={prMerged} thenPr={Boolean(rolesChange?.connectFirst)} accepts={accepts} acceptsUnknown={(startOnClaude && linkFile === 'unknown') || (rolesChange ? rolesFile === 'unknown' : !startOnClaude && pendingRead === 'unknown')} visibility={repo.visibility} named={readRoles(rolesChange?.content ?? liveFile ?? workflow)?.provider ?? null} ended={runEnded || Boolean(pr && missedSha === pr.headSha)} onBack={back.connect!} onSkip={() => setView('live')} startOnClaude={startOnClaude || rolesNeed === 'claude'} onClaudeCode={(url, c) => client!.sendClaudeCode(repo, url, c)} />}
              {/* Only an update's own pull request is an update: a change of AI on a repo that could update isn't one. */}
              {view === 'live' && repo && <LiveStep repo={repo} pr={shownPr} backTo={startOnClaude ? pr : null} status={status} hasLogin={hasLogin} merged={merged} updatedTo={startOnClaude || rolesChange ? null : updatePr} ai={yourAi} onAnother={anotherRepo} />}
              {view === 'roles' && repo && liveFile && currentRoles && !rolesLocked && <RolesStep current={currentRoles} openPr={openPr} logins={logins} own={ownLogins} visibility={repo.visibility} refreshMissing={!refreshLive} sharedLogin={sharedChatgpt} defaultBranch={repo.defaultBranch} file={liveFile} branch={branch} changing={changingRoles} failed={rolesFailed} accessUrl={repo.accessUrl} onBack={changingRoles ? () => undefined : back.roles!} onConfirm={(r) => void changeRoles(r)} />}
              {/* A read that finishes after they came here can leave no choice to make, but never leaves them without a way back. */}
              {view === 'roles' && repo && !(liveFile && currentRoles && !rolesLocked) && (
                <div>
                  <BackButton onClick={back.roles!} />
                  <Heading title="Choose your AI" />
                  {yourAi}
                </div>
              )}
            </Stage>
            <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[13px] text-faint">
              <LockIcon className="size-3.5 shrink-0" />
              Your code and AI login never touch Mergelight.
            </p>
          </motion.div>
          <AnimatePresence mode="popLayout" initial={false}>
            {wide && view === 'add' && fileOpen && <FileSide key="file" files={files} version={pinTo?.tag} onClose={() => setFileOpen(false)} />}
          </AnimatePresence>
        </div>
        {!wide && <FileSheet open={view === 'add' && fileOpen} files={files} version={pinTo?.tag} onClose={() => setFileOpen(false)} />}
      </main>
    </div>
  );
}

/** Runs now, then every few seconds while the tab is visible, until it returns true. */
/** How long a run may stay silent before the page says so. */
const LONG_WAIT_MS = 120_000;

/** True once `waiting` has held for a long time. A change of `key` starts the clock again. */
function useLongWait(waiting: boolean, key: string): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!waiting) return;
    const since = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - since >= LONG_WAIT_MS) setLong(true);
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, key]);
  return long;
}

function poll(check: () => Promise<boolean>, everyMs = 4000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    if (stopped) return;
    let done = false;
    if (document.visibilityState === 'visible') done = await check().catch(() => false);
    if (!done && !stopped) timer = setTimeout(run, everyMs);
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const isReviewing = (s: CheckStatus | null) => Boolean(s && (s.status === 'completed' || /^review/i.test(s.title ?? '')));
/** "Connected to ChatGPT" also completes a check, but the review is only just starting. */
const isDone = (s: CheckStatus | null) => s?.status === 'completed' && !/^connected/i.test(s.title ?? '');
/** What the check says when a login or a review ended early. It's completed, but nothing got reviewed. */
const couldntFinish = (s: CheckStatus | null) => s?.status === 'completed' && /^couldn't review/i.test(s.title ?? '');
/** Check titles start with a light emoji, and here the dot already shows it. */
const plainTitle = (s: CheckStatus | null) => (s?.title ?? '').replace(/^[^\p{L}]+/u, '');

/* ---------- Structure ---------- */

/** The card. Its height follows the content, and steps slide in the direction you're going. */
function Stage({ viewKey, direction, children }: { viewKey: string; direction: number; children: ReactNode }) {
  const reduce = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');

  useLayoutEffect(() => {
    if (!inner.current) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry!.contentRect.height));
    observer.observe(inner.current);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div className={`${SURFACE} overflow-hidden`} animate={{ height }} transition={reduce ? { duration: 0 } : SPRING} initial={false}>
      <div ref={inner}>
        <AnimatePresence mode="wait" initial={false} custom={direction}>
          <motion.div
            key={viewKey}
            custom={direction}
            variants={{
              enter: (d: number) => ({ opacity: 0, x: reduce ? 0 : d * 20 }),
              center: { opacity: 1, x: 0 },
              exit: (d: number) => ({ opacity: 0, x: reduce ? 0 : d * -20 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ ...SPRING, opacity: { duration: 0.16 } }}
            className="p-6 sm:p-8"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/** Progress as a thread that lights up on its way to the mint orb from the logo. */
function Rail({ at }: { at: number }) {
  const reduce = useReducedMotion();
  const stops = [0, 1, 2, 3, 4];
  return (
    <div role="img" aria-label={at >= 4 ? 'All done' : `Step ${at + 1} of 4`} className="relative flex w-[132px] items-center justify-between">
      <span className="absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-white/10" />
      <motion.span
        className="absolute left-1 top-1/2 h-px w-[calc(100%-8px)] origin-left -translate-y-1/2 bg-gradient-to-r from-lilac to-mint"
        initial={false}
        animate={{ scaleX: at / 4 }}
        transition={reduce ? { duration: 0 } : SPRING}
      />
      {stops.map((i) => {
        const last = i === 4;
        const reached = i <= at;
        return (
          <span
            key={i}
            className={`relative rounded-full transition-colors duration-300 ${last ? 'size-2.5' : 'size-1.5'} ${
              reached ? (last ? 'bg-mint shadow-[0_0_14px_3px_rgb(63_232_184/0.55)]' : 'bg-lilac') : 'bg-[#2a2833]'
            }`}
          />
        );
      })}
    </div>
  );
}

function Heading({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.025em] [text-wrap:balance]">{title}</h1>
      {sub && <p className="mt-2 text-[15px] leading-relaxed text-muted [text-wrap:pretty]">{sub}</p>}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="-ml-1.5 mb-4 flex h-8 items-center gap-1 rounded-lg pl-1 pr-2.5 text-[13px] text-faint transition-colors hover:bg-white/[0.05] hover:text-muted active:scale-[0.97]">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4">
        <path d="m10 4-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Back
    </button>
  );
}

const BUTTON = 'flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px] font-medium transition-[background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lilac';
const PRIMARY = `${BUTTON} bg-fg text-ink hover:bg-white`;

function External({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M5.5 10.5 10.5 5.5M6 5.5h4.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function InfoIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.25v3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.85" fill="currentColor" />
    </svg>
  );
}

/** A small live status, with a gentle pulse only while something is actually happening. */
function Pulse({ tone = 'lilac', still = false, children }: { tone?: 'lilac' | 'mint' | 'risk' | 'bug'; still?: boolean; children: ReactNode }) {
  const dot = { lilac: 'bg-lilac', mint: 'bg-mint', risk: 'bg-risk', bug: 'bg-bug' }[tone];
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative flex size-2 shrink-0">
        {!still && <span className={`absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden ${dot}`} />}
        <span className={`relative size-2 rounded-full ${dot}`} />
      </span>
      <span className="min-w-0 text-[14px] text-muted">{children}</span>
    </span>
  );
}

/* ---------- Steps ---------- */

function Spinner({ className = 'size-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={`${className} animate-spin motion-reduce:animate-none`}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Welcome({ failed, requested }: { failed: boolean; requested: boolean }) {
  return (
    <div className="py-2 text-center">
      <img src="/logo-animated.svg" alt="" width={84} height={84} className="mx-auto size-[84px] rounded-[20px] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_14px_40px_-12px_rgb(0_0_0/0.8)]" />
      <h1 className="mt-5 text-[32px] font-semibold leading-[1.1] tracking-[-0.03em]">{requested ? 'Request sent' : 'Turn on Mergelight'}</h1>
      <p className="mx-auto mt-3 max-w-[320px] text-[15px] leading-relaxed text-muted [text-wrap:pretty]">
        {requested
          ? 'An owner of your org has to approve Mergelight, and GitHub has emailed them. Once they have, come back here to finish.'
          : 'Real code review on the AI plan you already pay for. Three quick steps, nothing to install.'}
      </p>
      {failed && <p className="mt-4 text-[13px] text-risk">GitHub sign-in didn't work. Please try again.</p>}
      {requested ? (
        <a href={signInUrl()} className="mt-6 inline-flex text-[13px] text-muted transition-colors hover:text-fg">
          Already approved? Continue with GitHub
        </a>
      ) : (
        <a href={signInUrl()} className={`${PRIMARY} mt-7`}>
          <GitHubIcon className="size-[18px]" /> Continue with GitHub
        </a>
      )}
    </div>
  );
}

/** Holds the card while sign-in and the repo's details load. Most of the time it's on screen for about a second. */
function SettlingStep() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" aria-label="Loading">
      <span className="block h-7 w-3/5 animate-pulse rounded-lg bg-white/[0.06]" />
      <span className="mt-3 block h-4 w-4/5 animate-pulse rounded bg-white/[0.05]" style={{ animationDelay: '90ms' }} />
      <div className="mt-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <span key={i} className="block h-5 animate-pulse rounded bg-white/[0.05]" style={{ width: `${86 - i * 14}%`, animationDelay: `${(i + 2) * 90}ms` }} />
        ))}
      </div>
      <span className="mt-6 block h-12 animate-pulse rounded-full bg-white/[0.06]" style={{ animationDelay: '450ms' }} />
      {slow && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="mt-3 text-center text-[13px] text-muted">
          This can take up to a minute.
        </motion.p>
      )}
    </div>
  );
}

function RepoStep({ repos, onChoose, failed, missing }: { repos: Repo[] | null; onChoose: (r: Repo) => void; failed: boolean; missing: ConnectLink | null }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useMemo(() => (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase())), [repos, query]);
  useEffect(() => setActive(0), [query]);

  if (failed) {
    return (
      <div>
        <Heading title="Couldn't reach GitHub" sub="Your sign-in may have run out. Sign in again to pick up where you were." />
        <a href={signInUrl()} className={`${PRIMARY} mt-6`}>
          <GitHubIcon className="size-[18px]" /> Continue with GitHub
        </a>
      </div>
    );
  }

  if (missing) {
    return (
      <div>
        <Heading title={`Give Mergelight access to ${missing.repo.split('/')[1]}`} sub={`Your pull request is on ${missing.repo}, and Mergelight can't see that repo yet. Choose it on GitHub, and you'll come straight back here.`} />
        <a href={INSTALL_URL} onClick={() => rememberConnect(missing)} className={`${PRIMARY} mt-6`}>
          <GitHubIcon className="size-[18px]" /> Choose on GitHub
        </a>
      </div>
    );
  }

  if (repos && repos.length === 0) {
    return (
      <div>
        <Heading title="Pick your repos" sub="Choose which repos Mergelight can review. You can change this any time." />
        <a href={INSTALL_URL} className={`${PRIMARY} mt-6`}>
          <GitHubIcon className="size-[18px]" /> Choose on GitHub
        </a>
      </div>
    );
  }

  return (
    <div>
      <Heading title="Which repo should we review?" />
      {repos && repos.length > 6 && (
        <div className="relative mt-5">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-faint">
            <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, list.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && list[active]) {
                onChoose(list[active]!);
              }
            }}
            placeholder="Search repos"
            aria-label="Search repos"
            className="h-11 w-full rounded-xl bg-black/25 pl-10 pr-3.5 text-[15px] text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] outline-none transition-shadow placeholder:text-faint focus:shadow-[inset_0_0_0_1.5px_rgb(184_156_255/0.7)]"
          />
        </div>
      )}

      <div role="listbox" aria-label="Your repos" className="-mx-2 mt-4 max-h-[320px] overflow-y-auto overscroll-contain">
        {!repos &&
          [0, 1, 2].map((i) => (
            <div key={i} className="flex h-14 items-center gap-3 px-2">
              <span className="size-8 animate-pulse rounded-lg bg-white/[0.06]" />
              <span className="h-3 w-40 animate-pulse rounded bg-white/[0.06]" style={{ animationDelay: `${i * 90}ms` }} />
            </div>
          ))}
        {list.map((r, i) => (
          <button
            key={r.fullName}
            type="button"
            role="option"
            aria-selected={i === active}
            onClick={() => onChoose(r)}
            onMouseEnter={() => setActive(i)}
            className={`group flex h-14 w-full items-center gap-3 rounded-xl px-2 text-left transition-[background-color,transform] duration-100 active:scale-[0.985] ${i === active ? 'bg-white/[0.05]' : ''}`}
          >
            <img src={r.avatarUrl} alt="" width={32} height={32} className="size-8 rounded-lg bg-white/[0.06]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium leading-tight text-fg">{r.fullName.split('/')[1]}</span>
              <span className="mt-0.5 block truncate text-[12.5px] leading-tight text-faint">{r.account}</span>
            </span>
            {r.isPrivate && <LockIcon className="size-3.5 shrink-0 text-faint" />}
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={`size-4 shrink-0 text-faint transition-opacity ${i === active ? 'opacity-100' : 'opacity-0'}`}>
              <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ))}
        {repos && list.length === 0 && <p className="px-2 py-6 text-center text-[14px] text-faint">No repos match that.</p>}
      </div>

      {/* Same tab: GitHub sends them back here after an install, and after a change because the app has "Redirect on update" on. */}
      {repos && (
        <a href={INSTALL_URL} className="mt-3 flex items-center justify-center gap-1 text-[13px] text-muted transition-colors hover:text-fg">
          Don't see your repo? Add it on GitHub
        </a>
      )}
    </div>
  );
}

/** `tall` lines the icon up with a first line that holds a control. */
function Fact({ icon, center = false, tall = false, children }: { icon: ReactNode; center?: boolean; tall?: boolean; children: ReactNode }) {
  return (
    <li className={`flex gap-3 py-3 text-[14.5px] leading-[1.45] text-muted ${center ? 'items-center' : 'items-start'}`}>
      <span className={`grid size-[18px] shrink-0 place-items-center text-lilac ${center ? '' : tall ? 'mt-[7px]' : 'mt-[2px]'}`}>{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

/** Two choices side by side. Real radio buttons, so arrow keys and screen readers just work. */
function Choices<T extends string>({ label, options, value, onChange, top = 'mt-5' }: { label: string; options: { id: T; title: string; note?: string; disabled?: boolean; icon?: { path: string; color: string } }[]; value: T; onChange: (v: T) => void; top?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={`${top} grid grid-cols-2 gap-2`}>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <label
            key={o.id}
            className={`flex flex-col justify-center rounded-2xl p-3.5 transition-[background-color,box-shadow,transform] duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-lilac ${o.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer active:scale-[0.98]'} ${on ? 'bg-white/[0.07] shadow-[inset_0_0_0_1.5px_rgb(184_156_255/0.75)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:bg-white/[0.05]'}`}
          >
            <input type="radio" name={label} className="sr-only" checked={on} disabled={o.disabled} onChange={() => onChange(o.id)} />
            <span className="flex items-center gap-2.5">
              {o.icon && (
                <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0" fill={o.icon.color} fillRule="evenodd">
                  <path d={o.icon.path} />
                </svg>
              )}
              <span className="block text-[14.5px] font-medium text-fg">{o.title}</span>
            </span>
            {o.note && <span className="mt-1 block text-[12.5px] leading-snug text-muted [text-wrap:pretty]">{o.note}</span>}
          </label>
        );
      })}
    </div>
  );
}

/** One thing or the other, with a pill that slides between them. Real radio buttons, for the same reason as above. */
function Segment<T extends string>({ label, options, value, onChange }: { label: string; options: { id: T; title: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="mt-5 flex rounded-xl bg-black/25 p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
      {options.map((o) => {
        const on = value === o.id;
        return (
          <label key={o.id} className={`relative flex h-9 flex-1 cursor-pointer items-center justify-center rounded-lg text-[14px] font-medium transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-lilac ${on ? 'text-fg' : 'text-muted hover:text-fg'}`}>
            <input type="radio" name={label} className="sr-only" checked={on} onChange={() => onChange(o.id)} />
            {on && <motion.span layoutId={`${label} pill`} transition={{ type: 'spring', bounce: 0, duration: 0.28 }} className="absolute inset-0 rounded-lg bg-white/[0.1] shadow-[0_0_0_1px_rgb(255_255_255/0.06)]" />}
            <span className="relative">{o.title}</span>
          </label>
        );
      })}
    </div>
  );
}

function AddStep(props: {
  repo: Repo;
  details: RepoDetails | null;
  /** Who reviews and who checks, on a repo that's on already. */
  ai: ReactNode;
  fileCount: number;
  /** Whether this adds the job that keeps a ChatGPT login fresh. */
  addsRefresh: boolean;
  branch: string;
  setBranch: (b: string) => void;
  scope: Scope;
  setScope: (s: Scope) => void;
  fileOpen: boolean;
  onToggleFile: () => void;
  adding: boolean;
  failed: 'refused' | 'open' | 'scan' | 'no-step' | 'other' | null;
  /** The pull request that changes who reviews, which an update waits for. */
  blockedBy: SetupPr | null;
  detailsFailed: boolean;
  onRetry: () => void;
  update: Release | null;
  onAdd: () => void;
  fileUrl: string;
  onBack: () => void;
  onByHand: () => void;
  onContinue: () => void;
}) {
  const { repo, details, ai, fileCount, addsRefresh, branch, setBranch, scope, setScope, fileOpen, onToggleFile, adding, failed, blockedBy, detailsFailed, onRetry, update, onAdd, fileUrl, onBack, onByHand, onContinue } = props;
  const name = repo.fullName.split('/')[1]!;

  if (detailsFailed) {
    return (
      <div>
        <BackButton onClick={onBack} />
        <Heading title={`Couldn't read ${name}`} sub="GitHub didn't answer the way we expected. Nothing was changed." />
        <button type="button" onClick={onRetry} className={`${PRIMARY} mt-6`}>
          Try again
        </button>
      </div>
    );
  }

  if (details && update) {
    // What changes besides the version lines. The comment trigger goes in where the workflow's shape is known; one
    // changed by hand gets a pointer to the lines instead.
    const live = details.installed?.content ?? '';
    const comments = !live || hasCommentTrigger(live) ? 'has' : withCommentTrigger(live) ? 'adds' : 'by-hand';
    const existing = 1 + (details.refresh ? 1 : 0) + (details.approve ? 1 : 0);
    const where = existing === 1 ? 'in your file' : existing === 2 ? 'in both files' : 'in all three files';
    return (
      <div>
        <BackButton onClick={onBack} />
        <Heading title={`Update Mergelight on ${name}`} sub={`It's pinned to ${details.installed?.version ?? 'an older version'}, and ${update.tag} is out.`} />
        <ul className="mt-3 divide-y divide-white/[0.06]">
          <Fact icon={<Check className="size-4" />}>Moves the pin to the exact commit of {update.tag}</Fact>
          <Fact icon={<Check className="size-4" />}>
            {comments === 'adds'
              ? `Changes the Mergelight version lines ${where}, and adds the trigger that lets a comment that mentions @mergelight-ai answer the findings${branch === repo.defaultBranch ? '' : `. GitHub runs that trigger from ${repo.defaultBranch}, so it works once the change is there too`}`
              : `Changes only the Mergelight version lines ${where}`}
          </Fact>
          {!details.approve && <Fact icon={<Check className="size-4" />}>Adds the small job that turns a "needs a human" check green when someone approves</Fact>}
          {addsRefresh && <Fact icon={<Check className="size-4" />}>Adds the small job that keeps a ChatGPT login fresh</Fact>}
          {comments === 'by-hand' && (
            <Fact icon={<InfoIcon className="size-4" />}>
              <span className="[text-wrap:pretty]">
                Your workflow was changed by hand, so answering the findings in a comment needs its trigger added by hand too.{' '}
                <a href={EXAMPLE_WORKFLOW} target="_blank" rel="noreferrer" className="text-lilac underline-offset-4 hover:underline">
                  See the lines
                </a>
              </span>
            </Fact>
          )}
          <Fact center icon={<LockIcon className="size-4" />}>
            <span className="flex items-center justify-between gap-3">
              <span className="[text-wrap:pretty]">Opens a PR, and you decide whether to merge.</span>
              <button
                type="button"
                aria-expanded={fileOpen}
                onClick={onToggleFile}
                className={`h-8 shrink-0 rounded-lg px-2.5 text-[13px] font-medium text-fg outline-none transition-[background-color,transform] duration-100 hover:bg-white/[0.11] focus-visible:ring-2 focus-visible:ring-lilac active:scale-[0.97] ${fileOpen ? 'bg-white/[0.11]' : 'bg-white/[0.07]'}`}
              >
                {fileOpen ? (fileCount > 1 ? 'Hide files' : 'Hide file') : fileCount > 1 ? 'View files' : 'View file'}
              </button>
            </span>
          </Fact>
        </ul>
        {ai}
        <button type="button" onClick={onAdd} disabled={adding} className={`${PRIMARY} mt-5 ${adding ? 'pointer-events-none opacity-70' : ''}`}>
          {adding && <Spinner />}
          {adding ? 'Opening your PR...' : `Update to ${update.tag}`}
        </button>
        <a href={`https://github.com/mergelightai/mergelight/releases/tag/${update.tag}`} target="_blank" rel="noreferrer" className="mt-4 flex items-center justify-center gap-1 text-[13px] text-muted transition-colors hover:text-fg">
          What's new in {update.tag} <External />
        </a>
        {failed && (
          <div role="alert" className="mt-4 text-center text-[13px] leading-relaxed text-muted">
            <p>{failed === 'open' && blockedBy ? `PR #${blockedBy.number} changes your Mergelight workflow already. Merge or close it first, then update.` : failed === 'scan' ? SCAN_NOTE : failed === 'no-step' ? 'The workflow on your open PR has no Mergelight step, so nothing was changed.' : failed === 'refused' ? "GitHub didn't let us open the PR. Your install may need to approve the access." : "That didn't work. Please try again."}</p>
            {failed === 'open' && blockedBy && (
              <a href={blockedBy.url} target="_blank" rel="noreferrer" className="mx-auto mt-1.5 flex w-fit items-center gap-1 text-lilac transition-colors hover:text-fg">
                Open PR #{blockedBy.number} <External />
              </a>
            )}
            {failed === 'refused' && (
              <a href={repo.accessUrl} target="_blank" rel="noreferrer" className="mx-auto mt-1.5 flex w-fit items-center gap-1 text-lilac transition-colors hover:text-fg">
                Approve on GitHub <External />
              </a>
            )}
          </div>
        )}
      </div>
    );
  }

  const already = Boolean(details?.installed);
  const canChoose = Boolean(details && details.skip.length > 1);
  // With New work the branch is already picked up top, so only Every PR asks where the file goes.
  const pickFileBranch = scope === 'all' && Boolean(details && details.branches.length > 1);
  const others = details?.skip.filter((b) => b !== branch) ?? [];
  const mergedInto = others.includes('main') ? 'main' : others[0];
  const picker = details && <BranchPicker branches={details.branches} value={branch} suggested={details.base} onChange={setBranch} />;
  const sub = !details ? 'Reading your repo...' : already ? `It's already on ${branch}.` : canChoose ? 'Choose what it reviews.' : 'Here is what it will do.';

  return (
    <div>
      <BackButton onClick={onBack} />
      <Heading title={`Add Mergelight to ${name}`} sub={sub} />

      {!details ? (
        <div className="mt-5 space-y-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="block h-5 animate-pulse rounded bg-white/[0.05]" style={{ width: `${86 - i * 14}%`, animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : (
        <>
          {canChoose && !already && (
            <Choices
              label="What it reviews"
              value={scope}
              onChange={setScope}
              options={[
                { id: 'new', title: 'New work', note: 'Best if all your code goes through a PR' },
                { id: 'all', title: 'Every PR', note: 'Any branch, nothing skipped. Uses more of your AI plan' },
              ]}
            />
          )}
          <ul className="mt-3 divide-y divide-white/[0.06]">
            {!already && scope === 'new' && (
              <>
                <Fact center icon={<Check className="size-4" />}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">Reviews PRs into {picker}</span>
                </Fact>
                {mergedInto && (
                  <Fact icon={<Check className="size-4" />}>
                    Skips merges like {branch} into {mergedInto}, so code pushed straight to {branch} won't get reviewed.
                  </Fact>
                )}
              </>
            )}
            {!already && scope === 'all' && (
              <Fact icon={<Check className="size-4" />}>
                {canChoose ? 'Reviews every PR into a branch with the file' : pickFileBranch ? 'Reviews every PR' : `Reviews every PR on ${branch}`}
              </Fact>
            )}
            <Fact icon={<Check className="size-4" />}>Runs in your own GitHub Actions, on your AI plan</Fact>
            {details.installed && (
              <Fact icon={<Check className="size-4" />}>{isPinned(details.installed) ? `Pinned to ${details.installed.version ?? 'one version'}, so you choose when to update` : 'Gets new versions by itself'}</Fact>
            )}
            {!already && (
              <Fact center={!pickFileBranch} tall={pickFileBranch} icon={<LockIcon className="size-4" />}>
                <span className="flex items-center justify-between gap-3">
                  {pickFileBranch ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">Opens a PR into {picker}</span>
                  ) : (
                    <span className="[text-wrap:pretty]">{fileCount > 1 ? `Needs ${countWord(fileCount)} small files to run. We open a PR with them, and you decide whether to merge.` : 'Needs one small file to run. We open a PR with it, and you decide whether to merge.'}</span>
                  )}
                  <button
                    type="button"
                    aria-expanded={fileOpen}
                    onClick={onToggleFile}
                    className={`h-8 shrink-0 rounded-lg px-2.5 text-[13px] font-medium text-fg outline-none transition-[background-color,transform] duration-100 hover:bg-white/[0.11] focus-visible:ring-2 focus-visible:ring-lilac active:scale-[0.97] ${fileOpen ? 'bg-white/[0.11]' : 'bg-white/[0.07]'}`}
                  >
                    {fileOpen ? (fileCount > 1 ? 'Hide files' : 'Hide file') : fileCount > 1 ? 'View files' : 'View file'}
                  </button>
                </span>
                {pickFileBranch && (
                  <span className="mt-1 block [text-wrap:pretty]">
                    {fileCount > 1 ? `It adds ${countWord(fileCount)} small files needed to run` : 'It adds one small file needed to run'}, and you decide whether to merge.{canChoose && ` Merge ${fileCount > 1 ? 'them' : 'it'} into other branches to review PRs there.`}
                  </span>
                )}
              </Fact>
            )}
          </ul>
        </>
      )}

      {details?.installed ? (
        <>
          {ai}
          <button type="button" onClick={onContinue} className={`${PRIMARY} mt-5`}>
            Continue
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={onAdd} disabled={!details || adding} className={`${PRIMARY} mt-5 ${!details ? 'pointer-events-none opacity-40' : adding ? 'pointer-events-none opacity-70' : ''}`}>
            {adding && <Spinner />}
            {adding ? 'Opening your PR...' : `Add to ${name}`}
          </button>
          {failed && (
            <div role="alert" className="mt-4 text-center text-[13px] leading-relaxed text-muted">
              <p>{failed === 'scan' ? SCAN_NOTE : failed === 'refused' ? "GitHub didn't let us open the PR. Your install may need to approve the access." : "That didn't work. Please try again."}</p>
              <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                {failed === 'refused' && (
                  <a href={repo.accessUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-lilac transition-colors hover:text-fg">
                    Approve on GitHub <External />
                  </a>
                )}
                <a href={fileUrl} target="_blank" rel="noreferrer" onClick={onByHand} className="flex items-center gap-1 text-lilac transition-colors hover:text-fg">
                  Add the file yourself <External />
                </a>
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BranchPicker({ branches, value, suggested, onChange }: { branches: string[]; value: string; suggested: string; onChange: (v: string) => void }) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger aria-label="Branch to review" className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-white/[0.07] pl-2.5 pr-1.5 text-[14px] font-medium text-fg outline-none transition-colors hover:bg-white/[0.11] focus-visible:ring-2 focus-visible:ring-lilac data-[state=open]:bg-white/[0.11]">
        <span className="truncate">
          <Select.Value />
        </span>
        <Select.Icon asChild>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 shrink-0 text-muted">
            <path d="m4.5 6.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={6} align="start" className="setup-pop z-50 max-h-[280px] min-w-[220px] overflow-hidden rounded-2xl bg-[#1b1923]/90 p-1 shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_18px_50px_-12px_rgb(0_0_0/0.8)] backdrop-blur-xl">
          <Select.Viewport>
            {branches.map((b) => (
              <Select.Item key={b} value={b} className="flex h-9 cursor-pointer select-none items-center justify-between gap-4 rounded-xl px-3 text-[14px] text-muted outline-none data-[highlighted]:bg-white/[0.08] data-[highlighted]:text-fg data-[state=checked]:text-fg">
                <Select.ItemText>{b}</Select.ItemText>
                <span className="flex items-center gap-2">
                  {b === suggested && <span className="text-[12px] text-faint">Most PRs</span>}
                  <Select.ItemIndicator>
                    <Check className="size-3.5 text-mint" />
                  </Select.ItemIndicator>
                </span>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/** Colors one line of the workflow file. The file is small and regular, so a parser would be overkill. */
function YamlLine({ text }: { text: string }) {
  const [, indent, rest] = text.match(/^(\s*)(.*)$/)!;
  if (rest!.startsWith('#')) return <>{indent}<span className="text-faint">{rest}</span></>;
  const [, code, comment] = rest!.match(/^(.*?)(\s#\s.*)?$/)!;
  const [, dash, key, value] = code!.match(/^(- )?([\w-]+:)(\s.*)?$/) ?? [];
  const parts = (value ?? (key ? '' : code!)).split(/(\$\{\{.*?\}\})/);
  return (
    <>
      {indent}
      {dash && <span className="text-faint">{dash}</span>}
      {key && <span className="text-lilac">{key}</span>}
      {parts.map((part, i) => (
        <span key={i} className={i % 2 ? 'text-mint' : key ? 'text-fg' : 'text-muted'}>
          {/* Long expressions wrap at their dots on a phone, not mid-word. <wbr> stays out of copied text. */}
          {part.split(/(?<=\.)/).map((piece, j) => [j > 0 && <wbr key={j} />, piece])}
        </span>
      ))}
      {comment && <span className="text-faint">{comment}</span>}
    </>
  );
}

/** The exact file GitHub will open with, and why it's there. */
/** What each workflow is for, shown above its lines. */
const FILE_PURPOSE: Record<string, string> = {
  'mergelight.yml': 'Runs the review on your pull requests.',
  [REFRESH_FILE]: "Keeps a ChatGPT login from expiring. Scheduled jobs only run from your default branch, so it starts once it's merged there.",
  [APPROVE_FILE]: 'Turns a "needs a human" check green when someone who can push approves the pull request.',
};

/** The exact files the pull request will hold, and why they're there. */
function FileView({ files, version, onClose }: { files: WorkflowFile[]; version?: string; onClose: () => void }) {
  const all = files.flatMap((f) => f.content.trimEnd().split('\n'));
  // A line that wasn't there before lights up, so a choice on the card is visibly a change in the file.
  const seen = useRef(new Set(all));
  useEffect(() => {
    all.forEach((l) => seen.current.add(l));
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 pl-5 pr-2.5 shadow-[inset_0_-1px_0_rgb(255_255_255/0.06)]">
        <p className="min-w-0 truncate font-mono text-[12.5px]">
          <span className="text-faint">.github/workflows/</span>
          {files.length === 1 && <span className="text-fg">{files[0]!.name}</span>}
        </p>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 shrink-0 place-items-center rounded-lg text-faint outline-none transition-[background-color,color,transform] duration-100 hover:bg-white/[0.06] hover:text-fg focus-visible:ring-2 focus-visible:ring-lilac active:scale-[0.94]">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4">
            <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="shrink-0 px-5 py-4">
        <p className="text-[14.5px] font-medium text-fg [text-wrap:balance]">{files.length > 1 ? 'These files are' : 'This file is'} why your code and AI login never touch Mergelight</p>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted [text-wrap:pretty]">Most review tools run on their own servers. Mergelight runs in your GitHub Actions instead, and GitHub needs {files.length > 1 ? 'these files' : 'this file'} in your repo to do that.</p>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted">
          <li className="flex items-center gap-1.5"><Check className="size-3.5 text-lilac" /> Reads your code</li>
          <li className="flex items-center gap-1.5"><Check className="size-3.5 text-lilac" /> Posts reviews</li>
          <li className="flex items-center gap-1.5"><LockIcon className="size-3.5 text-lilac" /> Reviews can't push code</li>
          {version ? <li className="flex items-center gap-1.5"><LockIcon className="size-3.5 text-lilac" /> Pinned to {version}</li> : <li className="flex items-center gap-1.5"><Check className="size-3.5 text-lilac" /> Updates by itself</li>}
        </ul>
      </div>
      <div tabIndex={0} aria-label="The files' contents" className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-black/25 pb-7 font-mono text-[12px] leading-[20px] outline-none shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-lilac">
        {files.map((file) => (
          <section key={file.name} className="pt-3">
            <div className="mb-2 px-5 font-sans">
              <p className="font-mono text-[12.5px] text-fg">{file.name}</p>
              <p className="mt-0.5 text-[12.5px] leading-snug text-muted [text-wrap:pretty]">{FILE_PURPOSE[file.name]}</p>
            </div>
            {file.content.trimEnd().split('\n').map((line, i) => {
              const hang = line.match(/^\s*/)![0].length + 2;
              return (
                <div key={`${i}:${line}`} className={`flex pr-4 ${seen.current.has(line) ? '' : 'setup-fresh'}`}>
                  <span aria-hidden="true" className="w-10 shrink-0 select-none pr-3 text-right tabular-nums text-faint/50">{i + 1}</span>
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-words" style={{ paddingLeft: `${hang}ch`, textIndent: `-${hang}ch` }}>
                    <YamlLine text={line} />
                  </code>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Beside the card when there's room. The card moves over to make space, and back when it closes. */
function FileSide({ files, version, onClose, ref }: { files: WorkflowFile[]; version?: string; onClose: () => void; ref?: Ref<HTMLElement> }) {
  const reduce = useReducedMotion();
  return (
    <motion.aside
      ref={ref}
      aria-label="The workflow file"
      initial={{ opacity: 0, x: reduce ? 0 : -28 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: reduce ? 0 : -28 }}
      transition={{ ...SPRING, opacity: { duration: 0.2 } }}
      className={`${SURFACE} ml-5 h-[min(720px,calc(100dvh-64px-9vh-40px))] w-[600px] shrink-0 overflow-hidden`}
    >
      <FileView files={files} version={version} onClose={onClose} />
    </motion.aside>
  );
}

/** On a phone or tablet the same thing comes up as a sheet. */
function FileSheet({ open, files, version, onClose }: { open: boolean; files: WorkflowFile[]; version?: string; onClose: () => void }) {
  const reduce = useReducedMotion();
  const hidden = reduce ? { opacity: 0 } : { y: '100%' };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-40 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.div
                initial={hidden}
                animate={reduce ? { opacity: 1 } : { y: 0 }}
                exit={hidden}
                transition={SPRING}
                className="fixed inset-x-0 bottom-0 z-50 h-[88dvh] overflow-hidden rounded-t-[22px] bg-[linear-gradient(180deg,#1a1820_0%,#121116_100%)] pb-[env(safe-area-inset-bottom)] shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] outline-none"
              >
                <Dialog.Title className="sr-only">The workflow file</Dialog.Title>
                <FileView files={files} version={version} onClose={onClose} />
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function Numbered({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-[14.5px] leading-[1.45] text-muted">
      <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-white/[0.07] text-[12px] font-medium tabular-nums text-fg">{n}</span>
      <span className="min-w-0 flex-1 pt-px">{children}</span>
    </li>
  );
}

const Strong = ({ children }: { children: ReactNode }) => <span className="font-medium text-fg">{children}</span>;

/** Two apps, so that the key on our server can't commit anything. This one posts the reviews. */
function ReviewAppStep({ repo, onCheck, onBack }: { repo: Repo; onCheck: () => void; onBack: () => void }) {
  return (
    <div>
      <BackButton onClick={onBack} />
      <Heading title="One more install" sub={`Mergelight AI posts the reviews. We've selected ${repo.fullName.split('/')[1]} for you, so just approve it on GitHub.`} />
      <p className="mt-4 text-[13px] leading-relaxed text-muted">
        Mergelight uses two apps. Mergelight AI can't change your code or workflows. Mergelight Setup can, but only while you're signed in here.
      </p>
      <a href={reviewAppUrl(repo)} onClick={() => rememberRepo(repo.fullName)} className={`${PRIMARY} mt-6`}>
        <GitHubIcon className="size-[18px]" /> Install Mergelight AI
      </a>
      <button type="button" onClick={onCheck} className="mx-auto mt-3 flex items-center justify-center text-[13px] text-muted transition-colors hover:text-fg">
        I've installed it, check again
      </button>
    </div>
  );
}

/** `capped` is a repo with more open PRs than are looked through, so theirs is only known once it's merged. */
function FinishStep({ repo, branch, fileUrl, pr, capped, onBack }: { repo: Repo; branch: string; fileUrl: string; pr: SetupPr | null; capped: boolean; onBack: () => void }) {
  return (
    <div>
      <BackButton onClick={onBack} />
      <Heading title="Finish on GitHub" sub="We opened it with everything filled in. Three clicks there:" />
      <ol className="mt-5 space-y-3.5">
        <Numbered n={1}>
          Click <Strong>Commit changes</Strong>
        </Numbered>
        <Numbered n={2}>
          Choose <Strong>Create a new branch</Strong>, then <Strong>Propose changes</Strong>
        </Numbered>
        <Numbered n={3}>
          Click <Strong>Create pull request</Strong>
        </Numbered>
      </ol>
      <div className={`${WELL} mt-6 px-4 py-3.5`}>
        {pr ? <Pulse tone="mint" still>Found pull request #{pr.number}</Pulse> : capped ? <Pulse>This repo has more open PRs than we look through, so we'll see yours once it's merged into {branch}</Pulse> : <Pulse>Waiting for your pull request on {repo.fullName.split('/')[1]}</Pulse>}
      </div>
      <a href={fileUrl} target="_blank" rel="noreferrer" className="mt-4 flex items-center justify-center gap-1 text-[13px] text-muted transition-colors hover:text-fg">
        Open it on GitHub again <External />
      </a>
      <span className="sr-only">Adding to {branch}</span>
    </div>
  );
}

/**
 * `ended` is a run that finished without the login this step is for, which its check title alone can't tell. `ask` is
 * what the page knows the run asks for before it says so: one AI, for the review or for checking another AI's review.
 * `hold` is the branch whose reviews a login saved now would move, so the pull request has to be merged first. With
 * `holdOnBase`, it's the branch whose workflow the pull request's run reads, which doesn't ask for this AI.
 * `merged` is a pull request that's merged already, so a new commit on it starts no run. `accepts` is the login inputs
 * the workflow has, when that's known: a login saved for an input it doesn't have would never be used.
 */
function ConnectStep({ repo, pr, status, code: found, ask = null, commandWhy = null, visibility = 'private', hold = null, holdOnBase = false, merged = false, thenPr = false, accepts = null, acceptsUnknown = false, named = null, ended = false, onBack, onSkip, startOnClaude, onClaudeCode }: { repo: Repo; pr: SetupPr | null; status: CheckStatus | null; code: ConnectCode | null; ask?: { ai: Ai; forCheck: boolean } | null; commandWhy?: CommandWhy | null; visibility?: Repo['visibility']; hold?: string | null; holdOnBase?: boolean; merged?: boolean; thenPr?: boolean; accepts?: string[] | null; acceptsUnknown?: boolean; named?: Ai | null; ended?: boolean; onBack: () => void; onSkip: () => void; startOnClaude: boolean; onClaudeCode: (url: string, code: string) => Promise<void> }) {
  const failed = couldntFinish(status) || ended;
  // A code from a run that has gone on without it can't be used any more.
  const code = found?.code && !failed ? found : null;
  const claudeUrl = found?.claudeUrl ?? null;
  const [pasted, setPasted] = useState('');
  const [sending, setSending] = useState<'idle' | 'sending' | 'sent' | 'failed' | 'incomplete'>('idle');
  const [chosenBilling, setBilling] = useState<'plan' | 'key'>('plan');
  const [chosenProvider, setProvider] = useState<'openai' | 'anthropic'>(startOnClaude || ask?.ai === 'claude' ? 'anthropic' : 'openai');
  // A run that offers one AI only gets that AI here: the other one's code or link never comes on that run. That's the AI
  // for the job when the run asks for a checker, the link was for Claude, or the workflow names it. Otherwise only that
  // run's sign-in offers just the one, as when ChatGPT's code couldn't be made, and an API key for either still works.
  const [only, setOnly] = useState<Ai | null>(ask?.ai ?? null);
  const [planOnly, setPlanOnly] = useState<Ai | null>(null);
  const [forCheck, setForCheck] = useState(ask?.forCheck ?? false);
  useEffect(() => {
    if (!found) return;
    const one = onlyAi(found);
    // What the run says wins, and it holds once it has said it, also after its line is gone.
    if (one) {
      if (found.purpose === 'check' || startOnClaude || named === one) setOnly(one);
      else setPlanOnly(one);
      setProvider(one === 'claude' ? 'anthropic' : 'openai');
    } else {
      // A new run that offers both again: the last one's failed sign-in no longer holds.
      setPlanOnly(null);
    }
    // Each run says what its login is for: a new one can ask for a reviewer where the last one asked for a checker.
    setForCheck(found.purpose === 'check');
  }, [found, startOnClaude, named]);
  const checking = forCheck && only;
  // Only the ways the workflow takes a login, and the one AI a run asks for when it asks for one.
  const modeOf = (b: 'plan' | 'key', p: 'openai' | 'anthropic') => (b === 'plan' ? (p === 'openai' ? 'chatgpt' : 'claude') : p === 'openai' ? 'apikey' : 'anthropic');
  const inputOf = { chatgpt: LOGIN_INPUTS.codex[0], apikey: LOGIN_INPUTS.codex[1], claude: LOGIN_INPUTS.claude[0], anthropic: LOGIN_INPUTS.claude[1] };
  // While the organization's ChatGPT login is passed on, the Action uses it before any OpenAI key, so a key wouldn't help.
  const takes = (b: 'plan' | 'key', p: 'openai' | 'anthropic') => (!accepts || accepts.includes(inputOf[modeOf(b, p)])) && !(commandWhy === 'shared' && modeOf(b, p) === 'apikey');
  const onlyFor = (b: 'plan' | 'key') => only ?? (b === 'plan' ? planOnly : null);
  const offeredFor = (b: 'plan' | 'key'): ('openai' | 'anthropic')[] => {
    const ai = onlyFor(b);
    return ai ? [ai === 'claude' ? 'anthropic' : 'openai'] : ['openai', 'anthropic'];
  };
  const billings = (['plan', 'key'] as const).filter((b) => offeredFor(b).some((p) => takes(b, p)));
  const billing = billings.includes(chosenBilling) || !billings.length ? chosenBilling : billings[0]!;
  // The workflow takes none of the logins this step could connect.
  const noWay = Boolean(accepts) && !billings.length;
  const one = onlyFor(billing);
  const offered = offeredFor(billing);
  const provider = takes(billing, chosenProvider) && offered.includes(chosenProvider) ? chosenProvider : (offered.find((p) => takes(billing, p)) ?? chosenProvider);
  // No code comes for this ChatGPT login, so it's saved from their own computer.
  const byCommand = Boolean(commandWhy) && billing === 'plan' && provider === 'openai';
  // The same line the Action prints: a login of its own in a fresh folder, never the one their own Codex uses,
  // kept in a file so it can be saved, and the folder removed after. Every use of the folder is quoted: a temp
  // folder with a space in its path would otherwise split, and rm -rf would remove something else. Each step waits
  // for the one before, so a folder that couldn't be made writes nothing, and nothing is removed without one.
  // It says it saved the login only once it has, so a failed upload never looks like it worked, and the line ends with
  // the save's own result, kept from before the clean-up, without leaving the person's shell.
  const command = `d="$(mktemp -d)" && echo 'cli_auth_credentials_store = "file"' > "$d/config.toml" && CODEX_HOME="$d" codex login && gh secret set ${LOGIN_SECRET[LOGIN_INPUTS.codex[0]]} --repo ${repo.fullName} < "$d/auth.json" && echo "Saved the ChatGPT login in ${repo.fullName}."; s=$?; [ -n "$d" ] && rm -rf "$d"; (exit $s)`;
  const mode = modeOf(billing, provider);
  const [copied, setCopied] = useState<string | null>(null);
  const prUrl = pr?.url ?? `https://github.com/${repo.fullName}/pulls`;
  const prLink = (
    <a href={prUrl} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
      Open {pr ? `pull request #${pr.number}` : 'your pull requests'} <External />
    </a>
  );
  const waiting = !failed && status?.title?.toLowerCase().includes('connect');
  // With a pull request open, the run that makes the code is on its way or already going.
  const coming = Boolean(pr) && !failed && !waiting;
  const noteEnded = 'This link has ended';
  const note = byCommand ? (thenPr ? "We'll open your PR once it's saved" : commandWhy === 'shared' || commandWhy === 'base' ? "We'll move on when it's saved" : "Until it's saved, Claude checks its own reviews") : mode !== 'chatgpt' ? "We'll move on when you're connected" : code ? 'Waiting for you to enter the code' : failed ? "Couldn't connect. Check that step 1 is on." : waiting ? 'Your code is ready on the pull request' : "We'll move on when you're connected";
  // The run takes a little while to make the code, so this has to look busy, not stuck.
  const gettingCode = mode === 'chatgpt' && coming && !code && !byCommand;
  // The run offers Claude too. Once it has posted without a Claude link, none is coming: the repo was set up before that existed.
  const gettingClaude = mode === 'claude' && Boolean(pr) && !failed && !found;
  // A pull request's link means its run offered Claude, so no link now means that run has ended. A run that went on
  // without the login has ended too, though its comment still shows the link until the review replaces it.
  const claudeEnded = startOnClaude && mode === 'claude' && (ended || (failed && !claudeUrl));
  const sendCode = () => {
    const value = pasted.trim();
    if (!value || sending === 'sending' || sending === 'sent') return;
    // The run only reads a whole code, so a partial copy would wait until the link runs out.
    if (!/^[\w.~-]{10,500}#[\w.~-]{20,500}$/.test(value)) {
      setSending('incomplete');
      return;
    }
    if (!claudeUrl) return;
    setSending('sending');
    onClaudeCode(claudeUrl, value).then(() => setSending('sent'), () => setSending('failed'));
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const secretName = mode === 'claude' ? 'CLAUDE_CODE_OAUTH_TOKEN' : mode === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const providers = [
    { id: 'openai' as const, title: billing === 'plan' ? 'ChatGPT' : 'OpenAI', icon: OPENAI_MARK },
    { id: 'anthropic' as const, title: billing === 'plan' ? 'Claude' : 'Anthropic', icon: CLAUDE_MARK },
  ];
  // A run answers in under a minute. Past this, something stopped it, and a spinner would only keep people waiting.
  const busy = gettingCode || gettingClaude || (mode === 'claude' && sending === 'sent' && !failed);
  const slow = useLongWait(busy, `${mode} ${pr?.headSha ?? ''} ${sending}`);
  const slowNote = mode === 'chatgpt' ? "No code came yet. Check that the Mergelight run started on your pull request." : sending === 'sent' ? "Claude hasn't answered yet. Check the Mergelight run on your pull request." : 'No link came from your pull request, so connect by hand with these steps.';

  // The branch doesn't name its reviewer, so a login saved now would move its reviews. The pull request names it.
  if (hold && pr && only) {
    return (
      <div>
        <BackButton onClick={onBack} />
        <Heading title="Merge your PR first" sub={holdOnBase ? `Your workflow runs on pull_request_target, so PR #${pr.number} runs the one on ${hold}, which doesn't use ${aiName(only)} yet.` : `Your workflow on ${hold} doesn't say which AI reviews, so a ${aiName(only)} login saved now would make ${aiName(only)} review there before anyone merges a change. PR #${pr.number} says who reviews, so connect ${aiName(only)} once it's merged.`} />
        <ol className="mt-6 space-y-4">
          <Numbered n={1}>
            Merge pull request #{pr.number}
            {prLink}
          </Numbered>
          <Numbered n={2}>Connect {aiName(only)} here. The steps show up once it's merged.</Numbered>
        </ol>
        <div className={`${WELL} mt-6 px-4 py-3.5`}>
          <div role="status">
            <Pulse>Waiting for you to merge PR #{pr.number}</Pulse>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <BackButton onClick={onBack} />
      <Heading
        title={checking ? `Connect ${aiName(checking)} to check reviews` : one ? `Connect ${aiName(one)}` : 'Connect your AI'}
        sub={byCommand ? (commandWhy === 'shared' ? SHARED_LOGIN_NOTE : commandWhy === 'hold' ? 'Your workflow makes ChatGPT check once it has a login, so no PR asks for a code. Save the login from your own computer instead.' : commandWhy === 'base' ? 'Your PR is merged, so no run on it asks for a code. Save the login from your own computer instead.' : `${seenBy(visibility)} could enter a ChatGPT code. Save the login from your own computer instead.`) : checking ? `${aiName(otherAi(checking))}'s review then starts by itself, and ${aiName(checking)} checks its findings.` : billing === 'plan' ? 'Reviews use the subscription you already have.' : 'You pay your AI provider for each review.'}
      />

      {billings.length > 1 && <Segment label="How to pay" options={[{ id: 'plan' as const, title: 'Your plan' }, { id: 'key' as const, title: 'API key' }]} value={billing} onChange={setBilling} />}
      {!one && !noWay && <Choices label="Which AI" options={providers.filter((p) => takes(billing, p.id))} value={provider} onChange={setProvider} top={billings.length > 1 ? 'mt-3' : 'mt-5'} />}
      {acceptsUnknown && <p className="mt-3 text-[13px] leading-snug text-muted [text-wrap:pretty]">We couldn't read the workflow on this PR, so we can't tell which logins it takes.</p>}
      {mode === 'claude' && !checking && <p className="mt-3 text-[13px] leading-snug text-muted [text-wrap:pretty]">Reviews run on Opus, which uses a lot of a Claude plan. On a small plan, a few reviews can use up the week.</p>}

      {noWay ? (
        // No login the workflow takes can be connected, so the line it needs comes first.
        <p className="mt-6 text-[14.5px] leading-relaxed text-muted [text-wrap:pretty]">
          Your workflow doesn't pass {one ? `a ${aiName(one)}` : 'an AI'} login to Mergelight. Add{' '}
          {(one ? [one] : (['codex', 'claude'] as const)).map((ai, i) => (
            <span key={ai}>
              {i > 0 && ' or '}
              <span className="break-all font-mono text-[12.5px] text-fg">{`${LOGIN_INPUTS[ai][0]}: \${{ secrets.${LOGIN_SECRET[LOGIN_INPUTS[ai][0]]} }}`}</span>
            </span>
          ))}{' '}
          under <span className="font-mono text-[12.5px] text-fg">with:</span> in it first.
        </p>
      ) : byCommand ? (
        <ol className="mt-6 space-y-4">
          <Numbered n={1}>
            On your computer, run
            <span className={`${WELL} mt-2 flex items-center justify-between gap-3 py-2 pl-4 pr-2`}>
              <code className="min-w-0 select-all break-words font-mono text-[13px] text-fg">{command}</code>
              <button type="button" onClick={() => copy(command)} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-[background-color,color,transform] duration-100 hover:bg-white/[0.06] hover:text-fg active:scale-[0.97]">
                {copied === command ? 'Copied' : 'Copy'}
              </button>
            </span>
            <span className="mt-1 block text-[13.5px] text-muted [text-wrap:pretty]">It signs in to ChatGPT with a login of its own and saves it in {repo.fullName.split('/')[1]}, so your own Codex stays signed in. It needs Codex and the GitHub CLI on your computer.</span>
          </Numbered>
        </ol>
      ) : mode === 'chatgpt' ? (
        <ol className="mt-6 space-y-4">
          <Numbered n={1}>
            Turn on <Strong>Enable device code sign-in</Strong>
            <a href={CHATGPT_SECURITY} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
              Open ChatGPT settings <External />
            </a>
          </Numbered>
          <Numbered n={2}>
            {code ? (
              <>
                Enter this code at OpenAI
                <motion.span key={code.code} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className={`${WELL} mt-2 flex items-center justify-between gap-3 py-2.5 pl-4 pr-2`}>
                  <span className="select-all font-mono text-[20px] font-medium tracking-[0.06em] text-fg">{code.code}</span>
                  <button type="button" onClick={() => copy(code.code)} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-[background-color,color,transform] duration-100 hover:bg-white/[0.06] hover:text-fg active:scale-[0.97]">
                    {copied === code.code ? 'Copied' : 'Copy'}
                  </button>
                </motion.span>
                {/* Copies as it opens, so all that's left at OpenAI is pasting. */}
                <a href={code.url} target="_blank" rel="noreferrer" onClick={() => copy(code.code)} className="mt-2 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
                  Open OpenAI <External />
                </a>
              </>
            ) : failed && merged ? (
              <>Then open a new PR. Its review shows a new code.</>
            ) : !pr ? (
              // Nothing to change in the workflow, so no PR is open: the next one's run asks for the login.
              <>Open a new PR, then enter the code its Mergelight comment shows</>
            ) : failed ? (
              <>
                Then push a new commit to your pull request to get a new code
                {prLink}
              </>
            ) : coming ? (
              <>
                Enter the code. It shows up here in a moment.
                {prLink}
              </>
            ) : (
              <>
                Enter the code we post on your pull request
                {prLink}
              </>
            )}
          </Numbered>
        </ol>
      ) : claudeEnded ? (
        <ol className="mt-6 space-y-4">
          {/* A merged pull request starts no run, so only a new one gets a new link. */}
          <Numbered n={1}>
            {merged ? (
              'Open a new PR to get a new link'
            ) : (
              <>
                Push a new commit to your pull request to get a new link
                {prLink}
              </>
            )}
          </Numbered>
        </ol>
      ) : mode === 'claude' && (claudeUrl || (gettingClaude && !slow)) ? (
        <ol className="mt-6 space-y-4">
          <Numbered n={1}>
            Confirm on Claude's page
            {claudeUrl ? (
              <a href={claudeUrl} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
                Open Claude <External />
              </a>
            ) : (
              <span className="mt-1 block text-[13.5px] text-muted">The link shows up here in a moment.</span>
            )}
          </Numbered>
          <Numbered n={2}>
            Paste the code Claude shows you
            <span className={`${WELL} mt-2 flex items-center gap-2 py-1.5 pl-4 pr-1.5`}>
              <input aria-label="Code from Claude" value={pasted} disabled={!claudeUrl || sending === 'sent'} onChange={(e) => setPasted(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendCode()} placeholder="Paste here" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[14px] text-fg outline-none placeholder:text-faint" />
              <button type="button" onClick={sendCode} disabled={!pasted.trim() || sending === 'sending' || sending === 'sent'} className="shrink-0 rounded-lg bg-white/[0.08] px-3 py-1.5 text-[13px] text-fg transition-colors hover:bg-white/[0.13] disabled:opacity-40">
                Connect
              </button>
            </span>
            {sending === 'failed' && <span className="mt-1 block text-[13px] text-risk">GitHub didn't take that. Please try again.</span>}
            {sending === 'incomplete' && <span className="mt-1 block text-[13px] text-risk">That isn't the whole code. Copy it again from Claude's page.</span>}
            {sending !== 'failed' && sending !== 'incomplete' && <span className="mt-1 block text-[13px] text-muted">It works once, and goes straight to your repository.</span>}
          </Numbered>
        </ol>
      ) : (
        <ol className="mt-6 space-y-4">
          {mode === 'claude' && (
            <Numbered n={1}>
              On your computer, run{' '}
              <button type="button" onClick={() => copy('claude setup-token')} title="Copy" className="rounded-md bg-white/[0.08] px-1.5 py-0.5 font-mono text-[12.5px] text-fg transition-colors hover:bg-white/[0.13]">
                {copied === 'claude setup-token' ? 'Copied' : 'claude setup-token'}
              </button>
              <span className="mt-1 block text-[13.5px] text-muted">It signs in to your Claude plan and shows a token that lasts a year.</span>
            </Numbered>
          )}
          <Numbered n={mode === 'claude' ? 2 : 1}>
            Add {mode === 'claude' ? 'that token as' : ''} a secret named{' '}
            <button type="button" onClick={() => copy(secretName)} title="Copy" className="rounded-md bg-white/[0.08] px-1.5 py-0.5 font-mono text-[12.5px] text-fg transition-colors hover:bg-white/[0.13]">
              {copied === secretName ? 'Copied' : secretName}
            </button>
            <a href={`https://github.com/${repo.fullName}/settings/secrets/actions/new`} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
              Open GitHub secrets <External />
            </a>
          </Numbered>
          <Numbered n={mode === 'claude' ? 3 : 2}>{merged || !pr ? 'Open a new PR to start the review' : 'Push any commit to your pull request to start the review'}</Numbered>
        </ol>
      )}

      <div className={`${WELL} mt-6 px-4 py-3.5`}>
        <div role="status">
          {slow ? (
            <span className="block">
              <Pulse tone="risk">{slowNote}</Pulse>
              <a href={pr ? `${pr.url}/checks` : prUrl} target="_blank" rel="noreferrer" className="mt-2 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
                Open the run on GitHub <External />
              </a>
            </span>
          ) : gettingClaude || (mode === 'claude' && sending === 'sent' && !failed) ? (
            <span className="flex items-center gap-2.5">
              <Spinner className="size-4 shrink-0 text-lilac" />
              <span className="min-w-0 text-[14px] text-muted">{sending === 'sent' ? 'Connecting to Claude. Almost ready, hang tight.' : 'Getting your Claude link. Almost ready, hang tight.'}</span>
            </span>
          ) : gettingCode ? (
            <span className="flex items-center gap-2.5">
              <Spinner className="size-4 shrink-0 text-lilac" />
              <span className="min-w-0 text-[14px] text-muted">Getting your code. Almost ready, hang tight.</span>
            </span>
          ) : (
            <Pulse tone={claudeEnded || (mode === 'chatgpt' && !byCommand && (code || failed || waiting)) ? 'risk' : 'lilac'}>{claudeEnded ? noteEnded : note}</Pulse>
          )}
        </div>
      </div>
      {byCommand ? (
        <button type="button" onClick={onSkip} className={`${PRIMARY} mt-5`}>
          Continue
        </button>
      ) : (
        <button type="button" onClick={onSkip} className="mx-auto mt-4 block text-[13px] text-faint transition-colors hover:text-muted">
          I've done this
        </button>
      )}
    </div>
  );
}

/** One point on the way to reviews being on, joined to the next by a thread like the rail up top. */
function Milestone({ state, title, last = false, children }: { state: 'done' | 'now' | 'next'; title: ReactNode; last?: boolean; children: ReactNode }) {
  return (
    <li aria-current={state === 'now' ? 'step' : undefined} className={`relative flex gap-3.5 ${last ? '' : 'pb-5'}`}>
      {!last && <span aria-hidden="true" className={`absolute bottom-0 left-[10.5px] top-[26px] w-px ${state === 'done' ? 'bg-lilac/50' : 'bg-white/10'}`} />}
      <span className="grid size-[22px] shrink-0 place-items-center">
        {state === 'done' && (
          <span className="grid size-[22px] place-items-center rounded-full bg-lilac/15 text-lilac">
            <Check className="size-3.5" />
          </span>
        )}
        {state === 'now' && (
          <span className="relative flex size-2.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-lilac opacity-60 motion-reduce:hidden" />
            <span className="relative size-2.5 rounded-full bg-lilac" />
          </span>
        )}
        {state === 'next' && <span className="size-2 rounded-full bg-white/20" />}
      </span>
      <div className="min-w-0 flex-1 pt-px">
        <p className={`text-[14.5px] font-medium leading-[1.4] ${state === 'next' ? 'text-muted' : 'text-fg'}`}>{title}</p>
        <p className="mt-0.5 text-[13.5px] leading-relaxed text-muted [text-wrap:pretty]">{children}</p>
      </div>
    </li>
  );
}

function LiveStep({ repo, pr, backTo, status, hasLogin, merged, updatedTo, ai, onAnother }: { repo: Repo; pr: SetupPr | null; backTo: SetupPr | null; status: CheckStatus | null; hasLogin: boolean; merged: boolean; updatedTo: string | null; ai: ReactNode; onAnother: () => void }) {
  const name = repo.fullName.split('/')[1]!;
  const another = (
    <button type="button" onClick={onAnother} className={`${BUTTON} mt-3 text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] hover:bg-white/[0.05]`}>
      Set up another repo
    </button>
  );

  // Reviews are really on: the file is on the branch, so there's nothing left to do.
  if (!pr || merged) {
    return (
      <div className="py-1 text-center">
        <motion.div initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING} className="mx-auto w-fit">
          <img src="/logo-animated.svg" alt="" width={72} height={72} className="size-[72px] rounded-[18px] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_14px_40px_-12px_rgb(0_0_0/0.8)]" />
        </motion.div>
        <h1 className="mt-4 text-[28px] font-semibold leading-[1.1] tracking-[-0.028em]">{updatedTo ? `You're on ${updatedTo}` : 'Mergelight is on'}</h1>
        <p className="mx-auto mt-2 max-w-[340px] text-[15px] leading-relaxed text-muted [text-wrap:pretty]">
          {updatedTo ? `Reviews on ${name} now use the new version.` : `New PRs on ${name} get reviewed by themselves, and the results show up on the PR.`}{backTo ? '' : ' You can close this page.'}
        </p>
        {ai}
        <div className="mt-6">
          {/* GitHub opens a comment's links in the same tab, so this is the way back. */}
          {backTo && (
            <a href={backTo.url} className={PRIMARY}>
              Back to PR #{backTo.number}
            </a>
          )}
          {another}
        </div>
      </div>
    );
  }

  const failed = couldntFinish(status);
  const done = isDone(status) && !failed;
  // A repo that's updating has had reviews before, so this one isn't its first.
  const review = updatedTo ? 'review' : 'first review';
  const Review = updatedTo ? 'Review' : 'First review';
  const reviewTitle = failed ? `${Review} didn't finish` : done ? `${Review} done` : status ? `${Review} running` : hasLogin ? `Starting the ${review}` : `Waiting for the ${review} to start`;
  const reviewNote = updatedTo ? `reviewed this PR with ${updatedTo}` : 'reviewed this same PR, so you can see what a review looks like';
  const reviewingNote = updatedTo ? `reviewing this PR with ${updatedTo}` : 'reviewing this same PR, so you can see what a review looks like';
  return (
    <div>
      <Heading title="Your PR is open" sub={updatedTo ? `Merge it to update Mergelight on ${name}.` : `Merge it to turn on reviews for ${name}.`} />
      <ol className="mt-6">
        <Milestone state="done" title={`PR #${pr.number} opened`}>
          {updatedTo ? `It moves the workflow to ${updatedTo}.` : 'It adds what Mergelight needs to run.'}
        </Milestone>
        <Milestone state={done ? 'done' : 'now'} title={reviewTitle}>
          {failed ? 'The Mergelight check on the PR says why, and the next push tries again.' : done ? `${plainTitle(status)}. It ${reviewNote}.` : `It's ${reviewingNote}. It usually takes 2 to 15 minutes.`}
        </Milestone>
        <Milestone last state={done ? 'now' : 'next'} title="Merge the PR">
          {updatedTo ? `After that, reviews on ${name} use the new version.` : `After that, new PRs on ${name} get reviewed by themselves.`} You can merge any time.
        </Milestone>
      </ol>
      {ai}
      <a href={pr.url} target="_blank" rel="noreferrer" className={`${PRIMARY} mt-6`}>
        Open PR #{pr.number} <External className="size-4" />
      </a>
      {another}
      <p className="mt-4 text-center text-[13px] leading-relaxed text-faint [text-wrap:pretty]">{done || failed ? 'You can close this page. The PR stays open until you merge it.' : 'You can close this page. The review keeps running, and the result shows up on the PR.'}</p>
    </div>
  );
}

/* ---------- Which AI reviews, and which checks ---------- */

function AiMark({ ai, className = 'size-4' }: { ai: Ai; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`${className} shrink-0`} fill={AI_MARK[ai].color} fillRule="evenodd">
      <path d={AI_MARK[ai].path} />
    </svg>
  );
}

const rolesLine = (r: Roles) => `Reviews with ${aiName(r.reviewer)}, checked by ${aiName(r.checker)}`;
const rolesGoal = (r: Roles) => (r.reviewer === r.checker ? `review and check with ${aiName(r.reviewer)}` : `review with ${aiName(r.reviewer)} and check with ${aiName(r.checker)}`);

/**
 * Who reviews and who checks on a repo that's on, read from its workflow and its secrets. Null roles means that can't
 * be told for sure. `locked` says why the page offers no choice: the workflow is set up its own way, not every secret
 * could be read, or no AI has a login yet, so connecting one comes first. `resume` is an AI a change of AI still has to
 * connect.
 */
function YourAi({ roles, logins, locked, branchesNote, oldNote, onUpdate, pending, resume, busy, onChange, onConnect }: { roles: Roles | null; logins: Logins; locked: RolesLock | null; branchesNote: string; oldNote: string; onUpdate: { tag: string; go: () => void } | null; pending: { pr: SetupPr; roles: Roles } | null; resume: Ai | null; busy: boolean; onChange: () => void; onConnect: () => void }) {
  const action = logins.claude && !logins.codex ? 'Add ChatGPT' : logins.codex && !logins.claude ? 'Add Claude' : 'Change';
  const small = 'h-8 shrink-0 rounded-lg bg-white/[0.07] px-2.5 text-[13px] font-medium text-fg outline-none transition-[background-color,transform] duration-100 hover:bg-white/[0.11] focus-visible:ring-2 focus-visible:ring-lilac active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40';
  return (
    <section aria-label="Your AI" className={`${WELL} mt-6 px-4 py-3.5 text-left`}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-faint">Your AI</p>
        {roles && !locked && (
          <button type="button" onClick={onChange} disabled={busy} className={small}>
            {action}
          </button>
        )}
        {locked === 'none' && (
          <button type="button" onClick={onConnect} disabled={busy} className={small}>
            Connect
          </button>
        )}
      </div>
      {roles ? (
        <p className="mt-1 flex items-center gap-2.5 text-[14.5px] leading-snug text-fg">
          <span className="flex shrink-0 items-center gap-1">
            <AiMark ai={roles.reviewer} />
            {roles.checker !== roles.reviewer && <AiMark ai={roles.checker} />}
          </span>
          <span className="min-w-0 [text-wrap:pretty]">{rolesLine(roles)}</span>
        </p>
      ) : locked === 'none' ? (
        <p className="mt-1 text-[14.5px] leading-snug text-fg">No AI is connected yet.</p>
      ) : locked ? (
        <p className="mt-1 text-[14.5px] leading-snug text-fg">Who reviews and who checks: unknown</p>
      ) : (
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted [text-wrap:pretty]">We couldn't find the Mergelight step in your workflow file, so we can't tell which AI reviews.</p>
      )}
      {locked === 'old' && (
        <div className="mt-2.5 flex items-start justify-between gap-3 text-[13.5px] leading-relaxed text-muted [text-wrap:pretty]">
          <span>{oldNote}</span>
          {onUpdate && (
            <button type="button" onClick={onUpdate.go} className={small}>
              Update to {onUpdate.tag}
            </button>
          )}
        </div>
      )}
      {(locked === 'custom' || locked === 'branches' || locked === 'unchecked' || locked === 'secrets') && (
        <div className="mt-2.5 text-[13.5px] leading-relaxed text-muted [text-wrap:pretty]">
          {locked === 'custom' ? 'Your workflow is customized, so you set provider and verify-with in it by hand.' : locked === 'branches' ? branchesNote : locked === 'unchecked' ? "We couldn't check every branch your PRs go into, so you set provider and verify-with in your workflow by hand." : "We can't read all of this repo's secrets, so we can't tell which AIs are connected. You set provider and verify-with in your workflow by hand."}
          <a href={ROLES_DOCS} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-lilac transition-colors hover:text-fg">
            How to set them <External />
          </a>
        </div>
      )}
      {pending && (
        <div className="mt-2.5 text-[13.5px] leading-relaxed text-muted [text-wrap:pretty]">
          Merge PR #{pending.pr.number} to {rolesGoal(pending.roles)}.
          <a href={pending.pr.url} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-lilac transition-colors hover:text-fg">
            Open PR #{pending.pr.number} <External />
          </a>
        </div>
      )}
      {resume && (
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="text-[13.5px] leading-relaxed text-muted">{aiName(resume)} isn't connected yet.</span>
          <button type="button" onClick={onConnect} className={small}>
            Resume
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Picks who reviews and who checks. Two different AIs is the default, since the second one catches more. `openPr` is a
 * pull request that changes the workflow already, which has to be merged or closed first, and undefined while that's
 * being looked up.
 */
function RolesStep(props: { current: Roles; openPr: SetupPr | null | undefined; logins: Logins; own: Logins; visibility: Repo['visibility']; refreshMissing: boolean; sharedLogin: boolean; defaultBranch: string; file: string; branch: string; changing: boolean; failed: RolesFailure | null; accessUrl: string; onBack: () => void; onConfirm: (roles: Roles) => void }) {
  const { current, openPr, logins, own, visibility, refreshMissing, sharedLogin, defaultBranch, file, branch, changing, failed, accessUrl, onBack, onConfirm } = props;
  const [reviewer, setReviewer] = useState<Ai>(current.reviewer);
  // A model goes to the reviewer as it is, and only one AI takes it, so the reviewer stays until that's changed. An
  // effort only one AI takes goes to the checker too, so the checker stays that AI as well.
  const fixedBy = reviewerFixedBy(file);
  const checkerFixed = fixedBy === 'effort';
  const [checker, setChecker] = useState<Ai>(checkerFixed ? current.reviewer : otherAi(current.reviewer));
  const pick = { reviewer, checker };
  const edited = withRoles(file, pick);
  // Set like this already. With an AI still to connect, connecting it is all that's left to do, after the refresh job
  // for a ChatGPT login if that's missing.
  const same = edited === file;
  const chosen = [...new Set([reviewer, checker])];
  // `logins` is what the Action gets, which says who reviews. `own` is what counts as connected here.
  const need = chosen.filter((ai) => !own[ai]);
  // An AI the workflow hands no login to could never review or check, so that line has to be added first.
  const unpassed = chosen.find((ai) => !passesLogin(file, ai)) ?? null;
  const set = readRoles(file);
  const afterMerge = (ai: Ai) => Boolean(set && connectsAfterMerge(set, logins, pick, ai));
  // On pull_request_target the PR's run reads the workflow the branch has now, which may not use this AI yet.
  const onBase = (ai: Ai) => !afterMerge(ai) && waitsForBase(file, logins, ai);
  const baseNote = `Next, merge the PR, then connect it here. Your workflow runs on pull_request_target, so PRs use the one on ${branch} until then.`;
  const problem: RolesFailure | null = edited === null ? 'no-step' : failed;
  const checking = openPr === undefined;
  const refreshAdds = refreshMissing && chosen.includes('codex') && readsChatgpt(file);
  // Nothing to open a PR for: the roles are set like this, and no refresh job is missing.
  const nothing = same && !refreshAdds;
  // The organization's ChatGPT login can't be refreshed here, so the repo's own comes before the PR.
  const connectsFirst = !nothing && sharedLogin && need.includes('codex');
  const blocked = changing || checking || (nothing && !need.length) || edited === null || Boolean(unpassed);
  const options = (recommended: Ai | null, fixed = false) => (['claude', 'codex'] as const).map((ai) => ({ id: ai, title: aiName(ai), icon: AI_MARK[ai], note: ai === recommended ? 'Recommended' : undefined, disabled: fixed && ai !== current.reviewer }));

  // Each pull request from here says only what it changes, so one that changes the workflow already comes first.
  if (openPr) {
    return (
      <div>
        <BackButton onClick={onBack} />
        <Heading title={`Merge or close PR #${openPr.number} first`} sub="It changes your Mergelight workflow already. Once it's merged or closed, you can choose your AI here." />
        <a href={openPr.url} target="_blank" rel="noreferrer" className={`${PRIMARY} mt-6`}>
          Open PR #{openPr.number} <External className="size-4" />
        </a>
      </div>
    );
  }

  return (
    <div>
      <BackButton onClick={onBack} />
      <Heading title="Choose your AI" sub="One AI reviews your PRs. Another one can check what it finds." />
      <p className="mt-5 text-[13px] font-medium text-faint">Reviews your PRs</p>
      {/* A new reviewer gets the other AI as its checker, which is the pick we recommend. */}
      <Choices
        label="Reviews your PRs"
        options={options(null, Boolean(fixedBy))}
        value={reviewer}
        onChange={(v) => {
          setReviewer(v);
          setChecker(otherAi(v));
        }}
        top="mt-2"
      />
      <p className="mt-4 text-[13px] font-medium text-faint">Checks what it finds</p>
      <Choices label="Checks what it finds" options={options(checkerFixed ? null : otherAi(reviewer), checkerFixed)} value={checker} onChange={setChecker} top="mt-2" />
      <ul className="mt-3 divide-y divide-white/[0.06]">
        <Fact icon={<Check className="size-4" />}>Two AIs from different companies catch more than one.</Fact>
        {fixedBy && (
          <Fact icon={<span className="size-1.5 rounded-full bg-lilac" />}>
            Your workflow sets <span className="font-mono text-[12.5px] text-fg">{fixedBy}:</span> for the AI that reviews now{checkerFixed ? ', and the checker gets it too' : ''}. Change or remove it first to choose another {checkerFixed ? 'AI' : 'reviewer'}.
          </Fact>
        )}
        {unpassed ? (
          <Fact icon={<span className="size-1.5 rounded-full bg-risk" />}>
            Your workflow doesn't pass a {aiName(unpassed)} login to Mergelight. Add <span className="break-all font-mono text-[12.5px] text-fg">{`${LOGIN_INPUTS[unpassed][0]}: \${{ secrets.${LOGIN_SECRET[LOGIN_INPUTS[unpassed][0]]} }}`}</span> under <span className="font-mono text-[12.5px] text-fg">with:</span> in it first.
          </Fact>
        ) : (
          need.map((ai) => (
            <Fact key={ai} icon={<span className="size-1.5 rounded-full bg-lilac" />}>
              {aiName(ai)} isn't connected yet.{' '}
              {ai === 'codex' && sharedLogin
                ? `${SHARED_LOGIN_NOTE} Next, you save it from your own computer${nothing ? '' : ', and then we open the PR'}.`
                : ai === checker && ai !== reviewer
                  ? ai === 'codex' && visibility !== 'private'
                    ? `${seenBy(visibility)} could enter a ChatGPT code. Next, ${afterMerge(ai) || onBase(ai) ? 'merge the PR, then ' : 'you '}save the login from your own computer.`
                    : afterMerge(ai)
                      ? `Next, merge the PR, then save its login from your own computer. A ${aiName(ai)} login saved before that would make ${aiName(ai)} review on ${branch}.`
                      : onBase(ai)
                        ? baseNote
                        : 'Next, you connect it to check reviews.'
                  : onBase(ai)
                    ? baseNote
                    : 'You connect it next.'}
            </Fact>
          ))
        )}
        {!unpassed && refreshAdds && (
          <Fact icon={<Check className="size-4" />}>
            {branch === defaultBranch ? 'Adds the small job that keeps a ChatGPT login fresh' : `Adds the small job that keeps a ChatGPT login fresh. It only runs on a schedule from ${defaultBranch}, so merge it there too.`}
          </Fact>
        )}
        {!nothing && <Fact icon={<LockIcon className="size-4" />}>{same ? 'Opens a PR that adds only that job, and you decide whether to merge.' : 'Opens a PR that changes only this in your workflow, and you decide whether to merge.'}</Fact>}
      </ul>
      <button type="button" onClick={() => onConfirm(pick)} disabled={blocked} className={`${PRIMARY} mt-5 ${changing ? 'pointer-events-none opacity-70' : blocked ? 'pointer-events-none opacity-40' : ''}`}>
        {changing && <Spinner />}
        {changing ? 'Opening your PR...' : connectsFirst ? 'Connect ChatGPT' : nothing ? (need.length ? `Connect ${aiName(need[0]!)}` : 'Already set like this') : 'Open PR'}
      </button>
      {problem && (
        <div role="alert" className="mt-4 text-center text-[13px] leading-relaxed text-muted [text-wrap:pretty]">
          {problem === 'no-step' && (
            <p>
              We couldn't find the Mergelight step in <span className="font-mono text-[12.5px] text-fg">.github/workflows/mergelight.yml</span>, so nothing was changed. You can set provider and verify-with in it yourself.
            </p>
          )}
          {problem === 'changed' && <p>Your workflow on {branch} changed since this page read it, so nothing was changed. Reload this page to see it.</p>}
          {problem === 'scan' && <p>{SCAN_NOTE} You can set provider and verify-with in it yourself.</p>}
          {problem === 'no-file' && (
            <p>
              We couldn't find <span className="font-mono text-[12.5px] text-fg">.github/workflows/mergelight.yml</span> on {branch}, so nothing was changed.
            </p>
          )}
          {problem === 'refused' && (
            <>
              <p>GitHub didn't let us open the PR. Your install may need to approve the access.</p>
              <a href={accessUrl} target="_blank" rel="noreferrer" className="mx-auto mt-1.5 flex w-fit items-center gap-1 text-lilac transition-colors hover:text-fg">
                Approve on GitHub <External />
              </a>
            </>
          )}
          {problem === 'tag' && <p>We couldn't read which commit your workflow's release is on, so we can't add the job that keeps a ChatGPT login fresh on it. Nothing was changed. Please try again.</p>}
          {problem === 'other' && <p>That didn't work. Please try again.</p>}
        </div>
      )}
    </div>
  );
}
