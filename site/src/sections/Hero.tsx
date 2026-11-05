import LightRays from '../components/reactbits/LightRays';
import ShinyText from '../components/reactbits/ShinyText';
import BlurText from '../components/reactbits/BlurText';
import RotatingText from '../components/reactbits/RotatingText';
import StarBorder from '../components/reactbits/StarBorder';
import Magnet from '../components/reactbits/Magnet';
import { EARLY, GITHUB } from '../links';
import { GitHubIcon } from '../ui';

export default function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden pb-20 pt-28 sm:pt-36 lg:flex lg:min-h-[94svh] lg:items-center lg:pb-28">
      <div className="absolute inset-0 -z-10">
        <LightRays
          raysOrigin="top-center"
          raysColor="#cbb9ff"
          raysSpeed={0.8}
          lightSpread={0.9}
          rayLength={1.8}
          fadeDistance={1.1}
          followMouse
          mouseInfluence={0.08}
          noiseAmount={0}
          distortion={0.04}
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-28 bg-gradient-to-b from-ink/85 to-transparent" />
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_75%_65%,rgb(63_232_184/0.09),transparent)]" />

      <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <a
            href={GITHUB}
            className="inline-flex items-center gap-2.5 rounded-full border border-line bg-white/[0.03] px-3.5 py-1.5 text-sm backdrop-blur transition-colors hover:border-white/20"
          >
            <span className="size-1.5 rounded-full bg-mint shadow-[0_0_10px_2px_rgb(63_232_184/0.55)]" />
            <ShinyText text="Open source. Launching soon." color="#a3a0b8" shineColor="#ffffff" speed={3} />
          </a>

          <BlurText
            as="h1"
            text="AI code review on the plan you already pay for."
            animateBy="words"
            direction="top"
            delay={80}
            className="mt-7 text-[2.65rem] font-semibold leading-[1.04] tracking-[-0.04em] text-fg sm:text-6xl lg:text-[4.4rem]"
          />

          <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted sm:text-xl">
            Mergelight reviews every pull request with your own{' '}
            <span className="inline-grid align-bottom">
              <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-medium">ChatGPT</span>
              <RotatingText
                texts={['Claude', 'ChatGPT']}
                rotationInterval={2600}
                effect="blur"
                mainClassName="col-start-1 row-start-1 font-medium text-fg"
                staggerDuration={0.02}
              />
            </span>{' '}
            subscription. No per-review bill, no per-file overage. Just reviews that know when to stop.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Magnet padding={50} magnetStrength={5}>
              <StarBorder as="a" href={EARLY} color="#3fe8b8" radius={999} backgroundColor="#0e0c18" textColor="#eceaf4">
                Get early access
              </StarBorder>
            </Magnet>
            <a
              href={GITHUB}
              className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-3 text-[15px] font-medium text-fg/90 transition-colors hover:border-white/25 hover:bg-white/[0.04]"
            >
              <GitHubIcon /> Star on GitHub
            </a>
          </div>

          <p className="mt-8 text-sm text-faint">Runs in your own CI. We never see your Claude or ChatGPT login.</p>
        </div>

        <div className="relative mx-auto w-full max-w-[300px] sm:max-w-[360px] lg:ml-auto lg:max-w-[420px]">
          <div className="absolute -inset-16 -z-10 rounded-full bg-[radial-gradient(circle,rgb(184_156_255/0.22),rgb(63_232_184/0.08)_45%,transparent_70%)] blur-2xl" />
          <img
            src="/logo-animated.svg"
            alt="The Mergelight logo: two strokes merge into an M, and a green light switches on below the merge point"
            width={420}
            height={420}
            className="w-full rounded-[22.37%] shadow-[0_40px_120px_-30px_rgb(184_156_255/0.5)] ring-1 ring-white/10"
          />
        </div>
      </div>
    </section>
  );
}
