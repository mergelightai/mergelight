import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRightIcon, CheckIcon, CopyIcon, PlusIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ADD_REPOS_URL, SERVER, type Light, type Overview, type Review } from '../api';
import { ViewHeader } from '../AppShell';
import { DataBody, DataCard, DataCell, DataHead, DataHeadCell, DataRow, DataTable, DotMeter, Filler, GroupRow, TwoLines } from '../DataTable';
import { ago, findings, LIGHTS, plural, took } from '../format';

const ORDER: Light[] = ['green', 'yellow', 'red'];

/** A review's light as a tinted pill with a dot, as the reference's "Production". */
export function LightBadge({ light }: { light: Light }) {
  const l = LIGHTS[light];
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-[6px] px-2 text-[12.5px] whitespace-nowrap', l.pill)}>
      <span className={cn('size-1.5 rounded-full', l.dot)} />
      {l.label}
    </span>
  );
}

/** A segmented control, as the reference's "Overview · Machines · Members" and "All 5 · Done 4". */
function Segmented<T extends string>({ label, value, onChange, options, mono = false }: { label: string; value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode; count?: number }[]; mono?: boolean }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[10px] bg-well p-1 hairline [scrollbar-width:none]">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-[7px] px-3 whitespace-nowrap transition-colors',
            mono ? 'h-7 px-2.5 font-mono text-[12px]' : 'text-[14px]',
            value === o.id ? 'bg-panel text-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]' : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="text-[12.5px] text-ink-4 tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** The server address a workflow names, in a quiet box with a copy button. */
function ServerAddress() {
  const [copied, setCopied] = useState(false);
  const host = SERVER.replace(/^https?:\/\//, '');
  return (
    <div className="flex h-9 items-center gap-2 rounded-[8px] bg-panel pl-3.5 pr-1 hairline">
      <span className="truncate font-mono text-[12.5px] text-ink-2" title="The server address for the server: line in your workflow">
        {host}
      </span>
      <button
        type="button"
        aria-label="Copy the server address"
        onClick={() => {
          void navigator.clipboard?.writeText(SERVER).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="flex size-7 items-center justify-center rounded-[6px] text-ink-4 transition-colors hover:bg-white/[0.06] hover:text-ink"
      >
        {copied ? <CheckIcon className="size-3.5 text-safe-ink" /> : <CopyIcon className="size-3.5" />}
      </button>
    </div>
  );
}

/** A label in the reference's small mono capitals: "MACHINES", "CPU · 6 MACHINES · LAST 24 HOURS". */
function Caps({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[11px] tracking-[0.1em] text-[#767674] uppercase', className)}>{children}</span>;
}

/** One number of the four, as the reference's "6 HEALTHY": a big figure with a small mono word after it. */
function Stat({ label, value, unit, light, className }: { label: string; value: number; unit: string; light?: Light; className?: string }) {
  return (
    <div className={cn('min-w-0 border-white/[0.05] px-6 py-5', className)}>
      <p className="flex items-center gap-2">
        {light && <span className={cn('size-1.5 rounded-full', LIGHTS[light].dot)} />}
        <Caps>{label}</Caps>
      </p>
      <p className="mt-2.5 flex items-baseline gap-2">
        <span className="text-[26px] leading-none tracking-[-0.02em] text-ink tabular-nums">{value}</span>
        <Caps className="truncate text-[#727270]">{unit}</Caps>
      </p>
    </div>
  );
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const ROWS = 20;
const PITCH = 6;
/** Each time slot draws a bar 3 dots wide, then 1 dot of space, as the reference's chart. */
const BAR = 3;
const SLOT = BAR + 1;

/**
 * How long reviews took over time, as the reference's dotted CPU chart: a faint grid of dots across the
 * whole width, and in each time slot a lit bar as tall as the longest review in it. The slot of the
 * newest review is blue, as "now" is in the reference. A thin line marks the peak.
 */
function DurationChart({ reviews, span, from, controls }: { reviews: Review[]; span: string; from: number; controls: ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const now = Date.now();
  const height = ROWS * PITCH;
  const columns = Math.max(0, Math.floor(width / PITCH));
  const slots = Math.max(1, Math.floor(columns / SLOT));
  const start = Math.min(from, now - 60_000);
  const step = (now - start) / slots;
  const max = Math.max(1, ...reviews.map((r) => r.duration_ms));
  // The reviews in each time slot.
  const buckets = Array.from({ length: slots }, () => [] as Review[]);
  for (const r of reviews) {
    const i = Math.min(slots - 1, Math.max(0, Math.floor((Date.parse(r.created_at) - start) / step)));
    buckets[i].push(r);
  }
  const newestSlot = buckets.reduce((n, b, i) => (b.length ? i : n), -1);
  const peakSlot = buckets.reduce((p, b, i) => (Math.max(0, ...b.map((r) => r.duration_ms)) > Math.max(0, ...buckets[p].map((r) => r.duration_ms)) ? i : p), 0);
  const peak = buckets[peakSlot].reduce<Review | null>((p, r) => (!p || r.duration_ms > p.duration_ms ? r : p), null);
  const offset = (width - slots * SLOT * PITCH) / 2;
  const filledIn = (b: Review[]) => (b.length ? Math.max(1, Math.round((Math.max(...b.map((r) => r.duration_ms)) / max) * ROWS)) : 0);
  const peakX = offset + (peakSlot * SLOT + 1) * PITCH + PITCH / 2;
  const peakTop = (ROWS - filledIn(buckets[peakSlot])) * PITCH;
  const tickLabel = (t: number) => {
    if (t === 1) return 'NOW';
    const h = ((now - start) * (1 - t)) / 3_600_000;
    return h >= 48 ? `-${Math.round(h / 24)}D` : h >= 1 ? `-${Math.round(h)}H` : `-${Math.max(1, Math.round(h * 60))}M`;
  };
  const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <div className="border-t border-white/[0.05] px-6 pb-5 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Caps>
          Duration · {plural(reviews.length, 'review')} · {span}
        </Caps>
        {controls}
      </div>
      <div ref={ref} className="relative mt-8" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={`How long the ${reviews.length} reviews took, over time`}>
            {buckets.map((b, i) => {
              const filled = filledIn(b);
              const newest = i === newestSlot;
              return (
                <g key={i}>
                  {b.length > 0 && <title>{b.map((r) => `${r.repo} #${r.pr} · ${took(r.duration_ms)} · ${LIGHTS[r.light].label}`).join('\n')}</title>}
                  <rect x={offset + i * SLOT * PITCH} y={0} width={SLOT * PITCH} height={height} fill="transparent" />
                  {Array.from({ length: SLOT }, (_, c) =>
                    Array.from({ length: ROWS }, (_, row) => {
                      const lit = c < BAR && ROWS - row <= filled;
                      // Lit dots are brightest at the top of a bar and fade towards its foot.
                      const depth = lit ? (row - (ROWS - filled)) / Math.max(1, filled) : 0;
                      const fill = lit ? (newest ? `rgb(109 137 243 / ${0.98 - depth * 0.4})` : `rgb(212 212 210 / ${0.92 - depth * 0.6})`) : 'rgb(255 255 255 / 0.05)';
                      return <circle key={`${c}-${row}`} cx={offset + (i * SLOT + c) * PITCH + PITCH / 2} cy={row * PITCH + PITCH / 2} r={1.2} fill={fill} />;
                    }),
                  )}
                </g>
              );
            })}
            {peak && <line x1={peakX} x2={peakX} y1={-14} y2={Math.max(0, peakTop - 4)} stroke="rgb(255 255 255 / 0.35)" strokeWidth={1} />}
          </svg>
        )}
        {peak && width > 0 && (
          // The label sits beside the line, on the side with more room.
          <div
            className={cn('pointer-events-none absolute -top-7 flex flex-col whitespace-nowrap', peakX > width / 2 ? 'items-end text-right' : 'items-start')}
            style={peakX > width / 2 ? { right: width - peakX + 6 } : { left: peakX + 6 }}
          >
            <Caps className="text-[10.5px] text-ink-2">Peak {took(peak.duration_ms)}</Caps>
            <Caps className="text-[10.5px] text-ink-4">{clock(peak.created_at)}</Caps>
          </div>
        )}
      </div>
      <div className="relative mt-3 h-5 border-t border-white/[0.08]">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <span key={t} className="absolute top-0 flex flex-col" style={{ left: `${t * 100}%`, transform: t === 1 ? 'translateX(-100%)' : t === 0 ? 'none' : 'translateX(-50%)', alignItems: t === 1 ? 'flex-end' : t === 0 ? 'flex-start' : 'center' }}>
            <span className="h-1.5 w-px bg-white/[0.14]" />
            <Caps className="mt-1 text-[10.5px] text-[#5f5f5d]">{tickLabel(t)}</Caps>
          </span>
        ))}
      </div>
    </div>
  );
}

/** The most reviews the server sends for this page: the newest ones (RECENT_REVIEWS in packages/server/src/people.ts). */
const RECENT_REVIEWS = 50;

type Range = 'all' | '24h' | '7d' | '30d';
const RANGES: { id: Range; label: string; ms: number }[] = [
  { id: '24h', label: '24h', ms: 86_400_000 },
  { id: '7d', label: '7d', ms: 7 * 86_400_000 },
  { id: '30d', label: '30d', ms: 30 * 86_400_000 },
  { id: 'all', label: 'All', ms: Infinity },
];

/** A strip of the latest reviews of one repository, one bar each, newest on the right, as the reference's uptime bars. */
function History({ reviews, slots = 24 }: { reviews: Review[]; slots?: number }) {
  const last = reviews.slice(-slots);
  const empty = slots - last.length;
  return (
    <span className="inline-flex h-5 items-stretch gap-[2px]" aria-label={`The light of its last ${last.length} reviews`}>
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className="w-[3px] rounded-[1px] bg-white/[0.07]" />
      ))}
      {last.map((r) => (
        <span key={`${r.pr}-${r.created_at}`} title={`#${r.pr} · ${LIGHTS[r.light].label}`} className={cn('w-[3px] rounded-[1px]', LIGHTS[r.light].bar)} />
      ))}
    </span>
  );
}

export function ReviewsView({ overview, login, orgLogin }: { overview: Overview; login: string; orgLogin: string }) {
  const [range, setRange] = useState<Range>('all');
  const [show, setShow] = useState<'all' | Light>('all');
  const cutoff = Date.now() - (RANGES.find((r) => r.id === range)?.ms ?? Infinity);
  const inRange = overview.reviews.filter((r) => Date.parse(r.created_at) >= cutoff);
  const oldestSent = overview.reviews.reduce<string | null>((o, r) => (!o || r.created_at < o ? r.created_at : o), null);
  const capped = overview.reviews.length >= RECENT_REVIEWS && !!oldestSent && Date.parse(oldestSent) > cutoff;
  const by = (light: Light) => inRange.filter((r) => r.light === light).length;
  const oldest = inRange.reduce<string | null>((o, r) => (!o || r.created_at < o ? r.created_at : o), null);
  const pct = (n: number) => (inRange.length ? `${Math.round((n / inRange.length) * 100)}%` : '0%');
  const shown = show === 'all' ? inRange : inRange.filter((r) => r.light === show);
  const maxTook = Math.max(1, ...inRange.map((r) => r.duration_ms));
  const span = capped ? `latest ${inRange.length}, since ${ago(oldest)}` : range === 'all' ? `since ${ago(oldest)}` : `last ${RANGES.find((r) => r.id === range)?.label}`;

  // The reviews, grouped by repository, the newest first in each, and the busiest repository first.
  const groups = useMemo(() => {
    const map = new Map<string, Review[]>();
    for (const r of shown) map.set(r.repo, [...(map.get(r.repo) ?? []), r]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length).map(([repo, list]) => ({ repo, list: list.sort((a, b) => b.created_at.localeCompare(a.created_at)) }));
  }, [shown]);

  return (
    <>
      <ViewHeader title={`Hey ${login} 👋`} lead={`Here's how ${orgLogin} is reviewing right now.`} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Show"
          value={show}
          onChange={setShow}
          options={[{ id: 'all' as const, label: 'All', count: inRange.length }, ...ORDER.map((l) => ({ id: l, label: LIGHTS[l].short, count: by(l) }))]}
        />
        <div className="flex flex-wrap items-center gap-2">
          <ServerAddress />
          <Button nativeButton={false} render={<a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" />} className="gap-1.5 pl-3">
            <PlusIcon />
            Add repository
          </Button>
        </div>
      </div>

      <section className="overflow-hidden rounded-[14px] bg-panel hairline">
        <div className="grid grid-cols-2 lg:grid-cols-4">
          <Stat label={capped ? 'Latest reviews' : 'Reviews'} value={inRange.length} unit={capped || range === 'all' ? `since ${ago(oldest)}` : `last ${range}`} />
          {ORDER.map((l, i) => (
            // Hairlines between the cells: in one row of four on a wide screen, in two rows of two on a narrow one.
            <Stat key={l} label={LIGHTS[l].label} value={by(l)} unit={pct(by(l))} light={l} className={cn('lg:border-l lg:border-t-0', i === 0 && 'border-l', i >= 1 && 'border-t', i === 2 && 'border-l')} />
          ))}
        </div>
        <DurationChart reviews={inRange} span={span} from={range === 'all' ? (oldest ? Date.parse(oldest) - (Date.now() - Date.parse(oldest)) * 0.04 : Date.now() - 86_400_000) : cutoff} controls={<Segmented label="Time" mono value={range} onChange={setRange} options={RANGES.map((r) => ({ id: r.id, label: r.label }))} />} />
      </section>

      <DataCard
        className="mt-6"
        title="Latest reviews"
        count={shown.length}
        meta={ORDER.map((l) => `${by(l)} ${l === 'green' ? 'safe' : l === 'yellow' ? (by(l) === 1 ? 'needs a human' : 'need a human') : 'blocked'}`).join(' · ')}
      >
        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13.5px] text-ink-3">No reviews{show === 'all' ? '' : ' with this light'} {range === 'all' ? 'yet' : `in the last ${range}`}.</p>
        ) : (
          <DataTable>
            <DataHead>
              <DataHeadCell>Pull request</DataHeadCell>
              <DataHeadCell className="hidden sm:table-cell">Light</DataHeadCell>
              <DataHeadCell>Found</DataHeadCell>
              <DataHeadCell className="hidden lg:table-cell">Took</DataHeadCell>
              <DataHeadCell className="hidden md:table-cell">AI</DataHeadCell>
              <DataHeadCell className="hidden text-right sm:table-cell">When</DataHeadCell>
              <DataHeadCell className="w-12" aria-label="Open" />
            </DataHead>
            <DataBody>
              {groups.map((g) => [
                <GroupRow key={`g-${g.repo}`} span={7} label={g.repo} count={g.list.length} />,
                ...g.list.map((r) => {
                  const url = `https://github.com/${r.repo}/pull/${r.pr}`;
                  return (
                    <DataRow key={`${r.repo_id}-${r.pr}-${r.created_at}`} href={url}>
                      <DataCell>
                        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2.5 hover:underline">
                          <span className={cn('size-[7px] shrink-0 rounded-full', LIGHTS[r.light].dot)} title={LIGHTS[r.light].label} />
                          <span className="text-ink">
                            <span className="sr-only">{r.repo} </span>#{r.pr}
                          </span>
                          <span className="font-mono text-[12.5px] text-ink-4">{r.sha.slice(0, 7)}</span>
                        </a>
                      </DataCell>
                      <DataCell className="hidden sm:table-cell">
                        <LightBadge light={r.light} />
                      </DataCell>
                      <DataCell className={cn('whitespace-normal', r.bugs || r.risks ? 'text-ink' : 'text-ink-3')}>{findings(r)}</DataCell>
                      <DataCell className="hidden lg:table-cell">
                        <span className="inline-flex items-center gap-3">
                          <DotMeter value={r.duration_ms} of={maxTook} />
                          <span className="font-mono text-[12.5px] text-ink-3 tabular-nums">{took(r.duration_ms)}</span>
                        </span>
                      </DataCell>
                      <DataCell className="hidden font-mono text-[12.5px] text-ink-3 md:table-cell">{r.model ?? r.provider}</DataCell>
                      <DataCell className="hidden text-right font-mono text-[12.5px] whitespace-nowrap text-ink-3 sm:table-cell">
                        <time dateTime={r.created_at}>{ago(r.created_at)}</time>
                      </DataCell>
                      <DataCell className="text-right">
                        <Button variant="ghost" size="icon-sm" aria-label={`Open ${r.repo} #${r.pr} on GitHub`} nativeButton={false} render={<a href={url} target="_blank" rel="noreferrer" />}>
                          <ArrowUpRightIcon />
                        </Button>
                      </DataCell>
                    </DataRow>
                  );
                }),
              ])}
            </DataBody>
          </DataTable>
        )}
      </DataCard>

      <DataCard className="mt-6" fill title="Repositories" count={overview.repos.length} meta="all time" footer={`${plural(overview.repos.length, 'repository', 'repositories')} you can see sent a review.`}>
        <DataTable>
          <DataHead>
            <DataHeadCell>Repository</DataHeadCell>
            <DataHeadCell className="hidden md:table-cell">Latest reviews</DataHeadCell>
            <DataHeadCell className="text-right">Reviews</DataHeadCell>
            <DataHeadCell className="hidden text-right sm:table-cell">Last review</DataHeadCell>
            <DataHeadCell className="w-12" aria-label="Open" />
          </DataHead>
          <DataBody>
            {overview.repos.map((repo) => {
              const mine = overview.reviews.filter((r) => r.repo_id === repo.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
              const latest = mine[mine.length - 1];
              return (
                <DataRow key={repo.id} href={`https://github.com/${repo.name}`}>
                  <DataCell>
                    <span className="inline-flex items-center gap-2.5">
                      <span className={cn('size-[7px] shrink-0 rounded-full', latest ? LIGHTS[latest.light].dot : 'bg-white/20')} />
                      <TwoLines main={repo.name} sub={latest ? `last: ${LIGHTS[latest.light].label.toLowerCase()}` : 'no review in the list'} />
                    </span>
                  </DataCell>
                  <DataCell className="hidden md:table-cell">
                    <History reviews={mine} />
                  </DataCell>
                  <DataCell className="text-right font-mono text-[13px] text-ink tabular-nums">{repo.reviews}</DataCell>
                  <DataCell className="hidden text-right font-mono text-[12.5px] whitespace-nowrap text-ink-3 sm:table-cell">{ago(repo.last_review_at)}</DataCell>
                  <DataCell className="text-right">
                    <Button variant="ghost" size="icon-sm" aria-label={`Open ${repo.name} on GitHub`} nativeButton={false} render={<a href={`https://github.com/${repo.name}`} target="_blank" rel="noreferrer" />}>
                      <ArrowUpRightIcon />
                    </Button>
                  </DataCell>
                </DataRow>
              );
            })}
          </DataBody>
        </DataTable>
        <Filler />
      </DataCard>
    </>
  );
}
