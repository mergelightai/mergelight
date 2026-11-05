import type { Finding, Review } from "./types.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const yellow = paint("33");
const green = paint("32");

const LIGHT = {
  red: { dot: "🔴", label: "Blocked", color: red },
  yellow: { dot: "🟡", label: "Needs a human", color: yellow },
  green: { dot: "🟢", label: "Safe to merge", color: green },
} as const;

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function wrap(text: string, indent: string, width = 92): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (indent.length + line.length + 1 + w.length) > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

function where(f: Finding): string {
  return f.end_line > f.line ? `${f.file}:${f.line}-${f.end_line}` : `${f.file}:${f.line}`;
}

function full(f: Finding, dot: string, label: string): string {
  const pad = "            ";
  return [
    `${dot} ${bold(label)}  ${bold(f.title)}`,
    `   ${dim(where(f))}  ${dim(`${f.likelihood} · ${f.severity} · fix ${f.fix_cost}`)}`,
    `   How     ${wrap(f.how_it_happens, pad)}`,
    `   Breaks  ${wrap(f.what_breaks, pad)}`,
    `   Fix     ${wrap(f.fix, pad)}`,
    `   ${bold(`→ ${f.verdict}`)}`,
  ].join("\n");
}

export function renderTerminal(r: Review): string {
  const light = LIGHT[r.light];
  const posted = r.findings.filter((f) => f.tier === "post");
  const bugs = posted.filter((f) => f.class === "bug" && f.severity !== "minor");
  const minor = posted.filter((f) => f.class === "bug" && f.severity === "minor");
  const risks = posted.filter((f) => f.class === "risk");
  const small = posted.filter((f) => f.class === "hardening");
  const decisions = r.findings.filter((f) => f.tier === "decision");
  const hardening = r.findings.filter((f) => f.tier === "hardening");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const counts = [
    plural(bugs.length, "bug"),
    plural(minor.length, "minor bug"),
    plural(risks.length, "risk"),
    plural(decisions.length, "decision"),
    `${hardening.length} hardening`,
  ].join(", ");

  const out: string[] = [];
  out.push(`${bold("Mergelight")} ${dim("·")} ${r.pr.owner}/${r.pr.repo}#${r.pr.number} ${dim("·")} ${r.pr.title}`);
  out.push(
    `${light.dot} ${light.color(bold(light.label))}  ${dim(`(${counts})`)}  ${dim(`· codex ${r.provider.model ?? ""} · ${duration(r.stats.duration_ms)} · ${r.pr.head_sha.slice(0, 7)}`)}`,
  );
  const checked = r.trace.candidates.length;
  out.push(dim(`Checked ${checked} candidate${checked === 1 ? "" : "s"}, rejected ${r.trace.rejected.length}${r.trace.failed_hunters.length ? `, hunters failed: ${r.trace.failed_hunters.join(", ")}` : ""}`));
  out.push("");
  out.push(wrap(r.summary, ""));

  for (const f of bugs) out.push("", full(f, "🔴", "Bug"));
  for (const f of risks) out.push("", full(f, "🟡", "Risk"));
  for (const f of minor) out.push("", full(f, "🟠", "Minor bug"));
  for (const f of small) out.push("", full(f, "⚪", "Small fix"));

  if (decisions.length) {
    out.push("", bold(`Your call (${decisions.length})`));
    for (const f of decisions) {
      out.push(`   ${dim(where(f))}  ${f.title}`);
      out.push(`      ${dim(`${f.likelihood} · fix ${f.fix_cost} ·`)} ${f.verdict}`);
    }
  }

  if (hardening.length) {
    out.push("", dim(`⚪ Hardening, not worth fixing by default (${hardening.length})`));
    for (const f of hardening) {
      out.push(dim(`   ${where(f)}  ${f.title}`));
      out.push(dim(`      → ${f.verdict}`));
    }
  }
  if (!r.findings.length) out.push("", green("Nothing worth fixing."));
  return out.join("\n");
}
