import { randomUUID } from "node:crypto";
import type { PriorFinding, TeamCheck, TeamMemory, TeamRule } from "./prompt.js";
import { isSkillPath, isSkillText, withoutHidden, type WrittenSkill } from "./skills.js";
import type { Review } from "./types.js";

/**
 * The Mergelight server, for teams that use the dashboard. Off unless MERGELIGHT_SERVER is set.
 *
 * This program talks to the server, before the reviewing model starts and after it has finished.
 * The model never does: it has no network, no tool for it and no token.
 *
 * A run proves which repository it is with GitHub's OIDC token, so there is no key to store. Each
 * token is made for the one server it goes to, so no other server accepts it, and it is used once.
 *
 * Whatever goes wrong here must not stop or change the review. A server that is down, slow or
 * hostile costs a review a few seconds at most.
 */

/** Everything one question to the server may take: asking GitHub for tokens, both tries, and reading the answer. */
const DEADLINE_MS = 10_000;
/**
 * The largest answer that is read. A team's full set of rules and decisions fits well inside it,
 * so a team can't lose its rules by having many. Anything past it isn't an answer, and isn't read.
 */
const MAX_ANSWER = 512 * 1024;

export interface CloudDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Hides a value in the run's log. */
  mask?: (value: string) => void;
  /** For tests. */
  deadlineMs?: number;
}

/** What the server stores about one review: numbers and names from short fixed lists. No code, no text of a finding, no file paths. */
export interface ReviewNumbers {
  pr: number;
  sha: string;
  light: Review["light"];
  counts: { bug: number; risk: number; hardening: number };
  tiers: { post: number; list: number; decision: number };
  major: number;
  provider: "codex" | "claude";
  model: string | null;
  verifier: "codex" | "claude" | null;
  duration_ms: number;
  files_changed: number;
  additions: number;
  deletions: number;
}

/** The server checks a model's name against the same alphabet. */
const MODEL_NAME = /^[\w.:/@[\]-]{1,100}$/;

export function reviewNumbers(review: Review): ReviewNumbers {
  const n = (keep: (f: Review["findings"][number]) => boolean) => review.findings.filter(keep).length;
  const model = review.provider.model;
  return {
    pr: review.pr.number,
    sha: review.pr.head_sha,
    light: review.light,
    counts: { bug: n((f) => f.class === "bug"), risk: n((f) => f.class === "risk"), hardening: n((f) => f.class === "hardening") },
    tiers: { post: n((f) => f.tier === "post"), list: n((f) => f.tier === "list"), decision: n((f) => f.tier === "decision") },
    major: n((f) => f.severity === "major"),
    provider: review.provider.name,
    // A model name outside this plain alphabet isn't sent at all, so nothing typed into a setting can travel as text.
    // The brackets are for names like "sonnet[1m]".
    model: model && MODEL_NAME.test(model) ? model : null,
    verifier: review.verifier?.name ?? null,
    duration_ms: Math.round(review.stats.duration_ms),
    files_changed: review.stats.files_changed,
    additions: review.stats.additions,
    deletions: review.stats.deletions,
  };
}

/** The server's address, or null when it's off. Plain http is only for a server on this machine. */
export function serverUrl(env: Record<string, string | undefined>): URL | null {
  const raw = env.MERGELIGHT_SERVER?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || (url.protocol === "http:" && local) ? url : null;
}

/**
 * Who the OIDC token is made for: the server's own address, with its path if it's mounted under one.
 * Another Mergelight server refuses it, and so does the token server, so a token can't be passed on
 * to get anything anywhere else.
 */
export function audienceFor(server: URL): string {
  return server.origin + server.pathname.replace(/\/+$/, "");
}

function defaults(deps: CloudDeps) {
  const env = deps.env ?? process.env;
  return {
    env,
    fetchImpl: deps.fetchImpl ?? fetch,
    log: deps.log ?? (() => {}),
    // To stderr, where GitHub reads commands too, so it never lands in the review's JSON on stdout.
    mask: deps.mask ?? ((value: string) => void (env.GITHUB_ACTIONS === "true" && process.stderr.write(`::add-mask::${value}\n`))),
    deadlineMs: deps.deadlineMs ?? DEADLINE_MS,
  };
}

type Deps = ReturnType<typeof defaults>;

/** A new OIDC token from GitHub. The server takes each one once, so every request asks for its own. */
async function oidcToken(d: Deps, server: URL, signal: AbortSignal): Promise<string> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: at, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = d.env;
  if (!at || !bearer) throw new Error('the workflow needs "id-token: write" in its permissions');
  const url = new URL(at);
  url.searchParams.set("audience", audienceFor(server));
  const res = await d.fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` }, signal });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the OIDC token`);
  const { value } = (await res.json()) as { value?: string };
  if (!value) throw new Error("GitHub returned no OIDC token");
  d.mask(value);
  return value;
}

/** Reads a small JSON answer. A larger one is dropped unread, so a server can't fill this process's memory. */
async function readAnswer(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ANSWER) {
      await reader.cancel().catch(() => {});
      throw new Error("its answer is too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const drop = (res: Response) => res.body?.cancel().catch(() => {});

/** Keeps a path in the server's address, for a server mounted under one, like https://example.com/mergelight. */
export function endpoint(server: URL, path: string): URL {
  return new URL(server.pathname.replace(/\/+$/, "") + path, server.origin);
}

/** The server is off without a word when it isn't set. A setting that can't be used gets a line, or a typo would look like "on". */
function serverOrSay(d: Deps): URL | null {
  const server = serverUrl(d.env);
  if (!server && d.env.MERGELIGHT_SERVER?.trim()) d.log("The Mergelight server setting isn't an https:// address, so the server is off for this review.");
  return server;
}

/**
 * One question to the server, tried twice, each try with its own token, all inside one deadline.
 * A redirect is an error: the token is for this server and goes nowhere else.
 */
async function call(d: Deps, server: URL, path: string, init: { method: string; body?: string }): Promise<{ status: number; ok: boolean; answer: unknown }> {
  const signal = AbortSignal.timeout(d.deadlineMs);
  const late = () => new Error(`no answer within ${Math.round(d.deadlineMs / 1000)} seconds`);
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await d.fetchImpl(endpoint(server, path), {
        method: init.method,
        headers: { authorization: `Bearer ${await oidcToken(d, server, signal)}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body,
        redirect: "error",
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw late();
      if (attempt === 2) throw err;
      continue;
    }
    if (res.status >= 500 && attempt === 1) {
      await drop(res);
      continue;
    }
    if (!res.ok) {
      await drop(res);
      return { status: res.status, ok: false, answer: null };
    }
    // The server took the request. An answer that can't be read isn't a reason to send it again.
    try {
      return { status: res.status, ok: true, answer: await readAnswer(res) };
    } catch (err) {
      throw signal.aborted ? late() : err;
    }
  }
}

/** What the server gives a review before it starts. */
export interface CloudContext {
  /** Whether this repository's org uses the dashboard. False for everyone else, and whenever the server can't be asked. */
  connected: boolean;
  /** Findings the team declined in earlier pull requests of this repository. */
  memories: TeamMemory[];
  /** The rules the team set on the dashboard, for the org and for this repository. */
  rules: TeamRule[];
  /** Skill folders in this repository that the team picked for reviews. */
  skills: string[];
  /** The team's own checks for this repository. */
  checks: TeamCheck[];
  /** Skills the team wrote on its dashboard for this repository. */
  writtenSkills: WrittenSkill[];
  /** True when a server is set and it couldn't be asked. The review then says that it ran without the team's rules. */
  failed?: boolean;
}

const NOTHING: CloudContext = { connected: false, memories: [], rules: [], skills: [], checks: [], writtenSkills: [] };
/** One line of plain text: no line breaks and no control characters, so it can't pass for anything but itself. */
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(v);
const isLine = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000_000;

/**
 * The server's memories, each field checked. They go into the verifier's prompt, so one that isn't
 * shaped right is left out, however it got there.
 */
export function readMemories(value: unknown): TeamMemory[] {
  if (!Array.isArray(value)) return [];
  const memories: TeamMemory[] = [];
  for (const raw of value.slice(0, 200)) {
    const m = raw as Record<string, unknown> | null;
    if (!m || typeof m !== "object") continue;
    if (typeof m.id !== "string" || !/^M\d{1,12}$/.test(m.id) || !isText(m.title, 200) || !isText(m.file, 400) || !isLine(m.line) || !isText(m.reason, MAX_REASON)) continue;
    if (typeof m.by !== "string" || !/^[\w.-]{1,100}(\[bot\])?$/.test(m.by) || !isLine(m.pr)) continue;
    memories.push({ id: m.id, title: m.title, file: m.file, line: m.line, ...(isLine(m.end_line) ? { end_line: m.end_line } : {}), reason: m.reason, by: m.by, pr: m.pr });
  }
  return memories;
}

/** A pattern for file paths as the dashboard takes them: plain path characters and the wildcards * and ?. */
const isPattern = (v: unknown): v is string => typeof v === "string" && /^[\w.@+\-/*?]{1,100}$/.test(v);

/**
 * The team's rules, each field checked. A rule is an instruction to the reviewers by design, so its
 * shape is held tight: one line of plain text, and patterns made of path characters only.
 */
/**
 * The team's own checks, as the server sent them. One that isn't shaped right is left out: its name
 * ends up in the name of a check on GitHub and its text in a prompt, so both are held to their shapes here too.
 */
export function readChecks(value: unknown): TeamCheck[] {
  if (!Array.isArray(value)) return [];
  const checks: TeamCheck[] = [];
  for (const raw of value.slice(0, 50)) {
    if (checks.length === 5) break;
    const c = raw as Record<string, unknown> | null;
    if (!c || typeof c !== "object") continue;
    if (typeof c.id !== "string" || !/^K\d{1,12}$/.test(c.id) || !isText(c.text, 500)) continue;
    const checkText = withoutHidden(c.text);
    if (!checkText.trim()) continue;
    if (typeof c.name !== "string" || c.name.length > 40 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]| (?! ))*$/.test(c.name) || c.name.endsWith(" ")) continue;
    if (!Array.isArray(c.paths) || c.paths.length < 1 || c.paths.length > 10 || !c.paths.every(isPattern)) continue;
    if (checks.some((other) => other.name.toLowerCase() === (c.name as string).toLowerCase())) continue;
    checks.push({ id: c.id, name: c.name, text: checkText, paths: c.paths as string[] });
  }
  return checks;
}

/**
 * The skills a team wrote on its dashboard, as the server sent them. One that isn't shaped right is
 * left out: its name and description go into every prompt and its text into a file the reviewers read.
 */
export function readWrittenSkills(value: unknown): WrittenSkill[] {
  if (!Array.isArray(value)) return [];
  const skills: WrittenSkill[] = [];
  for (const raw of value.slice(0, 50)) {
    if (skills.length === 10) break;
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== "object") continue;
    // What a person can't see is taken out, so the reviewers read what the team read on its dashboard.
    const description = typeof s.description === "string" ? withoutHidden(s.description) : s.description;
    const text = typeof s.text === "string" ? withoutHidden(s.text) : s.text;
    if (typeof s.id !== "string" || !/^S\d{1,12}$/.test(s.id) || !isText(description, 300) || !isSkillText(text)) continue;
    if (typeof s.name !== "string" || s.name.length > 40 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]| (?! ))*$/.test(s.name) || s.name.endsWith(" ")) continue;
    if (skills.some((other) => other.name.toLowerCase() === (s.name as string).toLowerCase())) continue;
    skills.push({ id: s.id, name: s.name, description, text });
  }
  return skills;
}

export function readRules(value: unknown): TeamRule[] {
  if (!Array.isArray(value)) return [];
  const rules: TeamRule[] = [];
  for (const raw of value.slice(0, 100)) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== "object") continue;
    if (typeof r.id !== "string" || !/^R\d{1,12}$/.test(r.id) || !isText(r.text, 300)) continue;
    // A rule is never dropped for a character a person can't see: that character is taken out, and the rule stays.
    const ruleText = withoutHidden(r.text);
    if (!ruleText.trim()) continue;
    if ((r.kind !== "rule" && r.kind !== "needs_human") || (r.scope !== "org" && r.scope !== "repo")) continue;
    const paths = r.paths === undefined || r.paths === null ? [] : r.paths;
    if (!Array.isArray(paths) || paths.length > 10 || !paths.every(isPattern)) continue;
    // "Always needs a human" is about files, so one that names none says nothing.
    if (r.kind === "needs_human" && !paths.length) continue;
    rules.push({ id: r.id, kind: r.kind, text: ruleText, ...(paths.length ? { paths: paths as string[] } : {}), scope: r.scope });
  }
  return rules;
}

/** Asks the server what this review should know. Never throws: without an answer the review runs as it always has. */
export async function fetchContext(deps: CloudDeps = {}): Promise<CloudContext> {
  const d = defaults(deps);
  const server = serverOrSay(d);
  if (!server) return NOTHING;
  try {
    const res = await call(d, server, "/v1/context", { method: "GET" });
    if (!res.ok) {
      d.log(`The Mergelight server answered ${res.status}. The review runs without it.`);
      return { ...NOTHING, failed: true };
    }
    const answer = res.answer as { connected?: unknown; memories?: unknown; rules?: unknown; skills?: unknown; checks?: unknown; written_skills?: unknown } | null;
    if (answer?.connected !== true) return NOTHING;
    const skills = Array.isArray(answer.skills) ? answer.skills.filter(isSkillPath).slice(0, 10) : [];
    return { connected: true, memories: readMemories(answer.memories), rules: readRules(answer.rules), skills, checks: readChecks(answer.checks), writtenSkills: readWrittenSkills(answer.written_skills) };
  } catch (err) {
    d.log(`Couldn't reach the Mergelight server (${(err as Error).message}). The review runs without it.`);
    return { ...NOTHING, failed: true };
  }
}

/** True when this repository's org uses the dashboard. */
export async function cloudConnected(deps: CloudDeps = {}): Promise<boolean> {
  return (await fetchContext(deps)).connected;
}

/** The server reads 64 KB per report. The decisions get most of it, and the numbers always fit beside them. */
const MAX_DECLINE_BYTES = 48_000;
/** The longest reason sent and read. The server refuses a longer one, and with it the whole report. */
export const MAX_REASON = 1000;

/** A finding someone on the team chose not to fix, with their reason, as it is sent to the server to remember. */
export interface Decline {
  finding_id: string;
  title: string;
  file: string;
  line: number;
  end_line?: number;
  reason: string;
  by: string;
  /** When the person wrote it. A later decision about the same finding replaces an earlier one. */
  decided_at: string;
}

/**
 * The decisions on this pull request that are worth remembering: someone wrote a mark that says
 * "not fixing this" and gave a reason. A resolved thread has no reason, so it isn't one.
 */
export function declinesOf(previous: PriorFinding[] | undefined): Decline[] {
  // Line breaks and control characters become spaces: a reason is one line of plain text by the time it is sent.
  const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max).trim();
  const declines: Decline[] = [];
  for (const p of previous ?? []) {
    const h = p.handled;
    // A mark, or a reason someone gave when they resolved the thread. A plain resolve has no reason to keep.
    if (!h || h.as !== "wont_fix" || (h.from !== "mark" && h.from !== "reply") || !h.note?.trim()) continue;
    if (!/^[a-f0-9]{6,40}$/.test(p.id) || !/^[\w.-]{1,100}(\[bot\])?$/.test(h.by) || !isLine(p.line)) continue;
    const title = clean(p.title, 200);
    const file = clean(p.file, 400);
    // A person's own text, typed or pasted: characters nobody can see are taken out before anything reads it.
    const reason = clean(withoutHidden(h.note), MAX_REASON);
    const at = Date.parse(h.at ?? "");
    if (!title || !file || !reason || !Number.isFinite(at)) continue;
    declines.push({ finding_id: p.id, title, file, line: p.line, ...(isLine(p.end_line) ? { end_line: p.end_line } : {}), reason, by: h.by, decided_at: new Date(at).toISOString() });
  }
  // What fits one report, counted in bytes: a reason in another alphabet takes more of them than letters.
  const fit: Decline[] = [];
  let bytes = 0;
  for (const d of declines.slice(0, 40)) {
    bytes += Buffer.byteLength(JSON.stringify(d)) + 1;
    if (bytes > MAX_DECLINE_BYTES) break;
    fit.push(d);
  }
  return fit;
}

export interface ReportResult {
  /** Whether the server took the report. */
  stored: boolean;
  /**
   * The findings whose decision this report newly stored or replaced. Null when the server doesn't
   * say, as an older one doesn't: then nobody is told a decision was remembered.
   */
  remembered: string[] | null;
}

/**
 * Sends the review's numbers for the dashboard, with the team's new decisions to remember and the
 * earlier ones this review used.
 */
export async function reportReview(review: Review, deps: CloudDeps = {}, declines: Decline[] = []): Promise<ReportResult> {
  const d = defaults(deps);
  const server = serverUrl(d.env);
  if (!server) return { stored: false, remembered: null };
  try {
    // One id for this report, the same on both tries, so the server keeps it once.
    const used = (review.used_memories ?? []).filter((id) => /^M\d{1,12}$/.test(id)).slice(0, 200);
    const body = JSON.stringify({ ...reviewNumbers(review), report_id: randomUUID(), ...(declines.length ? { declines } : {}), ...(used.length ? { used_memories: used } : {}) });
    let res = await call(d, server, "/v1/reviews", { method: "POST", body });
    if (res.status === 400 && declines.length) {
      // The server refused something in the report. If it was a decision, the numbers still count: send
      // them again without any. An older server, for one, takes shorter reasons than this version sends.
      d.log("The Mergelight server refused the report with the team's decisions. Sending the numbers without them: the decisions aren't stored this time, and the next review of this pull request sends them again.");
      declines = [];
      res = await call(d, server, "/v1/reviews", { method: "POST", body: JSON.stringify({ ...JSON.parse(body), declines: undefined, report_id: randomUUID() }) });
    }
    d.log(res.ok ? "Sent this review's numbers to the Mergelight server." : `The Mergelight server answered ${res.status} to the review's numbers. The review itself is posted.`);
    if (!res.ok) return { stored: false, remembered: null };
    const said = (res.answer as { remembered?: unknown } | null)?.remembered;
    const sent = new Set(declines.map((x) => x.finding_id));
    // Only ids this report sent: the answer can't make Mergelight speak about any other finding.
    const remembered = Array.isArray(said) ? said.filter((id): id is string => typeof id === "string" && sent.has(id)) : null;
    return { stored: true, remembered };
  } catch (err) {
    d.log(`Couldn't send the review's numbers to the Mergelight server (${(err as Error).message}). The review itself is posted.`);
    return { stored: false, remembered: null };
  }
}
