import { ArrowUpRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Light, Overview, Review } from '../api';
import { ViewHeader } from '../AppShell';
import { DataBody, DataCell, DataRow, DataHead, DataHeadCell, DataTable, TwoLines } from '../DataTable';
import { ago, findings, LIGHTS, took } from '../format';

export function LightBadge({ light }: { light: Light }) {
  const l = LIGHTS[light];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', l.soft, l.text)}>
      <span className={cn('size-1.5 rounded-full', l.dot)} />
      {l.label}
    </span>
  );
}

/** A number in the same frame as the tables: the label on the frame's strip, the number on the inner panel. */
function Stat({ label, value, sub, light }: { label: string; value: number; sub: string; light?: Light }) {
  return (
    <div className="glass-frame glass-card relative rounded-[1.75rem] p-1">
      <p className="flex h-10 items-center gap-2 px-5 text-sm text-muted-foreground">
        {light && <span className={cn('size-2 rounded-full', LIGHTS[light].dot)} />}
        {label}
      </p>
      <div className="glass-inner rounded-3xl bg-panel px-5 py-4">
        <p className={cn('font-heading text-3xl font-semibold tabular-nums tracking-tight', light && LIGHTS[light].text)}>{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}

/** The four numbers. They count the latest reviews the server sent, so they say over which time. */
function Stats({ reviews }: { reviews: Review[] }) {
  const by = (light: Light) => reviews.filter((r) => r.light === light).length;
  const oldest = reviews.reduce<string | null>((o, r) => (!o || r.created_at < o ? r.created_at : o), null);
  const share = (n: number) => `${Math.round((n / reviews.length) * 100)}% of them`;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label={reviews.length === 1 ? 'Latest review' : `Latest ${reviews.length} reviews`} value={reviews.length} sub={`Since ${ago(oldest)}`} />
      {(['green', 'yellow', 'red'] as const).map((light) => (
        <Stat key={light} label={LIGHTS[light].label} value={by(light)} sub={share(by(light))} light={light} />
      ))}
    </div>
  );
}

export function ReviewsView({ overview }: { overview: Overview }) {
  return (
    <>
      <ViewHeader title="Reviews" lead="Each pull request Mergelight reviewed, with its light and what it found." />
      <Stats reviews={overview.reviews} />
      <h2 className="mb-3 mt-8 font-heading text-base font-semibold">Latest reviews</h2>
      <DataTable>
        <DataHead>
          <DataHeadCell>Pull request</DataHeadCell>
          <DataHeadCell className="hidden sm:table-cell">Light</DataHeadCell>
          <DataHeadCell>Found</DataHeadCell>
          <DataHeadCell className="hidden md:table-cell">AI</DataHeadCell>
          <DataHeadCell className="w-14" aria-label="Open" />
        </DataHead>
        <DataBody>
          {overview.reviews.map((r) => {
            const url = `https://github.com/${r.repo}/pull/${r.pr}`;
            return (
              <DataRow key={`${r.repo_id}-${r.pr}-${r.created_at}`} href={url}>
                <DataCell>
                  <TwoLines
                    main={
                      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 hover:underline">
                        <span className={cn('size-2 shrink-0 rounded-full sm:hidden', LIGHTS[r.light].dot)} title={LIGHTS[r.light].label} />
                        <span>
                          {r.repo} <span className="text-muted-foreground">#{r.pr}</span>
                        </span>
                      </a>
                    }
                    sub={<time dateTime={r.created_at}>{ago(r.created_at)}</time>}
                  />
                </DataCell>
                <DataCell className="hidden sm:table-cell">
                  <LightBadge light={r.light} />
                </DataCell>
                <DataCell className={r.bugs || r.risks ? '' : 'text-muted-foreground'}>{findings(r)}</DataCell>
                <DataCell className="hidden whitespace-nowrap font-mono text-xs text-muted-foreground md:table-cell">
                  {r.model ?? r.provider}, {took(r.duration_ms)}
                </DataCell>
                <DataCell className="text-right">
                  <Button variant="secondary" size="icon-sm" aria-label={`Open ${r.repo} #${r.pr} on GitHub`} render={<a href={url} target="_blank" rel="noreferrer" />} nativeButton={false}>
                    <ArrowUpRightIcon />
                  </Button>
                </DataCell>
              </DataRow>
            );
          })}
        </DataBody>
      </DataTable>
      <h2 className="mb-3 mt-8 font-heading text-base font-semibold">Repositories</h2>
      <DataTable>
        <DataHead>
          <DataHeadCell>Repository</DataHeadCell>
          <DataHeadCell className="text-right">Reviews</DataHeadCell>
          <DataHeadCell className="w-14" aria-label="Open" />
        </DataHead>
        <DataBody>
          {overview.repos.map((repo) => (
            <DataRow key={repo.id} href={`https://github.com/${repo.name}`}>
              <DataCell>
                <TwoLines main={repo.name} sub={`Last review ${ago(repo.last_review_at)}`} />
              </DataCell>
              <DataCell className="text-right font-medium tabular-nums">{repo.reviews}</DataCell>
              <DataCell className="text-right">
                <Button variant="secondary" size="icon-sm" aria-label={`Open ${repo.name} on GitHub`} render={<a href={`https://github.com/${repo.name}`} target="_blank" rel="noreferrer" />} nativeButton={false}>
                  <ArrowUpRightIcon />
                </Button>
              </DataCell>
            </DataRow>
          ))}
        </DataBody>
      </DataTable>
    </>
  );
}
