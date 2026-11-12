import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FolderIcon } from '@/lib/icons';
import { SignedOut, type Session, type Skill, type Skills } from '../api';
import { WrittenSkillsSection } from '../WrittenSkills';
import { ViewHeader } from '../AppShell';
import { DataBody, DataCard, DataCell, Filler, DataHead, DataHeadCell, DataRow, DataTable, TwoLines } from '../DataTable';
import { ago } from '../format';
import { Choose, Code, Confirm, EmptyList, Facts, Field, FormDialog, lastRepo, markResume, ReadOnly, rememberRepo, Tag, TextInput, useDraft } from '../kit';

function NewSkillForm({ orgId, skills, onAdd, startOpen }: { orgId: number; skills: Skills; onAdd: (skill: { repo_id: number; path: string }) => Promise<void>; startOpen: boolean }) {
  // Picking a skill takes an admin of that repository, so only those repositories are offered.
  const places = skills.repos.filter((r) => r.can_pick_skills).map((r) => ({ value: String(r.id), label: r.name }));
  const allowed = places.map((p) => p.value);
  const [draft, setDraft, clear] = useDraft(`mergelight.dashboard.draft.${orgId}.skill`, { path: '', place: '' });
  const place = allowed.includes(draft.place) ? draft.place : lastRepo(orgId, allowed);
  const [open, setOpen] = useState(startOpen);
  // Opens when asked to, also when the view was already on screen.
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = draft.path.trim().length > 0 && place !== null;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
      trigger="New skill"
      title="Add a skill"
      description={
        <>
          Name a skill folder your team already has for Claude Code or Codex: the folder that holds its <Code>SKILL.md</Code>.
        </>
      }
      submit="Add skill"
      busyLabel="Adding"
      ready={ready}
      busy={busy}
      error={error}
      onSubmit={() => {
        if (!place) return;
        setBusy(true);
        setError(null);
        rememberRepo(orgId, place);
        onAdd({ repo_id: Number(place), path: draft.path.trim() })
          .then(() => {
            clear();
            setOpen(false);
            toast.success('Skill added');
          })
          .catch((err: unknown) => {
            if (err instanceof SignedOut) markResume('skills');
            setError(err instanceof SignedOut ? 'Your session ran out. Signing you in again: your text is kept.' : err instanceof Error ? err.message : 'That did not work.');
          })
          .finally(() => setBusy(false));
      }}
    >
      <Field label="Repository">
        <Choose label="Skill repository" value={place} onChange={(v) => setDraft({ place: v })} choices={places} placeholder="Pick a repository" />
      </Field>
      <Field label="The skill's folder" hint="The real folder in the repository, not a link to it.">
        <TextInput aria-label="Skill folder" value={draft.path} maxLength={200} onChange={(e) => setDraft({ path: e.target.value })} placeholder=".claude/skills/migrations" className="font-mono text-[13px]" />
      </Field>
    </FormDialog>
  );
}

export function SkillsView({ session, signedIn, orgId, skills, onRetry, onAdd, onRemove, resume }: { session: Session; signedIn: (change: () => Promise<void>) => Promise<void>; orgId: number; skills: Skills | null; onRetry: () => void; onAdd: (skill: { repo_id: number; path: string }) => Promise<void>; onRemove: (skill: Skill) => Promise<void>; resume: string | null }) {
  const mayAdd = !!skills && skills.repos.some((r) => r.can_pick_skills);
  return (
    <>
      <ViewHeader
        title="Skills"
        lead="A skill tells each review what your team knows about one area. Pick a skill folder your team already wrote for Claude Code or Codex, or write one here."
      />
      <div className="grid flex-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-stretch">
        <div className="flex min-w-0 flex-col">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-medium text-ink">Skill folders</h2>
            <p className="mt-1 text-[13px] text-ink-4">Read from your repository.</p>
          </div>
          {skills && mayAdd ? <NewSkillForm orgId={orgId} skills={skills} onAdd={onAdd} startOpen={resume === 'skills'} /> : skills ? <ReadOnly>Only an admin of a repository can pick its skills.</ReadOnly> : null}
        </div>
        {!skills ? (
          <EmptyList title="Your skill folders couldn't load">
            The Mergelight server answered with an error for this list.{' '}
            <button type="button" onClick={onRetry} className="text-foreground underline underline-offset-4">
              Try again
            </button>
          </EmptyList>
        ) : skills.skills.length === 0 ? (
          <EmptyList title="No skill folders yet">Add a skill folder, and every review of its repository reads it.</EmptyList>
        ) : (
          <DataCard>
            <DataTable>
            <DataHead>
              <DataHeadCell>Skill folder</DataHeadCell>
              <DataHeadCell className="hidden md:table-cell">Repository</DataHeadCell>
              <DataHeadCell className="w-24" aria-label="Actions" />
            </DataHead>
            <DataBody>
              {skills.skills.map((s) => (
                <DataRow key={s.id}>
                  <DataCell className="whitespace-normal">
                    <TwoLines icon={<FolderIcon />} main={<span className="break-all font-mono text-[13px]">{s.path}</span>} sub={
                        <>
                          picked by {s.by}, {ago(s.created_at)}
                          <span className="md:hidden">, {s.repo}</span>
                        </>
                      } />
                  </DataCell>
                  <DataCell className="hidden md:table-cell">
                    <Tag>{s.repo}</Tag>
                  </DataCell>
                  <DataCell className="text-right">
                    {s.can_remove && (
                      <Confirm
                        label="Remove skill"
                        ariaLabel={`Remove skill ${s.path}`}
                        title="Remove this skill?"
                        body="Reviews stop reading it. The folder stays in your repository."
                        confirm="Yes, remove"
                        busyLabel="Removing"
                        onConfirm={() =>
                          onRemove(s).then(
                            () => void toast.success('Skill removed'),
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
            </DataCard>
        )}
        <WrittenSkillsSection session={session} orgId={orgId} signedIn={signedIn} resume={resume === 'skills#write'} />
        </div>
        <Facts
          items={[
            "A skill is read from the branch a pull request merges into, so a pull request can't change the skill that reviews it.",
            "Only the folder's path is stored here. The skill's text stays in your repository.",
            'Name the real folder, not a link to it.',
            'The text of a skill written here is stored on the Mergelight server.',
            "A skill says what matters in its area. It can't change how a review treats the code in a pull request.",
          ]}
        />
      </div>
    </>
  );
}
