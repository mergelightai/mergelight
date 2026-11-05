import type { GitHub } from "./api.js";

/**
 * GitHub only accepts inline review comments on lines inside the diff, and a
 * single bad line rejects the whole review. So every finding is placed on a
 * line GitHub will take, or listed in the summary instead.
 */

interface PrFile {
  filename: string;
  patch?: string;
}

/** For each file, the hunks as ranges of new-file lines you can comment on. */
export type Commentable = Map<string, { start: number; end: number; lines: Set<number> }[]>;

export function parsePatch(patch: string): { start: number; end: number; lines: Set<number> }[] {
  const hunks: { start: number; end: number; lines: Set<number> }[] = [];
  let current: { start: number; end: number; lines: Set<number> } | null = null;
  let right = 0;
  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      right = Number(header[1]);
      current = { start: right, end: right - 1, lines: new Set() };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    // Context and added lines both exist on the right side.
    current.lines.add(right);
    current.end = right;
    right++;
  }
  return hunks.filter((h) => h.lines.size > 0);
}

export async function commentableLines(api: GitHub, number: number): Promise<Commentable> {
  const files = await api.list<PrFile>(`pulls/${number}/files`);
  const map: Commentable = new Map();
  for (const f of files) if (f.patch) map.set(f.filename, parsePatch(f.patch));
  return map;
}

export interface Placement {
  line: number;
  start_line?: number;
}

/** Where to put a finding's inline comment, or null if its lines aren't in the diff. */
export function place(map: Commentable, file: string, line: number, endLine: number): Placement | null {
  const hunks = map.get(file);
  if (!hunks) return null;
  const lo = Math.min(line, endLine);
  const hi = Math.max(line, endLine);
  for (const h of hunks) {
    if (h.lines.has(lo) && h.lines.has(hi)) return hi > lo ? { start_line: lo, line: hi } : { line: hi };
  }
  // Fall back to the nearest commentable line inside the finding's range.
  for (const h of hunks) {
    for (let l = hi; l >= lo; l--) if (h.lines.has(l)) return { line: l };
  }
  return null;
}
