// Skills a team writes on the dashboard itself. Next to the Skills card, where a team picks skill
// folders that are in its repository. This card is in a file of its own, with its own calls to the
// server, so the rest of the page can change without it.

import { useEffect, useState } from 'react';
import { SURFACE, WELL } from '../ui';
import { call, NotConnected, type Session } from './api';

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
type Draft = { place: string; name: string; description: string; text: string };

function draft(): Partial<Draft> {
  try {
    const kept = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}') as Partial<Draft> | null;
    return kept && typeof kept === 'object' ? kept : {};
  } catch {
    return {};
  }
}

function keepDraft(value: Draft | null): void {
  try {
    if (value && (value.name || value.description || value.text)) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* Without storage a draft doesn't outlast a new sign-in. */
  }
}

const text_ = (v: unknown) => (typeof v === 'string' ? v : '');

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

const FIELD = 'w-full rounded-xl bg-white/[0.04] px-3.5 text-[14px] text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_rgb(184_156_255/0.6)]';
const PRIMARY = 'inline-flex h-10 items-center justify-center gap-2.5 rounded-full bg-fg px-5 text-[14px] font-medium text-ink transition-colors hover:bg-white disabled:opacity-40';

function when(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function NewWrittenSkillForm({ repos, onAdd }: { repos: WrittenSkills['repos']; onAdd: (skill: NewWrittenSkill) => Promise<void> }) {
  const places = repos.filter((r) => r.can_write_skills);
  const [kept] = useState(draft);
  const [place, setPlace] = useState(() => (places.some((p) => String(p.id) === kept.place) ? text_(kept.place) : places[0] ? String(places[0].id) : ''));
  const [name, setName] = useState(() => text_(kept.name).slice(0, 40));
  const [description, setDescription] = useState(() => text_(kept.description).slice(0, 300));
  const [text, setText] = useState(() => text_(kept.text).slice(0, TEXT_MAX));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => keepDraft({ place, name, description, text }), [place, name, description, text]);
  if (!places.length) {
    return <p className="mt-5 text-[13px] leading-relaxed text-faint">Only an admin of a repository can write its skills.</p>;
  }
  const ready = name.trim().length > 0 && description.trim().length > 0 && text.trim().length > 0 && !busy;
  return (
    <form
      className={`${WELL} mt-5 space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setError(null);
        onAdd({ repo_id: Number(place), name: name.trim(), description: description.trim(), text: text.trim() })
          .then(() => {
            setName('');
            setDescription('');
            setText('');
          })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That did not work.'))
          .finally(() => setBusy(false));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px] text-muted">
          Repository
          <select aria-label="Written skill repository" value={place} onChange={(e) => setPlace(e.target.value)} className={`${FIELD} mt-1.5 h-10`}>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[13px] text-muted">
          A short name
          <input aria-label="Written skill name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Payments" className={`${FIELD} mt-1.5 h-10`} />
        </label>
      </div>
      <label className="block text-[13px] text-muted">
        When to use it, in one line
        <input aria-label="Written skill description" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Use when a pull request changes src/billing." className={`${FIELD} mt-1.5 h-10`} />
      </label>
      <label className="block text-[13px] text-muted">
        The skill
        <textarea
          aria-label="Written skill text"
          value={text}
          maxLength={TEXT_MAX}
          rows={8}
          onChange={(e) => setText(e.target.value)}
          placeholder={'What matters in this area, and how to check it.\n\n- A refund is never larger than its invoice.\n- Amounts are whole cents, never fractions.'}
          className={`${FIELD} mt-1.5 py-2.5 font-mono text-[13px] leading-6`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button type="submit" disabled={!ready} className={PRIMARY}>
          {busy ? 'Saving' : 'Save skill'}
        </button>
        <span className="text-[12.5px] text-faint">
          {text.length} of {TEXT_MAX} characters
        </span>
        {error && <span className="text-[13px] text-risk">{error}</span>}
      </div>
    </form>
  );
}

/**
 * The card. It loads its own list. signedIn runs a change and signs the person in again when the
 * session ran out, the same way the rest of the page does.
 */
export function WrittenSkillsCard({ session, orgId, signedIn }: { session: Session; orgId: number; signedIn: (change: () => Promise<void>) => Promise<void> }) {
  const [data, setData] = useState<WrittenSkills | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);

  useEffect(() => {
    let gone = false;
    setData(null);
    // Through signedIn, so a session that ran out just before this call is renewed, like anywhere else on the page.
    // An org that isn't on has no card, and any other failure means no card either.
    signedIn(async () => {
      const loaded = await loadWrittenSkills(session, orgId);
      if (!gone) setData(loaded);
    }).catch(() => undefined);
    return () => {
      gone = true;
    };
    // signedIn is a new function on each render of the page. The card loads once for each session and org.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, orgId]);

  if (!data) return null;
  return (
    <section className={`${SURFACE} p-6 sm:p-7`}>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Skills written here</h2>
      <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-muted">
        Write a skill on this page when it isn't a folder in your repository: a how-to for one area, with a line that says when to use it. Each review of that repository can read it.
      </p>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-faint">
        The text of a skill written here is stored on the Mergelight server. A skill says what matters in its area. It can't change how a review treats the code in a pull request.
      </p>
      {data.skills.length > 0 && (
        <ul className="mt-3">
          {data.skills.map((s) => (
            <li key={s.id} className="border-t border-line py-3.5 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-[320px]">
                  <p className="text-[15px] text-fg">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-muted"> · {s.description}</span>
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-faint">
                    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-muted">{s.repo}</span>
                    <span>
                      written by {s.by}, {when(s.created_at)}
                    </span>
                  </p>
                  {failed === s.id && <p className="mt-2 text-[13px] text-risk">That didn't work. Please try again.</p>}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-expanded={open === s.id}
                    onClick={() => setOpen(open === s.id ? null : s.id)}
                    className="rounded-full px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
                  >
                    {open === s.id ? 'Hide text' : 'Show text'}
                  </button>
                  {s.can_remove && (
                    <button
                      type="button"
                      aria-label={`Delete skill ${s.name}`}
                      disabled={busy === s.id}
                      onClick={() => {
                        setBusy(s.id);
                        setFailed(null);
                        signedIn(() => removeWrittenSkill(session, orgId, s.id))
                          .then(() => setData((d) => (d ? { ...d, skills: d.skills.filter((x) => x.id !== s.id) } : d)))
                          .catch(() => setFailed(s.id))
                          .finally(() => setBusy(null));
                      }}
                      className="rounded-full px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-50"
                    >
                      {busy === s.id ? 'Deleting' : 'Delete skill'}
                    </button>
                  )}
                </div>
              </div>
              {open === s.id && <pre className={`${WELL} mt-3 max-h-80 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[13px] leading-6 text-muted`}>{s.text}</pre>}
            </li>
          ))}
        </ul>
      )}
      <NewWrittenSkillForm
        repos={data.repos}
        onAdd={async (skill) => {
          await signedIn(() => addWrittenSkill(session, orgId, skill));
          // The skill is in. If only the fresh list fails to load, that isn't a failed save.
          const fresh = await loadWrittenSkills(session, orgId).catch(() => null);
          if (fresh) setData(fresh);
        }}
      />
    </section>
  );
}
