import { useEffect, useRef, useState } from 'react';
import TextType from '../components/reactbits/TextType';
import SpotlightCard from '../components/reactbits/SpotlightCard';
import { Check, Container, SectionHead } from '../ui';

const COMMAND = 'npx mergelight init';

const output = [
  'Skill added for Claude Code',
  'Review rules added to AGENTS.md for Codex',
  'MCP server set up for Cursor and T3 Code',
];

const tools = [
  ['wait_for_review', 'Waits until the Mergelight check finishes, so your agent knows when to come back.'],
  ['get_findings', 'Returns the open findings as data, already sorted into bug, risk and hardening.'],
  ['reply', 'Accepts or declines a finding with a reason. Every reply teaches Mergelight.'],
  ['resolve', 'Closes the thread once the fix is pushed.'],
];

export default function Agent() {
  const [typed, setTyped] = useState(false);
  const term = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = term.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      t = setTimeout(() => setTyped(true), 400 + COMMAND.length * 60 + 350);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); if (t) clearTimeout(t); };
  }, []);
  return (
    <section id="agent" className="relative py-28 sm:py-36">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_40%_at_20%_50%,rgb(184_156_255/0.07),transparent)]" />
      <Container>
        <SectionHead
          eyebrow="Fixes happen where you work"
          title="Your agent fixes. Mergelight judges."
          lead="Mergelight never pushes code to your PR. It hands findings to the agent you already use, so every fix runs with your tests, your linter and your rules."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div ref={term} className="overflow-hidden rounded-2xl border border-line bg-[#0a0912] shadow-[0_30px_80px_-40px_rgb(0_0_0/0.8)]">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="ml-3 font-mono text-xs text-faint">~/your-repo</span>
            </div>
            <div className="min-h-[260px] p-5 font-mono text-[13.5px] leading-7 sm:p-6 sm:text-sm">
              <div className="flex gap-2">
                <span className="text-mint">$</span>
                <TextType
                  text={COMMAND}
                  typingSpeed={60}
                  initialDelay={400}
                  loop={false}
                  startOnVisible
                  showCursor={!typed}
                  cursorCharacter="▍"
                  cursorClassName="text-lilac"
                  className="text-fg"
                />
              </div>
              <div className={`mt-3 space-y-1 transition-opacity duration-700 ${typed ? 'opacity-100' : 'opacity-0'}`}>
                {output.map((line, i) => (
                  <p key={line} className="flex items-center gap-2 text-muted" style={{ transitionDelay: `${i * 120}ms` }}>
                    <Check className="size-4 text-mint" /> {line}
                  </p>
                ))}
                <p className="pt-3 text-faint">Your agent now waits for Mergelight after every push.</p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {tools.map(([name, desc]) => (
              <SpotlightCard key={name} spotlightColor="rgba(63, 232, 184, 0.14)" className="border border-line !bg-panel !p-6">
                <p className="font-mono text-sm text-lilac">{name}</p>
                <p className="mt-2.5 text-[15px] leading-relaxed text-muted">{desc}</p>
              </SpotlightCard>
            ))}
          </div>
        </div>

        <p className="mt-10 max-w-3xl text-lg leading-relaxed text-muted">
          The skill teaches your agent the routine: <span className="text-fg">fix the bugs, ask you about risks, decline hardening with a reason,</span> and never grow the PR beyond what it set out to do.
        </p>
      </Container>
    </section>
  );
}
