import type { UpdateNotice } from "../update.js";
import type { Finding, Light, Review } from "../types.js";
import type { Handled } from "./closed.js";
import type { Mark } from "./handled.js";
import { encodeState, type ReviewState } from "./state.js";

export const SUMMARY_MARKER = "<!-- mergelight:summary -->";
export const PENDING_MARKER = "<!-- mergelight:pending -->";
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
/**
 * A model as people read it: "Codex GPT-6.1-Sol", "Claude Opus 5.5". Just the tool's name when the model
 * isn't known, and the model's own name when it isn't one these rules know.
 */
export function modelLabel(name: string, model: string | null | undefined): string {
  const brand = name === "codex" ? "Codex" : "Claude";
  const m = model?.trim();
  if (!m || !/^[\w.-]{1,60}$/.test(m)) return brand;
  const cap = (w: string) => (/^gpt$/i.test(w) ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1));
  if (name === "codex") return `${brand} ${m.split("-").map(cap).join("-")}`;
  const [family = "", ...version] = m.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  return `${brand} ${cap(family)}${version.length ? ` ${version.join(".")}` : ""}`;
}

/** A token count as people read it: 812, 45k, 2.9M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Who reviews and who checks, for the line under "Reviewing". */
export interface ReviewPlan {
  reviewer: { name: string; model: string | null };
  checker?: { name: string; model: string | null };
}

export function pendingSummaryBody(plan?: ReviewPlan): string {
  const reviewer = plan ? modelLabel(plan.reviewer.name, plan.reviewer.model) : null;
  const checker = plan?.checker ? modelLabel(plan.checker.name, plan.checker.model) : null;
  const who = reviewer ? `Reviewing with ${reviewer}${checker && checker !== reviewer ? `, and ${checker} checks the findings` : ""}. ` : "";
  return [SUMMARY_MARKER, PENDING_MARKER, "### ⏳ Mergelight: Reviewing", "", `${who}This usually takes 2 to 15 minutes. This comment updates when the review is done.`].join("\n");
}

export const isPendingSummary = (body: string | undefined) => Boolean(body?.includes(PENDING_MARKER));

/** A failure with a known cause and a clear next step, instead of the general message. */
export interface FailureNotice {
  heading: string;
  body: string;
}

export const loginNotice = (plan: string, reason: string): FailureNotice => ({ heading: `⚠️ Mergelight: the ${plan} login didn't work`, body: reason });

export function limitNotice(plan: string, resets: string | null): FailureNotice {
  const reason = `This pull request wasn't reviewed, because your ${plan} plan has no usage left.`;
  return {
    heading: `⏳ Mergelight: your ${plan} plan hit its limit`,
    body: resets ? `${reason}\n\n**Resets:** ${resets}\n\nPush a new commit after that, and the review runs again.` : `${reason}\n\nPush a new commit once your plan has usage again, and the review runs again.`,
  };
}

/** Marks a summary that only says a run failed, so the next failure can say what's true now. */
export const FAILED_MARKER = "<!-- mergelight:failed -->";
const GENERAL_FAILURE = ["### ⚠️ Mergelight couldn't review this pull request", "", "The Mergelight check has the reason. The next push tries again."].join("\n");

export function failedSummaryBody(notice?: FailureNotice): string {
  if (notice) return [SUMMARY_MARKER, FAILED_MARKER, `### ${notice.heading}`, "", notice.body].join("\n");
  return [SUMMARY_MARKER, FAILED_MARKER, GENERAL_FAILURE].join("\n");
}

/** Only at the very start, because a summary with results can quote text from the pull request. Earlier releases wrote no marker. */
export const isFailedSummary = (body: string | undefined) => Boolean(body?.startsWith(`${SUMMARY_MARKER}\n${FAILED_MARKER}\n`) || body?.trim() === `${SUMMARY_MARKER}\n${GENERAL_FAILURE}`);

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
  // A guarded file is why this one needs a human, when nothing else is: "Nothing worth fixing" would contradict the light.
  const guarded = r.needs_human?.length ? "Changes a file that always needs a human" : "";
  return [fix, call].filter(Boolean).join(", ") || guarded || (handled ? "Nothing left to fix" : "Nothing worth fixing");
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
  /** A newer release of Mergelight, if this run isn't on the latest. */
  update?: UpdateNotice | null;
}

/** A finding this review still reports, though someone marked it handled before the review finished. */
function markTag(mark: Mark | undefined): string {
  if (!mark) return "";
  return mark.as === "fixed" ? " _(marked fixed, still found)_" : " _(marked won't fix, still reported)_";
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A title as HTML: escaped, with its `code` kept, and no one mentioned by accident. */
const inlineHtml = (text: string) => clean(escapeHtml(text)).replace(/`([^`]+)`/g, "<code>$1</code>");

/** A line for a finding worth fixing. Without an inline comment to link to, the details go here. */
function fixLine(f: Finding, urls: Map<string, string>, mark?: Mark): string[] {
  const { dot, name } = label(f);
  const url = urls.get(f.id);
  const tag = markTag(mark);
  if (url) return [`- ${dot} ${name}: [${clean(f.title)}](${url}) ${where(f)}${tag}`];
  // Markdown doesn't work inside <summary>, so this line is HTML.
  const markNote = mark ? ` <i>(${mark.as === "fixed" ? "marked fixed, still found" : "marked won't fix, still reported"})</i>` : "";
  return [
    "",
    `<details><summary>${dot} ${name}: <b>${inlineHtml(f.title)}</b> <code>${escapeHtml(where(f).replaceAll("`", ""))}</code>${markNote}</summary>`,
    "",
    clean(f.how_it_happens),
    "",
    `**What breaks:** ${clean(f.what_breaks)}`,
    "",
    `**Smallest fix** (${f.fix_cost}): ${clean(f.fix)}`,
    "",
    `**→ ${clean(f.verdict)}**`,
    "",
    "</details>",
  ];
}

const NEWS_SHOWN = 4;

/** At the top of the comment, because a pinned repo only gets new versions if someone notices and acts. */
function updateBanner({ tag, current, news }: UpdateNotice): string[] {
  const more = news.length - NEWS_SHOWN;
  return [
    "> [!IMPORTANT]",
    `> **You're missing out: Mergelight ${tag} is out, and this repo is on ${current}.**`,
    ...(news.length ? [">", ...news.slice(0, NEWS_SHOWN).map((n) => `> - ${clean(n)}`), ...(more > 0 ? [`> - and ${more} more`] : [])] : []),
    ">",
    "> **[Update now](https://mergelight.dev/setup/)**. It's one click, and only the version lines change.",
    "",
  ];
}

/** Says what the review couldn't see, so a quiet result isn't taken to cover it. The names are checked against a strict pattern before they get here. */
export function notReadLine(list: Review["not_read"]): string | null {
  if (!list?.length) return null;
  const names = (items: NonNullable<Review["not_read"]>) => {
    const shown = items.slice(0, 4).map((i) => `\`${i.uses.replace(/[^\w./@-]/g, "")}\``);
    return items.length > 4 ? `${shown.join(", ")} and ${items.length - 4} more` : shown.join(", ");
  };
  const programs = list.filter((i) => i.why === "program");
  const missing = list.filter((i) => i.why === "unreadable");
  const parts = [
    programs.length ? `the code that ${names(programs)} ${programs.length === 1 ? "runs" : "run"} (a Node or Docker action, so only ${programs.length === 1 ? "its definition was" : "their definitions were"} read)` : "",
    missing.length ? `${names(missing)} (couldn't be read)` : "",
  ].filter(Boolean);
  return `<sub>Not read: ${parts.join(", and ")}.</sub>`;
}

export function summaryBody({ review: r, state, urls, marks = new Map(), handled = new Map(), update }: SummaryInput, withState = true): string {
  const light = LIGHT[r.light];
  const top = r.findings.filter((f) => f.tier === "post").sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9) || rank(a) - rank(b));
  const listed = r.findings.filter((f) => f.tier === "list").sort((a, b) => rank(a) - rank(b));
  const decisions = r.findings.filter((f) => f.tier === "decision");
  const leftAlone = r.findings.filter((f) => f.tier === "hardening");
  const dropped = state.findings.filter((f) => f.status === "gone" && marks.get(f.id)?.as === "wont_fix");
  const done = state.findings.filter((f) => dropped.includes(f) || (f.status === "gone" && handled.has(f.id)));
  const gone = state.round > 1 ? state.findings.filter((f) => f.status === "gone" && f.tier !== "hardening" && !done.includes(f)) : [];

  const out: string[] = [SUMMARY_MARKER, ...(update ? updateBanner(update) : []), `### ${light.dot} Mergelight: ${light.label}`, "", clean(r.summary), "", `**${headline(r, done.length)}**`];

  if (top.length) {
    out.push("", "#### To fix");
    for (const f of top) out.push(...fixLine(f, urls, marks.get(f.id)));
  }

  if (listed.length) {
    // With nothing above it, the count is the heading already, and "also" would point at an empty section.
    out.push("", ...(top.length ? ["#### Also worth fixing"] : []));
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
    out.push("", `<details><summary>Left alone: ${plural(leftAlone.length, "smaller finding")}</summary>`, "");
    for (const f of leftAlone) out.push(`- ${clean(f.title)} ${where(f)}: ${clean(f.verdict)}`);
    out.push("", "</details>");
  }

  if (gone.length) {
    out.push("", `<details><summary>No longer found since the last review: ${gone.length}</summary>`, "");
    for (const f of gone) out.push(`- ${clean(f.title)} \`${f.file}:${f.line}\``);
    out.push("", "</details>");
  }

  const unread = notReadLine(r.not_read);
  if (unread) out.push("", unread);

  const reviewer = modelLabel(r.provider.name, r.provider.model);
  const checker = r.verifier ? modelLabel(r.verifier.name, r.verifier.model) : reviewer;
  const checkedBy = checker !== reviewer ? `, checked by ${checker},` : "";
  const t = r.stats.tokens;
  const used = t && t.input + t.output > 0 ? ` · ${tokenCount(t.input)} tokens in${t.cached ? ` (${tokenCount(t.cached)} from cache)` : ""}, ${tokenCount(t.output)} out` : "";
  out.push(
    "",
    `<sub>Round ${state.round} · reviewed \`${r.pr.head_sha.slice(0, 7)}\` with ${reviewer}${checkedBy} on your own plan · ${duration(r.stats.duration_ms)}${used}</sub>`,
  );

  const tail = withState ? `\n${encodeState(state)}` : "";
  const room = MAX_BODY - tail.length;
  let body = out.join("\n");
  if (body.length > room) body = `${body.slice(0, room - 200)}\n\n_Summary cut short: too many findings to list._`;
  return `${body}${tail}`;
}
