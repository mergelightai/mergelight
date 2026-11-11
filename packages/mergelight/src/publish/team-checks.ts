import type { GitHub } from "./api.js";
import type { TeamCheckResult } from "../types.js";

/** A team's check shows on the pull request under a name of its own, next to the Mergelight check. */
export const teamCheckName = (name: string) => `Mergelight: ${name}`;

/** As code, so nothing in it is read as markup, a link or a mention. */
const code = (text: string) => `\`${text.replace(/`/g, "'").replace(/[\u0000-\u001f\u007f]/g, "?")}\``;

/**
 * Plain text for a check on GitHub. These words come from the AI, which read a pull request someone
 * else wrote, or from the team's server. Neither may post a link, a picture, a mention or markup
 * under Mergelight's name. Short pieces between backticks stay code, which GitHub shows as it is.
 */
export function plain(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/[\\`*_{}[\]()#+!|<>~&]/g, "\\$&")
            // A zero-width space: the text reads the same, and GitHub no longer sees a mention or a link.
            .replace(/@/g, "@\u200b")
            .replace(/:\/\//g, ":\u200b//")
            .replace(/\bwww\./gi, "www\u200b."),
    )
    .join("")
    .trim();
}

/** What GitHub shows for one check: its conclusion, a title, and the reasons. */
/**
 * A team makes a check stop a merge by requiring it on GitHub, and GitHub lets a neutral check
 * through. So only a real pass is a success: "couldn't tell" and "couldn't run" ask for a person,
 * which a required check doesn't let through. Otherwise the author of a pull request could get past
 * a check by making its run fail.
 */
export function teamCheckBody(r: TeamCheckResult): { conclusion: "success" | "failure" | "skipped" | "action_required"; output: { title: string; summary: string } } {
  const asked = `**The check:** ${code(r.text)}`;
  if (r.outcome === "skipped") return { conclusion: "skipped", output: { title: "Not needed: none of its files changed", summary: `${asked}\n\n${r.summary}` } };
  if (r.outcome === "unsure") {
    return { conclusion: "action_required", output: { title: "Couldn't tell: look at this one yourself", summary: `${asked}\n\n${plain(r.summary)}\n\nThis is not a pass. If your team requires this check, it holds the merge until a run can tell.` } };
  }
  if (r.outcome === "error") {
    return { conclusion: "action_required", output: { title: "Couldn't run this check", summary: `${asked}\n\n${plain(r.summary)}\n\nThis is not a pass. If your team requires this check, it holds the merge. Run the review again, or push, to try once more.` } };
  }
  const problems = r.problems.map((p) => `- ${code(p.line ? `${p.file}:${p.line}` : p.file)} ${plain(p.note)}`);
  return {
    conclusion: r.outcome === "pass" ? "success" : "failure",
    output: {
      title: r.outcome === "pass" ? "Passed" : `Failed${r.problems.length ? `: ${r.problems.length} place${r.problems.length === 1 ? "" : "s"} to fix` : ""}`,
      summary: [asked, "", plain(r.summary), ...(problems.length ? ["", ...problems] : [])].join("\n").slice(0, 60_000),
    },
  };
}

/**
 * Posts each of the team's checks as a check of its own on the commit. Returns how many were
 * posted. One that can't be posted is logged and doesn't stop the others.
 */
export async function publishTeamChecks(api: Pick<GitHub, "write">, headSha: string, results: TeamCheckResult[], log: (line: string) => void = () => {}): Promise<number> {
  let posted = 0;
  for (const r of results) {
    try {
      await api.write("POST", "check-runs", { name: teamCheckName(r.name), head_sha: headSha, status: "completed", completed_at: new Date().toISOString(), ...teamCheckBody(r) });
      posted++;
    } catch (err) {
      const message = (err as Error).message;
      // GitHub only lets Apps write checks, so a personal gh login can't post any of them.
      if (/must authenticate via a GitHub App/i.test(message)) {
        log("Skipped your team's checks: GitHub only lets a GitHub App write checks, not a personal gh login.");
        return posted;
      }
      log(`Couldn't post your team's check "${r.name}": ${message}`);
    }
  }
  return posted;
}
