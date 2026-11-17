import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hasCommentTrigger, withCommentTrigger } from '../../src/setup/comment-trigger.ts';

const NOW = readFileSync(new URL('../../../examples/mergelight.yml', import.meta.url), 'utf8');
const SKIP = 'github.event.pull_request.head.repo.full_name == github.repository';

/** The template as it was before the comment trigger (Nov 10 to Nov 17 2026), made back from today's. */
function before(now) {
  const swap = (text, from, to) => {
    assert.ok(text.includes(from), `today's template has: ${from.slice(0, 60)}`);
    return text.replace(from, to);
  };
  let s = now;
  s = swap(s, "  # A comment that mentions @mergelight-ai on a pull request reviews it again, reading the comment as your\n  # team's answer to the findings: what's fixed, and what to leave and why. Only people who can push count.\n  issue_comment:\n    types: [created]\n", '');
  s = swap(s, "    # target branch changed, so a new title doesn't start a review. A comment counts when it mentions\n    # Mergelight on a pull request, and isn't a bot's.\n", "    # target branch changed, so a new title doesn't start a review.\n");
  s = swap(s, "      (github.event_name == 'issue_comment' &&\n      github.event.issue.pull_request &&\n      contains(github.event.comment.body, '@mergelight-ai') &&\n      github.event.comment.user.type != 'Bot') ||\n      (github.event_name == 'pull_request' &&\n", '');
  s = swap(s, `${SKIP})\n`, `${SKIP}\n`);
  s = swap(s, "    # A new push cancels the older review of the same PR. A comment's review has a group of its own, so\n    # neither cancels the other.\n", '    # A new push cancels the older review of the same PR.\n');
  s = swap(s, "group: mergelight-pr-${{ github.event.pull_request.number || github.event.issue.number }}${{ github.event_name == 'issue_comment' && format('-comment-{0}', github.event.comment.id) || '' }}", 'group: mergelight-pr-${{ github.event.pull_request.number }}');
  return s;
}

/** What the setup page writes for one branch, skipping the other long-lived ones. */
const scoped = (s) => s.replace('types: [opened, synchronize, reopened, ready_for_review, edited]', '$&\n    branches: ["staging"]').replace(SKIP, () => `${SKIP} &&\n      !contains(fromJSON('["main","develop"]'), github.head_ref)`);

test('a workflow from before the comment trigger becomes exactly today\'s template', () => {
  const old = before(NOW);
  assert.equal(hasCommentTrigger(old), false);
  assert.equal(withCommentTrigger(old), NOW);
});

test('one the setup page made for one branch keeps its branch filter, and skips branches for pull requests only', () => {
  const out = withCommentTrigger(scoped(before(NOW)));
  assert.equal(out, scoped(NOW));
  assert.match(out, /!contains\(fromJSON\('\["main","develop"\]'\), github\.head_ref\)\)\n    runs-on/);
});

test('the oldest shape, without the edit and Dependabot lines, gets the trigger too', () => {
  const oldest = before(NOW)
    .replace(", edited]", ']')
    .replace("      (github.event.action != 'edited' || github.event.changes.base) &&\n", '')
    .replace("      github.actor != 'dependabot[bot]' &&\n", '');
  const out = withCommentTrigger(oldest);
  assert.ok(out && hasCommentTrigger(out));
  assert.match(out, /\(github\.event_name == 'pull_request' &&\n      !github\.event\.pull_request\.draft &&\n      github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)\n/);
});

test('a workflow that has the trigger already stays as it is', () => {
  assert.equal(withCommentTrigger(NOW), NOW);
});

test('a condition or group changed by hand is left for its owner', () => {
  const old = before(NOW);
  // Another check could be joined with ||, so putting "it's a pull request" in front could change what it means.
  assert.equal(withCommentTrigger(old.replace("      !github.event.pull_request.draft &&\n", "      github.event.pull_request.user.login != 'bot' ||\n")), null);
  assert.equal(withCommentTrigger(old.replace('group: mergelight-pr-${{ github.event.pull_request.number }}', 'group: reviews-${{ github.ref }}')), null);
  // A workflow that runs jobs too has two conditions.
  assert.equal(withCommentTrigger(old.replace('    if: >\n', '    if: >\n      true &&\n').replace('jobs:\n', 'jobs:\n  other:\n    if: >\n      true\n')), null);
  assert.equal(withCommentTrigger(old.replace('on:\n  pull_request:', 'on:\n  pull_request_target:')), null);
  // Another job with no condition at all would run on every comment, with the workflow's secrets.
  assert.equal(withCommentTrigger(`${old.trimEnd()}\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n`), null);
  // The same job below a comment at the start of a line.
  assert.equal(withCommentTrigger(`${old.trimEnd()}\n# Lint too\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n`), null);
  // A step of the team's own before Mergelight's would run on anyone's comment, before Mergelight checks who wrote it.
  assert.equal(withCommentTrigger(old.replace('    steps:\n', '    steps:\n      - run: ./prepare.sh\n')), null);
  // The same step written as a dash on a line of its own, its keys below it.
  assert.equal(withCommentTrigger(old.replace('    steps:\n', '    steps:\n      -\n        run: ./prepare.sh\n')), null);
  // Or after Mergelight's, or in another list style.
  assert.equal(withCommentTrigger(old.replace('    steps:\n', '    steps:\n    - run: ./prepare.sh\n')), null);
  assert.equal(withCommentTrigger(`${old.trimEnd()}\n      - run: ./after.sh\n`), null);
});
