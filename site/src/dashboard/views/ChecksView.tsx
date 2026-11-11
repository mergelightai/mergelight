import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SignedOut, type Check, type Checks, type NewCheck } from '../api';
import { ViewHeader } from '../AppShell';
import { DataBody, DataCell, DataHead, DataHeadCell, DataRow, DataTable, TwoLines } from '../DataTable';
import { ago } from '../format';
import { Choose, Code, Confirm, EmptyList, Facts, Field, FormDialog, lastRepo, markResume, patterns, ReadOnly, rememberRepo, Tag, TextInput, useDraft } from '../kit';

function NewCheckForm({ orgId, checks, onAdd, startOpen }: { orgId: number; checks: Checks; onAdd: (check: NewCheck) => Promise<void>; startOpen: boolean }) {
  // Setting a check takes an admin of that repository, so only those repositories are offered.
  const places = checks.repos.filter((r) => r.can_set_checks).map((r) => ({ value: String(r.id), label: r.name }));
  const allowed = places.map((p) => p.value);
  const [draft, setDraft, clear] = useDraft(`mergelight.dashboard.draft.${orgId}.check`, { name: '', text: '', paths: '', place: '' });
  const place = allowed.includes(draft.place) ? draft.place : lastRepo(orgId, allowed);
  const [open, setOpen] = useState(startOpen);
  // Opens when asked to, also when the view was already on screen.
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = patterns(draft.paths);
  const ready = draft.name.trim().length > 0 && draft.text.trim().length > 0 && files.length > 0 && place !== null;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
      trigger="New check"
      title="Add a check"
      description="One question in plain words, about some files. Each review answers it on the pull request, passed or failed."
      submit="Add check"
      busyLabel="Adding"
      ready={ready}
      busy={busy}
      error={error}
      onSubmit={() => {
        if (!place) return;
        setBusy(true);
        setError(null);
        rememberRepo(orgId, place);
        onAdd({ repo_id: Number(place), name: draft.name.trim(), text: draft.text.trim(), paths: files })
          .then(() => {
            clear();
            setOpen(false);
            toast.success('Check added');
          })
          .catch((err: unknown) => {
            if (err instanceof SignedOut) markResume('checks');
            setError(err instanceof SignedOut ? 'Your session ran out. Signing you in again: your text is kept.' : err instanceof Error ? err.message : 'That did not work.');
          })
          .finally(() => setBusy(false));
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Repository">
          <Choose label="Check repository" value={place} onChange={(v) => setDraft({ place: v })} choices={places} placeholder="Pick a repository" />
        </Field>
        <Field label="A short name" hint={draft.name.trim() ? <>Shows as <Code>Mergelight: {draft.name.trim()}</Code></> : undefined}>
          <TextInput aria-label="Check name" value={draft.name} maxLength={40} onChange={(e) => setDraft({ name: e.target.value })} placeholder="Translations" />
        </Field>
      </div>
      <Field label="The check, in one line">
        <TextInput aria-label="The check" value={draft.text} maxLength={500} onChange={(e) => setDraft({ text: e.target.value })} placeholder="Every new text in en.json has a translation in da.json." />
      </Field>
      <Field label="Which files it is about" hint="The check runs only when a pull request changes one of these. Patterns, split by commas.">
        <TextInput aria-label="Check files" value={draft.paths} onChange={(e) => setDraft({ paths: e.target.value })} placeholder="src/i18n/**" className="font-mono text-[13px]" />
      </Field>
    </FormDialog>
  );
}

export function ChecksView({ orgId, checks, onAdd, onRemove, resume }: { orgId: number; checks: Checks; onAdd: (check: NewCheck) => Promise<void>; onRemove: (check: Check) => Promise<void>; resume: boolean }) {
  const mayAdd = checks.repos.some((r) => r.can_set_checks);
  return (
    <>
      <ViewHeader
        eyebrow="Reviewer"
        title="Checks"
        lead={
          <>
            Use a check for one yes or no question about some files. Each review asks it on its own and posts the answer on the pull request as a check named <Code>Mergelight: your name</Code>, passed or failed with the places to fix.
          </>
        }
        action={mayAdd ? <NewCheckForm orgId={orgId} checks={checks} onAdd={onAdd} startOpen={resume} /> : <ReadOnly>Only an admin of a repository can set its checks.</ReadOnly>}
      />
      <div className="grid flex-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-stretch">
        {checks.checks.length === 0 ? (
          <EmptyList title="No checks yet">Add a check, and each review of its files answers it on the pull request.</EmptyList>
        ) : (
          <DataTable fill>
            <DataHead>
              <DataHeadCell>Check</DataHeadCell>
              <DataHeadCell className="hidden md:table-cell">Repository</DataHeadCell>
              <DataHeadCell className="hidden lg:table-cell">Files</DataHeadCell>
              <DataHeadCell className="w-24" aria-label="Actions" />
            </DataHead>
            <DataBody>
              {checks.checks.map((c) => (
                <DataRow key={c.id}>
                  <DataCell className="whitespace-normal">
                    <TwoLines main={c.name} sub={c.text} />
                    <p className="mt-1 text-xs text-muted-foreground/70">
                      set by {c.by}, {ago(c.created_at)}
                      <span className="md:hidden">, {c.repo}</span>
                      <span className="block font-mono lg:hidden">{c.paths.join(', ')}</span>
                    </p>
                  </DataCell>
                  <DataCell className="hidden md:table-cell">
                    <Tag>{c.repo}</Tag>
                  </DataCell>
                  <DataCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">{c.paths.join(', ')}</DataCell>
                  <DataCell className="text-right">
                    {c.can_remove && (
                      <Confirm
                        label="Remove check"
                        ariaLabel={`Remove check ${c.name}`}
                        title="Remove this check?"
                        body={
                          <>
                            Reviews stop posting <Code>Mergelight: {c.name}</Code>. If your branch rules require it, take it out there too, or pull requests will wait for it.
                          </>
                        }
                        confirm="Yes, remove"
                        busyLabel="Removing"
                        onConfirm={() =>
                          onRemove(c).then(
                            () => void toast.success('Check removed'),
                            (err: unknown) => {
                              if (!(err instanceof SignedOut)) toast.error("That didn't work. Please try again.");
                              throw err;
                            },
                          )
                        }
                      />
                    )}
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        )}
        <Facts
          items={[
            'A check runs only when a pull request changes its files.',
            'Each run is one more AI run on your own plan.',
            'It reports, and never changes code.',
            "To make it stop a merge, require that check in your branch rules on GitHub. Pick the app that posts it as the check's source there, so nothing else can post a check of that name.",
            "Only a real pass gets through then: a check that couldn't tell or couldn't run holds the merge too.",
          ]}
        />
      </div>
    </>
  );
}
