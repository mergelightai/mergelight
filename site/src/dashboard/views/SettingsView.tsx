// The org's settings: its plan, and deleting everything Mergelight stores for it.
import { useState } from 'react';
import { TrashIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import type { Org, Session } from '../api';
import { ViewHeader } from '../AppShell';
import { BillingCard, type Billing } from '../Billing';
import { Code, GlassCard, ReadOnly, TextInput } from '../kit';

/**
 * Deleting takes the org's name typed again, as on GitHub: it can't be undone, so one stray click must not do it.
 * Only an owner of the org gets the form. Everyone else sees who can.
 */
export function SettingsView({
  org,
  canDelete,
  onDelete,
  session,
  billing,
  signedIn,
  onBillingChanged,
}: {
  org: Org;
  canDelete: boolean;
  onDelete: (confirm: string) => Promise<void>;
  session: Session;
  /** Null when the server couldn't say, or sells nothing and the org pays nothing. */
  billing: Billing | null;
  signedIn: (change: () => Promise<void>) => Promise<void>;
  onBillingChanged: () => void;
}) {
  const pays = billing?.subscription?.working === true;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // GitHub's names don't care about case, and the server doesn't either.
  const matches = typed.trim().toLowerCase() === org.login.toLowerCase();
  return (
    <>
      <ViewHeader title="Settings" />
      <div className="grid max-w-2xl gap-6">
        {billing && (billing.paddle || billing.subscription) && <BillingCard session={session} billing={billing} signedIn={signedIn} onChanged={onBillingChanged} />}
        <GlassCard label="Delete all data" icon={<TrashIcon className="size-4" />}>
          <p className="text-[14px] leading-relaxed text-ink-3">
            This deletes what Mergelight stores about {org.login}'s reviews and team: the numbers about each review, the rules, skills and checks, the decisions, and the log of changes. It happens at once, and it can't be undone.
          </p>
          {pays ? (
            <p className="mt-3 text-[14px] leading-relaxed text-ink-3">What {org.login} pays for stays on file, so the plan keeps running: the dashboard stays on, empty, and the next reviews are stored again. To stop paying, cancel the plan under Billing.</p>
          ) : (
            <p className="mt-3 text-[14px] leading-relaxed text-ink-3">
              The dashboard then turns off for {org.login}. Reviews keep working as before, and nothing more is stored.
              {billing?.subscription ? ' The record of the old plan stays on file: the plan, the number of developers and the payment company\'s ids, never a card.' : ''}
            </p>
          )}
          {canDelete ? (
            <form
              className="mt-5 grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!matches || busy) return;
                setBusy(true);
                setFailed(null);
                onDelete(typed.trim())
                  .catch((err: unknown) => setFailed(err instanceof Error ? err.message : 'The delete failed. Try again.'))
                  .finally(() => setBusy(false));
              }}
            >
              <label htmlFor="confirm-delete" className="text-[13.5px] text-ink-3">
                Type <Code>{org.login}</Code> to confirm.
              </label>
              <TextInput id="confirm-delete" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
              {failed && (
                <p role="alert" className="text-[13px] text-blocked-ink">
                  {failed}
                </p>
              )}
              <div>
                <Button type="submit" variant="destructive" disabled={!matches || busy}>
                  {busy ? 'Deleting…' : 'Delete the data'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-5">
              <ReadOnly>Only an owner of {org.login} can delete its data.</ReadOnly>
            </div>
          )}
        </GlassCard>
      </div>
    </>
  );
}
