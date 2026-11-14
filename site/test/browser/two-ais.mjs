// A repo that's on gets a second AI, or a new choice of who reviews and who checks, on the real built page against a
// fake GitHub. The connect comment comes from the Action's own code, so this breaks if the two ever stop matching.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.env.REPO ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const { connectBody, withState } = await import(`${root}/packages/mergelight/dist/connect.js`);
const { pendingSummaryBody } = await import(`${root}/packages/mergelight/dist/publish/markdown.js`);

const dist = process.env.DIST ?? new URL('../../dist', import.meta.url).pathname;
const out = process.env.SHOTS ?? `${mkdtempSync(join(tmpdir(), 'mergelight-browser-'))}/`;
mkdirSync(out, { recursive: true });
const base = 'https://mergelight.dev';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const b64 = (s) => Buffer.from(s).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString();

let failures = 0;
const expect = (ok, what) => { console.log(`  ${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// What a repo set up from this page has: the real template, on the moving tag.
const TEMPLATE = readFileSync(`${root}/examples/mergelight.yml`, 'utf8');
const REFRESH = readFileSync(`${root}/examples/mergelight-refresh.yml`, 'utf8');
const SHA = 'a'.repeat(40);
const LAST_INPUT = '          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}\n';
const BOT = 'mergelight-ai[bot]';
const CODE = '2ZYY-TEST1';
const askFor = () => withState(connectBody({ url: 'https://auth.openai.com/codex/device', code: CODE }, 'https://github.com/acme/api/actions/runs/1'), undefined);
const WAITING = { status: 'in_progress', conclusion: null, output: { title: 'Waiting for you to connect ChatGPT' } };
const PR = { number: 9, html_url: 'https://github.com/acme/api/pull/9' };
const CLAUDE = `https://claude.com/cai/oauth/authorize?code=true&code_challenge=abc&state=${'t'.repeat(43)}`;
/** A run asking to connect the AI that checks the review, written the way the Action's connectData writes it. */
const askToCheck = (data) => ({ user: { login: BOT }, body: ['<!-- mergelight:summary -->', '<!-- mergelight:pending -->', `<!-- mergelight:connect:v1 ${JSON.stringify({ ...data, for: 'check' }).replace(/--/g, '\\u002d\\u002d')} -->`, '### 🔌 Connect to check this review'].join('\n') });
const waitingToCheck = (who) => ({ status: 'in_progress', conclusion: null, output: { title: `Waiting for you to connect ${who} to check the review` } });
/** Whether any tile on the page offers this AI. */
const offers = (page, name) => page.evaluate((n) => [...document.querySelectorAll('[role=radiogroup] label')].some((l) => l.textContent.startsWith(n)), name);

async function scenario(name, start, body) {
  console.log(`\n== ${name}`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const world = { isPrivate: true, file: TEMPLATE, refresh: null, secrets: [], comments: [], checks: {}, head: 'rolesha', merged: false, open: null, branchFile: null, branchRefresh: null, fileGone: false, writes: [], ...start };
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
      if (u.pathname === '/review-app') return json(req, { installed: true });
      return req.respond({ status: 200, headers: cors, body: 'ok' });
    }
    if (u.origin === 'https://github.com' && u.pathname === '/login/oauth/authorize') return req.respond({ status: 302, headers: { location: `${base}/setup/?code=c&state=${u.searchParams.get('state')}` } });
    if (u.origin === 'https://api.github.com') {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (u.pathname === '/repos/mergelightai/mergelight/releases/latest') return json(req, { tag_name: 'v0.2.0' });
      if (u.pathname === '/repos/mergelightai/mergelight/commits/v0.2.0') return json(req, { sha: 'a'.repeat(40) });
      const p = u.pathname.replace('/repos/acme/api', '');
      if (m !== 'GET') {
        const data = req.postData() ? JSON.parse(req.postData()) : null;
        world.writes.push({ m, p, body: data });
        if (m === 'POST' && p === '/git/refs') return json(req, { ref: data.ref }, 201);
        if (m === 'PUT' && p.startsWith('/contents/')) {
          if (p.endsWith('/mergelight.yml')) world.branchFile = unb64(data.content);
          else world.branchRefresh = unb64(data.content);
          return json(req, { content: {}, commit: { sha: world.head } }, 201);
        }
        if (m === 'POST' && p === '/pulls') {
          world.open = { ...PR, ref: data.head };
          return json(req, { ...PR, head: { sha: world.head } }, 201);
        }
        if (m === 'DELETE') return req.respond({ status: 204, headers: cors });
        return json(req, {}, 404);
      }
      if (u.pathname === '/user/installations') return json(req, { installations: [{ id: 1, html_url: 'https://github.com/settings/installations/1', account: { id: 1, login: 'acme', avatar_url: `${base}/logo.png` } }] });
      if (u.pathname === '/user/installations/1/repositories') return json(req, { repositories: [{ id: 2, full_name: 'acme/api', private: world.isPrivate, default_branch: 'main', archived: false }, { id: 3, full_name: 'acme/zzz-other', private: true, default_branch: 'main', archived: false }] });
      if (p === '/branches') return json(req, [{ name: 'main' }]);
      if (p === '/pulls' && u.searchParams.get('state') === 'open') return json(req, world.open ? [{ number: world.open.number, html_url: world.open.html_url, head: { sha: world.head, ref: world.open.ref, repo: { full_name: 'acme/api' } } }] : []);
      if (p === '/pulls') return json(req, []);
      if (p === `/pulls/${PR.number}/files`) return json(req, [{ filename: '.github/workflows/mergelight.yml' }]);
      if (p === `/pulls/${PR.number}`) return json(req, { merged: world.merged, head: { sha: world.head } });
      if (p === `/issues/${PR.number}/comments`) return json(req, world.comments);
      if (p === '/actions/secrets') return json(req, { secrets: world.secrets.map((name) => ({ name })) });
      if (p === '/contents/.github/workflows/mergelight.yml') {
        const ref = u.searchParams.get('ref');
        if (world.fileGone) return json(req, {}, 404);
        if (ref === 'main') return json(req, { sha: 'baseblob', content: b64(world.file) });
        if (ref === world.open?.ref && world.branchFile) return json(req, { sha: 'prblob', content: b64(world.branchFile) });
        // A new branch starts with what main has.
        return json(req, { sha: 'baseblob', content: b64(world.file) });
      }
      if (p === '/contents/.github/workflows/mergelight-refresh.yml') {
        const ref = u.searchParams.get('ref');
        const body = ref === world.open?.ref && world.branchRefresh ? world.branchRefresh : world.refresh;
        return body ? json(req, { sha: 'refreshblob', content: b64(body) }) : json(req, {}, 404);
      }
      if (p.startsWith('/contents/')) return json(req, {}, 404);
      if (p === '/git/ref/heads/main') return json(req, { object: { sha: 'basesha' } });
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
      t = await text().catch(() => t);
      if (test(t)) return t;
      await wait(150);
    }
    throw new Error(`waited for ${what}, page says: ${t.slice(0, 240)}`);
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
  /** The tile that's on in a group of choices. */
  const picked = (group) => page.evaluate((g) => [...document.querySelectorAll(`[role=radiogroup][aria-label="${g}"] label`)].find((l) => l.querySelector('input').checked)?.textContent ?? null, group);
  /** At desktop width, and at a phone's when asked. Only a record for people, so it can't fail a run. */
  const shot = async (what, phone = false) => {
    await wait(700);
    await page.screenshot({ path: `${out}${what}-desktop.png`, fullPage: true }).catch(() => {});
    if (!phone) return;
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
    await wait(900);
    await page.screenshot({ path: `${out}${what}-phone.png`, fullPage: true }).catch(() => {});
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
    await wait(600);
  };
  /** Signs in, picks the repo, and goes past the add step, which only says it's on already. */
  const reachLive = async () => {
    await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
    await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
    await until((t) => t.includes('Which repo'), 'the list');
    await click('[role=option]', 'api');
    const added = await until((t) => /It's already on main/.test(t), 'the add step');
    await wait(800); // The screen slides in, and a click during that misses.
    await click('button', 'Continue');
    return { added, live: await until((t) => /Mergelight is on/.test(t), 'the live step') };
  };
  /** Opens the choice from the live step's button. */
  const choose = async (button) => {
    await wait(800);
    await click('button', button);
    const t = await until((x) => /Choose your AI/.test(x), 'the choice');
    await wait(800); // The screen slides in, and a click during that misses.
    return t;
  };

  try {
    await body({ page, world, text, until, click, picked, shot, reachLive, choose });
  } catch (e) {
    expect(false, `stopped early: ${e.message.slice(0, 260)}`);
  }
  if (errors.length) { console.log('  page errors', errors.slice(0, 3)); failures++; }
  await page.close();
}

await scenario('claude-only-adds-chatgpt', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }, async ({ page, world, until, click, picked, shot, reachLive, choose, text }) => {
  const { added, live } = await reachLive();
  expect(/Your AI/.test(added) && /Reviews with Claude, checked by Claude/.test(added), 'the add step says who reviews too');
  expect(/Reviews with Claude, checked by Claude/.test(live), 'the live step says Claude reviews and checks');
  expect(/Add ChatGPT/.test(live) && !/Add Claude/.test(live), 'offers to add ChatGPT');
  await shot('live-claude-only', true);

  let t = await choose('Add ChatGPT');
  expect((await picked('Reviews your PRs')) === 'Claude', 'Claude keeps reviewing');
  expect((await picked('Checks what it finds'))?.startsWith('ChatGPT'), 'ChatGPT checks, by default');
  expect(/ChatGPTRecommended|ChatGPT Recommended/.test(t), 'and that pick is the recommended one');
  expect(/ChatGPT isn't connected yet/.test(t), 'says ChatGPT still needs connecting');
  expect(/Adds the small job that keeps a ChatGPT login fresh/.test(t), 'says it adds the job that keeps that login fresh');
  await shot('roles-choice', true);

  await click('button', 'Open PR');
  t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  const puts = world.writes.filter((w) => w.m === 'PUT');
  const file = puts[0] && unb64(puts[0].body.content);
  expect(puts.length === 2 && puts[0].p === '/contents/.github/workflows/mergelight.yml' && puts[1].p === '/contents/.github/workflows/mergelight-refresh.yml', 'changes the workflow, and adds the refresh job');
  expect(puts[1] && unb64(puts[1].body.content) === REFRESH && !puts[1].body.sha, 'the job is the same one a setup adds, on the same version as the review');
  expect(file === TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`), 'adds the two lines, and every other byte stays');
  expect(puts[0]?.body.sha === 'baseblob' && puts[0]?.body.message === 'Review with Claude, check with ChatGPT', 'one commit that says what it does');
  const pull = world.writes.find((w) => w.m === 'POST' && w.p === '/pulls');
  expect(pull?.body.title === 'Set who reviews and who checks in Mergelight' && pull?.body.base === 'main', 'a pull request into the branch it runs from');
  expect(/Only the `provider` and `verify-with` lines/.test(pull?.body.body ?? ''), 'whose text says only those lines change');
  expect(/also adds a small job that keeps a ChatGPT login fresh/.test(pull?.body.body ?? ''), 'and that it adds the job');
  expect(/Connect ChatGPT to check reviews/.test(t) && /Claude's review then starts by itself, and ChatGPT checks its findings/.test(t), 'says the login is for checking the review');
  expect(!(await offers(page, 'Claude')) && !(await offers(page, 'ChatGPT')), 'offers no choice of AI: only ChatGPT can connect on this run');

  world.checks.rolesha = waitingToCheck('ChatGPT');
  world.comments = [askToCheck({ url: 'https://auth.openai.com/codex/device', code: CODE, claudeUrl: null })];
  t = await until((x) => x.includes(CODE), 'the code from the run');
  expect(/Enter this code at OpenAI/.test(t), 'shows the code from the run on that pull request');
  expect(/Connect ChatGPT to check reviews/.test(t) && !/Open Claude|claude setup-token/.test(t), 'and still only ChatGPT');
  expect(!/npx @mergelight\/cli|repo is public/.test(t), 'a private repo connects with the code, as before');
  await shot('connect-chatgpt');

  world.secrets.push('CODEX_AUTH_JSON');
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  t = await until((x) => /Mergelight is on/.test(x), 'back to live');
  expect(/Merge PR #9 to review with Claude and check with ChatGPT/.test(t), 'says what merging the pull request does');
  expect(!/Your PR is open|Merge it to turn on/.test(t), "doesn't call it a setup");
  // Nothing in the file names a reviewer yet, so with both logins the Action's default is ChatGPT until this merges.
  expect(/Reviews with ChatGPT, checked by Claude/.test(t), 'until it merges, it says what runs now');
  expect(/Change/.test(t) && !/Add ChatGPT/.test(t), 'with both connected, it offers a change');
  expect((await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open PR #9'))?.href)) === PR.html_url, 'links to the pull request');
  await shot('live-pending', true);

  world.merged = true;
  t = await until((x) => /Reviews with Claude, checked by ChatGPT/.test(x), 'the merged change');
  expect(!/Merge PR #9/.test(t), 'nothing left to merge');
  expect(!(await text()).includes(CODE), 'and no code is left on screen');
});

await scenario('both-change-roles', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: codex # we chose this\n`) }, async ({ page, world, until, click, picked, shot, reachLive, choose }) => {
  const { live } = await reachLive();
  expect(/Reviews with ChatGPT, checked by Claude/.test(live), 'reads provider from the file, and the other AI checks');
  expect(/Change/.test(live) && !/Add ChatGPT|Add Claude/.test(live), 'offers a change');

  await choose('Change');
  expect((await picked('Reviews your PRs')) === 'ChatGPT' && (await picked('Checks what it finds')) === 'Claude' + 'Recommended', 'starts on what runs now');
  await click('[role=radiogroup][aria-label="Reviews your PRs"] label', 'Claude');
  await wait(200);
  expect((await picked('Checks what it finds'))?.startsWith('ChatGPT'), 'a new reviewer gets the other AI as checker');
  const t0 = await until((x) => /Open PR/.test(x), 'the button');
  expect(!/isn't connected yet/.test(t0), 'nothing to connect');
  expect(!/Adds the small job/.test(t0), 'and no job to add');
  await shot('roles-change');

  await click('button', 'Open PR');
  const t = await until((x) => /Merge PR #9 to review with Claude and check with ChatGPT/.test(x), 'live with the pull request');
  expect(!/Connect your AI/.test(t), 'goes straight back to live');
  const href = await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open PR #9'))?.href);
  expect(href === PR.html_url, 'links to the pull request');
  const put = world.writes.find((w) => w.m === 'PUT');
  expect(unb64(put.body.content) === TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude # we chose this\n          verify-with: codex\n`), 'replaces provider in place, keeps its comment, and adds verify-with right after');
  expect(world.writes.filter((w) => w.m === 'PUT').length === 1, 'ChatGPT has a login already, so no refresh job comes along');
  await shot('live-after-change');
});

await scenario('already-set-like-this', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, click, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Change');
  expect(/Already set like this/.test(t), "says there's nothing to change");
  await click('button', 'Already set like this');
  await wait(600);
  expect(world.writes.length === 0, 'and writes nothing');
});

await scenario('open-pr-gets-the-change', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], open: { ...PR, ref: 'mergelight-setup-old' }, branchFile: TEMPLATE.replace('mergelightai/mergelight@v0', `mergelightai/mergelight@${'a'.repeat(40)} # v0.2.0`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  const put = world.writes.find((w) => w.m === 'PUT');
  expect(world.writes.every((w) => w.m === 'PUT') && put?.body.branch === 'mergelight-setup-old' && put?.body.sha === 'prblob', 'adds to the pull request that changes the workflow already');
  expect(unb64(put.body.content).includes(`mergelight@${'a'.repeat(40)} # v0.2.0`) && unb64(put.body.content).includes('verify-with: codex'), 'keeps what that pull request changed, and makes this change on top');
});

await scenario('pinned-repo-gets-a-pinned-job', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace('mergelightai/mergelight@v0', `mergelightai/mergelight@${SHA} # v0.2.0`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  const job = world.writes.find((w) => w.m === 'PUT' && w.p.endsWith('/mergelight-refresh.yml'));
  const content = job && unb64(job.body.content);
  expect(content?.includes(`uses: mergelightai/mergelight@${SHA} # v0.2.0\n`), 'the job is pinned to the same release as the review');
  expect(!/Not pinned/.test(content ?? '') && /# Pinned to a release/.test(content ?? ''), 'and says why, like a pinned setup');
});

await scenario('refresh-job-already-there', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: `# Ours, keep it\n${REFRESH}` }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Add ChatGPT');
  expect(!/Adds the small job/.test(t), "doesn't offer a job that's there");
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  const puts = world.writes.filter((w) => w.m === 'PUT');
  expect(puts.length === 1 && puts[0].p.endsWith('/mergelight.yml'), 'changes only the workflow, and leaves their job alone');
});

await scenario('public-repo-adds-chatgpt-checker', { isPrivate: false, secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }, async ({ page, world, until, click, shot, reachLive, choose }) => {
  await reachLive();
  let t = await choose('Add ChatGPT');
  expect(/This repo is public, so anyone who can see your PR could enter a ChatGPT code\. Next, you save the login from your own computer/.test(t), 'the choice says why the login comes from their computer');
  await click('button', 'Open PR');
  t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  const command = 'npx @mergelight/cli setup acme/api --relogin';
  expect(t.includes(command), 'shows the command, with this repo filled in');
  expect(/This repo is public, so anyone who can see your PR could enter a ChatGPT code/.test(t), 'and says why');
  expect(/close that PR/.test(t) && /merging it would undo this change/.test(t), 'warns about the extra PR the command opens');
  expect(/Until it's saved, Claude checks its own reviews/.test(t), 'says what happens until then');
  await click('button', 'Copy');
  await until((x) => /Copied/.test(x), 'the copied label');
  expect((await page.evaluate(() => window.__copied)).at(-1) === command, 'Copy copies the command');
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  await wait(6000);
  t = await page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' '));
  expect(!/Getting your code|Enter the code|Enter this code|Couldn't connect/.test(t), 'never waits for a code, and never calls it a failure');
  await shot('connect-public-checker', true);
  await click('button', 'Continue');
  t = await until((x) => /Mergelight is on/.test(x), 'back to live');
  expect(/Merge PR #9 to review with Claude and check with ChatGPT/.test(t), 'with the pull request linked');
});

await scenario('chatgpt-only-adds-claude', { secrets: ['CODEX_AUTH_JSON'] }, async ({ page, world, until, click, shot, reachLive, choose }) => {
  const { live } = await reachLive();
  expect(/Reviews with ChatGPT, checked by ChatGPT/.test(live) && /Add Claude/.test(live), 'offers to add Claude');
  let t = await choose('Add Claude');
  expect(/Claude isn't connected yet\. Next, you connect it to check reviews/.test(t), 'says Claude is connected to check reviews');
  await click('button', 'Open PR');
  t = await until((x) => /Connect Claude to check reviews/.test(x), 'the connect step for checking');
  expect(/ChatGPT's review then starts by itself, and Claude checks its findings/.test(t), 'says what Claude does');
  expect(!(await offers(page, 'ChatGPT')) && !(await offers(page, 'Claude')), 'offers no choice of AI');
  expect(!/uses a lot of a Claude plan/.test(t), "says nothing about reviews on Opus, since Claude only checks");
  world.checks.rolesha = waitingToCheck('Claude');
  world.comments = [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })];
  t = await until((x) => /Open Claude/.test(x), "Claude's link");
  expect(await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open Claude'))?.href) === CLAUDE, 'with the link from the run');
  expect(!/Enter this code|OpenAI/.test(t), 'and nothing about a ChatGPT code');
  await shot('connect-claude-check', true);
});

await scenario('claude-checker-from-the-link', { secrets: ['CODEX_AUTH_JSON'], comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until, text }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  let t = await until((x) => /Open Claude/.test(x), 'the Claude step');
  expect(/Connect Claude to check reviews/.test(t) && /ChatGPT's review then starts by itself, and Claude checks its findings/.test(t), 'says the link is for checking the review');
  expect(!(await offers(page, 'ChatGPT')), 'never offers ChatGPT, whose code never comes on this run');
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'completed', conclusion: 'neutral', output: { title: "Claude wasn't connected" } };
  t = await until((x) => /This link has ended/.test(x), 'the ended link');
  expect(/get a new link/.test(t), 'says how to get a new one');
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  await wait(6000);
  t = await text();
  expect(/This link has ended/.test(t) && !/Mergelight is on/.test(t), "the review going on without Claude doesn't count as connected");
});

await scenario('step-cant-be-found', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: `${TEMPLATE}  again:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: mergelightai/mergelight@v0\n` }, async ({ world, reachLive }) => {
  const { live } = await reachLive();
  expect(/couldn't find the Mergelight step in your workflow file/.test(live), "says it can't tell, instead of guessing");
  expect(!/Add ChatGPT|Change/.test(live), 'and offers no change it would have to guess at');
  expect(world.writes.length === 0, 'writes nothing');
});

await scenario('file-gone-before-the-pr', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  world.fileGone = true;
  await click('button', 'Open PR');
  const t = await until((x) => /couldn't find \.github\/workflows\/mergelight\.yml on main/.test(x), 'the message');
  expect(/nothing was changed/.test(t), 'says nothing changed');
  expect(world.writes.length === 0, 'and made no branch to clean up');
});

console.log(failures ? `\n${failures} FAILED` : '\nall good');
await browser.close();
process.exitCode = failures ? 1 : 0;
