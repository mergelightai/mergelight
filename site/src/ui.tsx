import type { ReactNode } from 'react';

/** The MagicBento dark card: surface gradient, hairline edge, top highlight and drop shadow. */
export const SURFACE =
  'rounded-[22px] bg-[linear-gradient(180deg,#1a1820_0%,#121116_100%)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07),inset_0_1px_0_rgb(255_255_255/0.06),0_24px_48px_-28px_rgb(0_0_0/0.85),0_8px_18px_-12px_rgb(0_0_0/0.6)]';
/** A recessed panel inside a SURFACE card, like the bento's wells. */
export const WELL = 'rounded-2xl bg-white/[0.03] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]';

export function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

export function SectionHead({ eyebrow, title, lead, center = false }: { eyebrow: string; title: ReactNode; lead?: ReactNode; center?: boolean }) {
  return (
    <div className={center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      <p className="text-sm font-medium text-mint">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-fg sm:text-[2.75rem] sm:leading-[1.08]">{title}</h2>
      {lead && <p className="mt-5 text-lg leading-relaxed text-muted">{lead}</p>}
    </div>
  );
}

export function GitHubIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function Check({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
