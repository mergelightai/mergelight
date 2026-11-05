import type { Finding, Light, Review } from "../types.js";
import { encodeState, type ReviewState } from "./state.js";

export const SUMMARY_MARKER = "<!-- mergelight:summary -->";
export const findingMarker = (id: string) => `<!-- mergelight:finding id=${id} -->`;
export const FINDING_MARKER_RE = /<!-- mergelight:finding id=([a-f0-9]+) -->/;

/** GitHub's limit for a comment body and a check run summary. */
const MAX_BODY = 65_000;

/**
 * Model text goes into comments, so it must not be able to fake our hidden
 * markers or ping people.
 */
export function clean(text: string): string {
  return text
    .replace(/<!--/g, "&lt;!--")
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9-])/g, "$1@​")
    .trim();
}

export function label(f: Finding): { dot: string; name: string } {
  if (f.class === "bug") return f.severity === "minor" ? { dot: "🟠", name: "Minor bug" } : { dot: "🔴", name: "Bug" };
  if (f.class === "risk") return { dot: "🟡", name: "Risk" };
  return { dot: "⚪", name: "Small fix" };
}

/** Display order: bugs, then risks, then minor bugs, then small fixes. */
export function rank(f: Finding): number {
  if (f.class === "bug") return f.severity === "minor" ? 2 : 0;
  return f.class === "risk" ? 1 : 3;
}

const where = (f: Finding) => `\`${f.file}:${f.end_line > f.line ? `${f.line}-${f.end_line}` : f.line}\``;

export function inlineBody(f: Finding): string {
  const { dot, name } = label(f);
  return [
    findingMarker(f.id),
    `${dot} **${name}** · **${clean(f.title)}**`,
    "",
    clean(f.how_it_happens),
    "",
    `**What breaks:** ${clean(f.what_breaks)}`,
    "",
    `**Smallest fix** (${f.fix_cost}): ${clean(f.fix)}`,
    "",
    `**→ ${clean(f.verdict)}**`,
    "",
    `<sub>${f.likelihood} · ${f.severity} · fix ${f.fix_cost}</sub>`,
  ].join("\n");
}

export const LIGHT: Record<Light, { dot: string; label: string }> = {
  red: { dot: "🔴", label: "Blocked" },
  yellow: { dot: "🟡", label: "Needs a human" },
  green: { dot: "🟢", label: "Safe to merge" },
};

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One line on what the review found, for the summary and the check title. */
export function headline(r: Review): string {
  const posted = r.findings.filter((f) => f.tier === "post");
  const bugs = posted.filter((f) => f.class === "bug" && f.severity !== "minor").length;
  const minor = posted.filter((f) => f.class === "bug" && f.severity === "minor").length;
  const risks = posted.filter((f) => f.class !== "bug").length;
  const decisions = r.findings.filter((f) => f.tier === "decision").length;
  const parts: string[] = [];
  if (bugs) parts.push(plural(bugs, "bug"));
  if (risks) parts.push(plural(risks, "risk"));
  if (minor) parts.push(plural(minor, "minor bug"));
  const fix = parts.length ? `${parts.join(", ")} to fix` : "";
  const call = decisions ? `${decisions} for you to decide` : "";
  return [fix, call].filter(Boolean).join(", ") || "Nothing worth fixing";
}

export interface SummaryInput {
  review: Review;
  state: ReviewState;
  /** Inline comment URL per finding id, for findings posted inline. */
  urls: Map<string, string>;
  /** Posted findings that couldn't go inline because their lines aren't in the diff. */
  outside: Finding[];
}

export function summaryBody({ review: r, state, urls, outside }: SummaryInput, withState = true): string {
  const light = LIGHT[r.light];
  const posted = r.findings.filter((f) => f.tier === "post").sort((a, b) => rank(a) - rank(b));
  const decisions = r.findings.filter((f) => f.tier === "decision");
  const leftAlone = r.findings.filter((f) => f.tier === "hardening");
  const gone = state.round > 1 ? state.findings.filter((f) => f.status === "gone" && f.tier !== "hardening") : [];
  const outsideIds = new Set(outside.map((f) => f.id));

  const out: string[] = [SUMMARY_MARKER, `### ${light.dot} Mergelight: ${light.label}`, "", clean(r.summary), "", `**${headline(r)}**`];

  if (posted.length) {
    out.push("", "#### To fix");
    for (const f of posted) {
      const { dot, name } = label(f);
      const url = urls.get(f.id);
      const title = url ? `[${clean(f.title)}](${url})` : `**${clean(f.title)}**`;
      out.push(`- ${dot} ${name}: ${title} ${where(f)}`);
      if (outsideIds.has(f.id)) {
        out.push(
          `  <details><summary>Details (outside the changed lines)</summary>`,
          "",
          `  ${clean(f.how_it_happens)}`,
          "",
          `  **What breaks:** ${clean(f.what_breaks)}`,
          "",
          `  **Smallest fix** (${f.fix_cost}): ${clean(f.fix)}`,
          "",
          `  **→ ${clean(f.verdict)}**`,
          "  </details>",
        );
      }
    }
  }

  if (decisions.length) {
    out.push("", "#### Your call", "Real, but whether to fix it is a trade-off for you to make.", "");
    for (const f of decisions) {
      out.push(`- **${clean(f.title)}** ${where(f)}: ${clean(f.verdict)}`);
      out.push(`  <details><summary>How it happens</summary>`, "", `  ${clean(f.how_it_happens)} ${clean(f.what_breaks)}`, "", `  Fix (${f.fix_cost}): ${clean(f.fix)}`, "  </details>");
    }
  }

  if (leftAlone.length) {
    out.push("", `<details><summary>Left alone: ${plural(leftAlone.length, "finding")} not worth fixing</summary>`, "");
    for (const f of leftAlone) out.push(`- ${clean(f.title)} ${where(f)}: ${clean(f.verdict)}`);
    out.push("", "</details>");
  }

  if (gone.length) {
    out.push("", `<details><summary>No longer found since the last review: ${gone.length}</summary>`, "");
    for (const f of gone) out.push(`- ${clean(f.title)} \`${f.file}:${f.line}\``);
    out.push("", "</details>");
  }

  const model = r.provider.model ? `Codex ${r.provider.model}` : "Codex";
  out.push(
    "",
    `<sub>Round ${state.round} · reviewed \`${r.pr.head_sha.slice(0, 7)}\` with ${model} on your own plan · ${duration(r.stats.duration_ms)} · <a href="https://mergelight.dev">Mergelight</a></sub>`,
  );

  let body = out.join("\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY - 200)}\n\n_Summary cut short: too many findings to list._`;
  return withState ? `${body}\n${encodeState(state)}` : body;
}
