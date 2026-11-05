import ScrollReveal from '../components/reactbits/ScrollReveal';
import GradientText from '../components/reactbits/GradientText';
import StarBorder from '../components/reactbits/StarBorder';
import DitherVeil from '../components/reactbits/DitherVeil';
import { EARLY, GITHUB } from '../links';
import { Container, GitHubIcon } from '../ui';

export default function Manifesto() {
  return (
    <section className="relative overflow-hidden border-t border-line/70 py-28 sm:py-36">
      <Container className="grid items-center gap-14 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <ScrollReveal
            baseOpacity={0.12}
            enableBlur
            blurStrength={6}
            baseRotation={2}
            containerClassName="max-w-2xl text-4xl font-semibold leading-[1.12] tracking-[-0.035em] text-fg sm:text-6xl"
          >
            Not every edge case deserves a table lock.
          </ScrollReveal>
          <p className="mt-6 max-w-xl text-xl leading-relaxed text-muted">
            Mergelight is the code reviewer that{' '}
            <GradientText colors={['#b89cff', '#f59ee6', '#f9a28c', '#3fe8b8', '#b89cff']} animationSpeed={6} className="font-medium">
              knows when to stop.
            </GradientText>
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <StarBorder as="a" href={EARLY} color="#3fe8b8" radius={999} backgroundColor="#0e0c18" textColor="#eceaf4">
              Get early access
            </StarBorder>
            <a
              href={GITHUB}
              className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-3 text-[15px] font-medium text-fg/90 transition-colors hover:border-white/25 hover:bg-white/[0.04]"
            >
              <GitHubIcon /> Star on GitHub
            </a>
          </div>
        </div>

        <figure className="mx-auto w-full max-w-[460px]">
          <div className="aspect-square overflow-hidden rounded-[22.37%] ring-1 ring-white/10 shadow-[0_40px_100px_-40px_rgb(0_0_0/0.8)]">
            <DitherVeil
              src="/dither-logo.png"
              fit="cover"
              pattern="floyd"
              pixelSize={3}
              inkColor="#0a0913"
              paperColor="#b89cff"
              contrast={1.25}
              brightness={0.04}
              revealRadius={120}
              softness={0.7}
              linger={1.2}
              rim={0.16}
              rimColor="#3fe8b8"
              wander
            />
          </div>
          <figcaption className="mt-4 text-center text-sm text-faint">Move your cursor over it. Light makes the difference.</figcaption>
        </figure>
      </Container>
    </section>
  );
}
