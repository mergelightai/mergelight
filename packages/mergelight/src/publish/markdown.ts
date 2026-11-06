import type { Finding, Light, Review } from "../types.js";
import type { Handled } from "./closed.js";
import type { Mark } from "./handled.js";
import { encodeState, type ReviewState } from "./state.js";

export const SUMMARY_MARKER = "<!-- mergelight:summary -->";
const PENDING_MARKER = "<!-- mergelight:pending -->";
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

/** Posted when a review starts, so the summary is the first thing on the pull request. */
export function pendingSummaryBody(): string {
  return [SUMMARY_MARKER, PENDING_MARKER, "### ⏳ Mergelight: Reviewing", "", "This usually takes 2 to 15 minutes. This comment updates when the review is done."].join("\n");
}

export const isPendingSummary = (body: string | undefined) => Boolean(body?.includes(PENDING_MARKER));

export function failedSummaryBody(): string {
  return [SUMMARY_MARKER, "### ⚠️ Mergelight couldn't review this pull request", "", "The Mergelight check has the reason. The next push tries again."].join("\n");
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
export function headline(r: Review, handled = 0): string {
  const toFix = r.findings.filter((f) => f.tier === "post" || f.tier === "list");
  const bugs = toFix.filter((f) => f.class === "bug" && f.severity !== "minor").length;
  const minor = toFix.filter((f) => f.class === "bug" && f.severity === "minor").length;
  const risks = toFix.filter((f) => f.class !== "bug").length;
  const decisions = r.findings.filter((f) => f.tier === "decision").length;
  const parts: string[] = [];
  if (bugs) parts.push(plural(bugs, "bug"));
  if (risks) parts.push(plural(risks, "risk"));
  if (minor) parts.push(plural(minor, "minor bug"));
  const fix = parts.length ? `${parts.join(", ")} to fix` : "";
  const call = decisions ? `${decisions} for you to decide` : "";
  return [fix, call].filter(Boolean).join(", ") || (handled ? "Nothing left to fix" : "Nothing worth fixing");
}

export interface SummaryInput {
  review: Review;
  state: ReviewState;
  /** Inline comment URL per finding id, for findings posted inline. */
  urls: Map<string, string>;
  /** What the team marked as handled, by finding id. */
  marks?: Map<string, Mark>;
  /** Inline findings that got fixed or whose thread someone resolved, by finding id. */
  handled?: Map<string, Handled>;
}

/** A finding this review still reports, though someone marked it handled before the review finished. */
function markTag(mark: Mark | undefined): string {
  if (!mark) return "";
  return mark.as === "fixed" ? " _(marked fixed, still found)_" : " _(marked won't fix, still reported)_";
}

/** A line for a finding worth fixing. Without an inline comment to link to, the details go here. */
function fixLine(f: Finding, urls: Map<string, string>, mark?: Mark): string[] {
  const { dot, name } = label(f);
  const url = urls.get(f.id);
  const tag = markTag(mark);
  if (url) return [`- ${dot} ${name}: [${clean(f.title)}](${url}) ${where(f)}${tag}`];
  return [
    `- ${dot} ${name}: **${clean(f.title)}** ${where(f)}${tag}`,
    `  <details><summary>Details</summary>`,
    "",
    `  ${clean(f.how_it_happens)}`,
    "",
    `  **What breaks:** ${clean(f.what_breaks)}`,
    "",
    `  **Smallest fix** (${f.fix_cost}): ${clean(f.fix)}`,
    "",
    `  **→ ${clean(f.verdict)}**`,
    "  </details>",
  ];
}

export function summaryBody({ review: r, state, urls, marks = new Map(), handled = new Map() }: SummaryInput, withState = true): string {
  const light = LIGHT[r.light];
  const top = r.findings.filter((f) => f.tier === "post").sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9) || rank(a) - rank(b));
  const listed = r.findings.filter((f) => f.tier === "list").sort((a, b) => rank(a) - rank(b));
  const decisions = r.findings.filter((f) => f.tier === "decision");
  const leftAlone = r.findings.filter((f) => f.tier === "hardening");
  const dropped = state.findings.filter((f) => f.status === "gone" && marks.get(f.id)?.as === "wont_fix");
  const done = state.findings.filter((f) => dropped.includes(f) || (f.status === "gone" && handled.has(f.id)));
  const gone = state.round > 1 ? state.findings.filter((f) => f.status === "gone" && f.tier !== "hardening" && !done.includes(f)) : [];

  const out: string[] = [SUMMARY_MARKER, `### ${light.dot} Mergelight: ${light.label}`, "", clean(r.summary), "", `**${headline(r, done.length)}**`];

  if (top.length) {
    out.push("", "#### To fix");
    for (const f of top) out.push(...fixLine(f, urls, marks.get(f.id)));
  }

  if (listed.length) {
    out.push("", "#### Also worth fixing");
    for (const f of listed) out.push(...fixLine(f, urls, marks.get(f.id)));
  }

  if (decisions.length) {
    out.push("", "#### Your call", "Real, but whether to fix it is a trade-off for you to make.", "");
    for (const f of decisions) {
      out.push(`- **${clean(f.title)}** ${where(f)}: ${clean(f.verdict)}${markTag(marks.get(f.id))}`);
      out.push(`  <details><summary>How it happens</summary>`, "", `  ${clean(f.how_it_happens)} ${clean(f.what_breaks)}`, "", `  Fix (${f.fix_cost}): ${clean(f.fix)}`, "  </details>");
    }
  }

  if (done.length) {
    out.push("", `<details><summary>✅ Handled: ${done.length}</summary>`, "");
    for (const f of done) {
      const mark = marks.get(f.id);
      const h = handled.get(f.id);
      const how =
        mark?.as === "wont_fix"
          ? `not fixing. ${clean(mark.note ?? "No reason given.")} (${mark.by})`
          : h?.how === "fixed"
            ? `fixed${h.sha ? ` in \`${h.sha}\`` : ""}`
            : `resolved${h?.by ? ` by ${h.by}` : ""}`;
      const url = urls.get(f.id) ?? f.url;
      out.push(`- ✅ ${url ? `[${clean(f.title)}](${url})` : clean(f.title)} \`${f.file}:${f.line}\`: ${how}`);
    }
    out.push("", "</details>");
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

  const who = (p: { name: string; model: string | null }) => `${p.name === "codex" ? "Codex" : "Claude"}${p.model ? ` ${p.model}` : ""}`;
  const checkedBy = r.verifier && r.verifier.name !== r.provider.name ? `, checked by ${who(r.verifier)},` : "";
  out.push(
    "",
    `<sub>Round ${state.round} · reviewed \`${r.pr.head_sha.slice(0, 7)}\` with ${who(r.provider)}${checkedBy} on your own plan · ${duration(r.stats.duration_ms)} · <a href="https://mergelight.dev">Mergelight</a></sub>`,
  );

  const tail = withState ? `\n${encodeState(state)}` : "";
  const room = MAX_BODY - tail.length;
  let body = out.join("\n");
  if (body.length > room) body = `${body.slice(0, room - 200)}\n\n_Summary cut short: too many findings to list._`;
  return `${body}${tail}`;
}
