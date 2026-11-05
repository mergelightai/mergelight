import type { Finding, Light, Tier } from "../types.js";

/**
 * Review state lives in a hidden comment inside the summary comment, so the
 * open source version needs no database. Later rounds read it to tell new
 * findings from old ones, and the MCP server reads it to hand findings to agents.
 */

export interface StateFinding {
  id: string;
  tier: Tier;
  class: Finding["class"];
  severity: Finding["severity"];
  title: string;
  file: string;
  line: number;
  first_round: number;
  /** open: in the latest review. gone: in an earlier review, not in the latest. */
  status: "open" | "gone";
  /** Inline comment URL, when the finding was posted as one. */
  url?: string;
}

export interface ReviewState {
  v: 1;
  round: number;
  rounds: { sha: string; at: string; light: Light; posted: number }[];
  findings: StateFinding[];
}

const MARKER = "mergelight:state:v1";

export function encodeState(state: ReviewState): string {
  return `<!-- ${MARKER} ${Buffer.from(JSON.stringify(state)).toString("base64")} -->`;
}

export function decodeState(body: string | undefined): ReviewState | null {
  const m = body?.match(new RegExp(`<!-- ${MARKER} ([A-Za-z0-9+/=]+) -->`));
  if (!m) return null;
  try {
    const state = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as ReviewState;
    return state.v === 1 ? state : null;
  } catch {
    return null;
  }
}

/** Merge this review into the previous state. */
export function nextState(prev: ReviewState | null, findings: Finding[], sha: string, light: Light, urls: Map<string, string>): ReviewState {
  const round = (prev?.round ?? 0) + 1;
  const current = new Set(findings.map((f) => f.id));
  const before = new Map((prev?.findings ?? []).map((f) => [f.id, f]));
  const merged: StateFinding[] = findings.map((f) => {
    const url = urls.get(f.id) ?? before.get(f.id)?.url;
    return {
      id: f.id,
      tier: f.tier,
      class: f.class,
      severity: f.severity,
      title: f.title,
      file: f.file,
      line: f.line,
      first_round: before.get(f.id)?.first_round ?? round,
      status: "open",
      ...(url ? { url } : {}),
    };
  });
  for (const old of prev?.findings ?? []) {
    if (!current.has(old.id)) merged.push({ ...old, status: "gone" });
  }
  return {
    v: 1,
    round,
    rounds: [
      ...(prev?.rounds ?? []).slice(-19),
      { sha, at: new Date().toISOString(), light, posted: findings.filter((f) => f.tier === "post").length },
    ],
    findings: merged,
  };
}
