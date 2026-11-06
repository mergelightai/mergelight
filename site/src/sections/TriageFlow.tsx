import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { SURFACE, WELL } from '../ui';

type Kind = 'bug' | 'risk' | 'hardening' | 'noise';

const VERDICT: Record<Kind, { label: string; tone: string }> = {
  bug: { label: 'Bug', tone: 'text-bug' },
  risk: { label: 'Risk', tone: 'text-risk' },
  hardening: { label: 'Hardening', tone: 'text-lilac/80' },
  noise: { label: 'Nitpick', tone: 'text-faint' },
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

const N = FINDINGS.length;
const ease = [0.16, 1, 0.3, 1] as const;
const BUGS = FINDINGS.filter((f) => f.kind === 'bug');
const RISKS = FINDINGS.filter((f) => f.kind === 'risk');
const SEGMENT: Record<Kind, string> = { bug: 'bg-bug', risk: 'bg-risk', hardening: 'bg-lilac/70', noise: 'bg-white/25' };

/** Placeholder lines that turn into the real text, so the comment keeps its shape while it is written. */
function Slot({ landed, children, bars = ['78%', '5.5rem'] }: { landed: boolean; children: React.ReactNode; bars?: string[] }) {
  return (
    <div className="grid">
      <motion.div aria-hidden="true" className="col-start-1 row-start-1 pt-[5px]" animate={{ opacity: landed ? 0 : 1 }} transition={{ duration: 0.25 }}>
        <div className="h-[11px] rounded-full bg-white/[0.07]" style={{ width: bars[0] }} />
        {bars[1] && <div className="mt-[9px] h-[9px] rounded-full bg-white/[0.045]" style={{ width: bars[1] }} />}
      </motion.div>
      <motion.div
        className="col-start-1 row-start-1"
        initial={false}
        animate={{ opacity: landed ? 1 : 0, y: landed ? 0 : 4, filter: landed ? 'blur(0px)' : 'blur(3px)' }}
        transition={{ duration: 0.45, ease }}
      >
        {children}
      </motion.div>
    </div>
  );
}

function Finding({ text, file }: { text: string; file: string }) {
  return (
    <>
      <p className="text-[14.5px] leading-snug text-fg">{text}</p>
      <p className="mt-0.5 font-mono text-[11.5px] text-faint">{file}</p>
    </>
  );
}

function Num({ value }: { value: number }) {
  return (
    <span className="relative inline-flex overflow-hidden tabular-nums">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={value} initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '-100%' }} transition={{ duration: 0.3, ease }}>
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
    const t = setTimeout(() => setStep(done ? 0 : step + 1), done ? 5000 : 900);
    return () => clearTimeout(t);
  }, [inView, step, reduce]);

  const seen = FINDINGS.slice(0, step);
  const bugs = seen.filter((f) => f.kind === 'bug');
  const risks = seen.filter((f) => f.kind === 'risk');
  const hardening = seen.filter((f) => f.kind === 'hardening').length;
  const noise = seen.filter((f) => f.kind === 'noise').length;
  const done = step >= N;

  return (
    <div ref={ref} className={`mt-14 overflow-hidden ${SURFACE}`}>
      <div className="grid lg:grid-cols-2">
        {/* What a typical reviewer posts */}
        <div className="p-6 sm:p-8">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="text-[15px] font-medium text-muted">A typical AI reviewer</h3>
            <p className="text-sm text-faint">
              <span className="tabular-nums text-fg">{N}</span> comments
            </p>
          </div>

          <ol className="mt-5 space-y-2">
            {FINDINGS.map((f, i) => {
              const weighed = i < step;
              const current = i === step && !done;
              const dropped = weighed && (f.kind === 'noise' || f.kind === 'hardening');
              const v = VERDICT[f.kind];
              return (
                <li
                  key={f.file}
                  className={`flex items-center gap-4 rounded-xl px-4 py-2.5 transition-[background-color,box-shadow] duration-300 ${
                    current
                      ? 'bg-white/[0.06] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16)]'
                      : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]'
                  }`}
                >
                  <div className={`min-w-0 flex-1 transition-opacity duration-500 ${dropped ? 'opacity-40' : ''}`}>
                    <p className="text-[14.5px] leading-snug text-fg/90">{f.text}</p>
                    <p className="mt-0.5 font-mono text-[11.5px] text-faint">{f.file}</p>
                  </div>
                  <span className="w-20 shrink-0 text-right text-[13px] font-medium">
                    <AnimatePresence>
                      {weighed && (
                        <motion.span key="v" initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className={v.tone}>
                          {v.label}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {/* What Mergelight posts: one PR comment */}
        <div className="flex flex-col border-t border-line p-6 sm:p-8 lg:border-l lg:border-t-0">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="text-[15px] font-medium text-fg">Mergelight</h3>
            <p className="text-sm text-faint">
              <span className="tabular-nums text-mint">1</span> comment
            </p>
          </div>

          {/* One segment per finding, coloured by its verdict once weighed */}
          <div className="mt-5" aria-live="polite">
            <div className="flex gap-1">
              {FINDINGS.map((f, i) => (
                <div key={f.file} className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
                  <motion.div
                    className={`h-full origin-left rounded-full ${SEGMENT[f.kind]}`}
                    initial={false}
                    animate={{ scaleX: i < step ? 1 : 0 }}
                    transition={{ duration: 0.4, ease }}
                  />
                </div>
              ))}
            </div>
            <p className="mt-2.5 flex justify-between text-[13px] text-faint">
              <span>{done ? 'All 8 weighed' : `Weighing ${Math.min(step + 1, N)} of ${N}`}</span>
              <span className="tabular-nums">{bugs.length + risks.length} kept, {hardening + noise} held back</span>
            </p>
          </div>

          <article className={`mt-5 flex flex-1 flex-col overflow-hidden ${WELL}`}>
            <header className="flex items-center gap-2.5 border-b border-line bg-white/[0.02] px-5 py-3 text-sm">
              <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] rounded-md" />
              <span className="font-medium text-fg">mergelight-ai</span>
              <span className="rounded-full border border-line px-1.5 py-px text-[11px] text-faint">bot</span>
              <span className="ml-auto text-[13px] text-faint">{done ? 'just now' : 'writing'}</span>
            </header>

            <div className="flex flex-1 flex-col px-5 pt-5 pb-4">
              <Slot landed={done} bars={['64%']}>
                <p className="text-[15px] font-medium text-fg">
                  Fix 2 bugs, then it's <span className="text-mint">safe to merge</span>.
                </p>
              </Slot>

              <h4 className="mt-6 text-[13px] font-medium text-muted">Fix before merging</h4>
              <div className="mt-2.5 space-y-3 border-l-2 pl-4 transition-colors duration-500" style={{ borderColor: bugs.length ? 'rgb(255 107 122 / 0.6)' : 'rgb(255 255 255 / 0.08)' }}>
                {BUGS.map((f) => (
                  <Slot key={f.file} landed={bugs.includes(f)}>
                    <Finding {...f} />
                  </Slot>
                ))}
              </div>

              <h4 className="mt-6 text-[13px] font-medium text-muted">Your call</h4>
              <div className="mt-2.5 border-l-2 pl-4 transition-colors duration-500" style={{ borderColor: risks.length ? 'rgb(245 196 81 / 0.6)' : 'rgb(255 255 255 / 0.08)' }}>
                {RISKS.map((f) => (
                  <Slot key={f.file} landed={risks.includes(f)} bars={['84%', '6rem']}>
                    <Finding {...f} />
                  </Slot>
                ))}
              </div>

              <div className="mt-auto pt-6">
                <div className="flex items-center gap-2 rounded-xl bg-white/[0.035] px-3 py-2.5 text-[14px] text-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
                  <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={1.8} className="text-faint" />
                  <span>
                    <Num value={hardening} /> hardening {hardening === 1 ? 'note' : 'notes'}
                  </span>
                  <span className="ml-auto text-[13px] text-faint">folded</span>
                </div>
                <p className="mt-2.5 px-3 text-[13px] text-faint">
                  <Num value={noise} /> {noise === 1 ? 'nitpick' : 'nitpicks'} not posted
                </p>
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}
