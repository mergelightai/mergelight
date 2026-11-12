import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// The dashboard's tables, as in the reference's "Machines" card: a card whose header strip carries the
// title, a count and a quiet summary line, and inside it a darker panel with the column names and rows.

/**
 * A card with a header strip and a darker panel inside. With fill, the card reaches the bottom of the
 * page on a wide screen, so a short list doesn't leave the page half empty.
 */
export function DataCard({ title, count, meta, action, footer, fill = false, className, children }: { title?: ReactNode; count?: ReactNode; meta?: ReactNode; action?: ReactNode; footer?: ReactNode; fill?: boolean; className?: string; children: ReactNode }) {
  return (
    <section data-fill={fill || undefined} className={cn('flex min-w-0 flex-col rounded-[14px] bg-strip p-1 hairline', fill && 'xl:flex-1', className)}>
      {title && (
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-[14px]">
          <span className="font-medium text-ink">{title}</span>
          {count !== undefined && <span className="text-ink-4 tabular-nums">{count}</span>}
          {meta && <span className="truncate text-ink-4">· {meta}</span>}
          {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-auto rounded-[10px] bg-panel hairline">{children}</div>
      {footer && <div className="px-3 pb-1.5 pt-2.5 text-[13px] text-ink-4">{footer}</div>}
    </section>
  );
}

export function DataTable({ className, children, ...props }: ComponentProps<'table'>) {
  return (
    <table className={cn('w-full border-separate border-spacing-0 text-[14px]', className)} {...props}>
      {children}
    </table>
  );
}

export function DataHead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr>{children}</tr>
    </thead>
  );
}

export function DataHeadCell({ className, ...props }: ComponentProps<'th'>) {
  return <th className={cn('h-10 border-b border-white/[0.05] px-4 text-left align-middle text-[13px] font-normal whitespace-nowrap text-[#767674] first:pl-5 last:pr-5', className)} {...props} />;
}

export function DataBody(props: ComponentProps<'tbody'>) {
  return <tbody className="[&_tr:not(:first-child)>td]:border-t [&_tr>td]:border-white/[0.05] [&_tr[data-href]:hover>td]:bg-white/[0.018]" {...props} />;
}

/** A row that heads a group of rows, as the reference's "Production 5". */
export function GroupRow({ label, count, span }: { label: ReactNode; count?: ReactNode; span: number }) {
  return (
    <tr>
      <td colSpan={span} className="h-10 bg-shell px-5 align-middle text-[14px] text-ink">
        {label} {count !== undefined && <span className="ml-1 text-ink-4 tabular-nums">{count}</span>}
      </td>
    </tr>
  );
}

export function DataCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-4 py-3 align-middle first:pl-5 last:pr-5', className)} {...props} />;
}

/** A row you can click anywhere on to open its page on GitHub, in a new tab. Its links and buttons keep working as they are. */
export function DataRow({ href, className, ...props }: ComponentProps<'tr'> & { href?: string }) {
  return (
    <tr
      data-href={href || undefined}
      className={cn(href && 'cursor-pointer', className)}
      onClick={
        href
          ? (e) => {
              if ((e.target as HTMLElement).closest('a, button, [role=menuitem]') || window.getSelection()?.toString()) return;
              window.open(href, '_blank', 'noopener,noreferrer');
            }
          : undefined
      }
      {...props}
    />
  );
}

/** A small square with an icon, as the folder icons of the reference's "Machines" list. */
export function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-shell text-ink-4 hairline [&_svg]:size-[15px]', className)}>{children}</span>;
}

/** Someone's initials in a small round chip, as the reference's activity list: "PS", "ST". */
export function Initials({ name }: { name: string }) {
  const letters = name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  return <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-strip text-[10px] font-medium tracking-wide text-ink-3 hairline">{letters}</span>;
}

/** A cell with a main line and a quieter line under it, as the reference's "api" over its address. With an icon, a tile on its left. */
export function TwoLines({ main, sub, mono = false, icon }: { main: ReactNode; sub: ReactNode; mono?: boolean; icon?: ReactNode }) {
  const lines = (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-[14px] text-ink">{main}</span>
      <span className={cn('text-[13px] text-ink-4', mono && 'font-mono text-[12.5px]')}>{sub}</span>
    </div>
  );
  if (!icon) return lines;
  return (
    <div className="flex items-center gap-3">
      <IconTile>{icon}</IconTile>
      {lines}
    </div>
  );
}

/** The panel's empty space under the rows, so a filled card has no gap at its bottom. */
export function Filler() {
  return <div aria-hidden="true" className="hidden flex-1 xl:block" />;
}

/** A row of dots that fills up, as the reference's CPU meter: ●●●●●○○○○○. */
export function DotMeter({ value, of = 1, dots = 10 }: { value: number; of?: number; dots?: number }) {
  const on = Math.max(value > 0 ? 1 : 0, Math.round((value / (of || 1)) * dots));
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-[3px]">
      {Array.from({ length: dots }, (_, i) => (
        <span key={i} className={cn('size-[3px] rounded-full', i < on ? 'bg-ink' : 'bg-white/[0.14]')} />
      ))}
    </span>
  );
}
