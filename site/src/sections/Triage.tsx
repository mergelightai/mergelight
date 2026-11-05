import SpotlightCard from '../components/reactbits/SpotlightCard';
import BorderGlow from '../components/reactbits/BorderGlow';
import { Container, SectionHead } from '../ui';

const kinds = [
  {
    name: 'Bug',
    dot: 'bg-bug shadow-[0_0_12px_2px_rgb(255_107_122/0.55)]',
    spot: 'rgba(255, 107, 122, 0.18)',
    meaning: 'Breaks for real users in normal use.',
    action: 'Must fix. Blocks the merge.',
  },
  {
    name: 'Risk',
    dot: 'bg-risk shadow-[0_0_12px_2px_rgb(245_196_81/0.5)]',
    spot: 'rgba(245, 196, 81, 0.16)',
    meaning: 'Plausible, but it needs specific conditions to happen.',
    action: 'A human decides.',
  },
  {
    name: 'Hardening',
    dot: 'bg-faint',
    spot: 'rgba(184, 156, 255, 0.16)',
    meaning: 'A theoretical edge case, or extra safety nobody asked for.',
    action: 'Left alone by default, collapsed.',
  },
];

const rounds = [
  ['Later rounds stay focused', 'They only check whether earlier findings were fixed, and whether a fix added a real bug.'],
  ['Severity only goes down', 'A fix for a hardening note can never come back as a new blocker.'],
  ['Scope alarm', 'If review fixes grow a 1 file PR into 20 files, Mergelight tells you the first version was safer.'],
];

export default function Triage() {
  return (
    <section id="triage" className="py-28 sm:py-36">
      <Container>
        <SectionHead
          eyebrow="Reviews that know when to stop"
          title="Every finding says whether it's worth fixing."
          lead="Most AI reviewers are built to find more. Mergelight weighs how a problem would actually happen against what the fix costs, so a 40 line change stays a 40 line change."
        />

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {kinds.map((k) => (
            <SpotlightCard key={k.name} spotlightColor={k.spot} className="border border-line !bg-panel">
              <div className="flex items-center gap-3">
                <span className={`size-2.5 rounded-full ${k.dot}`} />
                <h3 className="text-lg font-semibold tracking-tight">{k.name}</h3>
              </div>
              <p className="mt-5 text-[15px] leading-relaxed text-muted">{k.meaning}</p>
              <p className="mt-6 border-t border-line pt-5 text-[15px] font-medium text-fg">{k.action}</p>
            </SpotlightCard>
          ))}
        </div>
        <p className="mt-6 text-sm text-faint">Style nits and matters of taste are never posted at all.</p>

        <div className="mt-24 grid items-center gap-14 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <h3 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">Breaks the review loop.</h3>
            <p className="mt-4 text-lg leading-relaxed text-muted">
              The usual loop: a reviewer flags an unlikely edge case, the fix adds table locks, the next round flags the locks. Mergelight is built to converge instead.
            </p>
            <ul className="mt-8 space-y-6">
              {rounds.map(([t, d]) => (
                <li key={t} className="flex gap-4">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-mint" />
                  <div>
                    <p className="font-medium text-fg">{t}</p>
                    <p className="mt-1 leading-relaxed text-muted">{d}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <BorderGlow
            backgroundColor="#0e0c18"
            borderRadius={20}
            glowColor="258 90 80"
            colors={['#b89cff', '#f59ee6', '#3fe8b8']}
            className="w-full"
          >
            <div className="p-6 sm:p-7">
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2.5">
                  <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] rounded-md" />
                  <span className="font-medium text-fg">mergelight-ai</span>
                  <span className="rounded-full border border-line px-1.5 py-px text-[11px] text-faint">bot</span>
                  <span className="hidden text-faint sm:inline">reviewed just now</span>
                </div>
                <span className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-muted">
                  <span className="size-1.5 rounded-full bg-faint" /> Hardening
                </span>
              </div>
              <p className="mt-6 text-lg font-semibold tracking-tight">Two admins saving the same workout at once</p>
              <p className="mt-1 font-mono text-xs text-faint">api/workouts/save.ts:42</p>
              <dl className="mt-6 space-y-4 text-[15px]">
                {[
                  ['How it would happen', 'Two admins save the same workout within the same 50 ms.'],
                  ['What breaks', 'The second save fails with a clear error. No data is lost.'],
                  ['What the fix costs', 'Row locks across 4 files and a migration.'],
                ].map(([t, d]) => (
                  <div key={t} className="grid gap-1 sm:grid-cols-[170px_1fr] sm:gap-4">
                    <dt className="text-faint">{t}</dt>
                    <dd className="text-fg/90">{d}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-7 rounded-xl border border-mint/25 bg-mint/[0.07] px-4 py-3.5">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-mint">Verdict</p>
                <p className="mt-1.5 font-medium text-fg">The fix is bigger than the problem. Leave it.</p>
              </div>
            </div>
          </BorderGlow>
        </div>
      </Container>
    </section>
  );
}
