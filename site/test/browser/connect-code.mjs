// The Connect screen showing the login code, on the real built page against a fake GitHub.
// The comments come from the Action's own code, so this breaks if the two ever stop matching.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.env.REPO ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const { claudeSetupLink, connectBody, connectFailedBody, withState } = await import(`${root}/packages/mergelight/dist/connect.js`);
const { claudeCodeRef } = await import(`${root}/packages/mergelight/dist/connect-claude.js`);
const { pendingSummaryBody, SUMMARY_MARKER } = await import(`${root}/packages/mergelight/dist/publish/markdown.js`);
const { CHECK_FAILED_TITLE } = await import(`${root}/packages/mergelight/dist/publish/publish.js`);

const dist = process.env.DIST ?? new URL('../../dist', import.meta.url).pathname;
const out = `${mkdtempSync(join(tmpdir(), 'mergelight-browser-'))}/`;
const base = 'https://mergelight.dev';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let failures = 0;
const expect = (ok, what) => { console.log(`  ${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) failures++; };

const DEVICE = 'https://auth.openai.com/codex/device';
const CODE = '2ZYY-TEST1';
const NEW_CODE = 'Q7KD-NEWER';
const BOT = 'mergelight-ai[bot]';
const WAITING = { status: 'in_progress', conclusion: null, output: { title: 'Waiting for you to connect ChatGPT' } };
const askFor = (code = CODE, url = DEVICE) => withState(connectBody({ url, code }, 'https://github.com/acme/api/actions/runs/1'), undefined);
const comment = (login, body) => ({ user: { login }, body });
const FAILED = { status: 'completed', conclusion: 'neutral', output: { title: CHECK_FAILED_TITLE } };

async function scenario(name, start, body) {
  console.log(`\n== ${name}`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const world = { comments: [], checks: {}, head: 'headsha', login: false, isPrivate: true, commentsStatus: 200, asked: [], ...start };
  const json = (req, data, code = 200) => req.respond({ status: code, contentType: 'application/json', headers: cors, body: JSON.stringify(data) });
  await page.evaluateOnNewDocument(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } } });
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    const m = req.method();
    if (u.origin === 'https://api.mergelight.dev') {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (u.pathname === '/sign-in') return json(req, { token: 'fake-token' });
      return req.respond({ status: 200, headers: cors, body: 'ok' });
    }
    if (u.origin === 'https://github.com' && u.pathname === '/login/oauth/authorize') return req.respond({ status: 302, headers: { location: `${base}/setup/?code=c&state=${u.searchParams.get('state')}` } });
    if (u.origin === 'https://api.github.com') {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (u.pathname === '/repos/mergelightai/mergelight/releases/latest') return json(req, { tag_name: 'v0.2.0' });
      if (u.pathname === '/repos/mergelightai/mergelight/commits/v0.2.0') return json(req, { sha: 'a'.repeat(40) });
      const p = u.pathname.replace('/repos/acme/api', '');
      world.asked.push(p);
      if (m !== 'GET') {
        const data = req.postData() ? JSON.parse(req.postData()) : null;
        if (m === 'POST' && p === '/issues/7/comments') { (world.posted ??= []).push(data.body); return json(req, {}, 201); }
        if (m === 'POST' && p === '/git/blobs') { world.blob = data; return json(req, { sha: 'blobsha' }, 201); }
        if (m === 'POST' && p === '/git/refs') { (world.refs ??= []).push(data); return json(req, { ref: data.ref }, 201); }
        if (m === 'PUT' && p.startsWith('/contents/')) return json(req, { content: {}, commit: { sha: 'filesha' } }, 201);
        if (m === 'POST' && p === '/pulls') return json(req, { number: 7, html_url: 'https://github.com/acme/api/pull/7', head: { sha: world.head } }, 201);
        return json(req, {}, 404);
      }
      if (u.pathname === '/user/installations') return json(req, { installations: [{ id: 1, html_url: 'https://github.com/settings/installations/1', account: { login: 'acme', avatar_url: `${base}/logo.png` } }] });
      if (u.pathname === '/user/installations/1/repositories') return json(req, { repositories: [{ full_name: 'acme/api', private: world.isPrivate, default_branch: 'main', archived: false }, { full_name: 'acme/zzz-other', private: true, default_branch: 'main', archived: false }] });
      if (p === '/branches') return json(req, [{ name: 'main' }]);
      if (p === '/pulls') return json(req, []);
      if (p === '/pulls/7') return json(req, { merged: false, head: { sha: world.head } });
      if (p === '/issues/7/comments') return world.commentsStatus === 200 ? json(req, world.comments) : json(req, { message: 'no' }, world.commentsStatus);
      if (p === '/actions/secrets') return json(req, { secrets: world.login ? [{ name: 'CODEX_AUTH_JSON' }] : [] });
      if (p.startsWith('/contents/')) return json(req, {}, 404);
      if (p.startsWith('/git/ref/heads/')) return json(req, { object: { sha: 'basesha' } });
      const run = p.match(/^\/commits\/([^/]+)\/check-runs/);
      if (run) return json(req, { check_runs: world.checks[run[1]] ? [world.checks[run[1]]] : [] });
      return json(req, {}, 404);
    }
    if (dist && u.origin === base) {
      const file = join(dist, u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname);
      if (existsSync(file)) return req.respond({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    }
    return req.continue();
  });

  const text = () => page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' '));
  const until = async (test, what, ms = 14000) => {
    const end = Date.now() + ms;
    let t = '';
    while (Date.now() < end) {
      t = await text();
      if (test(t)) return t;
      await wait(150);
    }
    throw new Error(`waited for ${what}, page says: ${t.slice(0, 200)}`);
  };
  const click = async (selector, label) => {
    const at = await page.evaluate((s, l) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(l));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, selector, label);
    if (!at) throw new Error(`no ${selector} with ${label}: ${await text()}`);
    await page.mouse.click(at.x, at.y);
  };
  const shot = (what) => page.screenshot({ path: `${out}code-${name}-${what}.png` }).catch(() => {}); // Only a debugging aid, so it can't fail a run.
  const reach = async () => {
    await page.bringToFront();
    await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
    await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
    await until((t) => t.includes('Which repo'), 'the list');
    await click('[role=option]', 'api');
    await until((t) => /Add to api/.test(t), 'the add screen');
    await wait(800); // The screen slides in, and a click during that misses.
    await click('button', 'Add to api');
    await until((t) => !/Add to api/.test(t) || /Connect your AI/.test(t), 'leaving the add screen');
  };

  try {
    await body({ page, world, text, until, click, shot, reach });
  } catch (e) {
    expect(false, `stopped early: ${e.message.slice(0, 220)}`);
  }
  if (errors.length) { console.log('  page errors', errors.slice(0, 3)); failures++; }
  await page.close();
}

await scenario('code-shows', { comments: [comment(BOT, askFor())], checks: { headsha: WAITING } }, async ({ page, text, until, click, shot, reach }) => {
  await reach();
  const t = await until((x) => x.includes(CODE), 'the code');
  await wait(400);
  await shot('code');
  expect(/Enter this code at OpenAI/.test(t), 'asks to enter it at OpenAI');
  expect(/Waiting for you to enter the code/.test(t), 'says it is waiting for them');
  expect(!/Open pull request/.test(t), 'no need to open the pull request');
  const link = await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find((e) => e.textContent.includes('Open OpenAI')); return a && { href: a.href, target: a.target }; });
  expect(link?.href === DEVICE && link.target === '_blank', "opens OpenAI's own link in a new tab");
  await click('button', 'Copy');
  await until((x) => /Copied/.test(x), 'the copied label');
  expect((await page.evaluate(() => window.__copied)).at(-1) === CODE, 'Copy copies the code');
  await page.evaluate(() => { window.__copied = []; const a = [...document.querySelectorAll('a')].find((e) => e.textContent.includes('Open OpenAI')); a.addEventListener('click', (e) => e.preventDefault()); a.click(); });
  await wait(100);
  expect((await page.evaluate(() => window.__copied)).at(-1) === CODE, 'opening OpenAI copies it too');
  expect((await text()).includes(CODE), 'and it stays on screen');
});

await scenario('from-github-actions', { comments: [comment('github-actions[bot]', askFor())], checks: { headsha: WAITING } }, async ({ until, reach }) => {
  await reach();
  expect((await until((x) => x.includes(CODE), 'the code')).includes(CODE), 'also reads it from the older poster');
});

for (const [name, comments, what] of [
  ['someone-elses-comment', [comment('attacker', askFor('EVIL-CODE1'))], "a stranger's comment"],
  ['lookalike-name', [comment('mergelight-ai', askFor('EVIL-CODE1'))], 'a name that only looks like the bot'],
  ['wrong-link', [comment(BOT, askFor('EVIL-CODE1', 'https://auth.openai.com.evil.example/device'))], 'a link that is not OpenAI'],
  ['finished-review-quoting-a-code', [comment(BOT, `${SUMMARY_MARKER}\n### 🟢 Safe\n1. Open ${DEVICE}\n2. Enter this code: \`EVIL-CODE1\``)], 'a finished review quoting text from the PR'],
]) {
  await scenario(name, { comments, checks: { headsha: WAITING } }, async ({ until, reach, text }) => {
    await reach();
    await until((x) => /Your code is ready on the pull request/.test(x), 'the fallback');
    await new Promise((r) => setTimeout(r, 5000));
    const t = await text();
    expect(!t.includes('EVIL-CODE1'), `ignores ${what}`);
    expect(/Enter the code we post on your pull request/.test(t) && /Open pull request #7/.test(t), 'points to the pull request instead');
  });
}

await scenario('real-one-beside-a-fake', { comments: [comment(BOT, askFor()), comment('attacker', askFor('EVIL-CODE1'))], checks: { headsha: WAITING } }, async ({ until, reach }) => {
  await reach();
  const t = await until((x) => x.includes(CODE), 'the code');
  expect(!t.includes('EVIL-CODE1'), 'a later fake comment changes nothing');
});

await scenario('code-arrives-later', {}, async ({ page, world, until, shot, reach }) => {
  await reach();
  const t = await until((x) => /Getting your code\. Almost ready/.test(x), 'the waiting line');
  await shot('getting');
  expect(/It shows up here in a moment/.test(t), 'says it will show up here');
  expect(/Almost ready, hang tight/.test(t), 'says it is almost ready');
  expect(await page.evaluate(() => Boolean(document.querySelector('[role=status] .animate-spin'))), 'shows a spinner while it waits');
  expect(/Open pull request #7/.test(t), 'keeps the pull request a click away');
  world.checks.headsha = WAITING;
  world.comments = [comment(BOT, askFor())];
  await until((x) => x.includes(CODE), 'the code');
  expect(true, 'appears by itself, no reload');
});

await scenario('connected-moves-on', { comments: [comment(BOT, askFor())], checks: { headsha: WAITING } }, async ({ world, until, reach }) => {
  await reach();
  await until((x) => x.includes(CODE), 'the code');
  world.login = true;
  world.comments = [comment(BOT, pendingSummaryBody())];
  world.checks.headsha = { status: 'completed', conclusion: 'neutral', output: { title: 'Connected to ChatGPT' } };
  const t = await until((x) => /Your PR is open/.test(x), 'the timeline');
  expect(!t.includes(CODE), 'the code is gone');
  expect(/First review running/.test(t) || /Starting the first review/.test(t), `the review is on its way: ${t.slice(0, 100)}`);
});

await scenario('code-runs-out', { comments: [comment(BOT, askFor())], checks: { headsha: WAITING } }, async ({ world, until, shot, reach, text }) => {
  await reach();
  await until((x) => x.includes(CODE), 'the code');
  world.comments = [comment(BOT, connectFailedBody('The code ran out, or OpenAI refused it.'))];
  world.checks.headsha = FAILED;
  let t = await until((x) => /Couldn't connect/.test(x), 'the ran out message');
  await wait(400);
  await shot('ran-out');
  expect(!t.includes(CODE), 'stops showing the old code');
  expect(/Connect your AI/.test(t), 'stays on this screen');
  expect(!/First review done/.test(t) && !/It reviewed/.test(t), "doesn't claim a review happened");
  expect(/push a new commit/.test(t) && /Open pull request #7/.test(t), 'says how to get a new one');

  // Pushing that commit: new head, a new run, a new code.
  world.head = 'sha2';
  world.checks.sha2 = WAITING;
  world.comments = [comment(BOT, askFor(NEW_CODE))];
  t = await until((x) => x.includes(NEW_CODE), 'the new code');
  expect(/Waiting for you to enter the code/.test(t) && !/Couldn't connect/.test(t), 'shows the new code, and the failure is gone');
  expect(world.asked.includes('/commits/sha2/check-runs'), 'follows the new commit');
  world.login = true;
  world.comments = [comment(BOT, pendingSummaryBody())];
  world.checks.sha2 = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  t = await until((x) => /Your PR is open/.test(x), 'the timeline');
  expect(/First review running/.test(t), 'and the review of the new commit is what it reports');
});

await scenario('comments-cant-be-read', { commentsStatus: 403, checks: { headsha: WAITING } }, async ({ until, reach }) => {
  await reach();
  const t = await until((x) => /Your code is ready on the pull request/.test(x), 'the fallback');
  expect(/Enter the code we post on your pull request/.test(t) && /Open pull request #7/.test(t), 'falls back to the pull request');
});

await scenario('public-repo', { isPrivate: false, comments: [comment(BOT, askFor())], checks: { headsha: WAITING } }, async ({ world, until, reach, text }) => {
  await reach();
  await until((x) => /Connect your AI/.test(x), 'the connect screen');
  await new Promise((r) => setTimeout(r, 5000));
  expect(!(await text()).includes(CODE), "doesn't show a code");
  expect(!world.asked.includes('/issues/7/comments'), 'and never asks for one');
});

await scenario('claude-plan-public-repo', { isPrivate: false, checks: { headsha: WAITING } }, async ({ page, click, reach, until, shot }) => {
  await reach();
  await until((x) => /Connect your AI/.test(x), 'the Connect screen');
  await click('label', 'Claude plan');
  const t = await until((x) => /claude setup-token/.test(x), 'the Claude steps');
  await new Promise((r) => setTimeout(r, 900));
  await shot('claude');
  expect(await page.evaluate(() => document.querySelector('input[type=radio]:checked')?.closest('label')?.innerText.includes('Claude plan')), 'the Claude plan card is the one selected');
  expect(/CLAUDE_CODE_OAUTH_TOKEN/.test(t), 'names the secret');
  expect(/Push any commit/.test(t), 'says how to start the review');
  await click('label', 'Anthropic API key');
  const k = await until((x) => /ANTHROPIC_API_KEY/.test(x), 'the Anthropic key steps');
  expect(!/claude setup-token/.test(k), 'an API key needs only the secret');
});

const CLAUDE = `https://claude.com/cai/oauth/authorize?code=true&code_challenge=abc&state=${'t'.repeat(43)}`;
const WHOLE = `abcdef123456#${'s'.repeat(43)}`;
const CLAUDE_COMMENT = () => comment(BOT, withState(connectBody({ url: DEVICE, code: CODE }, 'https://github.com/acme/api/actions/runs/1', CLAUDE, claudeSetupLink('acme/api', 7)), undefined));
const OLD_COMMENT = ['<!-- mergelight:summary -->', '<!-- mergelight:pending -->', '### 🔌 Connect ChatGPT to start reviewing', '', `1. Open ${DEVICE}`, `2. Enter this code: \`${CODE}\``].join('\n');
await scenario('comment-from-an-older-release', { comments: [comment(BOT, OLD_COMMENT)], checks: { headsha: WAITING } }, async ({ until, reach }) => {
  await reach();
  await until((x) => x.includes(CODE), 'the code from the old layout');
  expect(true, 'still reads the old layout');
});

await scenario('claude-button-and-paste', { comments: [CLAUDE_COMMENT()], checks: { headsha: WAITING } }, async ({ page, world, click, reach, until }) => {
  await reach();
  await until((x) => x.includes(CODE), 'the code');
  await click('label', 'Claude plan');
  const t = await until((x) => /Open Claude/.test(x), 'the Claude button');
  expect(!/claude setup-token/.test(t), 'no terminal needed');
  expect(await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open Claude'))?.href) === CLAUDE, 'the button opens the link from the run');
  await new Promise((r) => setTimeout(r, 900)); // The card changes height, and a click during that misses.
  await page.type('input[aria-label="Code from Claude"]', 'abcdef123456');
  await click('button', 'Connect');
  await until((x) => /isn't the whole code/.test(x), 'the partial code warning');
  expect(!world.posted?.length, 'a partial code never reaches the pull request');
  await page.type('input[aria-label="Code from Claude"]', WHOLE.slice('abcdef123456'.length));
  await click('button', 'Connect');
  await until((x) => /Connecting to Claude/.test(x), 'the connecting line');
  const left = world.refs?.find((r) => r.ref.startsWith('refs/mergelight/'));
  expect(left?.ref === `refs/${claudeCodeRef(CLAUDE)}` && left?.sha === 'blobsha', 'leaves the code at the exact place the run looks');
  expect(world.blob?.content === WHOLE, 'leaves only the code');
  expect(!world.posted?.length, 'nothing shows on the pull request');
});

await scenario('link-from-the-pull-request', { comments: [CLAUDE_COMMENT()], checks: { headsha: WAITING }, login: true }, async ({ page, world, until }) => {
  const href = world.comments[0].body.match(/\[Connect on mergelight\.dev\]\((\S+?)\)/)?.[1];
  expect(Boolean(href), 'the comment has the link');
  await page.goto(href, { waitUntil: 'networkidle2' });
  const t = await until((x) => /Paste the code Claude shows you/.test(x), 'the Claude step');
  expect(/Open Claude/.test(t), 'opens on the Claude step');
  expect(!/Which repo|Add to api/.test(t), 'nothing to pick or click through first');
  expect(await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open Claude'))?.href) === CLAUDE, 'with the link from the run');
  expect(/It works once/.test(t), 'says what the code can do');
  await new Promise((r) => setTimeout(r, 2500));
  expect(/Paste the code Claude shows you/.test(await page.evaluate(() => document.querySelector('main').innerText)), 'a repo with some other login saved still stays on this step');
});

await scenario('link-to-a-repo-they-cannot-see', {}, async ({ page, until }) => {
  await page.goto(`${base}/setup/?repo=acme/secret&pr=7&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  expect(true, 'falls back to picking a repo');
});

for (const [name, comments, what] of [
  ['claude-link-from-a-stranger', [comment('attacker', withState(connectBody(null, undefined, CLAUDE), undefined))], "a stranger's Claude link"],
  ['claude-link-to-another-site', [comment(BOT, withState(connectBody(null, undefined, 'https://claude.com.evil.example/x'), undefined))], 'a link that is not Claude'],
]) {
  await scenario(name, { comments, checks: { headsha: WAITING } }, async ({ page, click, reach, until }) => {
    await reach();
    await until((x) => /Connect your AI/.test(x), 'the Connect screen');
    await click('label', 'Claude plan');
    await new Promise((r) => setTimeout(r, 1500));
    expect(!(await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => a.textContent.includes('Open Claude')))), `ignores ${what}`);
  });
}

await scenario('api-key-instead', { comments: [comment(BOT, askFor())], checks: { headsha: WAITING } }, async ({ until, click, reach, text }) => {
  await reach();
  await until((x) => x.includes(CODE), 'the code');
  await click('label', 'OpenAI API key');
  const t = await until((x) => /OPENAI_API_KEY/.test(x), 'the API key steps');
  expect(!t.includes(CODE), 'the code goes away on the API key tab');
  expect(/We'll move on when you're connected/.test(t), 'and the line fits that tab');
  await click('button', 'OPENAI_API_KEY');
  await until((x) => /Copied/.test(x), 'copied');
  expect(!(await text()).includes(CODE), 'copying the secret name still works');
});

await scenario('review-fails-with-a-login', { login: true, checks: { headsha: FAILED } }, async ({ until, reach, shot }) => {
  await reach();
  const t = await until((x) => /didn't finish/.test(x), 'the failed review');
  await shot('failed');
  expect(/First review didn't finish/.test(t), 'says it did not finish');
  expect(!/First review done/.test(t) && !/It reviewed/.test(t), "doesn't claim it reviewed anything");
  expect(/check on the PR says why/.test(t), 'says where the reason is');
  expect(!/keeps running/.test(t), "doesn't say it's still running");
});

console.log(failures ? `\n${failures} FAILED` : '\nall good');
await browser.close();
process.exitCode = failures ? 1 : 0;
