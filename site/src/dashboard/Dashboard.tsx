import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { GitHubIcon, SURFACE, WELL } from '../ui';
import { ADD_REPOS_URL, finishSignIn, loadOverview, NotConnected, rememberedSession, SERVER, SignedOut, signInUrl, signOut, tidyAddress, type Light, type Org, type Overview, type Review, type Session } from './api';

const LIGHTS: Record<Light, { label: string; dot: string; text: string }> = {
  green: { label: 'Safe to merge', dot: 'bg-mint', text: 'text-mint' },
  yellow: { label: 'Needs a human', dot: 'bg-risk', text: 'text-risk' },
  red: { label: 'Blocked', dot: 'bg-bug', text: 'text-bug' },
};

const BUTTON = 'inline-flex h-11 items-center justify-center gap-2.5 rounded-full px-6 text-[15px] font-medium transition-colors';
const PRIMARY = `${BUTTON} bg-fg text-ink hover:bg-white`;

/** "3 minutes ago", from the reader's own clock. */
function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const steps: [number, string][] = [[60, 'minute'], [60, 'hour'], [24, 'day'], [30, 'month'], [12, 'year']];
  let value = seconds;
  let unit = 'second';
  for (const [size, name] of steps) {
    if (value < size) break;
    value = Math.floor(value / size);
    unit = name;
  }
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

function took(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** "2 bugs, 1 risk", or what it means when there are none. */
function findings(r: Review): string {
  const parts = [
    r.bugs && `${r.bugs} bug${r.bugs === 1 ? '' : 's'}`,
    r.risks && `${r.risks} risk${r.risks === 1 ? '' : 's'}`,
    r.hardening && `${r.hardening} hardening`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing worth fixing';
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-[18px] animate-spin motion-reduce:animate-none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`${SURFACE} p-6 sm:p-7 ${className}`}>{children}</section>;
}

function SignIn({ failed, cancelled }: { failed: boolean; cancelled: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[460px] py-2 text-center">
      <img src="/logo-animated.svg" alt="" width={84} height={84} className="mx-auto size-[84px] rounded-[20px] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_14px_40px_-12px_rgb(0_0_0/0.8)]" />
      <h1 className="mt-5 text-[32px] font-semibold leading-[1.1] tracking-[-0.03em]">Your reviews, in one place</h1>
      <p className="mx-auto mt-3 max-w-[340px] text-[15px] leading-relaxed text-muted [text-wrap:pretty]">
        See what Mergelight found across your repositories. You only see repositories GitHub shows you.
      </p>
      {failed && <p className="mt-4 text-[13px] text-risk">Sign-in didn't work. Please try again.</p>}
      {cancelled && !failed && <p className="mt-4 text-[13px] text-muted">Sign-in was cancelled.</p>}
      <a href={signInUrl()} className={`${PRIMARY} mt-7`}>
        <GitHubIcon className="size-[18px]" /> Continue with GitHub
      </a>
      <p className="mx-auto mt-6 max-w-[340px] text-[13px] leading-relaxed text-faint">The dashboard holds numbers about each review. Never your code, and never what a finding says.</p>
    </div>
  );
}

function Stat({ label, value, tone = 'text-fg' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`${WELL} px-5 py-4`}>
      <p className="text-[13px] text-muted">{label}</p>
      <p className={`mt-1 font-mono text-[26px] font-medium tracking-[-0.02em] ${tone}`}>{value}</p>
    </div>
  );
}

function Stats({ reviews }: { reviews: Review[] }) {
  const by = (light: Light) => reviews.filter((r) => r.light === light).length;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label={reviews.length === 1 ? 'Latest review' : `Latest ${reviews.length} reviews`} value={reviews.length} />
      <Stat label={LIGHTS.green.label} value={by('green')} tone={LIGHTS.green.text} />
      <Stat label={LIGHTS.yellow.label} value={by('yellow')} tone={LIGHTS.yellow.text} />
      <Stat label={LIGHTS.red.label} value={by('red')} tone={LIGHTS.red.text} />
    </div>
  );
}

function ReviewRow({ review }: { review: Review }) {
  const light = LIGHTS[review.light];
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line py-3.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 basis-[260px] items-center gap-3">
        <span className={`size-2.5 shrink-0 rounded-full ${light.dot}`} title={light.label} />
        <a href={`https://github.com/${review.repo}/pull/${review.pr}`} target="_blank" rel="noreferrer" className="min-w-0 truncate text-[15px] font-medium text-fg hover:underline">
          {review.repo} <span className="text-muted">#{review.pr}</span>
        </a>
      </span>
      <span className={`basis-[190px] text-[14px] ${review.bugs || review.risks ? 'text-fg' : 'text-muted'}`}>{findings(review)}</span>
      <span className="basis-[150px] truncate font-mono text-[12.5px] text-faint">
        {review.model ?? review.provider}, {took(review.duration_ms)}
      </span>
      <time dateTime={review.created_at} className="basis-[110px] text-right text-[13px] text-faint">
        {ago(review.created_at)}
      </time>
    </li>
  );
}

function Reviews({ overview }: { overview: Overview }) {
  return (
    <div className="space-y-5">
      <Stats reviews={overview.reviews} />
      <Card>
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Latest reviews</h2>
        <ul className="mt-3">
          {overview.reviews.map((r) => (
            <ReviewRow key={`${r.repo_id}-${r.pr}-${r.created_at}`} review={r} />
          ))}
        </ul>
      </Card>
      <Card>
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Repositories</h2>
        <ul className="mt-3">
          {overview.repos.map((repo) => (
            <li key={repo.id} className="flex items-center gap-4 border-t border-line py-3 first:border-t-0">
              <a href={`https://github.com/${repo.name}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[15px] text-fg hover:underline">
                {repo.name}
              </a>
              <span className="font-mono text-[13px] text-muted">
                {repo.reviews} review{repo.reviews === 1 ? '' : 's'}
              </span>
              <span className="w-[120px] text-right text-[13px] text-faint">{ago(repo.last_review_at)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** How to send the first review's numbers. Shown when the dashboard is on and has nothing yet. */
function NothingYet({ org }: { org: Org }) {
  return (
    <Card>
      <h2 className="text-[19px] font-semibold tracking-[-0.01em]">No reviews to show yet</h2>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted">
        The dashboard is on for {org.login}. Add one line to the Mergelight step in a repository's workflow, and its next review shows up here.
      </p>
      <pre className={`${WELL} mt-5 overflow-x-auto px-5 py-4 font-mono text-[13px] leading-6 text-muted`}>
        {`- uses: mergelightai/mergelight@v0\n  with:\n    `}
        <span className="text-mint">{`server: ${SERVER}`}</span>
      </pre>
      <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-faint">
        A review then sends its numbers: the light, how many findings, which AI ran it and how long it took. It never sends code or what a finding says.
      </p>
      <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-muted">
        Already sending reviews? Then they are in repositories this sign-in can't see.{' '}
        <a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" className="text-fg underline decoration-white/30 underline-offset-4 hover:decoration-white">Add them on GitHub</a>, then sign in again.
      </p>
    </Card>
  );
}

function NotOn({ org }: { org: Org }) {
  return (
    <Card>
      <h2 className="text-[19px] font-semibold tracking-[-0.01em]">The dashboard isn't on for {org.login}</h2>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted">
        Nothing is stored for {org.login}, so there is nothing to show. Reviews work as always. The dashboard is being built, and turning it on for an org isn't open to everyone yet.
      </p>
    </Card>
  );
}

type View = { kind: 'loading' } | { kind: 'ready'; overview: Overview } | { kind: 'off' } | { kind: 'error' };

export default function Dashboard() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [session, setSession] = useState<Session | null>(() => (params.has('code') ? null : rememberedSession()));
  const [signingIn, setSigningIn] = useState(params.has('code'));
  const [failed, setFailed] = useState(false);
  // GitHub sends a cancelled sign-in back with an error and no code.
  const [cancelled] = useState(() => params.has('error') && !params.has('code'));
  const [orgId, setOrgId] = useState<number | null>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });

  // Coming back from GitHub with a sign-in code.
  useEffect(() => {
    if (!params.has('code')) {
      if (params.has('error')) tidyAddress();
      return;
    }
    let gone = false;
    finishSignIn(params)
      .then((s) => !gone && setSession(s))
      .catch(() => !gone && setFailed(true))
      .finally(() => {
        tidyAddress();
        if (!gone) setSigningIn(false);
      });
    return () => {
      gone = true;
    };
  }, [params]);

  const org = useMemo(() => {
    const orgs = session?.orgs ?? [];
    return orgs.find((o) => o.id === orgId) ?? orgs.find((o) => o.connected) ?? orgs[0] ?? null;
  }, [session, orgId]);

  const load = useCallback(() => {
    if (!session || !org) return () => undefined;
    let gone = false;
    setView({ kind: 'loading' });
    loadOverview(session, org.id)
      .then((overview) => !gone && setView({ kind: 'ready', overview }))
      .catch((err) => {
        if (gone) return;
        if (err instanceof SignedOut) setSession(null);
        else setView(err instanceof NotConnected ? { kind: 'off' } : { kind: 'error' });
      });
    return () => {
      gone = true;
    };
  }, [session, org]);
  useEffect(() => load(), [load]);

  if (signingIn) {
    return (
      <Shell>
        <p className="flex items-center justify-center gap-3 py-24 text-[15px] text-muted">
          <Spinner /> Signing you in
        </p>
      </Shell>
    );
  }
  if (!session) {
    return (
      <Shell>
        <div className="pt-[6vh] sm:pt-[9vh]">
          <SignIn failed={failed} cancelled={cancelled} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      right={
        <span className="flex items-center gap-4 text-[14px] text-muted">
          <span className="hidden sm:inline">{session.user.login}</span>
          <button
            type="button"
            onClick={() => {
              void signOut(session);
              setSession(null);
            }}
            className="rounded-full px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            Sign out
          </button>
        </span>
      }
    >
      {!org ? (
        <Card>
          <h2 className="text-[19px] font-semibold tracking-[-0.01em]">No repositories to show</h2>
          <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted">
            The dashboard shows the repositories you gave Mergelight Setup access to on GitHub, and this sign-in has none.{' '}
            <a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" className="text-fg underline decoration-white/30 underline-offset-4 hover:decoration-white">Add your org or repositories</a>, then sign in again.
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-mint">Dashboard</p>
              <h1 className="mt-1.5 text-[30px] font-semibold tracking-[-0.03em]">{org.login}</h1>
            </div>
            {session.orgs.length > 1 && (
              <div className={`${WELL} flex flex-wrap gap-1 p-1`} role="tablist" aria-label="Org">
                {session.orgs.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="tab"
                    aria-selected={o.id === org.id}
                    onClick={() => setOrgId(o.id)}
                    className={`rounded-xl px-3.5 py-1.5 text-[14px] transition-colors ${o.id === org.id ? 'bg-white/[0.09] text-fg' : 'text-muted hover:text-fg'}`}
                  >
                    {o.login}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* The page can only show what the sign-in's app is installed on, so the way to add more is always in reach. */}
          <p className="-mt-2 mb-6 text-[13px] text-faint">
            Don't see an org or a repository?{' '}
            <a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" className="text-muted underline decoration-white/20 underline-offset-4 hover:text-fg">Add it on GitHub</a>, then sign in again.
          </p>
          {view.kind === 'loading' && (
            <p className="flex items-center justify-center gap-3 py-24 text-[15px] text-muted">
              <Spinner /> Loading reviews
            </p>
          )}
          {view.kind === 'off' && <NotOn org={org} />}
          {view.kind === 'error' && (
            <Card>
              <h2 className="text-[19px] font-semibold tracking-[-0.01em]">The dashboard couldn't load</h2>
              <p className="mt-2 text-[15px] text-muted">The Mergelight server didn't answer. Your reviews are not affected.</p>
              <button type="button" onClick={() => load()} className={`${PRIMARY} mt-5 h-10 px-5 text-[14px]`}>
                Try again
              </button>
            </Card>
          )}
          {view.kind === 'ready' && (view.overview.reviews.length ? <Reviews overview={view.overview} /> : <NothingYet org={org} />)}
        </>
      )}
    </Shell>
  );
}

function Shell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-ink text-fg">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-5 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em]">
          <img src="/logo.png" alt="" className="size-7 rounded-[8px]" /> Mergelight
        </a>
        {right}
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 pb-20 pt-4 sm:px-8">{children}</main>
    </div>
  );
}
