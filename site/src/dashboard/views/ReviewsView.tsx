import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { Light, Overview, Review } from '../api';
import { ViewHeader } from '../AppShell';
import { ago, findings, LIGHTS, plural, took } from '../format';

export function LightBadge({ light }: { light: Light }) {
  const l = LIGHTS[light];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', l.soft, l.text)}>
      <span className={cn('size-1.5 rounded-full', l.dot)} />
      {l.label}
    </span>
  );
}

function Stat({ label, value, sub, light }: { label: string; value: number; sub: string; light?: Light }) {
  return (
    <Card size="sm">
      <CardContent>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {light && <span className={cn('size-2 rounded-full', LIGHTS[light].dot)} />}
          {label}
        </p>
        <p className={cn('mt-2 font-heading text-3xl font-semibold tabular-nums tracking-tight', light && LIGHTS[light].text)}>{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
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
      <Card className="mt-5">
        <CardHeader>
          <CardTitle className="font-heading">Latest reviews</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Pull request</TableHead>
                <TableHead className="hidden sm:table-cell">Light</TableHead>
                <TableHead>Found</TableHead>
                <TableHead className="hidden md:table-cell">AI</TableHead>
                <TableHead className="hidden pr-6 text-right sm:table-cell">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.reviews.map((r) => (
                <TableRow key={`${r.repo_id}-${r.pr}-${r.created_at}`}>
                  <TableCell className="pl-6">
                    <a href={`https://github.com/${r.repo}/pull/${r.pr}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 font-medium hover:underline">
                      <span className={cn('size-2 shrink-0 rounded-full sm:hidden', LIGHTS[r.light].dot)} title={LIGHTS[r.light].label} />
                      <span>
                        {r.repo} <span className="text-muted-foreground">#{r.pr}</span>
                      </span>
                    </a>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <LightBadge light={r.light} />
                  </TableCell>
                  <TableCell className={cn('whitespace-normal pr-6 sm:pr-2', r.bugs || r.risks ? '' : 'text-muted-foreground')}>{findings(r)}</TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                    {r.model ?? r.provider}, {took(r.duration_ms)}
                  </TableCell>
                  <TableCell className="hidden pr-6 text-right text-muted-foreground sm:table-cell">
                    <time dateTime={r.created_at}>{ago(r.created_at)}</time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card className="mt-5">
        <CardHeader>
          <CardTitle className="font-heading">Repositories</CardTitle>
          <CardDescription>The repositories you can see that sent a review.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableBody>
              {overview.repos.map((repo) => (
                <TableRow key={repo.id}>
                  <TableCell className="pl-6">
                    <a href={`https://github.com/${repo.name}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      {repo.name}
                    </a>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{plural(repo.reviews, 'review')}</TableCell>
                  <TableCell className="pr-6 text-right text-muted-foreground">Last {ago(repo.last_review_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
