import Scanner from '../components/reactbits/Scanner';
import DitherVeil from '../components/reactbits/DitherVeil';
import ShinyText from '../components/reactbits/ShinyText';
import BlurText from '../components/reactbits/BlurText';
import RotatingText from '../components/reactbits/RotatingText';
import StarBorder from '../components/reactbits/StarBorder';
import Magnet from '../components/reactbits/Magnet';
import { EARLY, GITHUB } from '../links';
import { REVIEW_BILLS } from '../bills';
import { GitHubIcon, usd } from '../ui';

export default function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden pb-20 pt-28 sm:pt-36 lg:flex lg:min-h-[94svh] lg:items-center lg:pb-28">
      <div className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,transparent,black_18%,black_70%,transparent)]">
        <Scanner
          color1="#5b47b8"
          color2="#3fe8b8"
          color3="#eafff8"
          scanDirection="diagonal"
          speed={0.35}
          sweepSpeed={0.12}
          sweepWidth={2}
          trail={0.55}
          scale={1.6}
          bandDensity={9}
          lineWidth={1.1}
          glow={0.55}
          colorSpread={0.5}
          brightness={0.9}
          vignette={0.35}
          scanline={false}
          grain={false}
          mouseStrength={0.6}
          clickEffect="none"
        />
      </div>
      {/* Keep the headline side calm: the scanner fades out behind the text on wide screens. */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgb(10_9_19/0.88)_0%,rgb(10_9_19/0.55)_38%,transparent_65%)] max-lg:bg-[linear-gradient(180deg,rgb(10_9_19/0.6),rgb(10_9_19/0.75))]" />

      <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <a
            href={GITHUB}
            className="inline-flex items-center gap-2.5 rounded-full border border-line bg-white/[0.03] px-3.5 py-1.5 text-sm backdrop-blur transition-colors hover:border-white/20"
          >
            <span className="size-1.5 rounded-full bg-mint shadow-[0_0_10px_2px_rgb(63_232_184/0.55)]" />
            <ShinyText text="Source available. Launching soon." color="#a3a0b8" shineColor="#ffffff" speed={3} />
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

          <a href="#bills" className="mt-5 inline-block text-[15px] text-muted underline decoration-white/20 underline-offset-4 transition-colors hover:text-fg">
            Our AI review bill last month: <span className="font-medium text-peach">{usd(REVIEW_BILLS, true)}</span>. 2 developers.
          </a>

          <div className="mt-8 flex flex-wrap items-center gap-4">
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

        <div className="relative mx-auto w-full max-w-[320px] sm:max-w-[400px] lg:ml-auto lg:max-w-[500px]">
          {/* The canvas is opaque, so a radial mask fades its square edges into the scanner behind. */}
          <div
            role="img"
            aria-label="The Mergelight logo drawn in dithered dots. Moving the cursor over it reveals it in full colour."
            className="aspect-square [mask-image:radial-gradient(closest-side,black_72%,transparent)]"
          >
            <DitherVeil
              src="/dither-mark.png"
              pattern="floyd"
              pixelSize={2}
              inkColor="#0a0913"
              paperColor="#d8ccff"
              revealRadius={200}
              softness={0.6}
              linger={1}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
