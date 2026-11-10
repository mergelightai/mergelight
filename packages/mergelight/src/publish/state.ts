import { gunzipSync, gzipSync } from "node:zlib";
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
  end_line?: number;
  /** How it happens, so later rounds can check it again. */
  how?: string;
  /** The rest of the finding, for the MCP server. Only while it's open, and older state doesn't have it. */
  likelihood?: Finding["likelihood"];
  what_breaks?: string;
  fix?: string;
  fix_cost?: Finding["fix_cost"];
  verdict?: string;
  rank?: number | null;
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

/** State shares a comment with the summary, and GitHub caps a comment at 65,536 characters. */
const MAX_STATE = 40_000;

const pack = (state: ReviewState) => `<!-- ${MARKER} ${gzipSync(JSON.stringify(state)).toString("base64")} -->`;

function withoutDetails(f: StateFinding): StateFinding {
  const { likelihood: _l, what_breaks: _w, fix: _f, fix_cost: _c, verdict: _v, rank: _r, ...rest } = f;
  return rest;
}

function withoutHow(f: StateFinding): StateFinding {
  const { how: _, ...rest } = withoutDetails(f);
  return rest;
}

/** Past any real review the details go first: a comment GitHub refuses would lose the whole round. */
export function encodeState(state: ReviewState): string {
  const packed = pack(state);
  if (packed.length <= MAX_STATE) return packed;
  const slimmer = pack({ ...state, findings: state.findings.map(withoutDetails) });
  return slimmer.length <= MAX_STATE ? slimmer : pack({ ...state, findings: state.findings.map(withoutHow) });
}

/** The encoded state exactly as it sits in a comment, to carry over into a new body. */
export function stateBlock(body: string | undefined): string | null {
  return body?.match(new RegExp(`<!-- ${MARKER} [A-Za-z0-9+/=]+ -->`))?.[0] ?? null;
}

export function decodeState(body: string | undefined): ReviewState | null {
  const m = body?.match(new RegExp(`<!-- ${MARKER} ([A-Za-z0-9+/=]+) -->`));
  if (!m) return null;
  try {
    const raw = Buffer.from(m[1]!, "base64");
    // Reviews from before the state was gzipped are plain base64 JSON.
    const json = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: 5_000_000 }) : raw;
    const state = JSON.parse(json.toString("utf8")) as ReviewState;
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
      end_line: f.end_line,
      how: f.how_it_happens,
      likelihood: f.likelihood,
      what_breaks: f.what_breaks,
      fix: f.fix,
      fix_cost: f.fix_cost,
      verdict: f.verdict,
      rank: f.rank ?? null,
      first_round: before.get(f.id)?.first_round ?? round,
      status: "open",
      ...(url ? { url } : {}),
    };
  });
  for (const old of prev?.findings ?? []) {
    if (!current.has(old.id)) merged.push({ ...withoutDetails(old), status: "gone" });
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
