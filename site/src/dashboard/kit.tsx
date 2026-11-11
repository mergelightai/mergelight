// The parts the dashboard's views share: the glass card, the facts card, the form window,
// the "are you sure" popup, the repository picker and the form fields.
import { useEffect, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { InfoIcon, LockIcon, PlusIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** A glass card with a quiet label on its rim and a lighter panel inside, like the number cards. */
export function GlassCard({ label, icon, className, children }: { label?: ReactNode; icon?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('glass-frame glass-card relative rounded-[1.75rem] p-1', className)}>
      {label && (
        <p className="flex h-10 items-center gap-2 px-5 text-sm text-muted-foreground">
          {icon}
          {label}
        </p>
      )}
      <div className="glass-inner rounded-3xl bg-panel p-5">{children}</div>
    </div>
  );
}

/** What someone must know before they rely on a feature: the promises the docs make too. */
export function Facts({ items }: { items: ReactNode[] }) {
  return (
    <GlassCard label="Good to know" icon={<InfoIcon className="size-4" />} className="xl:self-start">
      <ul className="grid gap-3 text-sm leading-relaxed text-muted-foreground">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </GlassCard>
  );
}

/** Says who may change this, for someone who can only read. */
export function ReadOnly({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-full bg-white/[0.04] px-3.5 py-2 text-[13px] text-muted-foreground">
      <LockIcon className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>;
}

/** A small round tag, such as the repository a rule applies to. */
export function Tag({ tone = 'plain', children }: { tone?: 'plain' | 'human'; children: ReactNode }) {
  return <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap', tone === 'human' ? 'bg-human/10 text-human shadow-[inset_0_0_0_1px_rgb(245_196_81/0.18)]' : 'bg-white/[0.03] text-muted-foreground shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]')}>{children}</span>;
}

/**
 * A button that asks first. Removing a rule or forgetting a decision acts on every later review,
 * so one stray click must not do it.
 */
export function Confirm({ label, ariaLabel, title, body, confirm, busyLabel, onConfirm }: { label: string; ariaLabel?: string; title: string; body: ReactNode; confirm: string; busyLabel: string; onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Popover open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={ariaLabel} className="text-muted-foreground hover:text-foreground" disabled={busy} />}>{busy ? busyLabel : label}</PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="grid gap-1.5">
          <p className="font-medium text-foreground">{title}</p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{body}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
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

/** The button that opens a form, and the form in a glass window. */
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
  wide = false,
  quiet = false,
}: {
  wide?: boolean;
  /** A smaller, quieter button, for a second form on the same view. */
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
      <Button onClick={() => onOpenChange(true)} variant={quiet ? 'secondary' : 'default'} className={quiet ? 'h-9 gap-1.5 rounded-full pl-3 pr-4 text-[13px]' : 'h-10 gap-1.5 rounded-full pl-3.5 pr-5 text-[14px] shadow-[0_8px_24px_-10px_rgb(236_234_244/0.35)] hover:bg-white'}>
        <PlusIcon />
        {trigger}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
        <DialogContent className="glass-frame rounded-[2rem]! bg-transparent! p-2! ring-0! shadow-none! sm:max-w-lg" style={wide ? { maxWidth: '42rem' } : undefined} showCloseButton={false}>
          <form
            className="glass-inner grid max-h-[calc(100svh-3rem)] gap-5 overflow-y-auto rounded-[1.6rem] bg-popover p-6"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (ready && !busy) onSubmit();
            }}
          >
            <div className="grid gap-1.5">
              <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
              <DialogDescription className="leading-relaxed">{description}</DialogDescription>
            </div>
            <div className="grid gap-4">{children}</div>
            {error && <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-[13px] text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={!ready || busy}>
                {busy ? busyLabel : submit}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A label, its control, and a quiet hint under it. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function TextInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input className={cn('h-10 rounded-xl bg-white/[0.05] px-3.5', className)} {...props} />;
}

export type Choice = { value: string; label: string; disabled?: boolean; note?: string };

/** A choice from a short list, in the glass menu style. */
export function Choose({ label, value, onChange, choices, placeholder }: { label: string; value: string | null; onChange: (v: string) => void; choices: Choice[]; placeholder: string }) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(String(v))} items={choices.map((c) => ({ value: c.value, label: c.label }))}>
      <SelectTrigger aria-label={label} className="h-10 w-full rounded-xl bg-white/[0.05] px-3.5">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value} disabled={c.disabled}>
            <span className="flex flex-col">
              <span>{c.label}</span>
              {c.note && <span className="text-xs font-normal text-muted-foreground">{c.note}</span>}
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

/** A list with nothing in it yet, inside a glass frame. */
export function EmptyList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="glass-frame glass-card relative flex flex-col rounded-[1.75rem] p-1">
      <div className="glass-inner grid flex-1 place-content-center place-items-center gap-1.5 rounded-3xl bg-panel px-6 py-12 text-center">
        <p className="font-medium text-foreground">{title}</p>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
