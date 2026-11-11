import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { addCheck, addRule, addSkill, finishSignIn, forgetDecision, loadChecks, loadDecisions, loadOverview, loadRules, loadSkills, mayRenew, NotConnected, rememberedSession, removeCheck, removeRule, removeSkill, SignedOut, signInUrl, signOut, tidyAddress, type Checks, type Decision, type Overview, type Rules, type Session, type Skills } from './api';
import { AppShell, VIEWS, type ViewId } from './AppShell';
import { takeResume } from './kit';
import { ChecksView } from './views/ChecksView';
import { DecisionsView } from './views/DecisionsView';
import { ReviewsView } from './views/ReviewsView';
import { RulesView } from './views/RulesView';
import { SkillsView } from './views/SkillsView';
import { Centered, LoadError, NoOrg, NothingYet, NotOn, SignIn, Spinning } from './views/States';

const ALL_VIEWS = VIEWS.flatMap((g) => g.items.map((i) => i.id));
/** The view in the address, such as #rules, so a reload or a shared link opens the same view. */
function fromHash(): ViewId {
  const id = window.location.hash.slice(1) as ViewId;
  return ALL_VIEWS.includes(id) ? id : 'reviews';
}

type View = { kind: 'loading' } | { kind: 'ready'; at: number; overview: Overview; decisions: Decision[]; total: number; rules: Rules | null; skills: Skills | null; checks: Checks | null } | { kind: 'off' } | { kind: 'error' };

export default function Dashboard() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [session, setSession] = useState<Session | null>(() => (params.has('code') ? null : rememberedSession()));
  const [signingIn, setSigningIn] = useState(params.has('code'));
  const [failed, setFailed] = useState(false);
  // GitHub sends a cancelled sign-in back with an error and no code.
  const [cancelled] = useState(() => params.has('error') && !params.has('code'));
  const [orgId, setOrgId] = useState<number | null>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [tab, setTab] = useState<ViewId>(() => fromHash());
  const pickTab = (id: ViewId) => {
    setTab(id);
    window.history.replaceState(null, '', id === 'reviews' ? window.location.pathname : `#${id}`);
  };

  // Coming back from GitHub with a sign-in code.
  useEffect(() => {
    if (!params.has('code')) {
      if (params.has('error')) tidyAddress();
      return;
    }
    let gone = false;
    finishSignIn(params)
      .then((s) => !gone && setSession(s))
      .catch(() => !gone && setFailed(true))
      .finally(() => {
        tidyAddress();
        if (!gone) setSigningIn(false);
      });
    return () => {
      gone = true;
    };
  }, [params]);

  const org = useMemo(() => {
    const orgs = session?.orgs ?? [];
    return orgs.find((o) => o.id === orgId) ?? orgs.find((o) => o.connected) ?? orgs[0] ?? null;
  }, [session, orgId]);

  const load = useCallback(() => {
    if (!session || !org) return () => undefined;
    let gone = false;
    setView({ kind: 'loading' });
    // The reviews are the page. If only the list of decisions fails, they still show.
    const decisions = loadDecisions(session, org.id).catch((err) => {
      if (err instanceof SignedOut || err instanceof NotConnected) throw err;
      return { decisions: [], total: 0 };
    });
    const rules = loadRules(session, org.id).catch((err) => {
      if (err instanceof SignedOut || err instanceof NotConnected) throw err;
      return null;
    });
    const skills = loadSkills(session, org.id).catch((err) => {
      if (err instanceof SignedOut || err instanceof NotConnected) throw err;
      return null;
    });
    const checks = loadChecks(session, org.id).catch((err) => {
      if (err instanceof SignedOut || err instanceof NotConnected) throw err;
      return null;
    });
    Promise.all([loadOverview(session, org.id), decisions, rules, skills, checks])
      .then(([overview, { decisions, total }, rules, skills, checks]) => !gone && setView({ kind: 'ready', at: Date.now(), overview, decisions, total, rules, skills, checks }))
      .catch((err) => {
        if (gone) return;
        if (err instanceof SignedOut) {
          // The session ran out. GitHub sends a signed-in person straight back, so the page renews it by itself.
          if (mayRenew()) window.location.assign(signInUrl());
          else setSession(null);
        } else setView(err instanceof NotConnected ? { kind: 'off' } : { kind: 'error' });
      });
    return () => {
      gone = true;
    };
  }, [session, org]);
  useEffect(() => load(), [load]);

  /** Runs a change. If the session ran out while the page was open, it signs in again, as loading does. */
  const signedIn = async (change: () => Promise<void>): Promise<void> => {
    try {
      await change();
    } catch (err) {
      if (!(err instanceof SignedOut)) throw err;
      if (mayRenew()) window.location.assign(signInUrl());
      else setSession(null);
      // The change didn't happen. The page is on its way to a new sign-in, so there is nothing to show for it.
      throw err;
    }
  };


  // A form whose save was cut off by a new sign-in opens again, once, with its text.
  const [resume, setResume] = useState<string | null>(null);
  useEffect(() => {
    if (view.kind !== 'ready') return;
    // A view, and after a # which of its forms, such as "skills#write".
    const again = takeResume();
    const target = again?.split('#')[0] as ViewId | undefined;
    if (!again || !target || !ALL_VIEWS.includes(target)) return;
    pickTab(target);
    setResume(again);
    toast.info('You were signed in again. Your text is still there: save it once more.');
    // Runs once each time the data is ready.
  }, [view.kind]);

  if (signingIn) {
    return (
      <Centered>
        <Spinning>Signing you in</Spinning>
      </Centered>
    );
  }
  if (!session) {
    return (
      <Centered>
        <SignIn failed={failed} cancelled={cancelled} />
      </Centered>
    );
  }
  if (!org) {
    return (
      <Centered>
        <NoOrg />
      </Centered>
    );
  }

  const ready = view.kind === 'ready' ? view : null;
  return (
    <AppShell
      user={session.user}
      orgs={session.orgs}
      org={org}
      onPickOrg={setOrgId}
      view={tab}
      onView={(id) => {
        setResume(null);
        pickTab(id);
      }}
      loadedAt={ready ? ready.at : null}
      onRefresh={() => load()}
      onSignOut={() => {
        void signOut(session);
        setSession(null);
      }}
    >
      {view.kind === 'loading' && <Spinning>Loading reviews</Spinning>}
      {view.kind === 'off' && <NotOn org={org} />}
      {view.kind === 'error' && <LoadError onRetry={() => load()} />}
      {ready && tab === 'reviews' && (ready.overview.reviews.length ? <ReviewsView overview={ready.overview} /> : <NothingYet org={org} />)}
      {ready && tab === 'rules' && (ready.rules ? (
        <RulesView
          key={org.id}
          orgId={org.id}
          rules={ready.rules}
          resume={resume === 'rules'}
          onAdd={async (rule) => {
            await signedIn(() => addRule(session, org.id, rule));
            // The rule is in. If only the fresh list fails to load, that isn't a failed Add: saying so would invite a second one.
            const rules = await loadRules(session, org.id).catch(() => null);
            if (rules) setView((v) => (v.kind === 'ready' ? { ...v, rules } : v));
          }}
          onRemove={async (rule) => {
            await signedIn(() => removeRule(session, org.id, rule.id));
            setView((v) => (v.kind === 'ready' && v.rules ? { ...v, rules: { ...v.rules, rules: v.rules.rules.filter((x) => x.id !== rule.id) } } : v));
          }}
        />
      ) : <LoadError onRetry={() => load()} />)}
      {ready && tab === 'skills' && (ready.skills ? (
        <SkillsView
          key={org.id}
          session={session}
          signedIn={signedIn}
          orgId={org.id}
          skills={ready.skills}
          resume={resume}
          onAdd={async (skill) => {
            await signedIn(() => addSkill(session, org.id, skill));
            // The skill is in. If only the fresh list fails to load, that isn't a failed Add.
            const skills = await loadSkills(session, org.id).catch(() => null);
            if (skills) setView((v) => (v.kind === 'ready' ? { ...v, skills } : v));
          }}
          onRemove={async (skill) => {
            await signedIn(() => removeSkill(session, org.id, skill.id));
            setView((v) => (v.kind === 'ready' && v.skills ? { ...v, skills: { ...v.skills, skills: v.skills.skills.filter((x) => x.id !== skill.id) } } : v));
          }}
        />
      ) : <LoadError onRetry={() => load()} />)}
      {ready && tab === 'checks' && (ready.checks ? (
        <ChecksView
          key={org.id}
          orgId={org.id}
          checks={ready.checks}
          resume={resume === 'checks'}
          onAdd={async (check) => {
            await signedIn(() => addCheck(session, org.id, check));
            // The check is in. If only the fresh list fails to load, that isn't a failed Add.
            const checks = await loadChecks(session, org.id).catch(() => null);
            if (checks) setView((v) => (v.kind === 'ready' ? { ...v, checks } : v));
          }}
          onRemove={async (check) => {
            await signedIn(() => removeCheck(session, org.id, check.id));
            setView((v) => (v.kind === 'ready' && v.checks ? { ...v, checks: { ...v.checks, checks: v.checks.checks.filter((x) => x.id !== check.id) } } : v));
          }}
        />
      ) : <LoadError onRetry={() => load()} />)}
      {ready && tab === 'decisions' && (
        <DecisionsView
          decisions={ready.decisions}
          total={ready.total}
          onForget={async (d) => {
            await signedIn(() => forgetDecision(session, org.id, d.id));
            setView((v) => (v.kind === 'ready' ? { ...v, decisions: v.decisions.filter((x) => x.id !== d.id), total: v.total - 1 } : v));
          }}
        />
      )}
    </AppShell>
  );
}
