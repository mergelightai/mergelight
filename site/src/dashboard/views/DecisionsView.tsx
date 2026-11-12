import { toast } from 'sonner';
import { SignedOut, type Decision } from '../api';
import { ViewHeader } from '../AppShell';
import { DataBody, DataCard, DataCell, DataHead, DataHeadCell, DataRow, DataTable, Filler, GroupRow, Initials } from '../DataTable';
import { ago, plural } from '../format';
import { Code, Confirm, EmptyList, Facts } from '../kit';

/** Which day a decision falls in, as the reference's activity list: "Today", then older groups. */
function day(iso: string): string {
  const then = new Date(iso);
  const today = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(today) - start(then)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Last 7 days';
  if (days < 31) return 'Last 30 days';
  return 'Earlier';
}

/**
 * What the team decided not to fix, as the reference's activity list: who did it, in one sentence,
 * grouped by day. Mergelight leaves these out of later reviews, and anyone who can push can take one back.
 */
export function DecisionsView({ decisions, total, onForget }: { decisions: Decision[]; total: number; onForget: (d: Decision) => Promise<void> }) {
  const groups: { label: string; list: Decision[] }[] = [];
  for (const d of [...decisions].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const label = day(d.created_at);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.list.push(d);
    else groups.push({ label, list: [d] });
  }
  return (
    <>
      <ViewHeader
        title="Decisions"
        lead="When someone declines a finding on a pull request and says why, Mergelight remembers it and leaves it out of later reviews of that file. A decision nobody needed for 90 days is dropped."
      />
      <div className="grid flex-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-stretch">
        <div className="flex min-w-0 flex-col gap-3">
          {decisions.length === 0 && total > 0 ? (
            <EmptyList title="More decisions are kept">You made Mergelight forget the ones shown here. Refresh the page, in the menu at the top right, to see the next ones.</EmptyList>
          ) : decisions.length === 0 ? (
            <EmptyList title="Nothing yet">Decline a finding with a reason on a pull request, and it shows up here after that pull request's next review.</EmptyList>
          ) : (
            <DataCard fill title="Decisions" count={total} meta={total > decisions.length ? `showing the ${decisions.length} most recent` : undefined}>
              <DataTable>
                <DataHead>
                  <DataHeadCell>Who decided what</DataHeadCell>
                  <DataHeadCell className="hidden lg:table-cell">Used since</DataHeadCell>
                  <DataHeadCell className="w-24" aria-label="Actions" />
                </DataHead>
                <DataBody>
                  {groups.map((g) => [
                    <GroupRow key={`g-${g.label}`} span={3} label={g.label} count={g.list.length} />,
                    ...g.list.map((d) => (
                      <DataRow key={d.id}>
                        <DataCell className="whitespace-normal">
                          <div className="flex gap-3">
                            <Initials name={d.by} />
                            <div className="min-w-0">
                              <p className="text-[14px] leading-relaxed text-ink-3">
                                <span className="font-medium text-ink">{d.by}</span> declined <span className="text-ink">{d.title}</span> in <span className="text-ink">{d.repo}</span>{' '}
                                <a href={`https://github.com/${d.repo}/pull/${d.pr}`} target="_blank" rel="noreferrer" className="text-ink hover:underline">
                                  #{d.pr}
                                </a>
                              </p>
                              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-4">
                                <span className="[overflow-wrap:anywhere]">
                                  <Code>
                                    {d.file}:{d.line}
                                  </Code>
                                </span>
                                <span>{ago(d.created_at)}</span>
                              </p>
                              <p className="mt-2.5 rounded-[8px] bg-shell px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-2 hairline">{d.reason}</p>
                              <p className="mt-2 text-[12.5px] text-ink-4 lg:hidden">{d.uses ? `Left out of ${plural(d.uses, 'review')} since, last ${ago(d.last_used_at)}.` : 'Not needed since.'}</p>
                            </div>
                          </div>
                        </DataCell>
                        <DataCell className="hidden align-top text-[13.5px] text-ink-3 lg:table-cell">
                          {d.uses ? (
                            <>
                              Left out of {plural(d.uses, 'review')} since, last {ago(d.last_used_at)}.
                            </>
                          ) : (
                            'Not needed since.'
                          )}
                        </DataCell>
                        <DataCell className="align-top text-right">
                          {d.can_forget && (
                            <Confirm
                              label="Forget"
                              title="Forget this decision?"
                              body="This can't be undone. A later review may raise this finding again."
                              confirm="Yes, forget"
                              busyLabel="Forgetting"
                              onConfirm={() =>
                                onForget(d).then(
                                  () => void toast.success('Decision forgotten'),
                                  (err: unknown) => {
                                    if (!(err instanceof SignedOut)) toast.error("That didn't work. Please try again.");
                                    throw err;
                                  },
                                )
                              }
                            />
                          )}
                        </DataCell>
                      </DataRow>
                    )),
                  ])}
                </DataBody>
              </DataTable>
              <Filler />
            </DataCard>
          )}
        </div>
        <Facts
          items={[
            'A decision nobody needed for 90 days is dropped.',
            'Anyone who can push to the repository can make Mergelight forget a decision. A later review may then raise the finding again.',
            "Stored for each decision: the finding's title, file and line, the reason, who gave it, and in which pull request. Never code.",
          ]}
        />
      </div>
    </>
  );
}
