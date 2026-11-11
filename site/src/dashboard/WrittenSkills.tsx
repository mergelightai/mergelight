// Skills a team writes on the dashboard itself. They sit in the Skills view, under the skill folders
// a team picks from its repository. This part is in a file of its own, with its own calls to the
// server, so the rest of the page can change without it.

import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { call, NotConnected, SignedOut, type Session } from './api';
import { DataBody, DataCell, DataHead, DataHeadCell, DataRow, DataTable, TwoLines } from './DataTable';
import { ago } from './format';
import { Choose, Confirm, EmptyList, Field, FormDialog, lastRepo, markResume, ReadOnly, rememberRepo, Tag, TextInput, useDraft } from './kit';

/** A skill written on the dashboard. Its text is stored on the Mergelight server. */
export interface WrittenSkill {
  id: number;
  repo_id: number;
  repo: string;
  name: string;
  /** One line: when a reviewer should use it. */
  description: string;
  text: string;
  by: string;
  created_at: string;
  can_remove: boolean;
}

export interface WrittenSkills {
  skills: WrittenSkill[];
  /** Writing a skill takes an admin of that repository. */
  repos: { id: number; name: string; can_write_skills: boolean }[];
}

export interface NewWrittenSkill {
  repo_id: number;
  name: string;
  description: string;
  text: string;
}

/** The most a skill can hold, the same as the server allows. */
const TEXT_MAX = 8000;

/**
 * A skill is a page of text, and a session lasts 15 minutes. When it runs out, the page goes to
 * GitHub and comes back, which empties every form. So what is being written is kept in this tab
 * until it is saved.
 */
const DRAFT_KEY = 'mergelight.dashboard.written-skill';

export async function loadWrittenSkills(session: Session, orgId: number): Promise<WrittenSkills> {
  const res = await call(session, `/v1/orgs/${orgId}/written-skills`);
  if (res.status === 404 && ((await res.json()) as { error?: string }).error === 'not_connected') throw new NotConnected();
  if (!res.ok) throw new Error(`The Mergelight server answered ${res.status}.`);
  return (await res.json()) as WrittenSkills;
}

/** Saves a skill. Throws with the server's own words when it says no, so the person sees why. */
export async function addWrittenSkill(session: Session, orgId: number, skill: NewWrittenSkill): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/written-skills`, { method: 'POST', body: JSON.stringify(skill) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `The Mergelight server answered ${res.status}.`);
}

export async function removeWrittenSkill(session: Session, orgId: number, id: number): Promise<void> {
  const res = await call(session, `/v1/orgs/${orgId}/written-skills/${id}`, { method: 'DELETE' });
  // Already gone counts as done.
  if (!res.ok && res.status !== 404) throw new Error(`The Mergelight server answered ${res.status}.`);
}

function WriteSkillForm({ orgId, repos, onAdd, startOpen }: { orgId: number; repos: WrittenSkills['repos']; onAdd: (skill: NewWrittenSkill) => Promise<void>; startOpen: boolean }) {
  const places = repos.filter((r) => r.can_write_skills).map((r) => ({ value: String(r.id), label: r.name }));
  const allowed = places.map((p) => p.value);
  const [draft, setDraft, clear] = useDraft(`${DRAFT_KEY}.${orgId}`, { place: '', name: '', description: '', text: '' });
  const place = allowed.includes(draft.place) ? draft.place : lastRepo(orgId, allowed);
  const [open, setOpen] = useState(startOpen);
  // Opens when asked to, also when the view was already on screen.
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = draft.name.trim().length > 0 && draft.description.trim().length > 0 && draft.text.trim().length > 0 && place !== null;
  return (
    <FormDialog
      quiet
      wide
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
      trigger="Write a skill"
      title="Write a skill"
      description="A how-to for one area, with a line that says when to use it. Each review of that repository can read it."
      submit="Save skill"
      busyLabel="Saving"
      ready={ready}
      busy={busy}
      error={error}
      onSubmit={() => {
        if (!place) return;
        setBusy(true);
        setError(null);
        rememberRepo(orgId, place);
        onAdd({ repo_id: Number(place), name: draft.name.trim(), description: draft.description.trim(), text: draft.text.trim() })
          .then(() => {
            clear();
            setOpen(false);
            toast.success('Skill saved');
          })
          .catch((err: unknown) => {
            if (err instanceof SignedOut) markResume('skills#write');
            setError(err instanceof SignedOut ? 'Your session ran out. Signing you in again: your text is kept.' : err instanceof Error ? err.message : 'That did not work.');
          })
          .finally(() => setBusy(false));
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Repository">
          <Choose label="Written skill repository" value={place} onChange={(v) => setDraft({ place: v })} choices={places} placeholder="Pick a repository" />
        </Field>
        <Field label="A short name">
          <TextInput aria-label="Written skill name" value={draft.name} maxLength={40} onChange={(e) => setDraft({ name: e.target.value })} placeholder="Payments" />
        </Field>
      </div>
      <Field label="When to use it, in one line">
        <TextInput aria-label="Written skill description" value={draft.description} maxLength={300} onChange={(e) => setDraft({ description: e.target.value })} placeholder="Use when a pull request changes src/billing." />
      </Field>
      <Field label="The skill" hint={`${draft.text.length} of ${TEXT_MAX} characters`}>
        <Textarea
          aria-label="Written skill text"
          value={draft.text}
          maxLength={TEXT_MAX}
          rows={9}
          onChange={(e) => setDraft({ text: e.target.value })}
          placeholder={'What matters in this area, and how to check it.\n\n- A refund is never larger than its invoice.\n- Amounts are whole cents, never fractions.'}
          className="field-sizing-fixed max-h-[45vh] min-h-48 resize-y rounded-xl bg-white/[0.05] px-3.5 py-2.5 font-mono text-[13px] leading-6"
        />
      </Field>
    </FormDialog>
  );
}

/**
 * The skills written on the dashboard, as a section of the Skills view. It loads its own list.
 * signedIn runs a change and signs the person in again when the session ran out, the same way the
 * rest of the page does.
 */
export function WrittenSkillsSection({ session, orgId, signedIn, resume }: { session: Session; orgId: number; signedIn: (change: () => Promise<void>) => Promise<void>; resume: boolean }) {
  const [data, setData] = useState<WrittenSkills | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let gone = false;
    setData(null);
    // Through signedIn, so a session that ran out just before this call is renewed, like anywhere else on the page.
    // An org that isn't on has no list, and any other failure means no list either.
    signedIn(async () => {
      const loaded = await loadWrittenSkills(session, orgId);
      if (!gone) setData(loaded);
    }).catch(() => undefined);
    return () => {
      gone = true;
    };
    // signedIn is a new function on each render of the page. The list loads once for each session and org.
  }, [session, orgId]);

  if (!data) return null;
  const mayWrite = data.repos.some((r) => r.can_write_skills);
  return (
    <section className="flex flex-col xl:flex-1">
      <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-semibold">Written here</h2>
          <p className="mt-1 text-sm text-muted-foreground">For an area that has no skill folder in the repository.</p>
        </div>
        {mayWrite ? (
          <WriteSkillForm
            orgId={orgId}
            repos={data.repos}
            startOpen={resume}
            onAdd={async (skill) => {
              await signedIn(() => addWrittenSkill(session, orgId, skill));
              // The skill is in. If only the fresh list fails to load, that isn't a failed save.
              const fresh = await loadWrittenSkills(session, orgId).catch(() => null);
              if (fresh) setData(fresh);
            }}
          />
        ) : (
          <ReadOnly>Only an admin of a repository can write its skills.</ReadOnly>
        )}
      </div>
      {data.skills.length === 0 ? (
        <EmptyList title="Nothing written yet">Skills written here are for an area that has no skill folder in the repository.</EmptyList>
      ) : (
        <DataTable fill>
          <DataHead>
            <DataHeadCell>Skill</DataHeadCell>
            <DataHeadCell className="hidden md:table-cell">Repository</DataHeadCell>
            <DataHeadCell className="w-56" aria-label="Actions" />
          </DataHead>
          <DataBody>
            {data.skills.map((s) => (
              <Fragment key={s.id}>
                <DataRow>
                  <DataCell className="whitespace-normal">
                    <TwoLines main={s.name} sub={s.description} />
                    <p className="mt-1 text-xs text-muted-foreground/70">
                      written by {s.by}, {ago(s.created_at)}
                      <span className="md:hidden">, {s.repo}</span>
                    </p>
                  </DataCell>
                  <DataCell className="hidden md:table-cell">
                    <Tag>{s.repo}</Tag>
                  </DataCell>
                  <DataCell className="text-right whitespace-nowrap">
                    <button type="button" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)} className="rounded-full px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
                      {open === s.id ? 'Hide text' : 'Show text'}
                    </button>
                    {s.can_remove && (
                      <Confirm
                        label="Delete skill"
                        ariaLabel={`Delete skill ${s.name}`}
                        title="Delete this skill?"
                        body="Its text is deleted from the Mergelight server, and reviews stop reading it."
                        confirm="Yes, delete"
                        busyLabel="Deleting"
                        onConfirm={() =>
                          signedIn(() => removeWrittenSkill(session, orgId, s.id)).then(
                            () => {
                              setData((d) => (d ? { ...d, skills: d.skills.filter((x) => x.id !== s.id) } : d));
                              toast.success('Skill deleted');
                            },
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
                {open === s.id && (
                  <tr>
                    <td colSpan={3} className="border-t-0! px-6 pb-5">
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-2xl bg-black/20 px-4 py-3 font-mono text-[13px] leading-6 text-muted-foreground">{s.text}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </DataBody>
        </DataTable>
      )}
    </section>
  );
}
