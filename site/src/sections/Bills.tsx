import { useRef, type ReactNode } from 'react';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { siCoderabbit, siGithubcopilot } from 'simple-icons';
import {
  ACTIONS_ESTIMATE,
  CODERABBIT_BILL,
  CODERABBIT_PRS,
  CODERABBIT_SEATS,
  COPILOT_BILL,
  COPILOT_LIST,
  COPILOT_PRS,
  DEVELOPERS,
  MERGELIGHT_BILL,
  MERGELIGHT_PER_DEV,
  REVIEW_BILLS,
} from '../bills';
import { BrandIcon, Container, Ticker, usd } from '../ui';

type Line = [label: string, amount: string];

/** A receipt that prints down out of a slot once it scrolls into view. */
function Receipt({
  icon,
  name,
  lines,
  totalLabel,
  total,
  cents = false,
  delay,
  winner = false,
}: {
  icon: ReactNode;
  name: string;
  lines: Line[];
  totalLabel: string;
  total: number;
  cents?: boolean;
  delay: number;
  winner?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: '-12% 0px' });
  const reduce = useReducedMotion();

  return (
    <div ref={ref}>
      <div aria-hidden="true" className={`relative h-1.5 rounded-full ${winner ? 'bg-mint/40' : 'bg-white/10'}`} />
      <div className="-mt-0.5 overflow-hidden px-2">
        <motion.div
          initial={reduce ? false : { y: '-101%' }}
          animate={seen ? { y: 0 } : undefined}
          transition={{ duration: 1.05, delay, ease: [0.22, 1, 0.36, 1] }}
          className={`receipt-edge px-5 pb-9 pt-6 sm:px-6 ${winner ? 'bg-[linear-gradient(180deg,#123029_0%,#0f1d1c_100%)]' : 'bg-[linear-gradient(180deg,#1c1a23_0%,#15141a_100%)]'}`}
        >
          <p className="flex items-center gap-2 text-[15px] font-medium text-fg">
            {icon}
            {name}
          </p>

          <dl className="mt-6 space-y-2.5 font-mono text-[13px]">
            {lines.map(([label, amount]) => (
              <div key={label} className="flex items-baseline justify-between gap-4">
                <dt className="text-muted">{label}</dt>
                <dd className="tabular-nums text-fg/85">{amount}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-6 border-t border-dashed border-white/15 pt-5">
            <p className="text-[13px] text-muted">{totalLabel}</p>
            <p
              className={
                winner
                  ? 'mt-1 text-7xl font-semibold tracking-tighter text-mint sm:text-8xl'
                  : 'mt-1 text-[2.1rem] font-semibold leading-tight tracking-tight text-peach'
              }
            >
              <Ticker from={0} to={total} start={seen} cents={cents} delay={delay + 0.55} duration={1.6} />
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function Together() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: '-12% 0px' });

  return (
    <div ref={ref} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-2 sm:col-span-2">
      <p className="text-[15px] text-muted">
        Together, for {DEVELOPERS} developers, in 1 month
      </p>
      <p className="text-4xl font-semibold tracking-tight text-peach sm:text-5xl">
        <Ticker from={0} to={REVIEW_BILLS} start={seen} cents delay={0.8} duration={2} />
      </p>
    </div>
  );
}

export default function Bills() {
  return (
    <section id="bills" className="relative border-t border-line/70 py-24 sm:py-32">
      <Container>
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-[-0.03em] text-fg sm:text-[2.75rem] sm:leading-[1.08]">
            We got these bills. So we built Mergelight.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Copilot is listed at {usd(COPILOT_LIST)} a seat. It billed us {usd(COPILOT_BILL, true)}.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.15fr]">
          <Receipt
            icon={<BrandIcon icon={siCoderabbit} className="size-[18px]" />}
            name="CodeRabbit"
            lines={[
              ['2 seats', usd(CODERABBIT_SEATS, true)],
              ['Usage on top', usd(CODERABBIT_BILL - CODERABBIT_SEATS, true)],
              ['PRs reviewed', String(CODERABBIT_PRS)],
            ]}
            totalLabel="Billed"
            total={CODERABBIT_BILL}
            cents
            delay={0}
          />

          <Receipt
            icon={<BrandIcon icon={siGithubcopilot} color="#9b98b0" className="size-[18px]" />}
            name="GitHub Copilot"
            lines={[
              ['Listed price', usd(COPILOT_LIST, true)],
              ['Usage in AI credits', 'metered'],
              ['PRs reviewed', String(COPILOT_PRS)],
            ]}
            totalLabel="Billed"
            total={COPILOT_BILL}
            cents
            delay={0.3}
          />

          <Together />

          <div className="sm:col-span-2 lg:col-span-1 lg:col-start-3 lg:row-span-2 lg:row-start-1">
            <Receipt
              winner
              icon={<img src="/logo.png" alt="" className="size-[22px] rounded-[6px]" />}
              name="Mergelight"
              lines={[
                ['Per-file fees', '$0'],
                ['Per-review fees', '$0'],
                ['AI credits', '$0'],
                [`${DEVELOPERS} developers at ${usd(MERGELIGHT_PER_DEV)}`, usd(MERGELIGHT_BILL, true)],
              ]}
              totalLabel="Per month"
              total={MERGELIGHT_BILL}
              delay={0.6}
            />
            <p className="mt-4 px-2 text-[12.5px] leading-relaxed text-muted">
              Planned price. Also uses your own AI plan's allowance, and about {usd(ACTIONS_ESTIMATE)} of GitHub Actions minutes at this volume (our estimate).
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}
