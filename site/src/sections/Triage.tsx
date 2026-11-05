import BorderGlow from '../components/reactbits/BorderGlow';
import TriageFlow from './TriageFlow';
import LoopChart from './LoopChart';
import { Container, SectionHead } from '../ui';

const rules = ['Later rounds only check the fixes', 'Severity only goes down', 'Scope alarm when a PR balloons'];

const card = 'rounded-[24px] border border-line bg-[#0d0b18]/75 p-6 backdrop-blur-xl sm:p-8';

export default function Triage() {
  return (
    <section id="triage" className="relative py-28 sm:py-36">
      <Container>
        <SectionHead
          eyebrow="Reviews that know when to stop"
          title="Every finding says whether it's worth fixing."
          lead="Most AI reviewers are built to find more. Mergelight weighs each finding, posts what matters and drops the rest."
        />

        <TriageFlow />

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className={card}>
            <h3 className="text-xl font-semibold tracking-tight sm:text-2xl">Breaks the review loop.</h3>
            <p className="mt-3 leading-relaxed text-muted">
              A reviewer flags something unlikely, the fix adds locks, the next round flags the locks. Mergelight converges instead.
            </p>
            <div className="mt-6">
              <LoopChart />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
              <span className="flex items-center gap-2"><span className="h-0.5 w-5 rounded-full bg-gradient-to-r from-faint to-bug" /> Typical AI review</span>
              <span className="flex items-center gap-2"><span className="h-0.5 w-5 rounded-full bg-mint" /> Mergelight</span>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              {rules.map((r) => (
                <span key={r} className="rounded-full border border-line bg-white/[0.03] px-3 py-1.5 text-[13px] text-muted">{r}</span>
              ))}
            </div>
          </div>

          <div className={card}>
            <h3 className="text-xl font-semibold tracking-tight sm:text-2xl">Every note comes with a verdict.</h3>
            <p className="mt-3 leading-relaxed text-muted">
              How it would actually happen, what breaks, and what the fix costs. Then a straight answer on whether to bother.
            </p>
            <BorderGlow
              backgroundColor="#110e1d"
              borderRadius={18}
              glowColor="258 90 80"
              colors={['#b89cff', '#f59ee6', '#3fe8b8']}
              className="mt-6 w-full"
            >
              <div className="p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2.5">
                    <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] rounded-md" />
                    <span className="font-medium text-fg">mergelight-ai</span>
                    <span className="rounded-full border border-line px-1.5 py-px text-[11px] text-faint">bot</span>
                  </div>
                  <span className="flex items-center gap-1.5 rounded-full bg-lilac/12 px-2.5 py-1 text-xs text-lilac ring-1 ring-lilac/25">
                    <span className="size-1.5 rounded-full bg-lilac" /> Hardening
                  </span>
                </div>
                <p className="mt-5 font-semibold tracking-tight">Two admins could save the same workout at once</p>
                <p className="mt-0.5 font-mono text-xs text-faint">save.ts:42</p>
                <dl className="mt-5 space-y-3.5 text-[14px]">
                  {[
                    ['How it would happen', 'Two admins save the same workout within the same 50 ms.'],
                    ['What breaks', 'The second save fails with a clear error. No data is lost.'],
                    ['What the fix costs', 'Row locks across 4 files and a migration.'],
                  ].map(([t, d]) => (
                    <div key={t} className="grid gap-0.5 sm:grid-cols-[150px_1fr] sm:gap-4">
                      <dt className="text-faint">{t}</dt>
                      <dd className="text-fg/90">{d}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-5 rounded-xl border border-mint/25 bg-mint/[0.07] px-4 py-3">
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-mint">Verdict</p>
                  <p className="mt-1 font-medium text-fg">The fix is bigger than the problem. Leave it.</p>
                </div>
              </div>
            </BorderGlow>
          </div>
        </div>
      </Container>
    </section>
  );
}
