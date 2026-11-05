import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

type Kind = 'bug' | 'risk' | 'hardening' | 'noise';

const KIND: Record<Kind, { label: string; dot: string; chip: string }> = {
  bug: { label: 'Bug', dot: 'bg-bug', chip: 'bg-bug/15 text-bug ring-bug/30' },
  risk: { label: 'Risk', dot: 'bg-risk', chip: 'bg-risk/15 text-risk ring-risk/30' },
  hardening: { label: 'Hardening', dot: 'bg-lilac', chip: 'bg-lilac/12 text-lilac ring-lilac/25' },
  noise: { label: 'Nitpick', dot: 'bg-faint', chip: 'bg-white/5 text-faint ring-white/10' },
};

const FINDINGS: { file: string; text: string; kind: Kind }[] = [
  { file: 'cart.ts:54', text: 'Discount is applied twice when the cart reloads', kind: 'bug' },
  { file: 'utils.ts:9', text: 'Prefer const over let here', kind: 'noise' },
  { file: 'save.ts:42', text: 'Two admins could save the same workout at once', kind: 'hardening' },
  { file: 'billing.ts:17', text: 'A retry can charge twice if the webhook times out', kind: 'risk' },
  { file: 'Header.tsx:31', text: 'Rename data to something more descriptive', kind: 'noise' },
  { file: 'admin.ts:120', text: 'Validate input on this internal-only endpoint', kind: 'hardening' },
  { file: 'auth.ts:88', text: 'Login crashes for SSO users with no email', kind: 'bug' },
  { file: 'List.tsx:12', text: 'Consider memoizing this component', kind: 'noise' },
];

const ROW = 64;
const N = FINDINGS.length;

function Count({ value }: { value: number }) {
  return (
    <span className="relative inline-flex h-6 min-w-6 items-center justify-center overflow-hidden rounded-full bg-white/[0.07] px-2 font-mono text-xs text-fg">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={value} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} transition={{ duration: 0.25 }}>
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export default function TriageFlow() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduce) {
      setStep(N);
      return;
    }
    if (!inView) return;
    const done = step >= N;
    const t = setTimeout(() => setStep(done ? 0 : step + 1), done ? 4500 : step === 0 ? 900 : 950);
    return () => clearTimeout(t);
  }, [inView, step, reduce]);

  const seen = FINDINGS.slice(0, step);
  const bugs = seen.filter((f) => f.kind === 'bug');
  const risks = seen.filter((f) => f.kind === 'risk');
  const hardening = seen.filter((f) => f.kind === 'hardening').length;
  const noise = seen.filter((f) => f.kind === 'noise').length;
  const done = step >= N;

  return (
    <div ref={ref} className="relative mt-14 rounded-[28px] bg-gradient-to-br from-white/15 via-white/[0.04] to-mint/25 p-px shadow-[0_40px_100px_-40px_rgb(0_0_0/0.7)]">
      <div className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-[27px] bg-[#0d0b18]/90 backdrop-blur-xl lg:grid-cols-[minmax(0,1.08fr)_auto_minmax(0,0.92fr)]">
        {/* Raw findings */}
        <div className="p-5 sm:p-7">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted">What a typical AI reviewer posts</p>
            <span className="rounded-full bg-white/[0.06] px-2.5 py-1 font-mono text-xs text-muted">{N} comments</span>
          </div>
          <div className="relative mt-5">
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-0 rounded-xl border border-mint/40 bg-gradient-to-r from-mint/[0.14] via-mint/[0.05] to-transparent shadow-[0_0_30px_-4px_rgb(63_232_184/0.45)]"
              style={{ height: ROW - 6 }}
              animate={{ y: Math.min(step, N - 1) * ROW + 3, opacity: done || step === 0 ? 0 : 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 30 }}
            />
            <ul className="relative z-10">
              {FINDINGS.map((f, i) => {
                const processed = i < step;
                const k = KIND[f.kind];
                return (
                  <li key={f.file} className="flex items-center gap-3 px-3" style={{ height: ROW }}>
                    <motion.div
                      className="min-w-0 flex-1"
                      animate={{ opacity: processed ? (f.kind === 'noise' ? 0.35 : f.kind === 'hardening' ? 0.6 : 1) : 0.85 }}
                    >
                      <p className="font-mono text-[11px] text-faint">{f.file}</p>
                      <p className={`truncate text-[14.5px] text-fg/90 ${processed && f.kind === 'noise' ? 'line-through decoration-faint' : ''}`}>{f.text}</p>
                    </motion.div>
                    <div className="w-[92px] shrink-0 text-right">
                      <AnimatePresence>
                        {processed && (
                          <motion.span
                            initial={{ scale: 0.6, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${k.chip}`}
                          >
                            <span className={`size-1.5 rounded-full ${k.dot}`} />
                            {k.label}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        {/* Connector */}
        <div className="relative hidden w-20 items-center justify-center lg:flex">
          <div className="absolute inset-y-8 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-white/15 to-transparent" />
          <div className="relative grid size-12 place-items-center rounded-2xl bg-[#0d0b18] ring-1 ring-white/10 shadow-[0_0_40px_-6px_rgb(63_232_184/0.5)]">
            <img src="/logo.png" alt="" width={32} height={32} className="size-8 rounded-lg" />
          </div>
        </div>

        {/* Mergelight summary */}
        <div className="border-t border-line bg-white/[0.02] p-5 sm:p-7 lg:border-l lg:border-t-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] rounded-md" />
              <p className="text-sm font-medium text-fg">What Mergelight posts</p>
            </div>
            <span className="rounded-full bg-mint/10 px-2.5 py-1 font-mono text-xs text-mint">1 comment</span>
          </div>

          <div className="mt-6 space-y-5">
            <div>
              <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-bug">
                <span className="size-1.5 rounded-full bg-bug" /> Blocks the merge
              </p>
              <ul className="mt-2.5 min-h-[88px] space-y-2">
                <AnimatePresence initial={false}>
                  {bugs.map((f) => (
                    <motion.li
                      key={f.file}
                      layout
                      initial={{ opacity: 0, x: -16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="rounded-xl border border-bug/25 bg-bug/[0.07] px-3.5 py-2.5"
                    >
                      <p className="text-[14px] text-fg">{f.text}</p>
                      <p className="font-mono text-[11px] text-faint">{f.file}</p>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>

            <div>
              <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-risk">
                <span className="size-1.5 rounded-full bg-risk" /> Needs your call
              </p>
              <ul className="mt-2.5 min-h-[44px]">
                <AnimatePresence initial={false}>
                  {risks.map((f) => (
                    <motion.li
                      key={f.file}
                      initial={{ opacity: 0, x: -16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="rounded-xl border border-risk/25 bg-risk/[0.07] px-3.5 py-2.5"
                    >
                      <p className="text-[14px] text-fg">{f.text}</p>
                      <p className="font-mono text-[11px] text-faint">{f.file}</p>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>

            <div className="space-y-2.5 border-t border-line pt-5 text-[14px]">
              <p className="flex items-center justify-between text-muted">
                <span className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-lilac" /> Hardening notes, collapsed</span>
                <Count value={hardening} />
              </p>
              <p className="flex items-center justify-between text-muted">
                <span className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-faint" /> Nitpicks, never posted</span>
                <Count value={noise} />
              </p>
            </div>

            <div className="relative h-11">
              <AnimatePresence mode="wait">
                {done ? (
                  <motion.p
                    key="done"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex h-11 items-center gap-2.5 rounded-xl bg-mint/10 px-3.5 text-[14px] font-medium text-mint ring-1 ring-mint/30"
                  >
                    <span className="size-2 rounded-full bg-mint shadow-[0_0_10px_2px_rgb(63_232_184/0.6)]" />
                    Fix 2 bugs, then it's safe to merge.
                  </motion.p>
                ) : (
                  <motion.p key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex h-11 items-center gap-2.5 px-1 text-[14px] text-faint">
                    <span className="size-3.5 animate-spin rounded-full border-2 border-mint/25 border-t-mint" />
                    Weighing finding {Math.min(step + 1, N)} of {N}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
