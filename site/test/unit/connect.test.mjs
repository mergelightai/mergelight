// What the setup page reads from a run's comment: the code or link, and whether the login is for checking a review.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onlyAi, readConnectCode, readConnectData } from '../../src/setup/connect.ts';

const DEVICE = 'https://auth.openai.com/codex/device';
const CLAUDE = `https://claude.com/cai/oauth/authorize?code=true&state=${'t'.repeat(43)}`;
/** The hidden line, written the way the Action's connectData writes it. */
const line = (data) => `<!-- mergelight:connect:v1 ${JSON.stringify(data).replace(/--/g, '\\u002d\\u002d')} -->`;
const comment = (body, login = 'mergelight-ai[bot]') => ({ user: { login }, body: `<!-- mergelight:summary -->\n<!-- mergelight:pending -->\n${body}` });

test('a line for connecting the ChatGPT that checks a Claude review', () => {
  const found = readConnectData(line({ url: DEVICE, code: 'ABCD-EFGH1', claudeUrl: null, for: 'check' }));
  assert.deepEqual(found, { url: DEVICE, code: 'ABCD-EFGH1', claudeUrl: null, purpose: 'check' });
  assert.equal(onlyAi(found), 'codex', 'only ChatGPT is offered');
});

test('a line for connecting the Claude that checks a ChatGPT review', () => {
  const found = readConnectData(line({ url: '', code: '', claudeUrl: CLAUDE, for: 'check' }));
  assert.deepEqual(found, { url: '', code: '', claudeUrl: CLAUDE, purpose: 'check' });
  assert.equal(onlyAi(found), 'claude', 'only Claude is offered');
});

test('a Claude reviewer with no login yet gets only the Claude link', () => {
  const found = readConnectData(line({ url: '', code: '', claudeUrl: CLAUDE }));
  assert.deepEqual(found, { url: '', code: '', claudeUrl: CLAUDE, purpose: 'review' });
  assert.equal(onlyAi(found), 'claude');
});

test('a line without "for" reads as it always did', () => {
  const both = readConnectData(line({ url: DEVICE, code: 'ABCD-EFGH1', claudeUrl: CLAUDE }));
  assert.deepEqual(both, { url: DEVICE, code: 'ABCD-EFGH1', claudeUrl: CLAUDE, purpose: 'review' });
  assert.equal(onlyAi(both), null, 'both are offered');
  const codeOnly = readConnectData(line({ url: DEVICE, code: 'ABCD-EFGH1', claudeUrl: null }));
  assert.equal(codeOnly?.purpose, 'review');
  assert.equal(onlyAi(codeOnly), null, "a reviewer's code alone still leaves Claude by hand");
});

test('anything else in "for" is a review, and a bad link is still refused', () => {
  assert.equal(readConnectData(line({ url: DEVICE, code: 'ABCD-EFGH1', claudeUrl: null, for: 'something' }))?.purpose, 'review');
  assert.equal(readConnectData(line({ url: '', code: '', claudeUrl: 'https://claude.com.evil.example/x', for: 'check' })), null);
  assert.equal(readConnectData(line({ url: 'https://auth.openai.com.evil.example/d', code: 'ABCD-EFGH1', claudeUrl: null, for: 'check' })), null);
});

test('readConnectCode keeps "for", and still only trusts its own comments', () => {
  const ask = line({ url: '', code: '', claudeUrl: CLAUDE, for: 'check' });
  assert.equal(readConnectCode([comment(ask)])?.purpose, 'check');
  assert.equal(readConnectCode([comment(ask, 'someone')]), null);
  assert.equal(readConnectCode([comment(ask).body.replace('<!-- mergelight:pending -->\n', '')].map((body) => ({ user: { login: 'mergelight-ai[bot]' }, body }))), null, 'a finished comment asks for nothing');
  const old = comment(`1. Open ${DEVICE}\n2. Enter this code: \`ABCD-EFGH1\``);
  assert.deepEqual(readConnectCode([old]), { url: DEVICE, code: 'ABCD-EFGH1', claudeUrl: null, purpose: 'review' }, 'the layout from before v0.1.10 too');
});
