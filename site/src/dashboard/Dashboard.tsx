import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { GitHubIcon, SURFACE, WELL } from '../ui';
import { addRule, ADD_REPOS_URL, finishSignIn, forgetDecision, loadDecisions, loadOverview, loadRules, mayRenew, removeRule, NotConnected, rememberedSession, SERVER, SignedOut, signInUrl, signOut, tidyAddress, type Decision, type Light, type NewRule, type Org, type Overview, type Rule, type Rules, type Review, type Session } from './api';

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
      <p className="mx-auto mt-6 max-w-[340px] text-[13px] leading-relaxed text-faint">The dashboard holds numbers about each review, and the findings your team declined, with who declined each one and why. Never your code.</p>
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

/** What the team decided not to fix. Mergelight leaves these out of later reviews, and anyone who can push can take one back. */
function Decisions({ decisions, total, onForget }: { decisions: Decision[]; total: number; onForget: (d: Decision) => Promise<void> }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  return (
    <Card>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">What your team decided</h2>
      <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-muted">
        When someone declines a finding and says why, Mergelight remembers it and leaves it out of later reviews of that file. A decision nobody needed for 90 days is dropped.
      </p>
      {total > decisions.length && (
        <p className="mt-3 text-[13px] text-faint">
          Showing the {decisions.length} most recent of {total}.
        </p>
      )}
      {decisions.length === 0 ? (
        <p className={`${WELL} mt-5 px-5 py-4 text-[14px] leading-relaxed text-muted`}>
          Nothing yet. Decline a finding with a reason on a pull request, and it shows up here after that pull request's next review.
        </p>
      ) : (
        <ul className="mt-3">
          {decisions.map((d) => (
            <li key={d.id} className="border-t border-line py-4 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-[320px]">
                  <p className="text-[15px] font-medium text-fg">{d.title}</p>
                  <p className="mt-1 truncate font-mono text-[12.5px] text-faint">
                    {d.repo} · {d.file}:{d.line}
                  </p>
                </div>
                {d.can_forget && (
                  <button
                    type="button"
                    disabled={busy === d.id}
                    onClick={() => {
                      setBusy(d.id);
                      setFailed(null);
                      onForget(d)
                        .catch(() => setFailed(d.id))
                        .finally(() => setBusy(null));
                    }}
                    className="rounded-full px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-50"
                  >
                    {busy === d.id ? 'Forgetting' : 'Forget'}
                  </button>
                )}
              </div>
              <p className={`${WELL} mt-3 px-4 py-3 text-[14px] leading-relaxed text-muted`}>
                <span className="text-fg">{d.by}:</span> {d.reason}
              </p>
              <p className="mt-2 text-[13px] text-faint">
                Declined in{' '}
                <a href={`https://github.com/${d.repo}/pull/${d.pr}`} target="_blank" rel="noreferrer" className="text-muted hover:underline">
                  #{d.pr}
                </a>
                , {ago(d.created_at)}. {d.uses ? `Left out of ${d.uses} review${d.uses === 1 ? '' : 's'} since, last ${ago(d.last_used_at)}.` : 'Not needed since.'}
              </p>
              {failed === d.id && <p className="mt-2 text-[13px] text-risk">That didn't work. Please try again.</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const FIELD = 'h-10 w-full rounded-xl bg-white/[0.04] px-3.5 text-[14px] text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_rgb(184_156_255/0.6)]';

/** The form for a new rule. Only the places this person may set rules for are offered. */
function NewRuleForm({ rules, onAdd }: { rules: Rules; onAdd: (rule: NewRule) => Promise<void> }) {
  const places = [...(rules.can_set_org_rules ? [{ value: 'org', label: 'Every repository' }] : []), ...rules.repos.filter((r) => r.can_set_rules).map((r) => ({ value: String(r.id), label: r.name }))];
  const [kind, setKind] = useState<Rule['kind']>('rule');
  const [text, setText] = useState('');
  const [paths, setPaths] = useState('');
  const [place, setPlace] = useState(places[0]?.value ?? 'org');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!places.length) {
    return <p className="mt-5 text-[13px] leading-relaxed text-faint">Only an owner of the org or an admin of a repository can change the rules.</p>;
  }
  const patterns = paths.split(',').map((p) => p.trim()).filter(Boolean);
  const ready = text.trim().length > 0 && (kind === 'rule' || patterns.length > 0) && !busy;
  return (
    <form
      className={`${WELL} mt-5 space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setError(null);
        onAdd({ kind, text: text.trim(), paths: patterns, repo_id: place === 'org' ? null : Number(place) })
          .then(() => {
            setText('');
            setPaths('');
          })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That did not work.'))
          .finally(() => setBusy(false));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px] text-muted">
          What it is
          <select aria-label="What it is" value={kind} onChange={(e) => setKind(e.target.value as Rule['kind'])} className={`${FIELD} mt-1.5`}>
            <option value="rule">A rule every review follows</option>
            <option value="needs_human">Files that always need a human</option>
          </select>
        </label>
        <label className="block text-[13px] text-muted">
          Where it applies
          <select aria-label="Where it applies" value={place} onChange={(e) => setPlace(e.target.value)} className={`${FIELD} mt-1.5`}>
            {places.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-[13px] text-muted">
        {kind === 'rule' ? 'The rule, in one line' : 'Why, in one line'}
        <input aria-label="The rule" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} placeholder={kind === 'rule' ? 'Ignore style and naming.' : 'Billing changes need a second pair of eyes.'} className={`${FIELD} mt-1.5`} />
      </label>
      <label className="block text-[13px] text-muted">
        {kind === 'rule' ? 'Only in these files (optional)' : 'Which files'}
        <input aria-label="Files" value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="src/billing/**, *.sql" className={`${FIELD} mt-1.5 font-mono text-[13px]`} />
      </label>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button type="submit" disabled={!ready} className={`${PRIMARY} h-10 px-5 text-[14px] disabled:opacity-40`}>
          {busy ? 'Adding' : 'Add'}
        </button>
        {error && <span className="text-[13px] text-risk">{error}</span>}
      </div>
    </form>
  );
}

/** The team's rules: lines every review follows, and files that always need a human. */
function RulesCard({ rules, onAdd, onRemove }: { rules: Rules; onAdd: (rule: NewRule) => Promise<void>; onRemove: (rule: Rule) => Promise<void> }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  return (
    <Card>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Rules</h2>
      <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-muted">
        A rule is one line that every review follows, for the whole org or for one repository. You can also name files that always need a human, so a pull request that changes them never goes green by itself.
      </p>
      {rules.rules.length > 0 && (
        <ul className="mt-3">
          {rules.rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-line py-3.5 first:border-t-0">
              <div className="min-w-0 flex-1 basis-[320px]">
                <p className="text-[15px] text-fg">{r.text}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-faint">
                  <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-muted">{r.repo ?? 'Every repository'}</span>
                  {r.kind === 'needs_human' && <span className="rounded-full bg-risk/10 px-2 py-0.5 text-risk">Always needs a human</span>}
                  {r.paths.length > 0 && <span className="font-mono">{r.paths.join(', ')}</span>}
                  <span>
                    set by {r.by}, {ago(r.created_at)}
                  </span>
                </p>
                {failed === r.id && <p className="mt-2 text-[13px] text-risk">That didn't work. Please try again.</p>}
              </div>
              {r.can_remove && (
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={() => {
                    setBusy(r.id);
                    setFailed(null);
                    onRemove(r)
                      .catch(() => setFailed(r.id))
                      .finally(() => setBusy(null));
                  }}
                  className="rounded-full px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-50"
                >
                  {busy === r.id ? 'Removing' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <NewRuleForm rules={rules} onAdd={onAdd} />
    </Card>
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
        A review then sends its numbers: the light, how many findings, which AI ran it and how long it took. It also sends the findings your team declined, with who declined each one and why. It never sends code.
      </p>
      <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-muted">
        Already sending reviews? Then they are in repositories this sign-in can't see.{' '}
        <a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" className="text-fg underline decoration-white/30 underline-offset-4 hover:decoration-white">Add them on GitHub</a>, then{' '}
        <a href={signInUrl()} className="text-fg underline decoration-white/30 underline-offset-4 hover:decoration-white">sign in again</a>.
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

type View = { kind: 'loading' } | { kind: 'ready'; overview: Overview; decisions: Decision[]; total: number; rules: Rules | null } | { kind: 'off' } | { kind: 'error' };

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
    // The reviews are the page. If only the list of decisions fails, they still show.
    const decisions = loadDecisions(session, org.id).catch((err) => {
      if (err instanceof SignedOut || err instanceof NotConnected) throw err;
      return { decisions: [], total: 0 };
    });
    const rules = loadRules(session, org.id).catch((err) => {
      if (err instanceof SignedOut || err instanceof NotConnected) throw err;
      return null;
    });
    Promise.all([loadOverview(session, org.id), decisions, rules])
      .then(([overview, { decisions, total }, rules]) => !gone && setView({ kind: 'ready', overview, decisions, total, rules }))
      .catch((err) => {
        if (gone) return;
        if (err instanceof SignedOut) {
          // The session ran out. GitHub sends a signed-in person straight back, so the page renews it by itself.
          if (mayRenew()) window.location.assign(signInUrl());
          else setSession(null);
        } else setView(err instanceof NotConnected ? { kind: 'off' } : { kind: 'error' });
      });
    return () => {
      gone = true;
    };
  }, [session, org]);
  useEffect(() => load(), [load]);

  /** Runs a change. If the session ran out while the page was open, it signs in again, as loading does. */
  const signedIn = async (change: () => Promise<void>): Promise<void> => {
    try {
      await change();
    } catch (err) {
      if (!(err instanceof SignedOut)) throw err;
      if (mayRenew()) window.location.assign(signInUrl());
      else setSession(null);
      // The change didn't happen. The page is on its way to a new sign-in, so there is nothing to show for it.
      throw err;
    }
  };

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
            <a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" className="text-fg underline decoration-white/30 underline-offset-4 hover:decoration-white">Add your org or repositories</a>, then{' '}
            <a href={signInUrl()} className="text-fg underline decoration-white/30 underline-offset-4 hover:decoration-white">sign in again</a>.
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
            <a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" className="text-muted underline decoration-white/20 underline-offset-4 hover:text-fg">Add it on GitHub</a>, then{' '}
            <a href={signInUrl()} className="text-muted underline decoration-white/20 underline-offset-4 hover:text-fg">sign in again</a>.
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
          {view.kind === 'ready' && (
            <div className="space-y-5">
              {view.overview.reviews.length ? <Reviews overview={view.overview} /> : <NothingYet org={org} />}
              {view.rules && (
                <RulesCard
                  rules={view.rules}
                  onAdd={async (rule) => {
                    await signedIn(() => addRule(session, org.id, rule));
                    // The rule is in. If only the fresh list fails to load, that isn't a failed Add: saying so would invite a second one.
                    const rules = await loadRules(session, org.id).catch(() => null);
                    if (rules) setView((v) => (v.kind === 'ready' ? { ...v, rules } : v));
                  }}
                  onRemove={async (rule) => {
                    await signedIn(() => removeRule(session, org.id, rule.id));
                    setView((v) => (v.kind === 'ready' && v.rules ? { ...v, rules: { ...v.rules, rules: v.rules.rules.filter((x) => x.id !== rule.id) } } : v));
                  }}
                />
              )}
              {(view.overview.reviews.length > 0 || view.decisions.length > 0) && (
                <Decisions
                  decisions={view.decisions}
                  total={view.total}
                  onForget={async (d) => {
                    await signedIn(() => forgetDecision(session, org.id, d.id));
                    setView((v) => (v.kind === 'ready' ? { ...v, decisions: v.decisions.filter((x) => x.id !== d.id), total: v.total - 1 } : v));
                  }}
                />
              )}
            </div>
          )}
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
