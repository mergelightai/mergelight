// The trigger that lets a pull request comment that mentions @mergelight-ai answer the findings (Action v0.1.20).
// A review workflow from before it has none, and an update only moves version lines, so this adds it: the same
// lines examples/mergelight.yml has. Only a workflow in a shape this page or `mergelight setup` wrote is changed,
// where every line is known. Anything else is left for its owner to change by hand.

/** Whether the workflow starts on a comment already, in whatever shape. */
export function hasCommentTrigger(content: string): boolean {
  return /^[ \t]+issue_comment[ \t]*:/m.test(content);
}

const TRIGGER = [
  '  # A comment that mentions @mergelight-ai on a pull request reviews it again, reading the comment as your',
  "  # team's answer to the findings: what's fixed, and what to leave and why. Only people who can push count.",
  '  issue_comment:',
  '    types: [created]',
];
const COMMENT_PART = [
  "      (github.event_name == 'issue_comment' &&",
  '      github.event.issue.pull_request &&',
  "      contains(github.event.comment.body, '@mergelight-ai') &&",
  "      github.event.comment.user.type != 'Bot') ||",
  "      (github.event_name == 'pull_request' &&",
];
const OLD_GROUP = '      group: mergelight-pr-${{ github.event.pull_request.number }}';
const NEW_GROUP =
  "      group: mergelight-pr-${{ github.event.pull_request.number || github.event.issue.number }}${{ github.event_name == 'issue_comment' && format('-comment-{0}', github.event.comment.id) || '' }}";
/**
 * The checks a review condition from this page or the setup command is made of, each on its own line. All must hold,
 * so putting "it's a pull request" in front of them keeps what they mean. A condition with any other line may join
 * its checks another way, and is left alone.
 */
const PR_CHECKS = [
  /^\(github\.event\.action != 'edited' \|\| github\.event\.changes\.base\) &&$/,
  /^!github\.event\.pull_request\.draft &&$/,
  /^github\.actor != 'dependabot\[bot\]' &&$/,
  /^github\.event\.pull_request\.head\.repo\.full_name == github\.repository(?: &&)?$/,
  /^!contains\(fromJSON\('.*'\), github\.head_ref\)$/,
];
/** The notes the template has above the condition and the concurrency group, which the new lines make incomplete. */
const NOTES: [string, string[]][] = [
  ["    # target branch changed, so a new title doesn't start a review.", ["    # target branch changed, so a new title doesn't start a review. A comment counts when it mentions", "    # Mergelight on a pull request, and isn't a bot's."]],
  ['    # A new push cancels the older review of the same PR.', ["    # A new push cancels the older review of the same PR. A comment's review has a group of its own, so", '    # neither cancels the other.']],
];

/**
 * The workflow with the comment trigger, its part of the review condition and a concurrency group per comment. The
 * same workflow when it starts on a comment already. Null when its shape isn't one this page knows, so a person adds
 * it by hand.
 */
export function withCommentTrigger(content: string): string | null {
  if (hasCommentTrigger(content)) return content;
  const lines = content.split('\n');
  // The events: the comment comes right after the pull request's own lines, inside `on:`.
  const on = lines.indexOf('on:');
  const pr = lines.indexOf('  pull_request:', on);
  if (on < 0 || pr < 0 || lines.slice(on + 1, pr).some((l) => l !== '' && !/^\s/.test(l))) return null;
  let afterPr = pr + 1;
  while (afterPr < lines.length && /^ {4,}\S/.test(lines[afterPr]!)) afterPr++;
  // One job, the review. A comment starts every job in the workflow, so another job, which may have no condition and
  // has the workflow's secrets, would run on every comment, from anyone on a public repo.
  const jobsAt = lines.indexOf('jobs:');
  if (jobsAt < 0) return null;
  const jobsEnd = lines.findIndex((l, i) => i > jobsAt && /^\S/.test(l));
  const jobs = lines.slice(jobsAt + 1, jobsEnd < 0 ? undefined : jobsEnd).filter((l) => /^ {2}[^\s#]/.test(l));
  if (jobs.length !== 1) return null;
  // Its condition, folded over lines of its own.
  const ifs = lines.flatMap((l, i) => (l === '    if: >' ? [i] : []));
  if (ifs.length !== 1) return null;
  const from = ifs[0]! + 1;
  let to = from;
  while (to < lines.length && lines[to]!.startsWith('      ')) to++;
  const checks = lines.slice(from, to).map((l) => l.trim());
  if (!checks.length || !checks.every((c) => PR_CHECKS.some((check) => check.test(c))) || checks.at(-1)!.endsWith('&&')) return null;
  const groups = lines.flatMap((l, i) => (l === OLD_GROUP ? [i] : []));
  if (groups.length !== 1 || groups[0]! < to) return null;

  // From the bottom up, so each change leaves the places of the ones above it as they were.
  const out = [...lines];
  out[groups[0]!] = NEW_GROUP;
  out[to - 1] = `${out[to - 1]})`;
  out.splice(from, 0, ...COMMENT_PART);
  out.splice(afterPr, 0, ...TRIGGER);
  for (const [old, next] of NOTES) {
    const at = out.indexOf(old);
    if (at >= 0 && out.indexOf(old, at + 1) < 0) out.splice(at, 1, ...next);
  }
  return out.join('\n');
}
