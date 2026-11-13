/**
 * Which AI reviews and which one checks the findings, as a repo's workflow sets them. No imports and only plain
 * types, so a Node test can load this file as it is.
 */

export type Ai = 'claude' | 'codex';

export interface Roles {
  reviewer: Ai;
  checker: Ai;
}

/** Which AIs have a login saved as a repo secret. */
export interface Logins {
  claude: boolean;
  codex: boolean;
}

/** What the Mergelight step's `with:` sets. Null where it says nothing the Action would read as an AI. */
export interface SetRoles {
  provider: Ai | null;
  verifyWith: Ai | null;
}

const CLAUDE_SECRETS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const CODEX_SECRETS = ['CODEX_AUTH_JSON', 'OPENAI_API_KEY'];

export const loginsFrom = (secretNames: string[]): Logins => ({
  claude: secretNames.some((n) => CLAUDE_SECRETS.includes(n)),
  codex: secretNames.some((n) => CODEX_SECRETS.includes(n)),
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

/**
 * Finds the one step that runs the Action, and the values in its `with:`. Null when there isn't exactly one such
 * step, or its shape is one this doesn't edit, like `with: { ... }`. Better to say so than to guess.
 */
function locate(content: string): Step | null {
  const lines = content.split(/(?<=\n)/);
  const text = lines.map((l) => l.replace(/\r?\n$/, ''));
  const uses = text.flatMap((t, i) => (USES.test(t) ? [i] : []));
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
  for (let i = start; i < end; i++) if (/^with[ \t]*:/.test(keyOn(i) ?? '')) withs.push(i);
  if (withs.length > 1) return null;
  const withLine = withs[0] ?? null;
  if (withLine === null) return { lines, text, usesLine, keyCol, withLine, childIndent: keyCol + 2, entries: [], blockEnd: usesLine + 1 };
  // Values written on the same line, like `with: { provider: codex }`, aren't edited.
  if (!/^with[ \t]*:[ \t]*(?:#.*)?$/.test(keyOn(withLine)!)) return null;

  let childIndent = -1;
  const entries: Entry[] = [];
  let blockEnd = withLine + 1;
  for (let i = withLine + 1; i < end; i++) {
    const t = text[i]!;
    if (NOTE.test(t)) continue;
    const indent = indentOf(t);
    if (indent <= keyCol) break;
    if (childIndent < 0) childIndent = indent;
    if (indent < childIndent) return null;
    if (indent === childIndent) {
      const key = t.slice(indent).match(/^([\w-]+)[ \t]*:(?:[ \t]|$)/);
      if (!key) return null;
      entries.push({ key: key[1]!, start: i, end: i + 1 });
    } else {
      // More of the value above, like the lines of a `|` block.
      entries.at(-1)!.end = i + 1;
    }
    blockEnd = i + 1;
  }
  const keys = entries.map((e) => e.key);
  if (new Set(keys).size !== keys.length) return null;
  return { lines, text, usesLine, keyCol, withLine, childIndent: childIndent < 0 ? keyCol + 2 : childIndent, entries, blockEnd };
}

/** An AI as the Action reads it. Anything else, like an expression or nothing, is null. */
function readAi(step: Step, key: string): Ai | null {
  const entry = step.entries.find((e) => e.key === key);
  if (!entry) return null;
  let value = step.text[entry.start]!.replace(/^[^:]*:/, '').replace(/[ \t]+#.*$/, '').trim();
  if (/^[|>]/.test(value)) value = step.text.slice(entry.start + 1, entry.end).join(' ').trim();
  value = value.replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase();
  return value === 'claude' || value === 'codex' ? value : null;
}

/** What the workflow sets, or null when the Mergelight step can't be found. */
export function readRoles(content: string): SetRoles | null {
  const step = locate(content);
  return step && { provider: readAi(step, 'provider'), verifyWith: readAi(step, 'verify-with') };
}

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

/** Sets who reviews and who checks, with nothing left to a default. */
export const withRoles = (content: string, roles: Roles) =>
  withInputs(content, [
    ['provider', roles.reviewer],
    ['verify-with', roles.checker],
  ]);
