import { useState } from 'react';
import { toast } from 'sonner';
import { SignedOut, type NewRule, type Rule, type Rules } from '../api';
import { ViewHeader } from '../AppShell';
import { DataBody, DataCell, DataHead, DataHeadCell, DataRow, DataTable, TwoLines } from '../DataTable';
import { ago } from '../format';
import { Choose, Code, Confirm, EmptyList, Facts, Field, FormDialog, lastRepo, markResume, patterns, ReadOnly, rememberRepo, Tag, TextInput, useDraft, type Choice } from '../kit';

const KINDS: Choice[] = [
  { value: 'rule', label: 'A rule every review follows' },
  { value: 'needs_human', label: 'Files that always need a human' },
];

function NewRuleForm({ orgId, rules, onAdd, startOpen }: { orgId: number; rules: Rules; onAdd: (rule: NewRule) => Promise<void>; startOpen: boolean }) {
  // Only the places this person may set rules for can be picked. "Every repository" stays in the
  // list for someone who isn't an owner, greyed out, so the page says why instead of looking broken.
  const repos = rules.repos.filter((r) => r.can_set_rules);
  const places: Choice[] = [{ value: 'org', label: 'Every repository', disabled: !rules.can_set_org_rules, note: rules.can_set_org_rules ? undefined : 'Only an owner of the org can set this' }, ...repos.map((r) => ({ value: String(r.id), label: r.name }))];
  const allowed = places.filter((p) => !p.disabled).map((p) => p.value);
  const [draft, setDraft, clear] = useDraft(`mergelight.dashboard.draft.${orgId}.rule`, { kind: 'rule', text: '', paths: '', place: '' });
  const place = allowed.includes(draft.place) ? draft.place : lastRepo(orgId, allowed);
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = draft.kind as Rule['kind'];
  const files = patterns(draft.paths);
  const ready = draft.text.trim().length > 0 && (kind === 'rule' || files.length > 0) && place !== null;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
      trigger="New rule"
      title="Add a rule"
      description="A line every review follows, or files that always need a human."
      submit="Add"
      busyLabel="Adding"
      ready={ready}
      busy={busy}
      error={error}
      onSubmit={() => {
        if (!place) return;
        setBusy(true);
        setError(null);
        rememberRepo(orgId, place);
        onAdd({ kind, text: draft.text.trim(), paths: files, repo_id: place === 'org' ? null : Number(place) })
          .then(() => {
            clear();
            setOpen(false);
            toast.success(kind === 'rule' ? 'Rule added' : 'Files added: they always need a human');
          })
          .catch((err: unknown) => {
            if (err instanceof SignedOut) markResume('rules');
            setError(err instanceof SignedOut ? 'Your session ran out. Signing you in again: your text is kept.' : err instanceof Error ? err.message : 'That did not work.');
          })
          .finally(() => setBusy(false));
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What it is">
          <Choose label="What it is" value={kind} onChange={(v) => setDraft({ kind: v })} choices={KINDS} placeholder="Pick one" />
        </Field>
        <Field label="Where it applies">
          <Choose label="Where it applies" value={place} onChange={(v) => setDraft({ place: v })} choices={places} placeholder="Pick a repository" />
        </Field>
      </div>
      <Field label={kind === 'rule' ? 'The rule, in one line' : 'Why, in one line'}>
        <TextInput aria-label="The rule" value={draft.text} maxLength={300} onChange={(e) => setDraft({ text: e.target.value })} placeholder={kind === 'rule' ? 'Ignore style and naming.' : 'Billing changes need a second pair of eyes.'} />
      </Field>
      <Field label={kind === 'rule' ? 'Only in these files (optional)' : 'Which files'} hint="Patterns, split by commas.">
        <TextInput aria-label="Files" value={draft.paths} onChange={(e) => setDraft({ paths: e.target.value })} placeholder="src/billing/**, *.sql" className="font-mono text-[13px]" />
      </Field>
    </FormDialog>
  );
}

export function RulesView({ orgId, rules, onAdd, onRemove, resume }: { orgId: number; rules: Rules; onAdd: (rule: NewRule) => Promise<void>; onRemove: (rule: Rule) => Promise<void>; resume: boolean }) {
  const mayAdd = rules.can_set_org_rules || rules.repos.some((r) => r.can_set_rules);
  return (
    <>
      <ViewHeader
        eyebrow="Reviewer"
        title="Rules"
        lead={
          <>
            Use a rule for a line every review should follow, like "Ignore style and naming". Or name files that always need a human, so a pull request that changes them never goes green by itself.
          </>
        }
        action={mayAdd ? <NewRuleForm orgId={orgId} rules={rules} onAdd={onAdd} startOpen={resume} /> : <ReadOnly>Only an owner of the org or an admin of a repository can change the rules.</ReadOnly>}
      />
      <div className="grid flex-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-stretch">
        {rules.rules.length === 0 ? (
          <EmptyList title="No rules yet">Reviews follow Mergelight's own judgement until your team adds a rule.</EmptyList>
        ) : (
          <DataTable fill>
            <DataHead>
              <DataHeadCell>Rule</DataHeadCell>
              <DataHeadCell className="hidden md:table-cell">Where</DataHeadCell>
              <DataHeadCell className="hidden lg:table-cell">Files</DataHeadCell>
              <DataHeadCell className="w-24" aria-label="Actions" />
            </DataHead>
            <DataBody>
              {rules.rules.map((r) => (
                <DataRow key={r.id}>
                  <DataCell className="whitespace-normal">
                    <TwoLines
                      main={
                        <span className="flex flex-wrap items-center gap-2">
                          {r.text}
                          {r.kind === 'needs_human' && <Tag tone="human">Always needs a human</Tag>}
                        </span>
                      }
                      sub={
                        <>
                          set by {r.by}, {ago(r.created_at)}
                          <span className="md:hidden">, {r.repo ?? 'every repository'}</span>
                        </>
                      }
                    />
                  </DataCell>
                  <DataCell className="hidden md:table-cell">
                    <Tag>{r.repo ?? 'Every repository'}</Tag>
                  </DataCell>
                  <DataCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">{r.paths.length ? r.paths.join(', ') : 'All files'}</DataCell>
                  <DataCell className="text-right">
                    {r.can_remove && (
                      <Confirm
                        label="Remove"
                        title="Remove this rule?"
                        body="Reviews stop following it from the next pull request on."
                        confirm="Yes, remove"
                        busyLabel="Removing"
                        onConfirm={() =>
                          onRemove(r).then(
                            () => void toast.success('Rule removed'),
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
            <>
              "Needs a human" stops a merge only where the Mergelight check is required and the workflow sets <Code>yellow-blocks: true</Code>. Without that it is a warning on the pull request.
            </>,
            'A rule for one repository applies there only. A rule for every repository needs an owner of the org.',
          ]}
        />
      </div>
    </>
  );
}
