// The org's plan: what it pays for, picking one, changing it, and Paddle's portal for invoices, card and
// cancel. Paddle sells the plans. The page asks the Mergelight server, which talks to Paddle with its own key.
// This part is in a file of its own, with its own calls to the server, as the written skills are.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CreditCardIcon, ExternalLinkIcon, LoaderCircleIcon, PencilIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { call, SignedOut, type Session } from './api';
import { Choose, Field, FormDialog, GlassCard, ReadOnly, TextInput } from './kit';
import { openCheckout } from './paddle';

export type PlanName = 'light' | 'pro';

export interface Billing {
  org: { id: number; login: string };
  /** An owner of the org, or the account's own person: they buy, change and cancel. */
  can_manage: boolean;
  dashboard: boolean;
  /** Which repositories' reviews use the dashboard: all, only the public ones (Light is free for those), or none. */
  covers: 'all' | 'public' | 'none';
  /** The org's data is stored and its plan ended or is paused. */
  ended: boolean;
  jobs: boolean;
  /** On without paying: whoever runs the server gave it. */
  free: boolean;
  subscription: { plan: PlanName; seats: number; status: string; working: boolean; current_period_end: string | null } | null;
  /** Null when the server sells nothing. */
  paddle: { env: 'sandbox' | 'live'; client_token: string; prices: Record<PlanName, string> } | null;
  /** Custom data the server signed for a checkout. Only for an owner of an org with no working plan. */
  checkout: Record<string, string> | null;
}

/** As the site's pricing shows them, per developer a month. Paddle's checkout shows the real total, with tax. */
export const PLANS: Record<PlanName, { name: string; price: number; what: string }> = {
  light: { name: 'Light', price: 7, what: 'The dashboard: memory, team rules, skills and checks.' },
  pro: { name: 'Pro', price: 14, what: 'Everything in Light, plus Jobs.' },
};
const MAX_SEATS = 1000;

export async function loadBilling(session: Session, orgId: number): Promise<Billing> {
  const res = await call(session, `/v1/orgs/${orgId}/billing`);
  if (!res.ok) throw new Error(`The Mergelight server answered ${res.status}.`);
  return (await res.json()) as Billing;
}

/** The server's own words when it says no, so the person sees why. */
const refusal = async (res: Response) => ((await res.json().catch(() => ({}))) as { message?: string }).message ?? `The Mergelight server answered ${res.status}.`;

async function changePlan(session: Session, orgId: number, plan: PlanName, seats: number): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/billing/change`, { method: 'POST', body: JSON.stringify({ plan, seats }) });
  if (!res.ok) throw new Error(await refusal(res));
}

async function freeForPublic(session: Session, orgId: number): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/billing/free`, { method: 'POST' });
  if (!res.ok) throw new Error(await refusal(res));
}

async function portalUrl(session: Session, orgId: number): Promise<string> {
  const res = await call(session, `/v1/orgs/${orgId}/billing/portal`, { method: 'POST' });
  if (!res.ok) throw new Error(await refusal(res));
  return ((await res.json()) as { url: string }).url;
}

const seatsOf = (text: string) => (/^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : NaN);
const goodSeats = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_SEATS;
const perMonth = (plan: PlanName, seats: number) => `$${PLANS[plan].price * seats} a month`;
const developers = (n: number) => `${n} ${n === 1 ? 'developer' : 'developers'}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

type SignedIn = (change: () => Promise<void>) => Promise<void>;

/**
 * Light or Pro, and how many developers, for an owner. Buy opens Paddle's checkout. After the payment
 * Paddle tells the server within seconds, and the page asks until the dashboard is on.
 */
export function PlanPicker({ session, billing, signedIn, onOn }: { session: Session; billing: Billing; signedIn: SignedIn; onOn: () => void }) {
  // An org on for free has the dashboard already: what it can buy that it lacks is Pro's Jobs.
  const [plan, setPlan] = useState<PlanName>(billing.free ? 'pro' : 'light');
  const [freeBusy, setFreeBusy] = useState(false);
  const [seats, setSeats] = useState('1');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = seatsOf(seats);
  const login = billing.org.login;

  useEffect(() => {
    if (!waiting) return;
    let gone = false;
    let tries = 0;
    const ask = async () => {
      if (gone) return;
      tries++;
      const got: { billing: Billing | null } = { billing: null };
      try {
        // Through signedIn: a session that runs out while the person pays signs them in again, and the page then shows the plan.
        await signedIn(async () => {
          got.billing = await loadBilling(session, billing.org.id);
        });
      } catch (err) {
        if (err instanceof SignedOut) return;
      }
      if (gone) return;
      const fresh = got.billing;
      // A plan that works, not only a dashboard that is on: an org on for free has that already, before Paddle's message.
      if (fresh?.subscription?.working) {
        toast.success(`${PLANS[plan].name} is on for ${login}`);
        onOn();
        return;
      }
      if (tries >= 60) {
        setWaiting(false);
        setError(`The payment went through, and Paddle hasn't told Mergelight yet. Reload this page in a minute. If ${login} is still off, write to hello@mergelight.dev.`);
        return;
      }
      setTimeout(() => void ask(), 2000);
    };
    void ask();
    return () => {
      gone = true;
    };
    // Asks again only when a new payment went through.
  }, [waiting]);

  const { paddle, checkout } = billing;
  if (!paddle) return null;
  if (!billing.can_manage || !checkout) return <ReadOnly>Only an owner of {login} can pick a plan.</ReadOnly>;
  if (waiting) {
    return (
      <p role="status" className="flex items-center gap-2.5 text-[14px] text-ink-3">
        <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" /> Payment done. Turning the dashboard on for {login}.
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      <div role="radiogroup" aria-label="Plan" className="grid gap-3 sm:grid-cols-2">
        {(['light', 'pro'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={plan === p}
            // As a radio group does: one stop for Tab, and the arrow keys move the choice.
            tabIndex={plan === p ? 0 : -1}
            onClick={() => setPlan(p)}
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
              e.preventDefault();
              const other = p === 'light' ? 'pro' : 'light';
              setPlan(other);
              (e.currentTarget.parentElement?.querySelector(`[data-plan=${other}]`) as HTMLElement | null)?.focus();
            }}
            data-plan={p}
            className={cn('flex flex-col justify-start rounded-[10px] p-4 text-left transition-colors', plan === p ? 'bg-panel shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)]' : 'bg-shell hairline hover:bg-strip')}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-[15px] font-medium text-ink">{PLANS[p].name}</span>
              <span className="text-[13px] text-ink-3 tabular-nums">${PLANS[p].price} per developer a month</span>
            </span>
            <span className="mt-1.5 block text-[13px] leading-relaxed text-ink-3">{PLANS[p].what}</span>
          </button>
        ))}
      </div>
      <Field label="Developers" hint={`The people who open pull requests in ${login}'s repositories. You can change it later.`}>
        <TextInput inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} className="w-32" />
      </Field>
      {error && (
        <p role="alert" className="text-[13px] text-blocked-ink">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          disabled={!goodSeats(n) || busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            // Asked again on the click: a page open for days holds signed data that ran out, or a plan another owner bought since.
            const got: { billing: Billing | null } = { billing: null };
            signedIn(async () => {
              got.billing = await loadBilling(session, billing.org.id);
            })
              .then(() => {
                const fresh = got.billing!;
                if (!fresh.paddle || !fresh.checkout) {
                  setError(fresh.subscription?.working ? `${login} has a working plan already. Reload the page to see it.` : `Only an owner of ${login} can pick a plan.`);
                  return;
                }
                return openCheckout({ env: fresh.paddle.env, clientToken: fresh.paddle.client_token, priceId: fresh.paddle.prices[plan], seats: n, customData: fresh.checkout }, () => setWaiting(true));
              })
              .catch((err: unknown) => {
                if (!(err instanceof SignedOut)) setError(err instanceof Error ? err.message : "Paddle's checkout didn't open.");
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Opening the checkout' : `Buy ${PLANS[plan].name}`}
        </Button>
        <span className="text-[13px] text-ink-3">{goodSeats(n) ? `${perMonth(plan, n)}, plus tax where it applies. Paddle takes the payment.` : `Pick 1 to ${MAX_SEATS} developers.`}</span>
      </div>
      {billing.covers === 'none' && (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-white/[0.06] pt-5">
          <p className="max-w-md text-[13.5px] leading-relaxed text-ink-3">Only public repositories? Light is free for them. Reviews of private repositories then work as they do now, without the dashboard.</p>
          <Button
            variant="outline"
            disabled={freeBusy}
            onClick={() => {
              setFreeBusy(true);
              setError(null);
              freeForPublic(session, billing.org.id)
                .then(() => {
                  toast.success(`Light is on for ${login}'s public repositories`);
                  onOn();
                })
                .catch((err: unknown) => setError(err instanceof SignedOut ? 'Your session ran out. Reload the page to sign in again.' : err instanceof Error ? err.message : 'That did not work.'))
                .finally(() => setFreeBusy(false));
            }}
          >
            {freeBusy ? 'Turning it on' : 'Turn on for free'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Changes the plan or the number of developers. Paddle charges or credits the difference for the rest of the month. */
function ChangePlan({ session, billing, signedIn, onChanged }: { session: Session; billing: Billing; signedIn: SignedIn; onChanged: () => void }) {
  const current = billing.subscription!;
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PlanName>(current.plan);
  const [seats, setSeats] = useState(String(current.seats));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = seatsOf(seats);
  const changed = plan !== current.plan || n !== current.seats;
  return (
    <FormDialog
      quiet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
        if (next) {
          setPlan(current.plan);
          setSeats(String(current.seats));
        }
      }}
      trigger="Change plan"
      triggerIcon={<PencilIcon />}
      title="Change the plan"
      description="Paddle charges the difference for the rest of the paid month now, on the card on file. A smaller plan leaves a credit toward the next payment."
      submit="Change"
      busyLabel="Changing"
      ready={goodSeats(n) && changed}
      busy={busy}
      error={error}
      onSubmit={() => {
        setBusy(true);
        setError(null);
        signedIn(() => changePlan(session, billing.org.id, plan, n))
          .then(() => {
            setOpen(false);
            toast.success(`${PLANS[plan].name}, ${developers(n)}`);
            onChanged();
          })
          .catch((err: unknown) => setError(err instanceof SignedOut ? 'Your session ran out. Signing you in again.' : err instanceof Error ? err.message : 'That did not work.'))
          .finally(() => setBusy(false));
      }}
    >
      <Field label="Plan">
        <Choose label="Plan" value={plan} onChange={(v) => setPlan(v as PlanName)} choices={(['light', 'pro'] as const).map((p) => ({ value: p, label: `${PLANS[p].name}, $${PLANS[p].price} per developer a month`, note: PLANS[p].what }))} placeholder="Pick a plan" />
      </Field>
      <Field label="Developers" hint={goodSeats(n) ? `${perMonth(plan, n)}, plus tax where it applies.` : `Pick 1 to ${MAX_SEATS} developers.`}>
        <TextInput inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} className="w-32" />
      </Field>
    </FormDialog>
  );
}

/** Opens Paddle's portal in a new tab: invoices, the card, the address, and cancel. The link works for a short while, so it is made on the click. */
export function PortalButton({ session, orgId, signedIn }: { session: Session; orgId: number; signedIn: SignedIn }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      className="gap-1.5"
      disabled={busy}
      onClick={() => {
        // Opened at once, inside the click, so the browser doesn't block it as a popup. The address comes when the server has it.
        const tab = window.open('', '_blank');
        setBusy(true);
        let url = '';
        signedIn(async () => {
          url = await portalUrl(session, orgId);
        })
          .then(() => {
            if (tab) tab.location.href = url;
            else window.location.assign(url);
          })
          .catch((err: unknown) => {
            tab?.close();
            if (!(err instanceof SignedOut)) toast.error(err instanceof Error ? err.message : "Paddle's portal didn't open.");
          })
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Opening' : 'Invoices, card and cancel'}
      <ExternalLinkIcon className="size-3.5" />
    </Button>
  );
}

/** The Billing card in Settings: the plan, what it costs, and what an owner can do about it. */
export function BillingCard({ session, billing, signedIn, onChanged }: { session: Session; billing: Billing; signedIn: SignedIn; onChanged: () => void }) {
  const { subscription: sub, org } = billing;
  let state: string;
  if (billing.free) state = `The dashboard is on for ${org.login} for free. There is nothing to pay.`;
  else if (billing.covers === 'public' && !sub?.working) state = `Light is on for ${org.login}'s public repositories, for free. Reviews of its private repositories don't use the dashboard: pick a plan for them.`;
  else if (sub?.working) {
    // The end of the paid month. Paddle renews then, unless an owner canceled: the date is true either way.
    const next = sub.current_period_end ? ` Paid until ${day(sub.current_period_end)}, and it renews then unless an owner cancels.` : '';
    const late = sub.status === 'past_due' ? ' The last payment failed, and Paddle tries again: check the card.' : '';
    state = `${PLANS[sub.plan].name} for ${developers(sub.seats)}, ${perMonth(sub.plan, sub.seats)} plus tax where it applies.${next}${late}`;
  } else if (sub) state = `The ${PLANS[sub.plan].name} plan for ${org.login} ${sub.status === 'paused' ? 'is paused' : 'ended'}. Reviews run without the rules, skills, checks and saved decisions on the dashboard, and nothing new can be added there. What is stored stays until an owner deletes it.`;
  else state = `${org.login} has no plan.`;
  return (
    <GlassCard label="Billing" icon={<CreditCardIcon className="size-4" />}>
      <p className="text-[14px] leading-relaxed text-ink-3">{state}</p>
      {/* An org the operator gives everything already has nothing to buy. */}
      {billing.can_manage && billing.paddle && (sub || (billing.checkout && !(billing.free && billing.jobs))) && (
        <div className="mt-5 grid gap-5">
          {billing.free && !sub?.working && billing.checkout && <p className="text-[13.5px] text-ink-3">Pro adds Jobs. Buying a plan keeps the dashboard as it is.</p>}
          {!sub?.working && billing.checkout && <PlanPicker session={session} billing={billing} signedIn={signedIn} onOn={onChanged} />}
          <div className="flex flex-wrap gap-2">
            {sub?.working && <ChangePlan session={session} billing={billing} signedIn={signedIn} onChanged={onChanged} />}
            {sub && <PortalButton session={session} orgId={org.id} signedIn={signedIn} />}
          </div>
        </div>
      )}
      {!billing.can_manage && !billing.free && (
        <div className="mt-5">
          <ReadOnly>Only an owner of {org.login} can change its plan.</ReadOnly>
        </div>
      )}
    </GlassCard>
  );
}
