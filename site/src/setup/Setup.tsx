import * as Select from '@radix-ui/react-select';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import workflowFile from '../../../examples/mergelight.yml?raw';
import Ambient from '../sections/Ambient';
import { Check, GitHubIcon, SURFACE, WELL } from '../ui';
import { cleanUrl, finishSignIn, INSTALL_URL, mockClient, realClient, signInUrl, type CheckStatus, type GitHubClient, type Repo, type RepoDetails, type SetupPr } from './github';

const CHATGPT_SECURITY = 'https://chatgpt.com/settings/security';
const SKIP_MARKER = 'github.event.pull_request.head.repo.full_name == github.repository';
const SPRING = { type: 'spring', bounce: 0, duration: 0.45 } as const;

function withSkippedBranches(content: string, branches: string[]): string {
  if (!branches.length) return content;
  return content.replace(SKIP_MARKER, `${SKIP_MARKER} &&\n      !contains(fromJSON('${JSON.stringify(branches)}'), github.head_ref)`);
}

/** GitHub's own editor, already filled in. Nothing is written until the person commits it there. */
function newFileUrl(repo: string, branch: string, content: string): string {
  const path = branch.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/new/${path}?filename=.github/workflows/mergelight.yml&value=${encodeURIComponent(content)}`;
}

function listInWords(items: string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
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
  const [skip, setSkip] = useState<string[]>([]);
  const [pr, setPr] = useState<SetupPr | null>(null);
  const [status, setStatus] = useState<CheckStatus | null>(null);
  const [hasLogin, setHasLogin] = useState(false);

  const previous = useRef(view);
  const direction = ORDER.indexOf(view) >= ORDER.indexOf(previous.current) ? 1 : -1;
  useEffect(() => {
    previous.current = view;
  }, [view]);

  const start = useCallback((c: GitHubClient) => {
    setClient(c);
    setView('repo');
  }, []);

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
    setDetails(null);
    setPr(null);
    setStatus(null);
    setHasLogin(false);
    setView('add');
    client?.details(r).then((d) => {
      setDetails(d);
      setBranch(d.base);
      setSkip(d.skip);
      setHasLogin(d.hasLogin);
    }, () => undefined);
  };

  const workflow = useMemo(() => withSkippedBranches(workflowFile, skip), [skip]);
  const fileUrl = repo ? newFileUrl(repo.fullName, branch, workflow) : '#';
  const afterAdding = useCallback(() => setView(hasLogin ? 'live' : 'connect'), [hasLogin]);

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

  // Following the first review once the pull request exists.
  useEffect(() => {
    if ((view !== 'connect' && view !== 'live') || !client || !repo) return;
    return poll(async () => {
      const [check, login] = await Promise.all([pr ? client.checkStatus(repo, pr.headSha) : null, client.hasLogin(repo)]);
      setStatus(check);
      setHasLogin(login);
      if (view === 'connect' && (login || isReviewing(check))) setView('live');
      return view === 'live' && isDone(check);
    });
  }, [view, client, repo, pr]);

  const anotherRepo = () => {
    setRepo(null);
    setDetails(null);
    setPr(null);
    setStatus(null);
    setView('repo');
  };

  const back: Partial<Record<View, () => void>> = {
    add: anotherRepo,
    finish: () => setView('add'),
    connect: () => setView('finish'),
  };

  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-x-clip">
      <Ambient />
      <header className="relative mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <img src="/logo.png" alt="" width={24} height={24} className="size-6 rounded-md" />
          Mergelight
        </a>
        <Rail at={RAIL[view]} />
      </header>

      <main className="flex flex-1 justify-center px-4 pb-16 pt-[6vh] sm:pt-[9vh]">
        <div className="w-full max-w-[460px]">
          <Stage viewKey={view} direction={direction}>
            {view === 'welcome' && <Welcome signingIn={signingIn} failed={signInFailed} installed={params.has('installation_id')} />}
            {view === 'repo' && <RepoStep repos={repos} onChoose={choose} failed={signInFailed} />}
            {view === 'add' && repo && (
              <AddStep repo={repo} details={details} branch={branch} setBranch={setBranch} skip={skip} setSkip={setSkip} workflow={workflow} fileUrl={fileUrl} onBack={back.add!} onOpened={() => setView('finish')} onContinue={afterAdding} />
            )}
            {view === 'finish' && repo && <FinishStep repo={repo} branch={branch} fileUrl={fileUrl} pr={pr} onBack={back.finish!} />}
            {view === 'connect' && repo && <ConnectStep repo={repo} pr={pr} status={status} onBack={back.connect!} onSkip={() => setView('live')} />}
            {view === 'live' && repo && <LiveStep repo={repo} pr={pr} status={status} hasLogin={hasLogin} onAnother={anotherRepo} />}
          </Stage>
          <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[13px] text-faint">
            <LockIcon className="size-3.5 shrink-0" />
            Your code and AI login never touch Mergelight.
          </p>
        </div>
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

function Welcome({ signingIn, failed, installed }: { signingIn: boolean; failed: boolean; installed: boolean }) {
  return (
    <div className="py-2 text-center">
      <img src="/logo-animated.svg" alt="" width={84} height={84} className="mx-auto size-[84px] rounded-[20px] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_14px_40px_-12px_rgb(0_0_0/0.8)]" />
      <h1 className="mt-5 text-[32px] font-semibold leading-[1.1] tracking-[-0.03em]">Turn on Mergelight</h1>
      <p className="mx-auto mt-3 max-w-[320px] text-[15px] leading-relaxed text-muted [text-wrap:pretty]">
        {installed ? "It's installed. Sign in to finish setting up." : 'Real code review on the AI plan you already pay for. Three quick steps, nothing to install.'}
      </p>
      {failed && <p className="mt-4 text-[13px] text-risk">GitHub sign-in didn't work. Please try again.</p>}
      <a href={signingIn ? undefined : signInUrl()} aria-disabled={signingIn} className={`${PRIMARY} mt-7 ${signingIn ? 'pointer-events-none opacity-70' : ''}`}>
        <GitHubIcon className="size-[18px]" />
        {signingIn ? 'Signing you in...' : 'Continue with GitHub'}
      </a>
    </div>
  );
}

function RepoStep({ repos, onChoose, failed }: { repos: Repo[] | null; onChoose: (r: Repo) => void; failed: boolean }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useMemo(() => (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase())), [repos, query]);
  const accounts = useMemo(() => [...new Set((repos ?? []).map((r) => r.account))], [repos]);
  const accessUrl = accounts.length === 1 ? repos![0]!.accessUrl : INSTALL_URL;
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
        <a href={accessUrl} target="_blank" rel="noreferrer" className="mt-3 flex items-center justify-center gap-1 text-[13px] text-muted transition-colors hover:text-fg">
          Don't see your repo? Add it on GitHub <External />
        </a>
      )}
    </div>
  );
}

function Fact({ icon, center = false, children }: { icon: ReactNode; center?: boolean; children: ReactNode }) {
  return (
    <li className={`flex gap-3 py-3 text-[14.5px] leading-[1.45] text-muted ${center ? 'items-center' : 'items-start'}`}>
      <span className={`grid size-[18px] shrink-0 place-items-center text-lilac ${center ? '' : 'mt-[2px]'}`}>{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

function AddStep(props: {
  repo: Repo;
  details: RepoDetails | null;
  branch: string;
  setBranch: (b: string) => void;
  skip: string[];
  setSkip: (s: string[]) => void;
  workflow: string;
  fileUrl: string;
  onBack: () => void;
  onOpened: () => void;
  onContinue: () => void;
}) {
  const { repo, details, branch, setBranch, skip, setSkip, workflow, fileUrl, onBack, onOpened, onContinue } = props;
  const [changingSkip, setChangingSkip] = useState(false);
  const [showingFile, setShowingFile] = useState(false);
  const name = repo.fullName.split('/')[1]!;

  return (
    <div>
      <BackButton onClick={onBack} />
      <Heading title={`Add Mergelight to ${name}`} sub={details?.hasWorkflow ? `It's already on ${branch}.` : 'Here is what it will do.'} />

      {!details ? (
        <div className="mt-5 space-y-3" aria-label="Reading your repo">
          {[0, 1, 2].map((i) => (
            <span key={i} className="block h-5 animate-pulse rounded bg-white/[0.05]" style={{ width: `${86 - i * 14}%`, animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-white/[0.06]">
          <Fact center icon={<Check className="size-4" />}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              Reviews every PR into
              <BranchPicker branches={details.branches} value={branch} suggested={details.base} onChange={setBranch} />
            </span>
          </Fact>
          {details.skip.length > 0 && (
            <Fact icon={<Check className="size-4" />}>
              <button type="button" onClick={() => setChangingSkip((v) => !v)} className="text-left transition-colors hover:text-fg">
                {skip.length ? `Skips releases from ${listInWords(skip)}` : 'Reviews releases too'} <span className="text-faint underline underline-offset-2">Change</span>
              </button>
              {changingSkip && (
                <span className="mt-2.5 flex flex-wrap gap-1.5">
                  {details.skip.map((b) => {
                    const on = skip.includes(b);
                    return (
                      <button
                        key={b}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSkip(on ? skip.filter((x) => x !== b) : [...skip, b])}
                        className={`flex h-8 items-center gap-1 rounded-full px-3 text-[13px] transition-[background-color,color,transform] duration-100 active:scale-[0.96] ${on ? 'bg-white/[0.12] text-fg' : 'text-faint shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] hover:text-muted'}`}
                      >
                        {on && <Check className="size-3" />}
                        {b}
                      </button>
                    );
                  })}
                </span>
              )}
            </Fact>
          )}
          <Fact icon={<Check className="size-4" />}>Runs in your own GitHub Actions, on your AI plan</Fact>
          <Fact icon={<LockIcon className="size-4" />}>
            Adds one small file, and can never push code.{' '}
            <button type="button" onClick={() => setShowingFile((v) => !v)} className="text-faint underline underline-offset-2 transition-colors hover:text-fg">
              {showingFile ? 'Hide it' : 'See it'}
            </button>
            {showingFile && <pre className={`${WELL} mt-2.5 max-h-56 overflow-auto p-3 font-mono text-[11.5px] leading-[1.6] text-muted`}>{workflow.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').trim()}</pre>}
          </Fact>
        </ul>
      )}

      {details?.hasWorkflow ? (
        <button type="button" onClick={onContinue} className={`${PRIMARY} mt-5`}>
          Continue
        </button>
      ) : (
        <a href={details ? fileUrl : undefined} target="_blank" rel="noreferrer" onClick={onOpened} aria-disabled={!details} className={`${PRIMARY} mt-5 ${details ? '' : 'pointer-events-none opacity-40'}`}>
          Add to {name} <External className="size-4" />
        </a>
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

      <div role="radiogroup" aria-label="How to connect" className="mt-5 grid grid-cols-2 gap-2">
        {options.map((o) => {
          const on = mode === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={o.disabled}
              onClick={() => setMode(o.id)}
              className={`rounded-2xl p-3.5 text-left transition-[background-color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${on ? 'bg-white/[0.07] shadow-[inset_0_0_0_1.5px_rgb(184_156_255/0.75)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:bg-white/[0.05]'}`}
            >
              <span className="block text-[14.5px] font-medium text-fg">{o.title}</span>
              <span className="mt-1 block text-[12.5px] leading-snug text-muted">{o.note}</span>
            </button>
          );
        })}
      </div>

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

function LiveStep({ repo, pr, status, hasLogin, onAnother }: { repo: Repo; pr: SetupPr | null; status: CheckStatus | null; hasLogin: boolean; onAnother: () => void }) {
  const name = repo.fullName.split('/')[1]!;
  const done = isDone(status);
  const tone = !done ? 'lilac' : status?.conclusion === 'success' ? 'mint' : status?.conclusion === 'failure' ? 'bug' : 'risk';
  return (
    <div className="py-1 text-center">
      <motion.div initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING} className="mx-auto w-fit">
        <img src="/logo-animated.svg" alt="" width={72} height={72} className="size-[72px] rounded-[18px] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_14px_40px_-12px_rgb(0_0_0/0.8)]" />
      </motion.div>
      <h1 className="mt-4 text-[28px] font-semibold leading-[1.1] tracking-[-0.028em]">Mergelight is on</h1>
      <p className="mx-auto mt-2 max-w-[330px] text-[15px] leading-relaxed text-muted [text-wrap:pretty]">
        {pr ? `Merge the pull request, and it reviews every new PR on ${name}.` : `It reviews the next pull request on ${name}.`}
      </p>
      {pr && (
        <a href={pr.url} target="_blank" rel="noreferrer" className={`${WELL} group mt-6 flex items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.05]`}>
          <Pulse tone={tone} still={done}>{done ? plainTitle(status) : status ? 'Reviewing your pull request' : hasLogin ? 'Starting the review' : 'Waiting for the review to start'}</Pulse>
          <span className="flex shrink-0 items-center gap-1 text-[13px] text-faint transition-colors group-hover:text-muted">
            #{pr.number} <External />
          </span>
        </a>
      )}
      <button type="button" onClick={onAnother} className={`${BUTTON} mt-3 text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] hover:bg-white/[0.05]`}>
        Set up another repo
      </button>
    </div>
  );
}
