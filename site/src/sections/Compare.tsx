import { useRef, type ReactNode } from 'react';
import { motion, useInView } from 'motion/react';
import { siCoderabbit, siGithubcopilot } from 'simple-icons';
import BorderGlow from '../components/reactbits/BorderGlow';
import { ACTIONS_ESTIMATE, CODERABBIT_BILL, COPILOT_BILL, DEVELOPERS, MERGELIGHT_BILL, MERGELIGHT_PER_DEV, REVIEW_BILLS } from '../bills';
import { BrandIcon, Container, SectionHead, Ticker, usd } from '../ui';

const CODERABBIT = CODERABBIT_BILL / DEVELOPERS;
const COPILOT = COPILOT_BILL / DEVELOPERS;
// Rounded down to the nearest thousand: it counts the estimated Actions minutes against Mergelight.
const SAVED_A_YEAR = Math.floor(((REVIEW_BILLS - MERGELIGHT_BILL - ACTIONS_ESTIMATE) * 12) / 1000) * 1000;

function Rival({ icon, name, price, note }: { icon: ReactNode; name: string; price: ReactNode; note: string }) {
  return (
    <div className="flex h-full flex-col rounded-[20px] border border-line bg-panel/70 p-5 sm:p-7">
      <p className="flex items-center gap-2 text-[13.5px] font-medium text-muted sm:text-[14.5px]">
        {icon}
        {name}
      </p>
      <p className="mt-6 flex items-baseline gap-1.5 sm:mt-10">
        <span className="text-3xl font-semibold tracking-tight text-fg/75 sm:text-[2.6rem]">{price}</span>
        <span className="text-[13px] text-faint">/mo</span>
      </p>
      <p className="mt-2 text-[12.5px] leading-snug text-faint sm:text-[13px]">{note}</p>
    </div>
  );
}

export default function Compare() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: '-20% 0px' });

  return (
    <section id="compare" className="relative border-t border-line/70 py-28 sm:py-36">
      <Container>
        <SectionHead
          center
          eyebrow="Compare"
          title="You already pay for the AI. Don't pay for it twice."
          lead="Your plan costs the same either way. This is what code review adds on top."
        />

        <div ref={ref} className="mx-auto mt-12 max-w-5xl">
          <p className="text-center text-[13px] text-muted">Our own bills for 1 month, per developer</p>

          {/* Price cards: Mergelight in the middle, on top */}
          <div className="relative mt-10 grid grid-cols-2 items-stretch gap-3 sm:gap-4 md:grid-cols-[1fr_1.3fr_1fr] md:items-center">
            <div className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-72 w-[min(560px,90%)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-mint/15 blur-[90px]" />

            <div className="md:order-1">
              <Rival icon={<BrandIcon icon={siCoderabbit} className="size-[18px]" />} name="CodeRabbit" price={<Ticker from={30} to={CODERABBIT} start={seen} delay={0.5} />} note="real bill, per developer" />
            </div>

            <motion.div
              className="order-first col-span-2 md:order-2 md:col-span-1"
              initial={{ opacity: 0, y: 18, scale: 0.97 }}
              animate={seen ? { opacity: 1, y: 0, scale: 1 } : undefined}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            >
              <BorderGlow
                backgroundColor="#0f1418"
                borderRadius={24}
                glowColor="160 80 60"
                colors={['#3fe8b8', '#b89cff', '#3fe8b8']}
                animated
                className="w-full"
              >
                <div className="flex flex-col items-center px-6 py-9 text-center sm:py-12">
                  <p className="flex items-center gap-2.5 text-[15px] font-medium text-fg">
                    <img src="/logo.png" alt="" className="size-6 rounded-[6px]" />
                    Mergelight
                  </p>
                  <p className="mt-6 flex items-baseline gap-2">
                    <span className="bg-gradient-to-b from-[#b6fbe6] to-mint bg-clip-text text-7xl font-semibold tracking-tighter text-transparent drop-shadow-[0_0_30px_rgb(63_232_184/0.45)] sm:text-8xl">
                      {usd(MERGELIGHT_PER_DEV)}
                    </span>
                    <span className="text-muted">/mo</span>
                  </p>
                  <p className="mt-3 text-[15px] text-fg/90">Every review included</p>
                  <span className="mt-5 rounded-full bg-mint/15 px-3 py-1 text-[12px] font-medium text-mint ring-1 ring-mint/30">Best value</span>
                </div>
              </BorderGlow>
            </motion.div>

            <div className="md:order-3">
              <Rival
                icon={<BrandIcon icon={siGithubcopilot} color="#9b98b0" className="size-[18px]" />}
                name="Copilot"
                price={<Ticker from={19} to={COPILOT} start={seen} delay={0.5} />}
                note="listed at $19 a seat"
              />
            </div>
          </div>

          {/* Savings */}
          <div className="mt-12 text-center">
            <p className="text-5xl font-semibold tracking-tight text-fg sm:text-6xl">
              <span className="text-mint">
                <Ticker from={0} to={SAVED_A_YEAR} start={seen} delay={1.1} duration={2} />
              </span>
            </p>
            <p className="mt-2 text-[15px] text-muted">about what {DEVELOPERS} developers save in a year, after GitHub Actions minutes</p>
          </div>
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-center text-[11.5px] leading-relaxed text-faint">
          Our own bills for 1 month: CodeRabbit {usd(CODERABBIT_BILL, true)} and GitHub Copilot usage {usd(COPILOT_BILL, true)}, for {DEVELOPERS} developers. The yearly saving counts about {usd(ACTIONS_ESTIMATE)} a month of GitHub Actions
          minutes, which is our estimate. Mergelight pricing is planned, and reviews use your plan's allowance. See the{' '}
          <a className="underline decoration-white/20 underline-offset-2 hover:text-muted" href="https://www.coderabbit.ai/pricing">CodeRabbit</a> and{' '}
          <a className="underline decoration-white/20 underline-offset-2 hover:text-muted" href="https://docs.github.com/en/copilot/concepts/agents/code-review">Copilot</a> pricing.
        </p>
      </Container>
    </section>
  );
}
