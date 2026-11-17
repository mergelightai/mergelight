import type { ReactNode } from 'react';
import CountUp from '../components/reactbits/CountUp';
import PixelCard from '../components/reactbits/PixelCard';
import { LIGHT_PER_DEV, PRO_PER_DEV } from '../bills';
import { EARLY, GITHUB } from '../links';
import { Check, Container, GitHubIcon, SectionHead } from '../ui';

type Item = { text: string; soon?: boolean };

const free: Item[] = [
  { text: 'GitHub Action, CLI and reviewer bot' },
  { text: 'Runs on your Claude or ChatGPT plan' },
  { text: 'Bug, risk and hardening triage' },
  { text: 'Two AIs: one reviews, the other checks' },
  { text: 'MCP server and agent skill' },
];
const light: Item[] = [
  { text: 'Everything in Free' },
  { text: 'Review memory that learns what your team won’t fix' },
  { text: 'Team rules, also org-wide' },
  { text: 'Skills and team checks in plain words' },
  { text: 'Team dashboard' },
];
const pro: Item[] = [
  { text: 'Everything in Light' },
  { text: 'Jobs: your own AI tasks on every PR' },
  { text: 'Cross-repo review', soon: true },
  { text: 'Slack digest', soon: true },
  { text: 'Linear and Jira ticket checks', soon: true },
];

function List({ items }: { items: Item[] }) {
  return (
    <ul className="mt-8 space-y-3.5 text-[15px]">
      {items.map(({ text, soon }) => (
        <li key={text} className="flex items-start gap-3 text-muted">
          <Check className={`mt-0.5 size-4 shrink-0 ${soon ? 'text-faint' : 'text-mint'}`} />
          <span>
            {text}
            {soon && <span className="ml-2 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-faint">Soon</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const outline =
  'inline-flex w-full items-center justify-center gap-2 rounded-full border border-line px-5 py-3 text-[15px] font-medium transition-colors hover:border-white/25 hover:bg-white/[0.04]';
const filled =
  'inline-flex w-full items-center justify-center rounded-full bg-fg px-5 py-3 text-[15px] font-medium text-ink transition-colors hover:bg-white';

function Plan({
  name,
  tagline,
  price,
  unit,
  badge,
  items,
  cta,
  featured = false,
  colors,
  glowColor,
}: {
  name: string;
  tagline: string;
  price: ReactNode;
  unit: string;
  badge?: string;
  items: Item[];
  cta: ReactNode;
  featured?: boolean;
  colors: string[];
  glowColor: string;
}) {
  return (
    <PixelCard
      colors={colors}
      gap={7}
      speed={30}
      origin="pointer"
      glowColor={glowColor}
      glow={featured ? 0.18 : 0.15}
      opacity={0.42}
      radius={20}
      noFocus
      className={`h-full w-full ${featured ? 'shadow-[0_30px_80px_-40px_rgb(63_232_184/0.45)] ring-1 ring-mint/30' : ''}`}
    >
      <div className="flex h-full flex-col p-8">
        <div className="flex items-center justify-between gap-3">
          <p className="text-lg font-semibold">{name}</p>
          {badge && <span className="rounded-full bg-mint/10 px-2.5 py-1 text-xs font-medium text-mint">{badge}</span>}
        </div>
        <p className="mt-1 text-sm text-muted">{tagline}</p>
        <p className="mt-7 flex items-baseline gap-2">
          <span className="text-5xl font-semibold tracking-tight">{price}</span>
          <span className="text-muted">{unit}</span>
        </p>
        <List items={items} />
        <div className="mt-auto pt-10">{cta}</div>
      </div>
    </PixelCard>
  );
}

export default function Pricing() {
  return (
    <section id="pricing" className="relative border-t border-line/70 py-28 sm:py-36">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(45%_45%_at_70%_60%,rgb(63_232_184/0.06),transparent)]" />
      <Container>
        <SectionHead
          center
          eyebrow="Planned pricing"
          title={`Reviews are free. Teams from $${LIGHT_PER_DEV}.`}
          lead="Every plan runs on your own Claude or ChatGPT subscription, so there's never a per-review or per-file bill."
        />

        <div className="mx-auto mt-14 grid max-w-md gap-6 lg:max-w-6xl lg:grid-cols-3">
          <Plan
            name="Free"
            tagline="The source-available engine"
            price="$0"
            unit="forever"
            items={free}
            colors={['#1f2a30', '#2c3a42', '#46565f']}
            glowColor="#c9d4da"
            cta={
              <a href={GITHUB} className={outline}>
                <GitHubIcon /> Star on GitHub
              </a>
            }
          />
          <Plan
            name="Light"
            tagline="For teams that want it to learn"
            price={
              <>
                $<CountUp to={LIGHT_PER_DEV} from={0} duration={1.4} />
              </>
            }
            unit="per developer / month"
            badge="Free for public repos"
            items={light}
            featured
            colors={['#134236', '#1d6a56', '#2a9a7a']}
            glowColor="#3fe8b8"
            cta={
              <a href={EARLY} className={filled}>
                Get early access
              </a>
            }
          />
          <Plan
            name="Pro"
            tagline="For teams that hand it more work"
            price={
              <>
                $<CountUp to={PRO_PER_DEV} from={0} duration={1.4} />
              </>
            }
            unit="per developer / month"
            items={pro}
            colors={['#2e2850', '#41387c', '#6a5bb5']}
            glowColor="#b89cff"
            cta={
              <a href={EARLY} className={outline}>
                Get early access
              </a>
            }
          />
        </div>
      </Container>
    </section>
  );
}
