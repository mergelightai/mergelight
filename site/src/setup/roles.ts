/**
 * Which AI reviews and which one checks the findings, as a repo's workflow sets them. No imports and only plain
 * types, so a Node test can load this file as it is.
 */

export type Ai = 'claude' | 'codex';

export interface Roles {
  reviewer: Ai;
  checker: Ai;
}

/** Which AIs have a login the Action gets. */
export interface Logins {
  claude: boolean;
  codex: boolean;
}

/** What the Mergelight step's `with:` sets. Null where it doesn't set a plain claude or codex. */
export interface SetRoles {
  provider: Ai | null;
  verifyWith: Ai | null;
}

/** Each AI's login inputs: its plan's login first, then its API key. */
export const LOGIN_INPUTS: Record<Ai, [string, string]> = {
  codex: ['codex-auth-json', 'openai-api-key'],
  claude: ['claude-code-oauth-token', 'anthropic-api-key'],
};
/** The secret each login input reads in a workflow this page can change, the one setup writes. */
export const LOGIN_SECRET: Record<string, string> = {
  'codex-auth-json': 'CODEX_AUTH_JSON',
  'openai-api-key': 'OPENAI_API_KEY',
  'claude-code-oauth-token': 'CLAUDE_CODE_OAUTH_TOKEN',
  'anthropic-api-key': 'ANTHROPIC_API_KEY',
};

/**
 * Whether a login input's secret is one this page counts. A ChatGPT plan's login the repo only gets from its organization
 * doesn't count: a review can't refresh it without signing out the other repos that share it, so the repo needs its own.
 * An API key has nothing to refresh, so the organization's counts. `shared` is the organization's secrets.
 */
const counts = (input: string, secretNames: string[], shared: string[]) => secretNames.includes(LOGIN_SECRET[input]!) && !(input === LOGIN_INPUTS.codex[0] && shared.includes(LOGIN_SECRET[input]!));

/**
 * The Action uses a ChatGPT plan's login before an OpenAI key, so when the one it would get is the organization's, an
 * API key never gets used, and ChatGPT still needs a login of the repo's own. `inputs` is what the workflow passes on.
 */
const sharedPlanWins = (inputs: string[], secretNames: string[], shared: string[]) => {
  const plan = LOGIN_INPUTS.codex[0];
  return inputs.includes(plan) && secretNames.includes(LOGIN_SECRET[plan]!) && shared.includes(LOGIN_SECRET[plan]!);
};

/** Which AIs have a login, from the secrets' names, for a workflow that hands every login input its own secret. */
export const loginsFrom = (secretNames: string[], shared: string[] = []): Logins => ({
  claude: LOGIN_INPUTS.claude.some((input) => counts(input, secretNames, shared)),
  codex: !sharedPlanWins(Object.keys(LOGIN_SECRET), secretNames, shared) && LOGIN_INPUTS.codex.some((input) => counts(input, secretNames, shared)),
});

export const otherAi = (ai: Ai): Ai => (ai === 'claude' ? 'codex' : 'claude');

/** The name people know. Codex runs on a ChatGPT login or an OpenAI key. */
export const aiName = (ai: Ai) => (ai === 'claude' ? 'Claude' : 'ChatGPT');

/** The AI the Action reviews with when the workflow doesn't say: Claude only when Claude is the only login. */
export const defaultReviewer = (logins: Logins): Ai => (logins.claude && !logins.codex ? 'claude' : 'codex');

/**
 * Who reviews and who checks, with the Action's own defaults for what the workflow leaves out. With a login for
 * both, the other AI checks. Otherwise the reviewer checks its own findings. A value in the workflow always wins.
 */
export function rolesFor(set: SetRoles, logins: Logins): Roles {
  const reviewer = set.provider ?? defaultReviewer(logins);
  const checker = set.verifyWith ?? (logins.claude && logins.codex ? otherAi(reviewer) : reviewer);
  return { reviewer, checker };
}

/**
 * Whether the login for `adding` has to wait until the pull request that sets `want` is merged. A login is a secret of
 * the whole repo, so it reaches the workflow that runs now at once. When that workflow doesn't name the reviewer, the
 * new login can move its reviews to the other AI before anyone merges the change: also when moving them is the person's
 * own choice, since nobody has approved it yet.
 */
export function connectsAfterMerge(set: SetRoles, logins: Logins, _want: Roles, adding: Ai | null): boolean {
  if (!adding) return false;
  return rolesFor(set, { ...logins, [adding]: true }).reviewer !== rolesFor(set, logins).reviewer;
}

/* ---------- Reading and editing the Mergelight step ---------- */

/** A real step that runs the Action. A line in a comment, or with anything after the version, isn't one. */
const USES = /^( *)(- +)?uses:[ \t]*(["']?)mergelightai\/mergelight@[^\s#"']+\3[ \t]*(?:#.*)?$/;
/** A blank line or a comment, which never ends or starts anything. */
const NOTE = /^[ \t]*(?:#.*)?$/;

interface Entry {
  key: string;
  /** Its first line, and the line after its last. A value can go on over more lines. */
  start: number;
  end: number;
}

interface Step {
  /** Each line with its own line ending, so the parts nobody touches come out byte for byte. */
  lines: string[];
  text: string[];
  /** The step's first line, with its dash. */
  start: number;
  usesLine: number;
  /** Where the step's own keys start, like `uses` and `with`. */
  keyCol: number;
  withLine: number | null;
  /** Where the keys inside `with:` start. */
  childIndent: number;
  entries: Entry[];
  /** The line after the last value in `with:`. */
  blockEnd: number;
}

const indentOf = (line: string) => line.match(/^ */)![0].length;
/** A key whose value is a block scalar, `|` or `>`. An anchor or a tag can come before it, as in `run: &fixture |`. */
const OPENS_SCALAR = /:[ \t]*(?:[&!]\S*[ \t]+)*[|>][-+0-9]*[ \t]*(?:#.*)?$/;
/** Where a line's key starts: after its indent, and after a sequence dash if it has one. */
const keyColumn = (line: string) => line.match(/^ *(?:- +)?/)![0].length;

/**
 * Whether this line is text inside a block scalar, like a `run: |` script or a heredoc in one: a line above it that's
 * set in less than it opens `|` or `>`. Such a line only looks like a step.
 */
function insideScalar(text: string[], at: number): boolean {
  let least = indentOf(text[at]!);
  for (let i = at - 1; i >= 0 && least > 0; i--) {
    const t = text[i]!;
    // A key after a sequence dash starts where the key does, so `- if: >-` is a sibling of the `uses` below it.
    if (NOTE.test(t) || keyColumn(t) >= least) continue;
    if (OPENS_SCALAR.test(t)) return true;
    least = indentOf(t);
  }
  return false;
}

/** Whether a line that looks like the Mergelight step is text inside a block scalar, which makes the file one set up its own way. */
export const stepInScalar = (content: string) => {
  const text = content.split(/\r?\n/);
  return text.some((t, i) => USES.test(t) && insideScalar(text, i));
};

/**
 * Finds the one step that runs the Action, and the values in its `with:`. Null when there isn't exactly one such
 * step, or its shape is one this doesn't edit, like `with: { ... }`. Better to say so than to guess.
 */
function locate(content: string): Step | null {
  const lines = content.split(/(?<=\n)/);
  const text = lines.map((l) => l.replace(/\r?\n$/, ''));
  // Only a real step: one inside a script's text is an example.
  const uses = text.flatMap((t, i) => (USES.test(t) && !insideScalar(text, i) ? [i] : []));
  if (uses.length !== 1) return null;
  const usesLine = uses[0]!;
  const m = text[usesLine]!.match(USES)!;
  const keyCol = m[1]!.length + (m[2]?.length ?? 0);

  // The step starts at its dash, which is this line unless `uses` isn't the step's first key.
  let start = usesLine;
  if (!m[2]) {
    start = -1;
    for (let i = usesLine - 1; i >= 0; i--) {
      const t = text[i]!;
      if (NOTE.test(t)) continue;
      const dash = t.match(/^( *)(- +)/);
      if (dash && dash[1]!.length + dash[2]!.length === keyCol) {
        start = i;
        break;
      }
      if (indentOf(t) < keyCol) return null;
    }
    if (start < 0) return null;
  }
  let end = text.length;
  for (let i = usesLine + 1; i < text.length; i++) {
    const t = text[i]!;
    if (!NOTE.test(t) && indentOf(t) < keyCol) {
      end = i;
      break;
    }
  }

  /** The step's own key on this line, if one starts there. */
  const keyOn = (i: number) => {
    const t = text[i]!;
    const head = t.slice(0, keyCol);
    const ok = i === start ? /^ *- +$/.test(head) : /^ *$/.test(head);
    return ok && t.length > keyCol && t[keyCol] !== ' ' ? t.slice(keyCol) : null;
  };
  const withs: number[] = [];
  for (let i = start; i < end; i++) {
    // A quoted "with" is valid YAML this doesn't read, so the step isn't read at all rather than as one without inputs.
    if (/^(["'])with\1[ \t]*:/.test(keyOn(i) ?? '')) return null;
    if (/^with[ \t]*:/.test(keyOn(i) ?? '')) withs.push(i);
  }
  if (withs.length > 1) return null;
  const withLine = withs[0] ?? null;
  if (withLine === null) return { lines, text, start, usesLine, keyCol, withLine, childIndent: keyCol + 2, entries: [], blockEnd: usesLine + 1 };
  // Values written on the same line, like `with: { provider: codex }`, aren't edited.
  if (!/^with[ \t]*:[ \t]*(?:#.*)?$/.test(keyOn(withLine)!)) return null;

  let childIndent = -1;
  const entries: Entry[] = [];
  let blockEnd = withLine + 1;
  // Whether the value above is a `|` or `>` block, whose lines are text even where they look like a comment, like `#123`.
  let scalar = false;
  for (let i = withLine + 1; i < end; i++) {
    const t = text[i]!;
    const indent = indentOf(t);
    if (scalar && t.trim() && indent > childIndent) {
      entries.at(-1)!.end = i + 1;
      blockEnd = i + 1;
      continue;
    }
    if (NOTE.test(t)) continue;
    if (indent <= keyCol) break;
    if (childIndent < 0) childIndent = indent;
    if (indent < childIndent) return null;
    if (indent === childIndent) {
      const key = t.slice(indent).match(/^([\w-]+)[ \t]*:(?:[ \t]|$)/);
      if (!key) return null;
      // GitHub reads input names without regard to case, so PROVIDER is provider. Two that differ only in case are
      // one input given twice, which isn't read below.
      entries.push({ key: key[1]!.toLowerCase(), start: i, end: i + 1 });
      scalar = OPENS_SCALAR.test(t);
    } else {
      // More of the value above, like the lines of a `|` block.
      entries.at(-1)!.end = i + 1;
    }
    blockEnd = i + 1;
  }
  const keys = entries.map((e) => e.key);
  if (new Set(keys).size !== keys.length) return null;
  return { lines, text, start, usesLine, keyCol, withLine, childIndent: childIndent < 0 ? keyCol + 2 : childIndent, entries, blockEnd };
}

/**
 * The keys of the job that holds the step, like `runs-on` and `environment`. Null when the step isn't under a
 * `steps:` the usual way, which isn't guessed at.
 */
function jobKeys(step: Step): string[] | null {
  const { text } = step;
  const dash = indentOf(text[step.start]!);
  // Up past the steps before this one, to its `steps:`.
  let i = step.start - 1;
  while (i >= 0 && (NOTE.test(text[i]!) || indentOf(text[i]!) > dash || (indentOf(text[i]!) === dash && /^ *- /.test(text[i]!)))) i--;
  if (i < 0 || !/^ *steps[ \t]*:[ \t]*(?:#.*)?$/.test(text[i]!)) return null;
  const keyIndent = indentOf(text[i]!);
  // Up past the job's other keys, to its name.
  let head = i - 1;
  while (head >= 0 && (NOTE.test(text[head]!) || indentOf(text[head]!) >= keyIndent)) head--;
  // `steps:` with no job above it has no job keys either.
  if (head < 0) return [];
  const keys: string[] = [];
  for (let j = head + 1; j < text.length; j++) {
    const t = text[j]!;
    if (NOTE.test(t)) continue;
    if (indentOf(t) <= indentOf(text[head]!)) break;
    if (indentOf(t) === keyIndent) keys.push(t.trim());
  }
  return keys;
}

/** An input's value on its one line, without quotes or a comment. Null when it isn't there or goes on over more lines. */
function readValue(step: Step, key: string): string | null {
  const entry = step.entries.find((e) => e.key === key);
  if (!entry || entry.end !== entry.start + 1) return null;
  const value = step.text[entry.start]!.replace(/^[^:]*:/, '').replace(/[ \t]+#.*$/, '').trim();
  return value.replace(/^(["'])(.*)\1$/, '$2');
}

/** An AI as the Action reads it: exactly claude or codex, which it compares as is. Anything else is null. */
function readAi(step: Step, key: string): Ai | null {
  const value = readValue(step, key);
  return value === 'claude' || value === 'codex' ? value : null;
}

/** What the workflow sets, or null when the Mergelight step can't be found. */
export function readRoles(content: string): SetRoles | null {
  const step = locate(content);
  return step && { provider: readAi(step, 'provider'), verifyWith: readAi(step, 'verify-with') };
}

/**
 * Whether the page can tell for sure who reviews and who checks, and change it. Each login input the Mergelight step
 * has reads its own secret, the way setup writes it, there's no auth-secret-name, and provider and verify-with are
 * left out or plain claude or codex. Anything else, like another secret, an expression or a YAML anchor, is a
 * workflow someone set up their own way, so it's theirs to change by hand.
 */
export function isStandard(content: string): boolean {
  const step = locate(content);
  if (!step || stepInScalar(content)) return false;
  // A step with an anchor can be used again by an alias, in another job with its own secrets, so one edit changes both.
  if (/^ *- +&/.test(step.text[step.start]!)) return false;
  // A commit, a moving tag like v0, or a release. A branch can change under the job that keeps a login fresh, which
  // this page would add, so a workflow on one is theirs to set up.
  const ref = step.text[step.usesLine]!.match(/mergelightai\/mergelight@([^\s#"']+)/)?.[1] ?? '';
  if (!/^(?:[0-9a-f]{40}|v\d+|v\d+\.\d+\.\d+)$/i.test(ref)) return false;
  // The review job's environment has secrets of its own, which this page can't see. Another job's doesn't matter.
  const keys = jobKeys(step);
  if (!keys || keys.some((k) => /^(["']?)environment\1[ \t]*:/.test(k))) return false;
  return step.entries.every(({ key }) => {
    if (key === 'auth-secret-name') return false;
    // A step that runs the jobs has its own AI, and only the review's is this page's to change.
    if (key === 'run') return readValue(step, key) === 'review';
    if (key === 'provider' || key === 'verify-with') return readAi(step, key) !== null;
    const secret = LOGIN_SECRET[key];
    return !secret || new RegExp(`^\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}$`, 'i').test(readValue(step, key) ?? '');
  });
}

/**
 * The input that ties the review to the AI that reviews now: a model, which the reviewer gets as it is and only its own
 * AI takes, or an effort other than low, medium or high, which both AIs take. The checker uses neither. Null when none.
 */
export function reviewerFixedBy(content: string): 'model' | 'effort' | null {
  const step = locate(content);
  if (!step) return null;
  // An empty value is left out by the Action, the same as none. One over more lines can't be told, so it counts.
  const set = (key: string) => step.entries.some((e) => e.key === key) && readValue(step, key) !== '';
  // Effort first: it ties the checker too, which a model alongside it mustn't hide.
  if (set('effort') && !/^(low|medium|high)$/.test(readValue(step, 'effort') ?? '')) return 'effort';
  return set('model') ? 'model' : null;
}

/** The login inputs the Mergelight step has. In a standard step each one reads its own secret. */
export function loginInputs(content: string): string[] {
  const step = locate(content);
  return step ? step.entries.map((e) => e.key).filter((key) => key in LOGIN_SECRET) : [];
}

/**
 * Whether the review reads the ChatGPT plan's login from CODEX_AUTH_JSON, and saves a refreshed one back there: the one
 * login the refresh job setup adds keeps fresh. One read from another secret, or saved to one, is set up its own way.
 */
export function readsPlanLogin(content: string): boolean {
  const step = locate(content);
  if (!step) return false;
  const plan = LOGIN_INPUTS.codex[0];
  const secret = LOGIN_SECRET[plan]!;
  const saved = step.entries.some((e) => e.key === 'auth-secret-name') ? readValue(step, 'auth-secret-name') : secret;
  return new RegExp(`^\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}$`, 'i').test(readValue(step, plan) ?? '') && saved?.toUpperCase() === secret;
}

/**
 * Which AIs have a login the Action gets: a secret that's there, read by an input the step has, whatever else the
 * workflow does its own way. A secret no input reads, like an app's own API key, never counts. Without a workflow yet,
 * the one setup writes reads them all. A step that can't be found reads none.
 */
export function loginsIn(content: string | null, secretNames: string[], shared: string[] = []): Logins {
  if (!content) return loginsFrom(secretNames, shared);
  const step = locate(content);
  if (!step) return { claude: false, codex: false };
  // The secret each input reads, where it reads exactly one: anything else, like a fallback or an expression, can't be
  // told, so it counts for nothing. Secret names are read without regard to case, as GitHub reads them.
  const secretOf = (input: string) => readValue(step, input)?.match(/^\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}$/i)?.[1]?.toUpperCase() ?? null;
  const there = (name: string | null): name is string => Boolean(name && secretNames.includes(name));
  const plan = LOGIN_INPUTS.codex[0];
  const planSecret = secretOf(plan);
  // The Action uses the plan's login before a key, so an organization's one there means ChatGPT needs the repo's own.
  const planShared = there(planSecret) && shared.includes(planSecret);
  const has = (input: string) => {
    const secret = secretOf(input);
    return there(secret) && !(input === plan && shared.includes(secret));
  };
  return { claude: LOGIN_INPUTS.claude.some(has), codex: !planShared && LOGIN_INPUTS.codex.some(has) };
}

/**
 * Whether the workflow runs on pull_request_target and not on pull_request. Such a run reads the workflow on the base
 * branch, not the one on the pull request.
 */
/**
 * Whether a workflow can review pull requests: it runs on pull_request or pull_request_target, or its events can't be
 * read, which counts as yes. The approval workflow runs only on pull_request_review and never reviews.
 */
export function reviewsPullRequests(content: string): boolean {
  const on = triggers(content);
  return on.size === 0 || on.has('pull_request') || on.has('pull_request_target');
}

export function runsOnBase(content: string | null): boolean {
  if (!content) return false;
  const on = triggers(content);
  if (!on.has('pull_request_target')) return false;
  // With both, the PR's own run is the one that asks only where pull_request surely runs on its new commits.
  const own = on.get('pull_request');
  return own === undefined || !runsOnCommits(own);
}

/**
 * Whether a pull_request event, by what's under it, runs on every new commit of any PR: no filter at all, or only a
 * `types` that has synchronize. A branch or path filter, or anything this can't read, may keep it from running.
 */
function runsOnCommits(config: string[] | null): boolean {
  if (config === null) return false;
  if (!config.length) return true;
  const indent = indentOf(config[0]!);
  const types: string[] = [];
  for (let i = 0; i < config.length; i++) {
    const t = config[i]!;
    if (indentOf(t) !== indent) continue;
    const key = t.trim().match(/^(["']?)([\w-]+)\1[ \t]*:(.*)$/);
    if (!key || key[2] !== 'types') return false;
    const inline = key[3]!.replace(/(^|[ \t])#.*$/, '').trim();
    const flow = inline.match(/^\[(.*)\]$/);
    if (flow) types.push(...flow[1]!.split(',').map((x) => x.trim().replace(/^(["'])(.*)\1$/, '$2')));
    else if (inline) types.push(inline.replace(/^(["'])(.*)\1$/, '$2'));
    // A list under it, one type a line.
    else for (let j = i + 1; j < config.length && /^ *-[ \t]/.test(config[j]!) && indentOf(config[j]!) >= indent; j++) types.push(config[j]!.replace(/^ *-[ \t]+/, '').replace(/(^|[ \t])#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2'));
  }
  return types.includes('synchronize');
}

/**
 * The events a workflow runs on: the keys of its `on:`, or the names in `on: push` and `on: [push, pull_request]`. Never
 * what's under an event, like the branches or paths it filters on, which can look like an event's name. Each has the
 * lines under it, none when it has nothing set, or null when what it has is set on its own line, which isn't read.
 */
function triggers(content: string): Map<string, string[] | null> {
  const found = new Map<string, string[] | null>();
  const lines = content.split(/\r?\n/);
  // The root mapping can be set in, as long as all of it is: `on` is a key at its indent.
  const root = indentOf(lines.find((l) => !NOTE.test(l) && !/^(?:---|\.\.\.)/.test(l)) ?? '');
  const at = lines.findIndex((l) => indentOf(l) === root && /^ *["']?on["']?[ \t]*:/.test(l));
  if (at < 0) return found;
  const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  const uncomment = (line: string) => line.replace(/(^|[ \t])#.*$/, '').trim();
  const open = (text: string) => (text.match(/[[{]/g)?.length ?? 0) - (text.match(/[\]}]/g)?.length ?? 0);
  let inline = uncomment(lines[at]!.replace(/^[^:]*:/, ''));
  // A list or a map on `on:` can go on over more lines, until its brackets close.
  for (let i = at + 1; /^[[{]/.test(inline) && open(inline) > 0 && i < lines.length; i++) inline += ` ${uncomment(lines[i]!)}`;
  if (inline) {
    const flow = inline.match(/^([[{])(.*)[\]}]$/);
    if (!flow) return found.set(unquote(inline), []);
    // Only what's at the top of the list or map: `{ pull_request_target: { paths: [a] } }` is that one event.
    const parts = [''];
    let depth = 0;
    for (const ch of flow[2]!) {
      if (ch === ',' && depth === 0) {
        parts.push('');
        continue;
      }
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      parts[parts.length - 1] += ch;
    }
    for (const part of parts) {
      if (flow[1] === '[') {
        if (unquote(part)) found.set(unquote(part), []);
        continue;
      }
      const [name, ...value] = part.split(':');
      const set = value.join(':').trim();
      if (unquote(name ?? '')) found.set(unquote(name!), !set || /^(?:\{\s*\}|null|~)$/.test(set) ? [] : null);
    }
    return found;
  }
  let indent = -1;
  let current: string[] | null = null;
  for (let i = at + 1; i < lines.length; i++) {
    const t = lines[i]!;
    if (NOTE.test(t)) continue;
    const col = indentOf(t);
    // A list of events can start right under `on:`, as in `- push`. Any other line there is the next root key.
    if (col < root || (col === root && !/^ *-[ \t]/.test(t))) break;
    if (indent < 0) indent = col;
    // Deeper is what an event filters on.
    if (col !== indent) {
      current?.push(t);
      continue;
    }
    const key = t.slice(col).match(/^(?:-[ \t]+)?(["']?)([^"':#\s]+)\1[ \t]*(?::(.*)|#.*|$)/);
    if (!key) {
      current = null;
      continue;
    }
    const set = uncomment(key[3] ?? '');
    current = !set || /^(?:\{\s*\}|null|~)$/.test(set) ? [] : null;
    found.set(key[2]!, current);
  }
  return found;
}

/**
 * Whether a pull request's own run can't ask for `adding`'s login, so it connects once the PR is merged. A workflow on
 * pull_request_target runs the one the branch has now, whatever the PR changes, and that asks only for the AIs it uses.
 */
export function waitsForBase(content: string, logins: Logins, adding: Ai): boolean {
  const set = readRoles(content);
  if (!set || !runsOnBase(content)) return false;
  const now = rolesFor(set, logins);
  return adding !== now.reviewer && adding !== now.checker;
}

/** Whether the Mergelight step hands this AI a login at all: without one of its inputs, it can never review or check. */
export const passesLogin = (content: string, ai: Ai): boolean => LOGIN_INPUTS[ai].some((input) => loginInputs(content).includes(input));

/**
 * Sets these inputs in the Mergelight step's `with:`, in this order. A line that's there gets its value replaced in
 * place, keeping a comment at its end. A missing one goes beside the others, or at the end of `with:`. Every other
 * byte stays as it was. Null when the step can't be found, so nothing gets guessed.
 */
export function withInputs(content: string, values: [key: string, value: string][]): string | null {
  const step = locate(content);
  if (!step) return null;
  const { lines, text, keyCol, childIndent, entries } = step;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const line = (indent: number, key: string, value: string) => `${' '.repeat(indent)}${key}: ${value}${eol}`;
  const replaced = new Map<number, { end: number; with: string }>();
  const inserted = new Map<number, string[]>();
  const insert = (at: number, add: string) => inserted.set(at, [...(inserted.get(at) ?? []), add]);

  if (step.withLine === null) {
    insert(step.usesLine + 1, `${' '.repeat(keyCol)}with:${eol}`);
    for (const [key, value] of values) insert(step.usesLine + 1, line(childIndent, key, value));
  } else {
    // Where the next missing one goes: right after the one before it, so the lines stay together.
    let next: number | null = null;
    for (const [i, [key, value]] of values.entries()) {
      const entry = entries.find((e) => e.key === key);
      if (entry) {
        const single = entry.end === entry.start + 1;
        const comment = single ? (text[entry.start]!.match(/[ \t]+#[^"']*$/)?.[0] ?? '') : '';
        const ending = lines[entry.end - 1]!.match(/\r?\n$/)?.[0] ?? '';
        replaced.set(entry.start, { end: entry.end, with: `${' '.repeat(childIndent)}${key}: ${value}${comment}${ending}` });
        next = entry.end;
        continue;
      }
      const later = values
        .slice(i + 1)
        .map(([k]) => entries.find((e) => e.key === k))
        .find(Boolean);
      const at: number = next ?? later?.start ?? step.blockEnd;
      insert(at, line(childIndent, key, value));
      next = at;
    }
  }

  const out: string[] = [];
  const emit = (piece: string) => {
    // A last line without a line ending gets one once something follows it.
    if (out.length && !out[out.length - 1]!.endsWith('\n')) out[out.length - 1] += eol;
    out.push(piece);
  };
  for (let i = 0; i <= lines.length; i++) {
    for (const piece of inserted.get(i) ?? []) emit(piece);
    if (i === lines.length) break;
    const swap = replaced.get(i);
    if (swap) {
      emit(swap.with);
      i = swap.end - 1;
    } else {
      emit(lines[i]!);
    }
  }
  return out.join('');
}

/** Takes these inputs out of the Mergelight step's `with:`, line and all. Every other byte stays. Null when the step can't be found. */
export function withoutInputs(content: string, keys: string[]): string | null {
  const step = locate(content);
  if (!step) return null;
  const drop = new Set<number>();
  for (const e of step.entries) if (keys.includes(e.key)) for (let i = e.start; i < e.end; i++) drop.add(i);
  return step.lines.filter((_, i) => !drop.has(i)).join('');
}

/** Sets who reviews and who checks, with nothing left to a default. */
export const withRoles = (content: string, roles: Roles) =>
  withInputs(content, [
    ['provider', roles.reviewer],
    ['verify-with', roles.checker],
  ]);
