import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import workflowFile from '../../../examples/mergelight.yml?raw';
import refreshFile from '../../../examples/mergelight-refresh.yml?raw';
import Ambient from '../sections/Ambient';
import { Check, GitHubIcon, SURFACE, WELL } from '../ui';
import { cleanUrl, finishSignIn, GitHubError, INSTALL_URL, isPinned, mockClient, pinned, realClient, REFRESH_FILE, signInUrl, wakeTokenServer, type CheckStatus, type GitHubClient, type Release, type Repo, type RepoDetails, type SetupPr, type WorkflowFile } from './github';

const CHATGPT_SECURITY = 'https://chatgpt.com/settings/security';
const TYPES_MARKER = 'types: [opened, synchronize, reopened, ready_for_review]';
const SKIP_MARKER = 'github.event.pull_request.head.repo.full_name == github.repository';
const SPRING = { type: 'spring', bounce: 0, duration: 0.45 } as const;

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

type View = 'welcome' | 'repo' | 'add' | 'finish' | 'connect' | 'live';
const ORDER: View[] = ['welcome', 'repo', 'add', 'finish', 'connect', 'live'];
/** Where each view sits on the rail. Add and finish are the same step to the person. */
const RAIL: Record<View, number> = { welcome: 0, repo: 1, add: 2, finish: 2, connect: 3, live: 4 };

export default function Setup() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [view, setView] = useState<View>('welcome');
  const [client, setClient] = useState<GitHubClient | null>(null);
  const [signingIn, setSigningIn] = useState(params.has('code'));
  const [signInFailed, setSignInFailed] = useState(false);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [details, setDetails] = useState<RepoDetails | null>(null);
  const [branch, setBranch] = useState('main');
  const [scope, setScope] = useState<Scope>('all');
  const [fileOpen, setFileOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addFailed, setAddFailed] = useState<'refused' | 'other' | null>(null);
  const [pr, setPr] = useState<SetupPr | null>(null);
  const [status, setStatus] = useState<CheckStatus | null>(null);
  const [hasLogin, setHasLogin] = useState(false);
  const [merged, setMerged] = useState(false);
  const [detailsFailed, setDetailsFailed] = useState(false);
  const wide = useWide();

  const previous = useRef(view);
  const direction = ORDER.indexOf(view) >= ORDER.indexOf(previous.current) ? 1 : -1;
  useEffect(() => {
    previous.current = view;
  }, [view]);

  const start = useCallback((c: GitHubClient) => {
    setClient(c);
    setView('repo');
  }, []);

  // Sign-in needs the token server, so start waking it while the person reads the first screen.
  useEffect(wakeTokenServer, []);

  // Local development: `?mock` runs the whole flow on made-up data. Not in the built site.
  useEffect(() => {
    if (import.meta.env.DEV && params.has('mock')) start(mockClient());
  }, [params, start]);

  // Coming back from GitHub with a sign-in code.
  useEffect(() => {
    if (!params.has('code')) return;
    finishSignIn(params)
      .then((token) => {
        if (token) start(realClient(token));
      })
      .catch(() => setSignInFailed(true))
      .finally(() => {
        setSigningIn(false);
        cleanUrl();
      });
  }, [params, start]);

  const loadRepos = useCallback(() => {
    client?.repos().then(setRepos, () => setSignInFailed(true));
  }, [client]);
  useEffect(loadRepos, [loadRepos]);

  // After giving access in another tab, the new repo should just be there.
  useEffect(() => {
    window.addEventListener('focus', loadRepos);
    return () => window.removeEventListener('focus', loadRepos);
  }, [loadRepos]);

  const choose = (r: Repo) => {
    setRepo(r);
    setDetailsFailed(false);
    setDetails(null);
    setPr(null);
    setStatus(null);
    setHasLogin(false);
    setMerged(false);
    setFileOpen(false);
    setAddFailed(null);
    setView('add');
    client?.details(r).then((d) => {
      setDetails(d);
      setBranch(d.base);
      setScope(d.skip.length > 1 ? 'new' : 'all');
      setHasLogin(d.hasLogin);
    }, () => setDetailsFailed(true));
  };

  /** New repos follow a moving tag, which updates by itself. A pinned one only moves when someone asks. Anything else in its file stays theirs. */
  const update = details?.installed && details.release && isPinned(details.installed) && details.installed.ref !== details.release.sha ? details.release : null;
  const workflow = useMemo(() => {
    if (!details) return workflowFile;
    return update && details.installed ? pinned(details.installed.content, update) : workflowFor(scope, branch, details.skip);
  }, [scope, branch, details, update]);
  /**
   * The review, and on a private repo the job that keeps a ChatGPT login fresh. Without that job reviews refresh the
   * login themselves, and one that starts during another's refresh can fail. An API key needs no refreshing, and public repos can't use ChatGPT.
   */
  const files = useMemo<WorkflowFile[]>(() => {
    const list = [{ name: 'mergelight.yml', content: workflow }];
    if (!details || !repo) return list;
    const version = (content: string) => (update ? pinned(content, update) : content);
    if (details.refresh) list.push({ name: REFRESH_FILE, content: version(details.refresh) });
    else if (repo.isPrivate && !details.hasApiKey) list.push({ name: REFRESH_FILE, content: version(refreshFile) });
    return list;
  }, [workflow, details, repo, update]);
  const fileUrl = repo ? newFileUrl(repo.fullName, branch, workflow) : '#';
  const afterAdding = useCallback(() => setView(hasLogin ? 'live' : 'connect'), [hasLogin]);

  /** Opens the pull request right here, with the person's own sign-in. Nothing goes through Mergelight. */
  const addToRepo = async () => {
    if (!client || !repo || !details || adding) return;
    setAdding(true);
    setAddFailed(null);
    setFileOpen(false);
    try {
      setPr(await client.proposeWorkflows(repo, branch, files, update));
      afterAdding();
    } catch (err) {
      setAddFailed(err instanceof GitHubError && (err.status === 403 || err.status === 404) ? 'refused' : 'other');
    } finally {
      setAdding(false);
    }
  };

  // Waiting for the pull request to show up on GitHub.
  useEffect(() => {
    if (view !== 'finish' || !client || !repo) return;
    return poll(async () => {
      const found = await client.findSetupPr(repo);
      if (found) {
        setPr(found);
        setTimeout(afterAdding, 900);
        return true;
      }
      if (await client.hasWorkflow(repo, branch)) {
        setTimeout(afterAdding, 900);
        return true;
      }
      return false;
    });
  }, [view, client, repo, branch, afterAdding]);

  // Following the first review and the merge once the pull request exists. A failed read just waits for the next one.
  useEffect(() => {
    if ((view !== 'connect' && view !== 'live') || !client || !repo) return;
    return poll(async () => {
      const check = pr ? await client.checkStatus(repo, pr.headSha).catch(() => null) : null;
      const login = view === 'connect' || !check ? await client.hasLogin(repo) : true;
      const done = view === 'live' && pr ? await client.isMerged(repo, pr.number).catch(() => false) : false;
      if (check) setStatus(check);
      setHasLogin(login);
      setMerged(done);
      if (view === 'connect' && (login || isReviewing(check))) setView('live');
      return view === 'live' && (done || !pr);
    });
  }, [view, client, repo, pr]);

  const anotherRepo = () => {
    setRepo(null);
    setDetails(null);
    setPr(null);
    setStatus(null);
    setMerged(false);
    setView('repo');
  };

  const back: Partial<Record<View, () => void>> = {
    add: anotherRepo,
    finish: () => setView('add'),
    connect: () => setView('add'),
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
        <Rail at={view === 'live' && pr && !merged ? 3 : RAIL[view]} />
      </header>

      <main className="flex flex-1 justify-center px-4 pb-16 pt-[6vh] sm:pt-[9vh]">
        <div className="relative flex w-full items-start justify-center">
          <motion.div layout="position" transition={SPRING} className="z-10 w-full max-w-[460px] shrink-0">
            <Stage viewKey={view} direction={direction}>
              {view === 'welcome' && <Welcome signingIn={signingIn} failed={signInFailed} installed={params.has('installation_id')} />}
              {view === 'repo' && <RepoStep repos={repos} onChoose={choose} failed={signInFailed} />}
              {view === 'add' && repo && (
                <AddStep repo={repo} details={details} fileCount={files.length} branch={branch} setBranch={setBranch} scope={scope} setScope={setScope} fileOpen={fileOpen} onToggleFile={() => setFileOpen((v) => !v)} adding={adding} failed={addFailed} detailsFailed={detailsFailed} onRetry={() => choose(repo)} update={update} onAdd={() => void addToRepo()} fileUrl={fileUrl} onBack={adding ? () => undefined : back.add!} onByHand={() => { setFileOpen(false); setView('finish'); }} onContinue={afterAdding} />
              )}
              {view === 'finish' && repo && <FinishStep repo={repo} branch={branch} fileUrl={fileUrl} pr={pr} onBack={back.finish!} />}
              {view === 'connect' && repo && <ConnectStep repo={repo} pr={pr} status={status} onBack={back.connect!} onSkip={() => setView('live')} />}
              {view === 'live' && repo && <LiveStep repo={repo} pr={pr} status={status} hasLogin={hasLogin} merged={merged} updatedTo={update?.tag ?? null} onAnother={anotherRepo} />}
            </Stage>
            <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[13px] text-faint">
              <LockIcon className="size-3.5 shrink-0" />
              Your code and AI login never touch Mergelight.
            </p>
          </motion.div>
          <AnimatePresence mode="popLayout" initial={false}>
            {wide && view === 'add' && fileOpen && <FileSide key="file" files={files} version={update?.tag} onClose={() => setFileOpen(false)} />}
          </AnimatePresence>
        </div>
        {!wide && <FileSheet open={view === 'add' && fileOpen} files={files} version={update?.tag} onClose={() => setFileOpen(false)} />}
      </main>
    </div>
  );
}

/** Runs now, then every few seconds while the tab is visible, until it returns true. */
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

function Welcome({ signingIn, failed, installed }: { signingIn: boolean; failed: boolean; installed: boolean }) {
  // Most sign-ins take a second. When one doesn't, say so before it looks stuck.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!signingIn) return;
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, [signingIn]);

  return (
    <div className="py-2 text-center">
      <img src="/logo-animated.svg" alt="" width={84} height={84} className="mx-auto size-[84px] rounded-[20px] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_14px_40px_-12px_rgb(0_0_0/0.8)]" />
      <h1 className="mt-5 text-[32px] font-semibold leading-[1.1] tracking-[-0.03em]">Turn on Mergelight</h1>
      <p className="mx-auto mt-3 max-w-[320px] text-[15px] leading-relaxed text-muted [text-wrap:pretty]">
        {installed ? "It's installed. Sign in to finish setting up." : 'Real code review on the AI plan you already pay for. Three quick steps, nothing to install.'}
      </p>
      {failed && <p className="mt-4 text-[13px] text-risk">GitHub sign-in didn't work. Please try again.</p>}
      <a href={signingIn ? undefined : signInUrl()} aria-disabled={signingIn} className={`${PRIMARY} mt-7 ${signingIn ? 'pointer-events-none opacity-70' : ''}`}>
        {signingIn ? <Spinner /> : <GitHubIcon className="size-[18px]" />}
        {signingIn ? 'Signing you in...' : 'Continue with GitHub'}
      </a>
      {signingIn && slow && (
        <motion.p role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="mt-3 text-[13px] text-muted">
          This can take up to a minute.
        </motion.p>
      )}
    </div>
  );
}

function RepoStep({ repos, onChoose, failed }: { repos: Repo[] | null; onChoose: (r: Repo) => void; failed: boolean }) {
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

      {repos && (
        <a href={INSTALL_URL} target="_blank" rel="noreferrer" className="mt-3 flex items-center justify-center gap-1 text-[13px] text-muted transition-colors hover:text-fg">
          Don't see your repo? Add it on GitHub <External />
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
function Choices<T extends string>({ label, options, value, onChange }: { label: string; options: { id: T; title: string; note: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="mt-5 grid grid-cols-2 gap-2">
      {options.map((o) => {
        const on = value === o.id;
        return (
          <label
            key={o.id}
            className={`rounded-2xl p-3.5 transition-[background-color,box-shadow,transform] duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-lilac ${o.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer active:scale-[0.98]'} ${on ? 'bg-white/[0.07] shadow-[inset_0_0_0_1.5px_rgb(184_156_255/0.75)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:bg-white/[0.05]'}`}
          >
            <input type="radio" name={label} className="sr-only" checked={on} disabled={o.disabled} onChange={() => onChange(o.id)} />
            <span className="block text-[14.5px] font-medium text-fg">{o.title}</span>
            <span className="mt-1 block text-[12.5px] leading-snug text-muted [text-wrap:pretty]">{o.note}</span>
          </label>
        );
      })}
    </div>
  );
}

function AddStep(props: {
  repo: Repo;
  details: RepoDetails | null;
  fileCount: number;
  branch: string;
  setBranch: (b: string) => void;
  scope: Scope;
  setScope: (s: Scope) => void;
  fileOpen: boolean;
  onToggleFile: () => void;
  adding: boolean;
  failed: 'refused' | 'other' | null;
  detailsFailed: boolean;
  onRetry: () => void;
  update: Release | null;
  onAdd: () => void;
  fileUrl: string;
  onBack: () => void;
  onByHand: () => void;
  onContinue: () => void;
}) {
  const { repo, details, fileCount, branch, setBranch, scope, setScope, fileOpen, onToggleFile, adding, failed, detailsFailed, onRetry, update, onAdd, fileUrl, onBack, onByHand, onContinue } = props;
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
    return (
      <div>
        <BackButton onClick={onBack} />
        <Heading title={`Update Mergelight on ${name}`} sub={`It's pinned to ${details.installed?.version ?? 'an older version'}, and ${update.tag} is out.`} />
        <ul className="mt-3 divide-y divide-white/[0.06]">
          <Fact icon={<Check className="size-4" />}>Moves the pin to the exact commit of {update.tag}</Fact>
          <Fact icon={<Check className="size-4" />}>{details.refresh ? 'Changes that one line in both files, and nothing else' : 'Changes that one line, and nothing else in your file'}</Fact>
          {!details.refresh && fileCount > 1 && <Fact icon={<Check className="size-4" />}>Adds the small job that keeps a ChatGPT login fresh</Fact>}
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
        <button type="button" onClick={onAdd} disabled={adding} className={`${PRIMARY} mt-5 ${adding ? 'pointer-events-none opacity-70' : ''}`}>
          {adding && <Spinner />}
          {adding ? 'Opening your PR...' : `Update to ${update.tag}`}
        </button>
        <a href={`https://github.com/mergelightai/mergelight/releases/tag/${update.tag}`} target="_blank" rel="noreferrer" className="mt-4 flex items-center justify-center gap-1 text-[13px] text-muted transition-colors hover:text-fg">
          What's new in {update.tag} <External />
        </a>
        {failed && (
          <div role="alert" className="mt-4 text-center text-[13px] leading-relaxed text-muted">
            <p>{failed === 'refused' ? "GitHub didn't let us open the PR. Your install may need to approve the access." : "That didn't work. Please try again."}</p>
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
                    <span className="[text-wrap:pretty]">{fileCount > 1 ? 'Needs two small files to run. We open a PR with them, and you decide whether to merge.' : 'Needs one small file to run. We open a PR with it, and you decide whether to merge.'}</span>
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
                    {fileCount > 1 ? 'It adds two small files needed to run' : 'It adds one small file needed to run'}, and you decide whether to merge.{canChoose && ` Merge ${fileCount > 1 ? 'them' : 'it'} into other branches to review PRs there.`}
                  </span>
                )}
              </Fact>
            )}
          </ul>
        </>
      )}

      {details?.installed ? (
        <button type="button" onClick={onContinue} className={`${PRIMARY} mt-5`}>
          Continue
        </button>
      ) : (
        <>
          <button type="button" onClick={onAdd} disabled={!details || adding} className={`${PRIMARY} mt-5 ${!details ? 'pointer-events-none opacity-40' : adding ? 'pointer-events-none opacity-70' : ''}`}>
            {adding && <Spinner />}
            {adding ? 'Opening your PR...' : `Add to ${name}`}
          </button>
          {failed && (
            <div role="alert" className="mt-4 text-center text-[13px] leading-relaxed text-muted">
              <p>{failed === 'refused' ? "GitHub didn't let us open the PR. Your install may need to approve the access." : "That didn't work. Please try again."}</p>
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

function FinishStep({ repo, branch, fileUrl, pr, onBack }: { repo: Repo; branch: string; fileUrl: string; pr: SetupPr | null; onBack: () => void }) {
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
        {pr ? <Pulse tone="mint" still>Found pull request #{pr.number}</Pulse> : <Pulse>Waiting for your pull request on {repo.fullName.split('/')[1]}</Pulse>}
      </div>
      <a href={fileUrl} target="_blank" rel="noreferrer" className="mt-4 flex items-center justify-center gap-1 text-[13px] text-muted transition-colors hover:text-fg">
        Open it on GitHub again <External />
      </a>
      <span className="sr-only">Adding to {branch}</span>
    </div>
  );
}

function ConnectStep({ repo, pr, status, onBack, onSkip }: { repo: Repo; pr: SetupPr | null; status: CheckStatus | null; onBack: () => void; onSkip: () => void }) {
  const [mode, setMode] = useState<'chatgpt' | 'apikey'>(repo.isPrivate ? 'chatgpt' : 'apikey');
  const [copied, setCopied] = useState(false);
  const prUrl = pr?.url ?? `https://github.com/${repo.fullName}/pulls`;
  const waiting = status?.title?.toLowerCase().includes('connect');

  const copy = () => {
    void navigator.clipboard?.writeText('OPENAI_API_KEY').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const options = [
    { id: 'chatgpt' as const, title: 'ChatGPT plan', note: repo.isPrivate ? 'Uses the subscription you already have' : 'Private repos only, by OpenAI', disabled: !repo.isPrivate },
    { id: 'apikey' as const, title: 'OpenAI API key', note: 'Pay OpenAI per use', disabled: false },
  ];

  return (
    <div>
      <BackButton onClick={onBack} />
      <Heading title="Connect your AI" sub="Reviews run on your own account." />

      <Choices label="How to connect" options={options} value={mode} onChange={setMode} />

      {mode === 'chatgpt' ? (
        <ol className="mt-6 space-y-4">
          <Numbered n={1}>
            Turn on <Strong>Enable device code sign-in</Strong>
            <a href={CHATGPT_SECURITY} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
              Open ChatGPT settings <External />
            </a>
          </Numbered>
          <Numbered n={2}>
            Enter the code we post on your pull request
            <a href={prUrl} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
              Open {pr ? `pull request #${pr.number}` : 'your pull requests'} <External />
            </a>
          </Numbered>
        </ol>
      ) : (
        <ol className="mt-6 space-y-4">
          <Numbered n={1}>
            Add a secret named{' '}
            <button type="button" onClick={copy} title="Copy" className="rounded-md bg-white/[0.08] px-1.5 py-0.5 font-mono text-[12.5px] text-fg transition-colors hover:bg-white/[0.13]">
              {copied ? 'Copied' : 'OPENAI_API_KEY'}
            </button>
            <a href={`https://github.com/${repo.fullName}/settings/secrets/actions/new`} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-[13.5px] text-lilac transition-colors hover:text-fg">
              Open GitHub secrets <External />
            </a>
          </Numbered>
          <Numbered n={2}>Push any commit to your pull request to start the review</Numbered>
        </ol>
      )}

      <div className={`${WELL} mt-6 px-4 py-3.5`}>
        <Pulse tone={waiting ? 'risk' : 'lilac'}>{waiting ? 'Your code is ready on the pull request' : "We'll move on when you're connected"}</Pulse>
      </div>
      <button type="button" onClick={onSkip} className="mx-auto mt-4 block text-[13px] text-faint transition-colors hover:text-muted">
        I've done this
      </button>
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

function LiveStep({ repo, pr, status, hasLogin, merged, updatedTo, onAnother }: { repo: Repo; pr: SetupPr | null; status: CheckStatus | null; hasLogin: boolean; merged: boolean; updatedTo: string | null; onAnother: () => void }) {
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
          {updatedTo ? `Reviews on ${name} now use the new version.` : `New PRs on ${name} get reviewed by themselves, and the results show up on the PR.`} You can close this page.
        </p>
        <div className="mt-6">{another}</div>
      </div>
    );
  }

  const done = isDone(status);
  // A repo that's updating has had reviews before, so this one isn't its first.
  const review = updatedTo ? 'review' : 'first review';
  const Review = updatedTo ? 'Review' : 'First review';
  const reviewTitle = done ? `${Review} done` : status ? `${Review} running` : hasLogin ? `Starting the ${review}` : `Waiting for the ${review} to start`;
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
          {done ? `${plainTitle(status)}. It ${reviewNote}.` : `It's ${reviewingNote}. It usually takes 2 to 15 minutes.`}
        </Milestone>
        <Milestone last state={done ? 'now' : 'next'} title="Merge the PR">
          {updatedTo ? `After that, reviews on ${name} use the new version.` : `After that, new PRs on ${name} get reviewed by themselves.`} You can merge any time.
        </Milestone>
      </ol>
      <a href={pr.url} target="_blank" rel="noreferrer" className={`${PRIMARY} mt-6`}>
        Open PR #{pr.number} <External className="size-4" />
      </a>
      {another}
      <p className="mt-4 text-center text-[13px] leading-relaxed text-faint [text-wrap:pretty]">{done ? 'You can close this page. The PR stays open until you merge it.' : 'You can close this page. The review keeps running, and the result shows up on the PR.'}</p>
    </div>
  );
}
