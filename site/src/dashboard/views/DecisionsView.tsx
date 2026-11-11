import { toast } from 'sonner';
import { SignedOut, type Decision } from '../api';
import { ViewHeader } from '../AppShell';
import { DataBody, DataCell, DataHead, DataHeadCell, DataRow, DataTable } from '../DataTable';
import { ago, plural } from '../format';
import { Confirm, EmptyList, Facts } from '../kit';

/** What the team decided not to fix. Mergelight leaves these out of later reviews, and anyone who can push can take one back. */
export function DecisionsView({ decisions, total, onForget }: { decisions: Decision[]; total: number; onForget: (d: Decision) => Promise<void> }) {
  return (
    <>
      <ViewHeader
        eyebrow="Reviewer"
        title="Decisions"
        lead="When someone declines a finding on a pull request and says why, Mergelight remembers it and leaves it out of later reviews of that file. A decision nobody needed for 90 days is dropped."
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-3">
          {total > decisions.length && (
            <p className="text-[13px] text-muted-foreground">
              Showing the {decisions.length} most recent of {total}.
            </p>
          )}
          {decisions.length === 0 ? (
            <EmptyList title="Nothing yet">Decline a finding with a reason on a pull request, and it shows up here after that pull request's next review.</EmptyList>
          ) : (
            <DataTable>
              <DataHead>
                <DataHeadCell>Finding</DataHeadCell>
                <DataHeadCell className="hidden lg:table-cell">Used</DataHeadCell>
                <DataHeadCell className="w-24" aria-label="Actions" />
              </DataHead>
              <DataBody>
                {decisions.map((d) => (
                  <DataRow key={d.id}>
                    <DataCell className="whitespace-normal">
                      <p className="font-medium text-foreground">{d.title}</p>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {d.repo} · {d.file}:{d.line}
                      </p>
                      <p className="mt-3 rounded-2xl bg-white/[0.04] px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                        <span className="font-medium text-foreground">{d.by}:</span> {d.reason}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Declined in{' '}
                        <a href={`https://github.com/${d.repo}/pull/${d.pr}`} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
                          #{d.pr}
                        </a>
                        , {ago(d.created_at)}.<span className="lg:hidden"> {d.uses ? `Left out of ${plural(d.uses, 'review')} since, last ${ago(d.last_used_at)}.` : 'Not needed since.'}</span>
                      </p>
                    </DataCell>
                    <DataCell className="hidden align-top text-sm text-muted-foreground lg:table-cell">
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
                ))}
              </DataBody>
            </DataTable>
          )}
        </div>
        <Facts
          items={[
            'A decision nobody needed for 90 days is dropped.',
            'Anyone who can push to the repository can make Mergelight forget a decision. A later review may then raise the finding again.',
            'Stored for each decision: the finding\'s title, file and line, the reason, who gave it, and in which pull request. Never code.',
          ]}
        />
      </div>
    </>
  );
}
