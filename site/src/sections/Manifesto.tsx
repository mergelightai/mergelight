import ScrollReveal from '../components/reactbits/ScrollReveal';
import GradientText from '../components/reactbits/GradientText';
import StarBorder from '../components/reactbits/StarBorder';
import { EARLY, GITHUB } from '../links';
import { Container, GitHubIcon } from '../ui';

export default function Manifesto() {
  return (
    <section className="relative overflow-hidden border-t border-line/70 py-32 sm:py-44">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[70%] bg-[radial-gradient(50%_60%_at_50%_100%,rgb(184_156_255/0.12),transparent)]" />
      <Container className="text-center">
        <ScrollReveal
          baseOpacity={0.12}
          enableBlur
          blurStrength={6}
          baseRotation={2}
          containerClassName="mx-auto max-w-4xl text-4xl font-semibold leading-[1.12] tracking-[-0.035em] text-fg sm:text-6xl"
        >
          Not every edge case deserves a table lock.
        </ScrollReveal>
        <p className="mx-auto mt-8 max-w-xl text-xl leading-relaxed text-muted">
          Mergelight is the code reviewer that{' '}
          <GradientText colors={['#b89cff', '#f59ee6', '#f9a28c', '#3fe8b8', '#b89cff']} animationSpeed={6} className="font-medium">
            knows when to stop.
          </GradientText>
        </p>
        <div className="mt-12 flex flex-wrap items-center justify-center gap-4">
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
      </Container>
    </section>
  );
}
