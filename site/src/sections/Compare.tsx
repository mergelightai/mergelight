import { useEffect, useRef, type ReactNode } from 'react';
import { animate, motion, useInView, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { siClaude, siCoderabbit, siGithubcopilot, type SimpleIcon } from 'simple-icons';
import BorderGlow from '../components/reactbits/BorderGlow';
import { Container, SectionHead } from '../ui';
import { OPENAI_PATH } from '../brandIcons';

// Public list prices, checked 2026-11-05 on each vendor's pricing page.
const PLAN = 200; // Claude Ultra or ChatGPT Pro
const PER_DAY = 10; // pull requests per working day, close to the invoiced team's 11
const REVIEWS = PER_DAY * 20 * 2; // a first review and one re-review after fixes
const COPILOT = Math.max(19, REVIEWS * 1.5); // $19 Business seat, GitHub's ~$1.50 per default review
const CODERABBIT = 30; // Essentials, month to month
const MERGELIGHT = 9;

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/** A dollar amount that counts from `from` to `to` once `start` is true. */
function Ticker({ from, to, start, delay = 0, duration = 2.2 }: { from: number; to: number; start: boolean; delay?: number; duration?: number }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? to : from);
  const text = useTransform(mv, usd);
  useEffect(() => {
    if (reduce) {
      mv.set(to);
      return;
    }
    if (!start) return;
    const c = animate(mv, to, { duration, delay, ease: [0.45, 0, 0.2, 1] });
    return () => c.stop();
  }, [start, to, delay, duration, reduce, mv]);
  return <motion.span className="tabular-nums">{text}</motion.span>;
}

function BrandIcon({ icon, color, className = 'size-5' }: { icon: SimpleIcon; color?: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill={color ?? `#${icon.hex}`}>
      <path d={icon.path} />
    </svg>
  );
}

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
          {/* The example */}
          <div className="flex flex-wrap justify-center gap-2 text-[13px] text-muted">
            <span className="flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1">
              <BrandIcon icon={siClaude} className="size-3.5" />
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 text-fg" fill="currentColor">
                <path d={OPENAI_PATH} fillRule="evenodd" />
              </svg>
              One developer on a ${PLAN} plan
            </span>
            <span className="rounded-full border border-line bg-panel px-3 py-1">{PER_DAY} pull requests a day</span>
            <span className="rounded-full border border-line bg-panel px-3 py-1">{REVIEWS} reviews a month</span>
          </div>

          {/* Price cards: Mergelight in the middle, on top */}
          <div className="relative mt-10 grid grid-cols-2 items-stretch gap-3 sm:gap-4 md:grid-cols-[1fr_1.3fr_1fr] md:items-center">
            <div className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-72 w-[min(560px,90%)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-mint/15 blur-[90px]" />

            <div className="md:order-1">
              <Rival icon={<BrandIcon icon={siCoderabbit} className="size-[18px]" />} name="CodeRabbit" price={usd(CODERABBIT)} note="plus overage past 5 reviews an hour" />
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
                      {usd(MERGELIGHT)}
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
                note="$1.50 a review adds up"
              />
            </div>
          </div>

          {/* Savings */}
          <div className="mt-12 text-center">
            <p className="text-5xl font-semibold tracking-tight text-fg sm:text-6xl">
              <span className="text-mint">
                <Ticker from={0} to={(COPILOT - MERGELIGHT) * 12} start={seen} delay={1.1} duration={2} />
              </span>
            </p>
            <p className="mt-2 text-[15px] text-muted">saved a year, per developer, compared with Copilot</p>
          </div>

          {/* Real invoice */}
          <div className="mx-auto mt-14 flex max-w-3xl flex-col items-center justify-between gap-5 rounded-[20px] border border-line bg-panel/70 px-6 py-5 sm:flex-row sm:px-8">
            <div className="text-center sm:text-left">
              <p className="text-[15px] font-medium text-fg">A real CodeRabbit bill</p>
              <p className="mt-0.5 text-[13px] text-faint">2 developers, 1 month, 870 reviews</p>
            </div>
            <div className="flex items-center gap-6">
              <p className="text-center">
                <span className="block text-3xl font-semibold tracking-tight text-peach">$443</span>
                <span className="text-[12px] text-faint">CodeRabbit</span>
              </p>
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
              <p className="text-center">
                <span className="block text-3xl font-semibold tracking-tight text-mint">$18</span>
                <span className="text-[12px] text-faint">Mergelight</span>
              </p>
            </div>
          </div>
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-center text-[11.5px] leading-relaxed text-faint">
          List prices checked November 5, 2026 (
          <a className="underline decoration-white/20 underline-offset-2 hover:text-muted" href="https://www.coderabbit.ai/pricing">CodeRabbit</a>,{' '}
          <a className="underline decoration-white/20 underline-offset-2 hover:text-muted" href="https://docs.github.com/en/copilot/concepts/agents/code-review">Copilot</a>,{' '}
          <a className="underline decoration-white/20 underline-offset-2 hover:text-muted" href="https://claude.com/pricing">Claude</a>,{' '}
          <a className="underline decoration-white/20 underline-offset-2 hover:text-muted" href="https://learn.chatgpt.com/docs/pricing">ChatGPT</a>
          ). Copilot is Business at GitHub's estimate of $1.50 per review, without Actions minutes. CodeRabbit is Essentials without overage. Mergelight
          pricing is planned, and reviews use your plan's allowance.
        </p>
      </Container>
    </section>
  );
}
