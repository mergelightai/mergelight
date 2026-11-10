import CountUp from '../components/reactbits/CountUp';
import PixelCard from '../components/reactbits/PixelCard';
import { EARLY, GITHUB } from '../links';
import { Check, Container, GitHubIcon, SectionHead } from '../ui';

const self = ['GitHub Action and CLI', 'Runs on your Claude or ChatGPT plan', 'Bug, risk and hardening triage', 'MCP server and agent skill'];
const hosted = [
  'Everything in self-host',
  'GitHub App with its own reviewer bot',
  'Live, branded checks on every PR',
  'Review memory that learns from your replies',
  'Org-wide rules and a team dashboard',
];

function List({ items }: { items: string[] }) {
  return (
    <ul className="mt-8 space-y-3.5 text-[15px]">
      {items.map((i) => (
        <li key={i} className="flex items-start gap-3 text-muted">
          <Check className="mt-0.5 size-4 shrink-0 text-mint" />
          {i}
        </li>
      ))}
    </ul>
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
          title="Free to self-host. $9 if you'd rather not."
          lead="Either way, reviews run on your own subscription, so there's never a per-review or per-file bill."
        />

        <div className="mx-auto mt-14 grid max-w-4xl gap-6 md:grid-cols-2">
          <PixelCard
            colors={['#2e2850', '#41387c', '#6a5bb5']}
            gap={7}
            speed={30}
            origin="pointer"
            glowColor="#b89cff"
            glow={0.15}
            opacity={0.42}
            radius={20}
            noFocus
            className="flex h-full w-full flex-col p-8"
          >
            <p className="text-lg font-semibold">Self-host</p>
            <p className="mt-1 text-sm text-muted">The source-available engine</p>
            <p className="mt-7 flex items-baseline gap-2">
              <span className="text-5xl font-semibold tracking-tight">$0</span>
              <span className="text-muted">forever</span>
            </p>
            <List items={self} />
            <div className="mt-auto pt-10">
              <a
                href={GITHUB}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-line px-5 py-3 text-[15px] font-medium transition-colors hover:border-white/25 hover:bg-white/[0.04]"
              >
                <GitHubIcon /> Star on GitHub
              </a>
            </div>
          </PixelCard>

          <PixelCard
            colors={['#134236', '#1d6a56', '#2a9a7a']}
            gap={7}
            speed={30}
            origin="pointer"
            glowColor="#3fe8b8"
            glow={0.18}
            opacity={0.42}
            radius={20}
            noFocus
            className="h-full w-full shadow-[0_30px_80px_-40px_rgb(63_232_184/0.45)] ring-1 ring-mint/30"
          >
            <div className="flex h-full flex-col p-8">
              <div className="flex items-center justify-between">
                <p className="text-lg font-semibold">Hosted</p>
                <span className="rounded-full bg-mint/10 px-2.5 py-1 text-xs font-medium text-mint">Free for public repos</span>
              </div>
              <p className="mt-1 text-sm text-muted">We run the app, you keep your plan</p>
              <p className="mt-7 flex items-baseline gap-2">
                <span className="text-5xl font-semibold tracking-tight">
                  $<CountUp to={9} from={0} duration={1.4} />
                </span>
                <span className="text-muted">per developer / month</span>
              </p>
              <List items={hosted} />
              <a
                href={EARLY}
                className="mt-10 inline-flex items-center justify-center rounded-full bg-fg px-5 py-3 text-[15px] font-medium text-ink transition-colors hover:bg-white"
              >
                Get early access
              </a>
            </div>
          </PixelCard>
        </div>
      </Container>
    </section>
  );
}
