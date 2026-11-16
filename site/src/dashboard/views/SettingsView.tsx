// The org's settings. For now one thing: deleting everything Mergelight stores for it.
import { useState } from 'react';
import { TrashIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import type { Org } from '../api';
import { ViewHeader } from '../AppShell';
import { Code, GlassCard, ReadOnly, TextInput } from '../kit';

/**
 * Deleting takes the org's name typed again, as on GitHub: it can't be undone, so one stray click must not do it.
 * Only an owner of the org gets the form. Everyone else sees who can.
 */
export function SettingsView({ org, canDelete, onDelete }: { org: Org; canDelete: boolean; onDelete: (confirm: string) => Promise<void> }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // GitHub's names don't care about case, and the server doesn't either.
  const matches = typed.trim().toLowerCase() === org.login.toLowerCase();
  return (
    <>
      <ViewHeader title="Settings" />
      <div className="grid max-w-2xl gap-6">
        <GlassCard label="Delete all data" icon={<TrashIcon className="size-4" />}>
          <p className="text-[14px] leading-relaxed text-ink-3">
            This deletes everything Mergelight stores for {org.login}: the numbers about each review, the rules, skills and checks, the decisions, and the log of changes. It happens at once, and it can't be undone.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-3">The dashboard then turns off for {org.login}. Reviews keep working as before, and nothing more is stored.</p>
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
                  {busy ? 'Deleting…' : 'Delete everything'}
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
