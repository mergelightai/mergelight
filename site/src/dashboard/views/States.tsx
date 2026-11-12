// The dashboard's states other than its views: signing in, signed out, loading, and the ones that explain why there is nothing to show.
import type { ReactNode } from 'react';
import { LoaderCircleIcon, LockIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { ADD_REPOS_URL, SERVER, signInUrl, type Org } from '../api';
import { ViewHeader } from '../AppShell';
import { GlassCard } from '../kit';

function GitHubMark({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const LINK = 'text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground';

/** A page with no menu: the logo on top and one glass card in the middle. */
export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="flex items-center px-6 py-5">
        <a href="/" className="flex items-center gap-2.5 font-heading text-[15px] font-semibold tracking-tight">
          <img src="/logo.png" alt="" className="size-7 rounded-lg" /> Mergelight
        </a>
      </header>
      <main className="flex flex-1 items-start justify-center px-5 pb-20 pt-[8vh]">{children}</main>
    </div>
  );
}

export function Spinning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center justify-center gap-3 py-24 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-[18px] animate-spin motion-reduce:animate-none" /> {children}
    </p>
  );
}

export function SignIn({ failed, cancelled }: { failed: boolean; cancelled: boolean }) {
  return (
    <div className="glass-frame relative w-full max-w-[440px] rounded-[2rem] p-2">
      <div className="glass-inner grid justify-items-center rounded-[1.6rem] bg-popover px-8 pb-8 pt-9 text-center">
        <img src="/logo-animated.svg" alt="" width={72} height={72} className="size-[72px] rounded-[18px] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_14px_40px_-12px_rgb(0_0_0/0.8)]" />
        <h1 className="mt-5 font-heading text-[28px] font-semibold leading-tight tracking-tight">Your reviews, in one place</h1>
        <p className="mt-2.5 max-w-[320px] text-[15px] leading-relaxed text-muted-foreground">See what Mergelight found across your repositories. You only see repositories GitHub shows you.</p>
        {failed && <p className="mt-4 text-[13px] text-human">Sign-in didn't work. Please try again.</p>}
        {cancelled && !failed && <p className="mt-4 text-[13px] text-muted-foreground">Sign-in was cancelled.</p>}
        <Button size="lg" className="mt-7 h-11 w-full gap-2.5 bg-foreground text-[15px] text-background hover:bg-foreground/90" nativeButton={false} render={<a href={signInUrl()} />}>
          <GitHubMark className="size-[18px]" /> Continue with GitHub
        </Button>
      </div>
      <p className="flex items-start justify-center gap-2 px-6 pb-2 pt-3.5 text-center text-[13px] leading-relaxed text-muted-foreground">
        <LockIcon className="mt-[3px] size-3.5 shrink-0" />
        <span>The dashboard holds numbers about each review, and the findings your team declined, with who declined each one and why. Never your code.</span>
      </p>
    </div>
  );
}

export function NoOrg({ onSignOut }: { onSignOut: () => void }) {
  return (
    <GlassCard className="w-full max-w-lg">
      <h2 className="font-heading text-lg font-semibold">No repositories to show</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        The dashboard shows the repositories Mergelight AI, the app that posts the reviews, is installed on, and this sign-in has none.{' '}
        <a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" className={LINK}>
          Add your org or repositories
        </a>
        , then{' '}
        <a href={signInUrl()} className={LINK}>
          sign in again
        </a>
        .
      </p>
      <Button variant="secondary" className="mt-5" onClick={onSignOut}>
        Sign out
      </Button>
    </GlassCard>
  );
}

export function NotOn({ org }: { org: Org }) {
  return (
    <>
      <ViewHeader title={org.login} />
      <GlassCard className="max-w-2xl">
        <h2 className="font-heading text-lg font-semibold">The dashboard isn't on for {org.login}</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">Nothing is stored for {org.login}, so there is nothing to show. Reviews work as always. The dashboard is being built, and turning it on for an org isn't open to everyone yet.</p>
      </GlassCard>
    </>
  );
}

export function LoadError({ onRetry, what }: { onRetry: () => void; what?: string }) {
  return (
    <GlassCard className="max-w-2xl">
      <h2 className="font-heading text-lg font-semibold">{what ? `Your ${what} couldn't load` : "The dashboard couldn't load"}</h2>
      <p className="mt-2 text-[15px] text-muted-foreground">{what ? 'The Mergelight server answered with an error for this list. The other views work, and your reviews are not affected.' : "The Mergelight server didn't answer. Your reviews are not affected."}</p>
      <Button className="mt-5" onClick={onRetry}>
        Try again
      </Button>
    </GlassCard>
  );
}

/** How to send the first review's numbers. Shown when the dashboard is on and has nothing yet. */
export function NothingYet({ org }: { org: Org }) {
  return (
    <>
      <ViewHeader eyebrow="Overview" title="Reviews" lead={`The dashboard is on for ${org.login}. Add one line to the Mergelight step in a repository's workflow, and its next review shows up here.`} />
      <div className="grid max-w-3xl gap-5">
        <GlassCard label="No reviews to show yet">
          <pre className="overflow-x-auto rounded-2xl bg-black/25 px-5 py-4 font-mono text-[13px] leading-6 text-muted-foreground">
            {`- uses: mergelightai/mergelight@v0\n  with:\n    `}
            <span className="text-safe">{`server: ${SERVER}`}</span>
          </pre>
          <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">A review then sends its numbers: the light, how many findings, which AI ran it and how long it took. It also sends the findings your team declined, with who declined each one and why. It never sends code.</p>
        </GlassCard>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Already sending reviews? Then they are in repositories this sign-in can't see.{' '}
          <a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" className={LINK}>
            Add them on GitHub
          </a>
          , then{' '}
          <a href={signInUrl()} className={LINK}>
            sign in again
          </a>
          .
        </p>
      </div>
    </>
  );
}
