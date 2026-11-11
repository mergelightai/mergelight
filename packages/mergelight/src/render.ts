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

function kind(f: Finding): { dot: string; label: string } {
  if (f.class === "bug") return f.severity === "minor" ? { dot: "🟠", label: "Minor bug" } : { dot: "🔴", label: "Bug" };
  if (f.class === "risk") return { dot: "🟡", label: "Risk" };
  return { dot: "⚪", label: "Small fix" };
}

export function renderTerminal(r: Review): string {
  const light = LIGHT[r.light];
  // Top picks first, most important first. Older reviews without picks post everything marked post.
  const posted = r.findings.filter((f) => f.tier === "post").sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
  const listed = r.findings.filter((f) => f.tier === "list");
  const decisions = r.findings.filter((f) => f.tier === "decision");
  const hardening = r.findings.filter((f) => f.tier === "hardening");
  const counts = [
    `${posted.length} to fix first`,
    `${listed.length} more worth fixing`,
    `${decisions.length} decision${decisions.length === 1 ? "" : "s"}`,
    `${hardening.length} hardening`,
  ].join(", ");
  const words = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" ");
  const hunters = words(r.provider.name, r.provider.model, r.provider.effort);
  const checker = r.verifier && r.verifier.name !== r.provider.name ? `, checked by ${words(r.verifier.name, r.verifier.model)}` : "";

  const out: string[] = [];
  out.push(`${bold("Mergelight")} ${dim("·")} ${r.pr.owner}/${r.pr.repo}#${r.pr.number} ${dim("·")} ${r.pr.title}`);
  out.push(
    `${light.dot} ${light.color(bold(light.label))}  ${dim(`(${counts})`)}  ${dim(`· ${hunters}${checker} · ${duration(r.stats.duration_ms)} · ${r.pr.head_sha.slice(0, 7)}`)}`,
  );
  const checked = r.trace.candidates.length;
  out.push(dim(`Checked ${checked} candidate${checked === 1 ? "" : "s"}, rejected ${r.trace.rejected.length}${r.trace.failed_hunters.length ? `, hunters failed: ${r.trace.failed_hunters.join(", ")}` : ""}`));
  out.push("");
  out.push(wrap(r.summary, ""));

  for (const f of posted) {
    const k = kind(f);
    out.push("", full(f, k.dot, k.label));
  }

  if (listed.length) {
    out.push("", bold(`Also worth fixing (${listed.length})`));
    for (const f of listed) {
      out.push(`   ${kind(f).dot} ${dim(where(f))}  ${f.title}`);
      out.push(`      ${dim(`${f.likelihood} · ${f.severity} · fix ${f.fix_cost} ·`)} ${f.verdict}`);
    }
  }

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
  if (r.team_checks?.length) {
    out.push("", bold("Your team's checks"));
    for (const c of r.team_checks) {
      const mark = c.outcome === "pass" ? "✅" : c.outcome === "fail" ? "❌" : c.outcome === "skipped" ? "➖" : c.outcome === "unsure" ? "❔" : "⚠️";
      out.push(`   ${mark} ${c.name}  ${dim(c.summary)}`);
      for (const p of c.problems) out.push(dim(`      ${p.line ? `${p.file}:${p.line}` : p.file}  ${p.note}`));
    }
  }
  return out.join("\n");
}
