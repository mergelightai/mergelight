import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Check, Container, SectionHead } from '../ui';

const LOOP = 13500;
const FINAL = 12000;
const PHASE = { s1: 0, b1: 2600, s2: 3400, lock: 4700, badge: 4950, b2: 5400, s3: 6200, reviewed: 8600, triage: 8800, queued: 9300, posted: 9800 };

const YAML: [string, string][] = [
  ['on', ' pull_request'],
  ['jobs', ''],
  ['  review', ''],
  ['    runs-on', ' ubuntu-latest'],
  ['    steps', ''],
  ['      - uses', ' mergelightai/review@v1'],
  ['        with', ''],
  ['          provider', ' claude'],
];

const STEPS = [
  { n: '1', title: 'Add one workflow file', desc: 'It runs the official Claude Code or Codex CLI, unmodified, in your own runner.' },
  { n: '2', title: 'Use your own login', desc: 'Your login stays in your repo secrets. Mergelight never sees it.' },
  { n: '3', title: 'Open a pull request', desc: 'Live checks show every step. Then one summary comment, updated in place.' },
];

function useClock(active: boolean, reduce: boolean | null) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (reduce) {
      setT(FINAL);
      return;
    }
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastPaint = 0;
    const tick = (now: number) => {
      acc = (acc + (now - last)) % LOOP;
      last = now;
      if (now - lastPaint > 33) {
        lastPaint = now;
        setT(acc);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, reduce]);
  return t;
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function Card({ active, children, label }: { active: boolean; children: React.ReactNode; label: string }) {
  return (
    <div
      className={`relative h-[236px] overflow-hidden rounded-2xl border bg-[#0b0a14] transition-all duration-500 ${
        active ? 'border-mint/40 shadow-[0_0_0_1px_rgb(63_232_184/0.15),0_20px_60px_-20px_rgb(63_232_184/0.35)]' : 'border-line'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/15" />
        <span className="ml-2 truncate font-mono text-[11px] text-faint">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Lock({ closed }: { closed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.8" fill="currentColor" />
      <motion.path
        d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        animate={{ y: closed ? 0 : -1.6 }}
        transition={{ type: 'spring', stiffness: 400, damping: 18 }}
      />
    </svg>
  );
}

export default function How() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const reduce = useReducedMotion();
  const t = useClock(inView, reduce);

  const active = t < PHASE.s2 ? 0 : t < PHASE.s3 ? 1 : 2;
  const beam = t < PHASE.b1 ? 0 : t < PHASE.s2 ? clamp((t - PHASE.b1) / (PHASE.s2 - PHASE.b1)) : t < PHASE.b2 ? 1 : t < PHASE.s3 ? 1 + clamp((t - PHASE.b2) / (PHASE.s3 - PHASE.b2)) : 2;
  const lines = clamp(Math.floor(t / 240) + 1, 1, YAML.length);
  const dots = clamp(Math.floor((t - PHASE.s2) / 90), 0, 14);
  const locked = t >= PHASE.lock;
  const files = t < PHASE.s3 ? 0 : clamp(Math.floor((t - PHASE.s3) / 200) + 1, 1, 12);
  const reviewed = t >= PHASE.reviewed;

  return (
    <section id="how" className="relative border-t border-line/70 py-28 sm:py-36">
      <Container>
        <SectionHead
          eyebrow="How it works"
          title="No new bill. Your plan does the work."
          lead="Reviews run in your own CI on the Claude or ChatGPT subscription you already have. You never pay per review or per file."
        />

        <div ref={ref} className="relative mt-16">
          {/* Beam track (desktop) */}
          <div aria-hidden="true" className="absolute inset-x-[16.6%] top-5 hidden h-px bg-white/10 md:block">
            <div className="h-full bg-gradient-to-r from-mint/0 via-mint/70 to-mint" style={{ width: `${(beam / 2) * 100}%` }} />
            <div
              className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-mint shadow-[0_0_14px_4px_rgb(63_232_184/0.6)]"
              style={{ left: `${(beam / 2) * 100}%`, opacity: t > FINAL - 100 && !reduce ? 0 : 1 }}
            />
          </div>

          <div className="grid gap-10 md:grid-cols-3 md:gap-6">
            {STEPS.map((s, i) => (
              <div key={s.n} className={`transition-opacity duration-500 ${active === i || reduce ? 'opacity-100' : 'md:opacity-60'}`}>
                <div className="flex items-center gap-3 md:flex-col md:items-center md:text-center">
                  <span
                    className={`relative z-10 grid size-10 shrink-0 place-items-center rounded-full border font-mono text-sm transition-colors duration-500 ${
                      active >= i ? 'border-mint/50 bg-[#0d1a17] text-mint' : 'border-line bg-ink text-faint'
                    }`}
                  >
                    {active > i ? <Check className="size-4" /> : s.n}
                  </span>
                  <h3 className="text-lg font-semibold tracking-tight md:mt-4">{s.title}</h3>
                </div>
                <p className="mt-2 text-[15px] leading-relaxed text-muted md:mx-auto md:min-h-[52px] md:max-w-[300px] md:text-center">{s.desc}</p>

                <div className="mt-6">
                  {i === 0 && (
                    <Card active={active === 0} label=".github/workflows/review.yml">
                      <div className="font-mono text-[12.5px] leading-[22px]">
                        {YAML.map(([k, v], li) => (
                          <motion.p
                            key={li}
                            className="whitespace-pre"
                            animate={{ opacity: li < lines ? 1 : 0, x: li < lines ? 0 : -6 }}
                            transition={{ duration: 0.25 }}
                          >
                            <span className="text-lilac">{k}</span>
                            <span className="text-faint">:</span>
                            <span className={v.includes('mergelight') ? 'text-mint' : 'text-peach'}>{v}</span>
                          </motion.p>
                        ))}
                      </div>
                    </Card>
                  )}

                  {i === 1 && (
                    <Card active={active === 1} label="Settings / Secrets and variables / Actions">
                      <p className="text-xs font-medium text-faint">Repository secrets</p>
                      <div
                        className={`mt-3 flex items-center gap-3 rounded-xl border px-3 py-3 transition-colors duration-500 ${
                          locked ? 'border-mint/35 bg-mint/[0.06]' : 'border-line bg-white/[0.02]'
                        }`}
                      >
                        <span className={locked ? 'text-mint' : 'text-faint'}>
                          <Lock closed={locked} />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[12px] text-fg">CLAUDE_CODE_OAUTH_TOKEN</p>
                          <p className="h-4 font-mono text-[12px] tracking-[0.15em] text-muted">{'•'.repeat(dots)}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-3 opacity-60">
                        <span className="text-faint"><Lock closed /></span>
                        <p className="truncate text-[12.5px] text-muted">Codex login <span className="text-faint">(optional)</span></p>
                      </div>
                      <AnimatePresence>
                        {t >= PHASE.badge && (
                          <motion.p
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="mt-3 flex items-center gap-2 text-[13px] text-mint"
                          >
                            <Check className="size-4" /> Stays in your repo. Never sent to Mergelight.
                          </motion.p>
                        )}
                      </AnimatePresence>
                    </Card>
                  )}

                  {i === 2 && (
                    <Card active={active === 2} label="Pull request #482 / Checks">
                      <ul className="space-y-2.5 text-[13.5px]">
                        <li className="flex items-center gap-3">
                          {reviewed ? (
                            <span className="grid size-4 shrink-0 place-items-center rounded-full bg-mint text-ink"><Check className="size-3" /></span>
                          ) : (
                            <span className={`size-4 shrink-0 rounded-full border-2 ${files ? 'animate-spin border-risk/30 border-t-risk' : 'border-faint/40'}`} />
                          )}
                          <span className="font-medium text-fg">review</span>
                          <span className="truncate text-muted">{reviewed ? 'Reviewed 12 files' : files ? `Reviewing ${files} of 12 files` : 'Waiting for the PR'}</span>
                        </li>
                        <motion.li className="flex items-center gap-3" animate={{ opacity: t >= PHASE.triage ? 1 : 0.25 }}>
                          <span className={`grid size-4 shrink-0 place-items-center rounded-full ${t >= PHASE.triage ? 'bg-mint text-ink' : 'border-2 border-faint/40'}`}>
                            {t >= PHASE.triage && <Check className="size-3" />}
                          </span>
                          <span className="font-medium text-fg">triage</span>
                          <span className="truncate text-muted">{t >= PHASE.triage ? '1 bug, 1 risk, 2 collapsed' : 'Queued'}</span>
                        </motion.li>
                        <motion.li className="flex items-center gap-3" animate={{ opacity: t >= PHASE.queued ? 1 : 0.25 }}>
                          <span className="size-4 shrink-0 rounded-full border-2 border-faint/50" />
                          <span className="font-medium text-fg">follow-up</span>
                          <span className="truncate text-muted">Waits for your plan, never skipped</span>
                        </motion.li>
                      </ul>
                      <AnimatePresence>
                        {t >= PHASE.posted && (
                          <motion.div
                            initial={{ opacity: 0, y: 8, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0 }}
                            className="mt-4 flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5"
                          >
                            <img src="/logo.png" alt="" width={18} height={18} className="size-[18px] rounded" />
                            <span className="text-[13px] text-fg">Summary comment updated</span>
                            <span className="ml-auto rounded-full bg-bug/15 px-2 py-0.5 text-[11px] text-bug">1 bug</span>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </Card>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
