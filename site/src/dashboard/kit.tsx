// The parts the dashboard's views share, in the look of the reference: the card, the facts card, the
// form window, the "are you sure" popup, the repository picker and the form fields.
import { useEffect, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { InfoIcon, LockIcon, PlusIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { LIGHTS } from './format';

/** A card: a header strip with a quiet label, and a darker panel inside with a hairline edge. */
export function GlassCard({ label, icon, className, children }: { label?: ReactNode; icon?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-[14px] bg-strip p-1 hairline', className)}>
      {label && (
        <p className="flex min-h-10 items-center gap-2 px-3 py-1.5 text-[14px] font-medium text-ink [&_svg]:text-ink-4">
          {icon}
          {label}
        </p>
      )}
      <div className="rounded-[10px] bg-panel p-5 hairline">{children}</div>
    </div>
  );
}

/** What someone must know before they rely on a feature: the promises the docs make too. */
export function Facts({ items }: { items: ReactNode[] }) {
  return (
    <div className="rounded-[14px] bg-strip p-1 hairline xl:self-start">
      <p className="flex min-h-10 items-center gap-2 px-3 py-1.5 text-[14px] font-medium text-ink">
        <InfoIcon className="size-4 text-ink-4" />
        Good to know
      </p>
      <ul className="rounded-[10px] bg-panel hairline">
        {items.map((item, i) => (
          <li key={i} className="border-t border-white/[0.05] px-4 py-3 text-[13.5px] leading-relaxed text-ink-3 first:border-t-0">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Says who may change this, for someone who can only read. */
export function ReadOnly({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-[8px] bg-shell px-3 py-2 text-[13px] text-ink-3 hairline">
      <LockIcon className="size-3.5 shrink-0 text-ink-4" />
      {children}
    </p>
  );
}

/** A bit of code in a sentence, as the reference's "npm run migrate". */
export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-[5px] bg-strip px-1.5 py-0.5 font-mono text-[0.86em] text-ink-2">{children}</code>;
}

/** A small tag, as the reference's "Development" pill. The human tone uses the "needs a human" light. */
export function Tag({ tone = 'plain', children }: { tone?: 'plain' | 'human'; children: ReactNode }) {
  return <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-[6px] px-2 text-[12.5px] whitespace-nowrap', tone === 'human' ? LIGHTS.yellow.pill : 'bg-shell text-ink-2 hairline')}>{children}</span>;
}

/**
 * A button that asks first. Removing a rule or forgetting a decision acts on every later review,
 * so one stray click must not do it. Its popup ends in an action bar, as the reference's diagnosis.
 */
export function Confirm({ label, ariaLabel, title, body, confirm, busyLabel, onConfirm }: { label: string; ariaLabel?: string; title: string; body: ReactNode; confirm: string; busyLabel: string; onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Popover open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={ariaLabel} disabled={busy} />}>{busy ? busyLabel : label}</PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="grid gap-1.5">
          <p className="text-[14px] font-medium text-ink">{title}</p>
          <p className="text-[13px] leading-relaxed text-ink-3">{body}</p>
        </div>
        <div className="-mx-3 -mb-3 flex justify-end gap-2 border-t border-white/[0.06] px-3 py-2.5">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onConfirm()
                .then(() => setOpen(false))
                .catch(() => setOpen(false))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? busyLabel : confirm}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The button that opens a form, and the form in a small window, as the reference's "Invite people":
 * a header with an icon, a title and one line, the fields, and an action bar with the soft blue button.
 */
export function FormDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  submit,
  busyLabel,
  ready,
  busy,
  error,
  onSubmit,
  children,
  icon,
  wide = false,
  quiet = false,
}: {
  icon?: ReactNode;
  wide?: boolean;
  /** A quieter button, for a second form on the same view. */
  quiet?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: string;
  title: string;
  description: ReactNode;
  submit: string;
  busyLabel: string;
  ready: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <Button onClick={() => onOpenChange(true)} variant={quiet ? 'outline' : 'default'} className="gap-1.5 pl-3">
        <PlusIcon />
        {trigger}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
        <DialogContent className={cn('gap-0 rounded-[14px]! bg-transparent! p-0! ring-0! shadow-none!', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')} showCloseButton={false}>
          <div className="rounded-[14px] shadow-[0_24px_60px_-18px_rgb(0_0_0/0.75)]">
          <form
            className="flex max-h-[calc(100svh-3rem)] flex-col overflow-hidden rounded-[14px] bg-panel shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (ready && !busy) onSubmit();
            }}
          >
            <div className="flex items-start gap-3 border-b border-white/[0.06] px-5 py-4">
              {icon && <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-ink-3 [&_svg]:size-[18px]">{icon}</span>}
              <div className="grid gap-0.5">
                <DialogTitle className="text-[15px] font-medium text-ink">{title}</DialogTitle>
                <DialogDescription className="text-[13px] leading-relaxed text-ink-3">{description}</DialogDescription>
              </div>
            </div>
            <div className="grid gap-4 overflow-y-auto px-5 py-5">{children}</div>
            {error && <p className="mx-5 mb-4 rounded-[8px] bg-blocked/[0.1] px-3.5 py-2.5 text-[13px] text-blocked-ink shadow-[inset_0_0_0_1px_rgb(211_134_125/0.25)]">{error}</p>}
            <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-shell/60 px-5 py-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={!ready || busy}>
                {busy ? busyLabel : submit}
              </Button>
            </div>
          </form>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A label, its control, and a quiet hint under it. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-[13px] text-ink-3">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-ink-4">{hint}</span>}
    </label>
  );
}

export function TextInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input className={cn('h-10 px-3.5', className)} {...props} />;
}

export type Choice = { value: string; label: string; disabled?: boolean; note?: string };

/** A choice from a short list, in the small window style of the menus. */
export function Choose({ label, value, onChange, choices, placeholder }: { label: string; value: string | null; onChange: (v: string) => void; choices: Choice[]; placeholder: string }) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(String(v))} items={choices.map((c) => ({ value: c.value, label: c.label }))}>
      <SelectTrigger aria-label={label} className="h-10 w-full px-3.5">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value} disabled={c.disabled}>
            <span className="flex flex-col">
              <span>{c.label}</span>
              {c.note && <span className="text-xs text-ink-4">{c.note}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* Without storage a draft lives only as long as the page. */
  }
}

/**
 * A form's text, kept for this tab until it is saved. If the 15 minute session runs out, the page
 * signs in again on its own and reloads; the text is still here afterwards.
 */
export function useDraft<T extends Record<string, string>>(key: string, empty: T): [T, (patch: Partial<T>) => void, () => void] {
  const [draft, setDraft] = useState<T>(() => {
    try {
      return { ...empty, ...(JSON.parse(read(key) ?? '{}') as Partial<T>) };
    } catch {
      return empty;
    }
  });
  useEffect(() => write(key, JSON.stringify(draft)), [key, draft]);
  // Clearing also empties the storage at once: the form may be gone from the page by the time a save ends.
  return [
    draft,
    (patch) => setDraft((d) => ({ ...d, ...patch })),
    () => {
      write(key, null);
      setDraft(empty);
    },
  ];
}


/** The repository someone picked last in this org, so the next form starts there and not on the first one in the list. Kept for this tab only. */
export function lastRepo(orgId: number, allowed: string[]): string | null {
  const last = read(`${LAST_REPO}.${orgId}`);
  if (last && allowed.includes(last)) return last;
  return allowed.length === 1 ? allowed[0] : null;
}

export function rememberRepo(orgId: number, value: string): void {
  write(`${LAST_REPO}.${orgId}`, value);
}

const LAST_REPO = 'mergelight.dashboard.repo';
const ORG = 'mergelight.dashboard.org';
const RESUME = 'mergelight.dashboard.resume';

/** The org picked in this tab. A reload, or a new sign-in through GitHub, comes back to it. */
export function keptOrg(): number | null {
  const id = Number(read(ORG));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function keepOrg(id: number): void {
  write(ORG, String(id));
}

const VIEW = 'mergelight.dashboard.view';

/** The view open in this tab, for the way back from a new sign-in. */
export function keptView(): string | null {
  return read(VIEW);
}

export function keepView(view: string): void {
  write(VIEW, view);
}

/**
 * Forgets what this tab kept for the person who signs out: form drafts, the picked org and view,
 * and a form waiting to open again. The next person on this browser starts clean.
 */
export function forgetTab(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('mergelight.dashboard.draft.') || key.startsWith('mergelight.dashboard.written-skill')) sessionStorage.removeItem(key);
    }
  } catch {
    /* No storage: nothing was kept. */
  }
  for (const key of [ORG, VIEW, RESUME, OWNER]) write(key, null);
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(`${LAST_REPO}.`)) sessionStorage.removeItem(key);
  } catch {
    /* No storage: no remembered picks. */
  }
}

const OWNER = 'mergelight.dashboard.owner';

/** What this tab kept belongs to one GitHub user. When someone else signs in here, it is forgotten first. */
export function claimTab(userId: number): boolean {
  const owner = read(OWNER);
  const other = !!owner && owner !== String(userId);
  if (other) forgetTab();
  write(OWNER, String(userId));
  return other;
}


/** Marks a form to open again after a new sign-in, because the session ran out while it was being saved. */
export function markResume(view: string): void {
  write(RESUME, view);
}

/** The view whose form should open again, once. */
export function takeResume(): string | null {
  const view = read(RESUME);
  write(RESUME, null);
  return view;
}

/** Splits "src/**, *.sql" into its patterns. */
export const patterns = (text: string) =>
  text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

/** A list with nothing in it yet: the card, with a quiet line in its panel. */
export function EmptyList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-[14px] bg-strip p-1 hairline">
      <div className="grid flex-1 place-content-center place-items-center gap-1.5 rounded-[10px] bg-panel px-6 py-12 text-center hairline">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        <p className="max-w-md text-[13.5px] leading-relaxed text-ink-3">{children}</p>
      </div>
    </div>
  );
}
