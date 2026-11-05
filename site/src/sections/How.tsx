import SpotlightCard from '../components/reactbits/SpotlightCard';
import { Check, Container, SectionHead } from '../ui';

const steps = [
  ['01', 'Add the GitHub Action', 'One workflow file in your repo. It runs the official Claude Code or Codex CLI, unmodified. Self-hosted runners work too.'],
  ['02', 'Use your own login', 'Your Claude or ChatGPT login lives in your repository secrets. Mergelight never sees it, not even during setup.'],
  ['03', 'Open a pull request', 'Live checks show what Mergelight is doing, with a reason on every state. Then one summary comment, updated in place.'],
];

function Spinner() {
  return <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-risk/30 border-t-risk" />;
}

export default function How() {
  return (
    <section id="how" className="relative border-t border-line/70 py-28 sm:py-36">
      <Container>
        <SectionHead
          eyebrow="How it works"
          title="No new bill. Your plan does the work."
          lead="Reviews run in your own CI on the Claude or ChatGPT subscription you already have. You never pay per review or per file."
        />

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {steps.map(([n, t, d]) => (
            <SpotlightCard key={n} spotlightColor="rgba(184, 156, 255, 0.16)" className="border border-line !bg-panel">
              <p className="font-mono text-sm text-lilac">{n}</p>
              <h3 className="mt-4 text-lg font-semibold tracking-tight">{t}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">{d}</p>
            </SpotlightCard>
          ))}
        </div>

        <div className="mt-16 overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-6">
            <p className="text-sm font-medium text-fg">Checks on your pull request</p>
            <p className="hidden text-sm text-faint sm:block">You always know how far along it is</p>
          </div>
          <ul className="divide-y divide-line text-[15px]">
            <li className="flex items-center gap-4 px-5 py-4 sm:px-6">
              <Spinner />
              <span className="font-medium text-fg">Mergelight / review</span>
              <span className="truncate text-muted">Reviewing 4 of 12 files</span>
            </li>
            <li className="flex items-center gap-4 px-5 py-4 sm:px-6">
              <span className="grid size-4 shrink-0 place-items-center rounded-full bg-mint text-ink"><Check className="size-3" /></span>
              <span className="font-medium text-fg">Mergelight / triage</span>
              <span className="truncate text-muted">1 bug, 0 risks, 2 hardening notes (collapsed)</span>
            </li>
            <li className="flex items-center gap-4 px-5 py-4 sm:px-6">
              <span className="size-4 shrink-0 rounded-full border-2 border-faint/60" />
              <span className="font-medium text-fg">Mergelight / follow-up</span>
              <span className="truncate text-muted">Queued until your plan's usage limit resets, never skipped</span>
            </li>
          </ul>
        </div>
      </Container>
    </section>
  );
}
