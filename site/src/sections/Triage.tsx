import TriageFlow from './TriageFlow';
import LoopChart from './LoopChart';
import { Container, SectionHead, SURFACE, WELL } from '../ui';

const rules = ['Later rounds only check the fixes', 'Severity only goes down', 'Scope alarm when a PR balloons'];

const card = `${SURFACE} p-6 sm:p-8`;

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
                <span key={r} className="rounded-full bg-white/[0.035] px-3 py-1.5 text-[13px] text-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]">{r}</span>
              ))}
            </div>
          </div>

          <div className={card}>
            <h3 className="text-xl font-semibold tracking-tight sm:text-2xl">Every note comes with a verdict.</h3>
            <p className="mt-3 leading-relaxed text-muted">
              How it would actually happen, what breaks, and what the fix costs. Then a straight answer on whether to bother.
            </p>
            <article className={`mt-6 overflow-hidden ${WELL}`}>
              <header className="flex items-center gap-2.5 border-b border-line bg-white/[0.02] px-5 py-3 text-sm">
                <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] rounded-md" />
                <span className="font-medium text-fg">mergelight-ai</span>
                <span className="rounded-full border border-line px-1.5 py-px text-[11px] text-faint">bot</span>
                <span className="ml-auto text-[13px] font-medium text-lilac/80">Hardening</span>
              </header>
              <div className="p-5 sm:p-6">
                <p className="font-semibold tracking-tight">Two admins could save the same workout at once</p>
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
                <div className="mt-6 border-l-2 border-mint/60 pl-4">
                  <p className="text-[13px] font-medium text-muted">Verdict</p>
                  <p className="mt-1 font-medium text-fg">
                    The fix is bigger than the problem. <span className="text-mint">Leave it.</span>
                  </p>
                </div>
              </div>
            </article>
          </div>
        </div>
      </Container>
    </section>
  );
}
