// The edit the setup page makes to a repo's workflow when someone chooses who reviews and who checks.
// Plain Node: roles.ts has no imports and only erasable types, so Node loads it as it is.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { authSecretName, connectsAfterMerge, loginsFrom, passesLogin, readRoles, rolesFor, withInputs, withRoles } from '../../src/setup/roles.ts';

const template = readFileSync(new URL('../../../examples/mergelight.yml', import.meta.url), 'utf8');
const both = { claude: true, codex: true };
const claudeOnly = { claude: true, codex: false };
const codexOnly = { claude: false, codex: true };
const none = { claude: false, codex: false };

/** The lines `after` has that `before` doesn't, when the rest is the same in the same order. */
function added(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const extra = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && line === a[i]) i++;
    else extra.push(line);
  }
  assert.equal(i, a.length, 'every old line is still there, in order');
  return extra;
}

test('the real template gets two lines after its last input, and nothing else changes', () => {
  const out = withRoles(template, { reviewer: 'claude', checker: 'codex' });
  assert.deepEqual(added(template, out), ['          provider: claude', '          verify-with: codex']);
  assert.match(out, /anthropic-api-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}\n {10}provider: claude\n {10}verify-with: codex\n$/);
});

test('editing twice is the same as editing once', () => {
  const once = withRoles(template, { reviewer: 'codex', checker: 'claude' });
  assert.equal(withRoles(once, { reviewer: 'codex', checker: 'claude' }), once);
  const changed = withRoles(once, { reviewer: 'claude', checker: 'claude' });
  assert.deepEqual(added(template, changed), ['          provider: claude', '          verify-with: claude']);
});

test('lines that are there get their values replaced in place, with their comments and indentation', () => {
  const file = [
    'jobs:',
    '    review:',
    '        steps:',
    '            -   uses: mergelightai/mergelight@v0',
    '                with:',
    '                    provider: codex # who reviews',
    '                    effort: high',
    '                    verify-with: "codex"',
    '                    model: x',
    '',
  ].join('\n');
  const out = withRoles(file, { reviewer: 'claude', checker: 'codex' });
  assert.equal(out, file.replace('provider: codex # who reviews', 'provider: claude # who reviews').replace('verify-with: "codex"', 'verify-with: codex'));
});

test('a missing verify-with goes right after provider', () => {
  const file = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: codex\n      effort: medium\n';
  assert.equal(withRoles(file, { reviewer: 'claude', checker: 'codex' }), 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: claude\n      verify-with: codex\n      effort: medium\n');
});

test('a missing provider goes right before verify-with', () => {
  const file = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      effort: medium\n      verify-with: claude\n';
  assert.equal(withRoles(file, { reviewer: 'codex', checker: 'codex' }), 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      effort: medium\n      provider: codex\n      verify-with: codex\n');
});

test('a step without with: gets one, right under uses', () => {
  const file = 'steps:\n  - uses: mergelightai/mergelight@v0\n    env:\n      A: b\n  - run: echo done\n';
  assert.equal(withRoles(file, { reviewer: 'claude', checker: 'codex' }), 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: claude\n      verify-with: codex\n    env:\n      A: b\n  - run: echo done\n');
});

test('an empty with: gets the lines under it', () => {
  const file = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n  - run: echo done\n';
  assert.equal(withRoles(file, { reviewer: 'claude', checker: 'claude' }), 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: claude\n      verify-with: claude\n  - run: echo done\n');
});

test("uses doesn't have to be the step's first key, and with: can come before it", () => {
  const file = 'steps:\n  - name: Review\n    with:\n      effort: low\n    uses: "mergelightai/mergelight@abc123" # v0.2.0\n  - run: echo\n';
  assert.equal(withRoles(file, { reviewer: 'codex', checker: 'claude' }), 'steps:\n  - name: Review\n    with:\n      effort: low\n      provider: codex\n      verify-with: claude\n    uses: "mergelightai/mergelight@abc123" # v0.2.0\n  - run: echo\n');
});

test("another step's inputs are never touched", () => {
  const file = [
    'steps:',
    '  - uses: someone/else@v1',
    '    with:',
    '      provider: codex',
    '  - uses: mergelightai/mergelight@v0',
    '    with:',
    '      effort: low',
    '  - uses: someone/third@v1',
    '    with:',
    '      verify-with: codex',
    '',
  ].join('\n');
  const out = withRoles(file, { reviewer: 'claude', checker: 'claude' });
  assert.deepEqual(added(file, out), ['      provider: claude', '      verify-with: claude']);
  assert.match(out, /effort: low\n {6}provider: claude\n {6}verify-with: claude\n {2}- uses: someone\/third@v1/);
});

test('comments and blank lines after the last input stay where they are', () => {
  const file = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      effort: low\n      # a note about effort\n\n  # next comes the summary\n  - run: echo\n';
  assert.equal(withRoles(file, { reviewer: 'claude', checker: 'codex' }), 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      effort: low\n      provider: claude\n      verify-with: codex\n      # a note about effort\n\n  # next comes the summary\n  - run: echo\n');
});

test('a value over several lines is replaced as a whole', () => {
  const file = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: >-\n        codex\n      effort: low\n';
  assert.equal(withRoles(file, { reviewer: 'claude', checker: 'claude' }), 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: claude\n      verify-with: claude\n      effort: low\n');
});

test('Windows line endings stay Windows line endings', () => {
  const file = template.replace(/\n/g, '\r\n');
  const out = withRoles(file, { reviewer: 'claude', checker: 'codex' });
  assert.equal(out, withRoles(template, { reviewer: 'claude', checker: 'codex' }).replace(/\n/g, '\r\n'));
});

test('a file without a last line ending still comes out whole', () => {
  const file = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      effort: low';
  assert.equal(withRoles(file, { reviewer: 'claude', checker: 'codex' }), 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      effort: low\n      provider: claude\n      verify-with: codex\n');
});

test("anything it can't place for sure is left alone, so the page can say so", () => {
  const roles = { reviewer: 'claude', checker: 'codex' };
  assert.equal(withRoles('name: x\njobs: {}\n', roles), null, 'no Mergelight step');
  assert.equal(withRoles('steps:\n  # - uses: mergelightai/mergelight@v0\n  - run: echo\n', roles), null, 'only a comment');
  assert.equal(withRoles(`${template}\n  again:\n    steps:\n      - uses: mergelightai/mergelight@v0\n`, roles), null, 'two Mergelight steps');
  assert.equal(withRoles('steps:\n  - uses: mergelightai/mergelight@v0\n    with: { effort: low }\n', roles), null, 'with: on one line');
  assert.equal(withRoles('steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: codex\n      provider: claude\n', roles), null, 'the same input twice');
  assert.equal(withRoles('steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      - provider\n', roles), null, 'a list where inputs should be');
});

test('withInputs can set provider alone, which is what a new repo gets', () => {
  assert.deepEqual(added(template, withInputs(template, [['provider', 'claude']])), ['          provider: claude']);
});

test('readRoles reads what the Action would read', () => {
  assert.deepEqual(readRoles(template), { provider: null, verifyWith: null });
  assert.deepEqual(readRoles(withRoles(template, { reviewer: 'claude', checker: 'codex' })), { provider: 'claude', verifyWith: 'codex' });
  const quoted = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: "Codex" # here\n      verify-with: \'claude\'\n';
  assert.deepEqual(readRoles(quoted), { provider: 'codex', verifyWith: 'claude' });
  const expression = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      provider: ${{ vars.WHO }}\n      verify-with:\n';
  assert.deepEqual(readRoles(expression), { provider: null, verifyWith: null });
  assert.equal(readRoles('name: x\n'), null);
});

test("rolesFor uses the Action's defaults for anything the workflow leaves out", () => {
  const unset = { provider: null, verifyWith: null };
  assert.deepEqual(rolesFor(unset, claudeOnly), { reviewer: 'claude', checker: 'claude' });
  assert.deepEqual(rolesFor(unset, codexOnly), { reviewer: 'codex', checker: 'codex' });
  assert.deepEqual(rolesFor(unset, none), { reviewer: 'codex', checker: 'codex' });
  assert.deepEqual(rolesFor(unset, both), { reviewer: 'codex', checker: 'claude' }, 'with both, the other AI checks');
  assert.deepEqual(rolesFor({ provider: 'claude', verifyWith: null }, both), { reviewer: 'claude', checker: 'codex' });
  assert.deepEqual(rolesFor({ provider: 'claude', verifyWith: null }, codexOnly), { reviewer: 'claude', checker: 'claude' }, 'without both, the reviewer checks');
  assert.deepEqual(rolesFor({ provider: 'codex', verifyWith: 'codex' }, both), { reviewer: 'codex', checker: 'codex' }, 'a value in the file always wins');
});

test('loginsFrom knows which secret belongs to which AI', () => {
  assert.deepEqual(loginsFrom(['CLAUDE_CODE_OAUTH_TOKEN']), claudeOnly);
  assert.deepEqual(loginsFrom(['ANTHROPIC_API_KEY', 'OTHER']), claudeOnly);
  assert.deepEqual(loginsFrom(['CODEX_AUTH_JSON']), codexOnly);
  assert.deepEqual(loginsFrom(['OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']), both);
  assert.deepEqual(loginsFrom([]), none);
  assert.deepEqual(loginsFrom(['MY_CODEX'], 'MY_CODEX'), codexOnly, "the workflow's own name for a ChatGPT login counts");
  assert.deepEqual(loginsFrom(['MY_CODEX']), none, 'and only when the workflow names it');
});

test('a login waits for the merge only when it would move reviews the person chose to keep', () => {
  const unset = { provider: null, verifyWith: null };
  const keepClaude = { reviewer: 'claude', checker: 'codex' };
  assert.equal(connectsAfterMerge(unset, claudeOnly, keepClaude, 'codex'), true, 'Claude reviews only as the one login, so ChatGPT would take over');
  assert.equal(connectsAfterMerge({ provider: 'claude', verifyWith: null }, claudeOnly, keepClaude, 'codex'), false, 'a file that names Claude keeps Claude');
  assert.equal(connectsAfterMerge(unset, claudeOnly, { reviewer: 'codex', checker: 'claude' }, 'codex'), false, 'moving reviews to ChatGPT is the choice itself');
  assert.equal(connectsAfterMerge(unset, codexOnly, { reviewer: 'codex', checker: 'claude' }, 'claude'), false, 'a Claude login never moves reviews away from ChatGPT');
  assert.equal(connectsAfterMerge(unset, claudeOnly, keepClaude, null), false, 'nothing to connect');
});

test('passesLogin tells whether the Mergelight step hands an AI its login', () => {
  assert.equal(passesLogin(template, 'codex', true), true);
  assert.equal(passesLogin(template, 'claude', true), true);
  const claudeStep = 'steps:\n  - uses: mergelightai/mergelight@v0\n    with:\n      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n      openai-api-key: ${{ secrets.OPENAI_API_KEY }}\n      codex-auth-json: ""\n';
  assert.equal(passesLogin(claudeStep, 'claude', true), true);
  assert.equal(passesLogin(claudeStep, 'claude', false), true);
  assert.equal(passesLogin(claudeStep, 'codex', false), true, 'a saved login can come through an API key');
  assert.equal(passesLogin(claudeStep, 'codex', true), false, 'one still to connect needs codex-auth-json, and an empty one passes nothing');
  assert.equal(passesLogin('steps:\n  - uses: mergelightai/mergelight@v0\n', 'claude', false), false, 'a step without with: passes nothing');
  assert.equal(passesLogin('name: x\n', 'claude', false), false, 'without the step, nothing');
});

test("authSecretName reads the workflow's own name for a ChatGPT login", () => {
  assert.equal(authSecretName(template), 'CODEX_AUTH_JSON');
  assert.equal(authSecretName(null), 'CODEX_AUTH_JSON');
  assert.equal(authSecretName(withInputs(template, [['auth-secret-name', 'TEAM_CODEX # ours']])), 'TEAM_CODEX');
  assert.equal(authSecretName(withInputs(template, [['auth-secret-name', '"QUOTED_NAME"']])), 'QUOTED_NAME');
  assert.equal(authSecretName(withInputs(template, [['auth-secret-name', '${{ vars.WHICH }}']])), 'CODEX_AUTH_JSON', "an expression can't be told, so the default stays");
});
