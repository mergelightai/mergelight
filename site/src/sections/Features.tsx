import { useEffect, useState } from 'react';
import { siClaude } from 'simple-icons';
import MagicBento, { type MagicBentoItem } from '../components/reactbits/MagicBento';
import { OPENAI_PATH } from '../brandIcons';
import { Check, Container, SectionHead } from '../ui';

function Thread() {
  return (
    <div className="flex flex-col gap-2.5 text-[13px]">
      <div className="mb-2 rounded-xl border border-line bg-white/[0.02] p-3">
        <p className="flex items-center justify-between text-[11px] text-faint">
          <span>What Mergelight knows about this repo</span>
          <span className="font-mono">14 learnings</span>
        </p>
        <ul className="mt-2 space-y-1.5 text-[12.5px] text-muted">
          {['Migrations always run inside a transaction', 'Feature flags are read once at boot', 'Admin routes are internal only'].map((l) => (
            <li key={l} className="flex items-center gap-2"><span className="size-1 rounded-full bg-lilac" />{l}</li>
          ))}
        </ul>
      </div>
      <div className="max-w-[88%] rounded-xl rounded-tl-sm border border-line bg-white/[0.03] px-3 py-2">
        <p className="flex items-center gap-1.5 text-[11px] text-faint">
          <img src="/logo.png" alt="" className="size-3.5 rounded-[3px]" /> mergelight-ai
          <span className="ml-1 rounded-full bg-risk/15 px-1.5 text-risk">Risk</span>
        </p>
        <p className="mt-1 text-fg/90">user.profile could be null here.</p>
      </div>
      <div className="ml-auto max-w-[80%] rounded-xl rounded-tr-sm bg-lilac/15 px-3 py-2 text-fg/90 ring-1 ring-lilac/25">
        It's guarded by requireProfile() in every route.
      </div>
      <div className="flex items-center gap-2 self-start rounded-full bg-mint/10 px-3 py-1.5 text-[12px] text-mint ring-1 ring-mint/30">
        <Check className="size-3.5" /> Learned for this repo. Won't flag it again.
      </div>
    </div>
  );
}

function Checks() {
  return (
    <div className="flex flex-col gap-1.5 text-[12.5px]">
      {[
        ['review', 'Reviewed 12 files', true],
        ['triage', '1 bug, 2 collapsed', true],
        ['follow-up', 'Waits for your plan', false],
      ].map(([n, d, ok]) => (
        <p key={n as string} className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-2.5 py-1">
          {ok ? <span className="grid size-3.5 place-items-center rounded-full bg-mint text-ink"><Check className="size-2.5" /></span> : <span className="size-3.5 rounded-full border-2 border-faint/50" />}
          <span className="font-medium text-fg">{n as string}</span>
          <span className="truncate text-faint">{d as string}</span>
        </p>
      ))}
    </div>
  );
}

function Comment() {
  return (
    <div className="rounded-xl border border-line bg-white/[0.03] p-3 text-[12.5px]">
      <p className="flex items-center gap-1.5 text-[11px] text-faint">
        <img src="/logo.png" alt="" className="size-3.5 rounded-[3px]" /> mergelight-ai <span className="ml-auto italic">edited</span>
      </p>
      <p className="mt-1.5 font-medium text-fg">Safe to merge after 1 fix.</p>
      <p className="mt-1 flex gap-3 text-faint">
        <span className="text-mint">3 resolved</span>
        <span className="text-bug">1 open</span>
      </p>
    </div>
  );
}

function Rules() {
  return (
    <div className="flex flex-wrap gap-1.5 text-[12px]">
      {['Ignore style', 'Flag migrations', 'Skip generated', 'Tests first', 'No nitpicks', 'Small PRs'].map((r) => (
        <span key={r} className="rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-muted">{r}</span>
      ))}
    </div>
  );
}

function Private() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-mint/10 text-mint ring-1 ring-mint/30">
        <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6L12 3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      </div>
      <div className="space-y-0.5 text-[13px] leading-snug text-muted">
        <p>Code: <span className="text-fg">your CI</span></p>
        <p>Login: <span className="text-fg">your secrets</span></p>
        <p>Usage: <span className="text-fg">your plan</span></p>
      </div>
    </div>
  );
}

function Plans() {
  const bar = (label: string, icon: React.ReactNode, used: number, color: string) => (
    <div className="flex-1">
      <div className="flex items-center justify-between text-[13px]">
        <span className="flex items-center gap-2 font-medium text-fg">{icon}{label}</span>
        <span className="font-mono text-[12px] text-faint">{used}% used</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full" style={{ width: `${used}%`, background: color }} />
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      {bar(
        'Claude Max',
        <svg viewBox="0 0 24 24" className="size-4" fill="#D97757" aria-hidden="true"><path d={siClaude.path} /></svg>,
        92,
        'linear-gradient(90deg,#f9a28c,#ff6b7a)',
      )}
      {bar(
        'ChatGPT Pro',
        <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true"><path d={OPENAI_PATH} fillRule="evenodd" /></svg>,
        38,
        'linear-gradient(90deg,#3fe8b8,#b89cff)',
      )}
    </div>
  );
}

function Agent() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-[#0a0912] px-3 py-2.5 font-mono text-[12px] leading-5 [&>p]:truncate">
      <p><span className="text-mint">get_findings</span> <span className="text-faint">returned 1 bug, 2 hardening</span></p>
      <p><span className="text-lilac">fix</span> <span className="text-muted">cart.ts:54, tests pass</span></p>
      <p><span className="text-lilac">reply</span> <span className="text-muted">decline 2 hardening, reason given</span></p>
      <p><span className="text-mint">resolve</span> <span className="text-faint">all threads closed</span></p>
    </div>
  );
}

const items: MagicBentoItem[] = [
  {
    label: 'Memory',
    title: 'Learns from every reply',
    description: 'Decline a finding with a reason and Mergelight remembers it for the whole repo. No more "reviewed, ignore" comments in your code.',
    visual: <Thread />,
    colSpan: 2,
    rowSpan: 2,
  },
  { label: 'Status', title: 'Live checks', description: 'A reason on every state. Your agent can watch them too.', visual: <Checks /> },
  { label: 'Comments', title: 'One comment', description: 'Updated in place, never a wall of notifications.', visual: <Comment /> },
  { label: 'Rules', title: 'Rules for every repo', description: 'Set them once for the whole org.', visual: <Rules /> },
  { label: 'Privacy', title: 'Private by design', description: 'Your code and your login stay in your CI.', visual: <Private /> },
  {
    label: 'Plans',
    title: 'Uses both of your plans',
    description: 'When one subscription nears its limit, the next review runs on the other.',
    visual: <Plans />,
    colSpan: 2,
  },
  {
    label: 'Agents',
    title: 'Your agent closes the loop',
    description: 'Over MCP, your agent fixes the real findings and replies to the rest.',
    visual: <Agent />,
    colSpan: 2,
  },
];

export default function Features() {
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setSmall(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return (
    <section id="features" className="relative border-t border-line/70 py-28 sm:py-36">
      <Container>
        <SectionHead
          eyebrow="Built for teams that ship"
          title="Everything a good reviewer does."
          lead="And nothing that slows you down. These come with the hosted app."
        />
        <div className="mt-14">
          <MagicBento items={items} columns={4} minCellWidth={258} rowHeight={small ? 268 : 250} textAutoHide={false} gap={14} radius={22} glowColor="#b89cff" clickEffect enableTilt={false} enableMagnetism={false} />
        </div>
      </Container>
    </section>
  );
}
