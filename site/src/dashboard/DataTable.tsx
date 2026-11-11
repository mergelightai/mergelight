import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// The dashboard's tables: a rounded frame with a soft header strip, and the rows on an inner panel.

/**
 * A table in its glass frame. With fill, the frame reaches the bottom of the page on a wide screen,
 * and the rows' panel runs on below the last row, so a short list doesn't leave the page half empty.
 */
export function DataTable({ className, children, fill = false, ...props }: ComponentProps<'table'> & { fill?: boolean }) {
  return (
    <div data-fill={fill || undefined} className={cn('group/table glass-frame glass-card relative overflow-x-auto rounded-[1.75rem] p-1', fill && 'flex flex-col xl:flex-1')}>
      <table className={cn('w-full border-separate border-spacing-0 text-sm', className)} {...props}>
        {children}
      </table>
      {fill && <div aria-hidden="true" className="hidden min-h-6 flex-1 rounded-b-3xl bg-panel xl:block" />}
    </div>
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
  return <th className={cn('h-11 px-4 text-left align-middle font-normal whitespace-nowrap text-muted-foreground first:pl-6 last:pr-6', className)} {...props} />;
}

export function DataBody(props: ComponentProps<'tbody'>) {
  return (
    <tbody
      className={cn(
        // The inner panel: each cell carries the panel's colour, and the corner cells its round corners.
        '[&_td]:bg-panel [&_tr:not(:first-child)_td]:border-t [&_tr_td]:border-border',
        '[&_tr:first-child_td:first-child]:rounded-tl-3xl [&_tr:first-child_td:last-child]:rounded-tr-3xl',
        '[&_tr:last-child_td:first-child]:rounded-bl-3xl [&_tr:last-child_td:last-child]:rounded-br-3xl',
        '[&_tr:hover_td]:bg-[color-mix(in_oklch,var(--color-panel),var(--foreground)_3%)]',
      )}
      {...props}
    />
  );
}

export function DataCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-4 py-4 align-middle first:pl-6 last:pr-6', className)} {...props} />;
}

/** A row you can click anywhere on to open its page on GitHub, in a new tab. Its links and buttons keep working as they are. */
export function DataRow({ href, className, ...props }: ComponentProps<'tr'> & { href?: string }) {
  return (
    <tr
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

/** A cell with a main line and a quieter line under it. */
export function TwoLines({ main, sub }: { main: ReactNode; sub: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="font-medium text-foreground">{main}</span>
      <span className="text-[13px] text-muted-foreground">{sub}</span>
    </div>
  );
}
