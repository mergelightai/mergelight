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
  const world = { isPrivate: true, visibility: null, defaultBranch: 'main', headFile: null, file: TEMPLATE, refresh: null, secrets: [], orgSecrets: [], comments: [], checks: {}, head: 'rolesha', merged: false, open: null, branchFile: null, branchRefresh: null, fileGone: false, slowPut: 0, writes: [], ...start };
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
      // v0 points at a release with two AIs, unless a test moves it back. b is v0.1.19, the first with them, and c is older.
      if (u.pathname === '/repos/mergelightai/mergelight/commits/v0') return json(req, { sha: world.v0 ?? 'a'.repeat(40) });
      if (u.pathname === '/repos/mergelightai/mergelight/tags') return json(req, [{ name: 'v0.2.0', commit: { sha: 'a'.repeat(40) } }, { name: 'v0', commit: { sha: world.v0 ?? 'a'.repeat(40) } }, { name: 'v0.1.19', commit: { sha: 'b'.repeat(40) } }, { name: 'v0.1.18', commit: { sha: 'c'.repeat(40) } }]);
      const p = u.pathname.replace('/repos/acme/api', '');
      if (m !== 'GET') {
        const data = req.postData() ? JSON.parse(req.postData()) : null;
        world.writes.push({ m, p, body: data });
        if (m === 'POST' && p === '/git/refs') return json(req, { ref: data.ref }, 201);
        if (m === 'PUT' && p.startsWith('/contents/')) {
          if (p.endsWith('/mergelight.yml')) world.branchFile = unb64(data.content);
          else world.branchRefresh = unb64(data.content);
          if (world.slowPut) return void setTimeout(() => json(req, { content: {}, commit: { sha: world.head } }, 201), world.slowPut);
          return json(req, { content: {}, commit: { sha: world.head } }, 201);
        }
        if (m === 'POST' && p === '/pulls') {
          world.open = { ...PR, ref: data.head, base: data.base };
          return json(req, { ...PR, head: { sha: world.head } }, 201);
        }
        if (m === 'DELETE') return req.respond({ status: 204, headers: cors });
        return json(req, {}, 404);
      }
      if (u.pathname === '/user/installations') return json(req, { installations: [{ id: 1, html_url: 'https://github.com/settings/installations/1', account: { id: 1, login: 'acme', avatar_url: `${base}/logo.png` } }] });
      if (p === `/pulls/${PR.number}` && world.closed) return json(req, { merged: false, state: 'closed', head: { sha: world.head } });
      if (u.pathname === '/user/installations/1/repositories') return json(req, { repositories: [{ id: 2, full_name: 'acme/api', private: world.isPrivate, visibility: world.visibility ?? (world.isPrivate ? 'private' : 'public'), default_branch: world.defaultBranch, archived: false }, { id: 3, full_name: 'acme/zzz-other', private: true, default_branch: 'main', archived: false }] });
      if (p === '/branches') return json(req, [{ name: 'main' }]);
      if (p === '/pulls' && u.searchParams.get('state') === 'open') {
        // Other open PRs come first when a test asks for them, a page at a time as GitHub hands them out.
        const others = Array.from({ length: world.otherOpen ?? 0 }, (_, i) => ({ number: 100 + i, html_url: `https://github.com/acme/api/pull/${100 + i}`, title: 'Some feature', base: { ref: 'main' }, head: { sha: 'othersha', ref: `feat/${i}`, repo: { full_name: 'acme/api' } } }));
        const mine = world.open ? [{ number: world.open.number, html_url: world.open.html_url, title: world.open.title ?? 'Add Mergelight code review', base: { ref: world.open.base ?? 'main' }, head: { sha: world.head, ref: world.open.ref, repo: { full_name: 'acme/api' } } }] : [];
        const per = Number(u.searchParams.get('per_page') ?? 30);
        const page = Number(u.searchParams.get('page') ?? 1);
        const list = [...others, ...mine].slice((page - 1) * per, page * per);
        // An answer can come late, holding what was true when it was asked.
        const delay = world.openDelays?.shift() ?? 0;
        return delay ? void setTimeout(() => json(req, list), delay) : json(req, list);
      }
      if (/^\/pulls\/[12]\d\d\/files$/.test(p)) return json(req, [{ filename: 'src/app.ts' }]);
      // Most new work goes to main, which is the default branch unless a test says otherwise.
      if (p === '/pulls') return json(req, [{ base: { ref: 'main' }, head: { ref: 'feat/x' } }]);
      if (p === `/pulls/${PR.number}/files` && world.filesFail) return json(req, {}, 500);
      if (p === `/pulls/${PR.number}/files`) {
        // A big PR lists its files a page at a time, with the workflow on the second page.
        if (!world.manyFiles) return json(req, [{ filename: '.github/workflows/mergelight.yml' }]);
        const page = Number(u.searchParams.get('page') ?? 1);
        return json(req, page === 1 ? Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.ts` })) : [{ filename: '.github/workflows/mergelight.yml' }]);
      }
      if (p === `/pulls/${PR.number}`) return json(req, { merged: world.merged, head: { sha: world.head } });
      if (p === `/issues/${PR.number}/comments`) return json(req, world.comments);
      // A number is how GitHub answers instead of a list.
      if (p === '/actions/secrets') return Array.isArray(world.secrets) ? json(req, { secrets: world.secrets.map((name) => ({ name })) }) : json(req, {}, world.secrets);
      if (p === '/actions/organization-secrets') {
        const answer = () => (Array.isArray(world.orgSecrets) ? json(req, { secrets: world.orgSecrets.map((name) => ({ name })) }) : json(req, {}, world.orgSecrets));
        // A read that answers late, after the person has moved on.
        if (world.slowOrg) return void setTimeout(answer, world.slowOrg);
        const delay = world.orgDelays?.shift() ?? 0;
        return delay ? void setTimeout(answer, delay) : answer();
      }
      if (p === '/contents/.github/workflows/mergelight.yml') {
        const ref = u.searchParams.get('ref');
        if (world.fileGone) return json(req, {}, 404);
        // The commit main is at when the PR's branch is made, which someone may have changed since the page read main.
        if (world.baseShaGone && ref === 'basesha') return json(req, {}, 404);
        // Once the PR is merged, main has what its branch held.
        if (ref === 'main' || ref === 'basesha') return json(req, { sha: 'baseblob', content: b64(world.merged && world.branchFile ? world.branchFile : world.file) });
        // The pull request's own commit, as a link from its run reads it. A number is how GitHub answers instead.
        // The run's own workflow is at the PR's merge commit. An answer can come late, holding what was true when asked.
        if (world.headFile !== null && ref === `refs/pull/${PR.number}/merge`) {
          const file = world.headFile;
          const answer = () => (typeof file === 'number' ? json(req, {}, file) : json(req, { sha: 'mergeblob', content: b64(file) }));
          const delay = world.mergeDelays?.shift() ?? 0;
          return delay ? void setTimeout(answer, delay) : answer();
        }
        if (ref === world.open?.ref && world.branchFile) return json(req, { sha: 'prblob', content: b64(world.branchFile) });
        // A new branch starts with what main has.
        return json(req, { sha: 'baseblob', content: b64(world.file) });
      }
      if (p === '/contents/.github/workflows/mergelight-refresh.yml') {
        const ref = u.searchParams.get('ref');
        // Once the PR is merged, main has the job only if its branch still had it.
        const body = ref === world.open?.ref && world.branchRefresh ? world.branchRefresh : (ref === 'main' || ref === 'basesha') && world.merged && world.branchRefresh !== null ? world.branchRefresh : world.refresh;
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
      // A long step can put it below the window, where a click misses.
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
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
  // The file doesn't name Claude, which reviews only as the one login, so a ChatGPT login would move reviews on main.
  expect(/ChatGPT isn't connected yet\. Next, merge the PR, then save its login from your own computer\. A ChatGPT login saved before that would make ChatGPT review on main\./.test(t), 'says ChatGPT connects once the PR is merged, and why');
  expect(/Adds the small job that keeps a ChatGPT login fresh/.test(t), 'says it adds the job that keeps that login fresh');
  await shot('roles-choice', true);

  await click('button', 'Open PR');
  t = await until((x) => /Merge your PR first/.test(x), 'the step that waits for the merge');
  const puts = world.writes.filter((w) => w.m === 'PUT');
  const file = puts[0] && unb64(puts[0].body.content);
  expect(puts.length === 2 && puts[0].p === '/contents/.github/workflows/mergelight.yml' && puts[1].p === '/contents/.github/workflows/mergelight-refresh.yml', 'changes the workflow, and adds the refresh job');
  expect(puts[1] && unb64(puts[1].body.content) === REFRESH && !puts[1].body.sha, 'the job is the same one a setup adds, on the same version as the review');
  // With no checker set, the PR's own run has none to ask for, so no ChatGPT code can show on it before the merge.
  expect(file === TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`), 'names only the reviewer, and every other byte stays');
  expect(puts[0]?.body.sha === 'baseblob' && puts[0]?.body.message === 'Review with Claude, check with ChatGPT', 'one commit that says what it does');
  const pull = world.writes.find((w) => w.m === 'POST' && w.p === '/pulls');
  expect(pull?.body.title === 'Set who reviews and who checks in Mergelight' && pull?.body.base === 'main', 'a pull request into the branch it runs from');
  expect(/Only the `provider` and `verify-with` lines/.test(pull?.body.body ?? ''), 'whose text says only those lines change');
  expect(/also adds a small job that keeps a ChatGPT login fresh/.test(pull?.body.body ?? ''), 'and that it adds the job');
  expect(/Your workflow on main doesn't say which AI reviews, so a ChatGPT login saved now would make ChatGPT review there\. PR #9 keeps Claude reviewing\./.test(t), 'says why the merge comes first');
  expect(/Waiting for you to merge PR #9/.test(t), 'and waits for it');

  await shot('connect-after-merge', true);

  await click('button', 'Back');
  t = await until((x) => /Mergelight is on/.test(x), 'live, after Back');
  expect(/ChatGPT isn't connected yet\./.test(t) && /Resume/.test(t), 'offers to pick up the connection again');
  await shot('live-resume');
  await wait(600);
  await click('button', 'Resume');
  await until((x) => /Merge your PR first/.test(x), 'the step that waits for the merge, again');

  world.merged = true;
  t = await until((x) => /codex login && gh secret set CODEX_AUTH_JSON --repo acme\/api/.test(x), 'the command, once merged');
  expect(/Connect ChatGPT to check reviews/.test(t) && /Your workflow makes ChatGPT check once it has a login, so no PR asks for a code\. Save the login from your own computer instead\./.test(t), 'says why the login comes from their computer');
  expect(!/Open Claude|claude setup-token|Enter this code/.test(t) && !(await offers(page, 'Claude')), 'and only ChatGPT');
  await shot('connect-chatgpt');

  world.secrets.push('CODEX_AUTH_JSON');
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  t = await until((x) => /Mergelight is on/.test(x), 'back to live');
  expect(/Reviews with Claude, checked by ChatGPT/.test(t), 'Claude still reviews, now checked by ChatGPT');
  expect(!/Merge PR #9/.test(t) && !/Resume/.test(t), 'nothing left to merge or connect');
  expect(!t.includes(CODE), 'and no code is left on screen');
});

await scenario('merged-after-the-run-moved-on', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  world.merged = true;
  const t = await until((x) => /Then open a new PR\. Its review shows a new code\./.test(x), 'what to do now');
  expect(/Connect ChatGPT to check reviews/.test(t) && !/push a new commit/.test(t), "doesn't ask for a commit on a merged PR");
});

await scenario('claude-named-adds-chatgpt', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ page, world, until, click, shot, reachLive, choose }) => {
  await reachLive();
  let t = await choose('Add ChatGPT');
  expect(/ChatGPT isn't connected yet\. Next, you connect it to check reviews\./.test(t), 'the file names Claude, so ChatGPT connects right away');
  await click('button', 'Open PR');
  t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  expect(!/Merge your PR first/.test(t), 'with no merge first');
  world.checks.rolesha = waitingToCheck('ChatGPT');
  world.comments = [askToCheck({ url: 'https://auth.openai.com/codex/device', code: CODE, claudeUrl: null })];
  t = await until((x) => x.includes(CODE), 'the code from the run');
  expect(!/npx @mergelight\/cli|repo is public/.test(t), 'a private repo connects with the code, as before');

  world.secrets.push('CODEX_AUTH_JSON');
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  t = await until((x) => /Mergelight is on/.test(x), 'back to live');
  expect(/Merge PR #9 to review with Claude and check with ChatGPT/.test(t), 'says what merging the pull request does');
  expect(!/Your PR is open|Merge it to turn on/.test(t), "doesn't call it a setup");
  expect(/Reviews with Claude, checked by ChatGPT/.test(t), 'Claude keeps reviewing while the PR waits, as the file says');
  expect(/Change/.test(t) && !/Add ChatGPT/.test(t), 'with both connected, it offers a change');
  expect((await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open PR #9'))?.href)) === PR.html_url, 'links to the pull request');
  await shot('live-pending', true);

  world.merged = true;
  t = await until((x) => !/Merge PR #9/.test(x), 'the merged change');
  expect(/Reviews with Claude, checked by ChatGPT/.test(t), 'and the same once it is merged');
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
  expect(/Adds the small job that keeps a ChatGPT login fresh/.test(t0), 'a saved ChatGPT login with no job to refresh it gets one');
  await shot('roles-change');

  await click('button', 'Open PR');
  const t = await until((x) => /Merge PR #9 to review with Claude and check with ChatGPT/.test(x), 'live with the pull request');
  expect(!/Connect your AI/.test(t), 'goes straight back to live');
  const href = await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open PR #9'))?.href);
  expect(href === PR.html_url, 'links to the pull request');
  const puts = world.writes.filter((w) => w.m === 'PUT');
  expect(unb64(puts[0].body.content) === TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude # we chose this\n          verify-with: codex\n`), 'replaces provider in place, keeps its comment, and adds verify-with right after');
  expect(puts.length === 2 && puts[1].p.endsWith('/mergelight-refresh.yml') && unb64(puts[1].body.content) === REFRESH, 'and adds the refresh job');
  await shot('live-after-change');
});

await scenario('refresh-job-there-and-login-saved', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Change');
  expect(!/Adds the small job/.test(t), 'the job is there already');
  await click('button', 'Open PR');
  await until((x) => /Merge PR #9 to review with Claude and check with ChatGPT/.test(x), 'live with the pull request');
  expect(world.writes.filter((w) => w.m === 'PUT').length === 1, 'so only the workflow changes');
});

await scenario('already-set-like-this', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, click, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Change');
  expect(/Already set like this/.test(t), "says there's nothing to change");
  await click('button', 'Already set like this');
  await wait(600);
  expect(world.writes.length === 0, 'and writes nothing');
});

await scenario('second-change-waits-for-the-pr', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ page, world, until, click, reachLive, choose, shot }) => {
  await reachLive();
  await choose('Change');
  await click('[role=radiogroup][aria-label="Reviews your PRs"] label', 'ChatGPT');
  await wait(200);
  await click('button', 'Open PR');
  await until((x) => /Merge PR #9 to review with ChatGPT and check with Claude/.test(x), 'the pending change');
  await wait(800);
  await click('button', 'Change');
  const t = await until((x) => /Merge or close PR #9 first/.test(x), 'the step that waits for that PR');
  expect(/It changes your Mergelight workflow already/.test(t) && !/Choose your AI|Open PR$/.test(t), 'says why, and offers no change');
  expect(!(await page.evaluate(() => document.querySelectorAll('[role=radiogroup]').length)), 'with nothing to pick');
  expect((await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open PR #9'))?.href)) === PR.html_url, 'and links that PR');
  expect(world.writes.filter((w) => w.m === 'PUT').length === 1, 'writes nothing more');
  await shot('roles-wait-for-pr');
});

await scenario('open-pr-blocks-a-change', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], open: { ...PR, ref: 'mergelight-setup-old', title: 'Update Mergelight to v0.2.0' } }, async ({ world, until, click, reachLive }) => {
  await reachLive();
  await wait(800);
  await click('button', 'Add ChatGPT');
  await until((x) => /Merge or close PR #9 first/.test(x), 'the step that waits for that PR');
  expect(world.writes.length === 0, 'an open workflow PR gets no change of AI in it');
});

await scenario('pr-opened-meanwhile', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  // Someone opens a workflow PR while the choice is on screen.
  world.open = { ...PR, ref: 'mergelight-setup-old', title: 'Add Mergelight code review' };
  await click('button', 'Open PR');
  await until((x) => /Merge or close PR #9 first/.test(x), 'the step that waits for that PR');
  expect(world.writes.length === 0, 'and nothing was written');
});

await scenario('tagged-repo-gets-a-tagged-job', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace('mergelightai/mergelight@v0', 'mergelightai/mergelight@v0.2.0') }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Merge your PR first/.test(x), 'the next step');
  const job = world.writes.find((w) => w.m === 'PUT' && w.p.endsWith('/mergelight-refresh.yml'));
  expect(job && unb64(job.body.content).includes('uses: mergelightai/mergelight@v0.2.0\n'), 'the job runs the same tag as the review');
});


await scenario('open-pr-into-another-branch', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], open: { ...PR, ref: 'mergelight-setup-old', base: 'staging' }, branchFile: TEMPLATE }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Merge your PR first/.test(x), 'the next step');
  const put = world.writes.find((w) => w.m === 'PUT');
  expect(world.writes[0]?.m === 'POST' && world.writes[0]?.p === '/git/refs' && put?.body.branch !== 'mergelight-setup-old', 'leaves the pull request into staging alone, and makes its own branch');
  expect(world.writes.find((w) => w.m === 'POST' && w.p === '/pulls')?.body.base === 'main', 'with a pull request into main');
});

await scenario('pinned-repo-gets-a-pinned-job', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace('mergelightai/mergelight@v0', `mergelightai/mergelight@${SHA} # v0.2.0`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Merge your PR first/.test(x), 'the next step');
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
  await until((x) => /Merge your PR first/.test(x), 'the next step');
  const puts = world.writes.filter((w) => w.m === 'PUT');
  expect(puts.length === 1 && puts[0].p.endsWith('/mergelight.yml'), 'changes only the workflow, and leaves their job alone');
});

await scenario('update-available-shows-ai', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace('mergelightai/mergelight@v0', `mergelightai/mergelight@${'b'.repeat(40)} # v0.1.19`) }, async ({ page, world, until, click, shot }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  let t = await until((x) => /Update Mergelight on api/.test(x), 'the update step');
  expect(/Your AI/.test(t) && /Reviews with ChatGPT, checked by Claude/.test(t) && /Change/.test(t), 'shows who reviews, and the change, beside the update');
  await shot('update-with-ai');
  await wait(800);
  await click('button', 'Change');
  await until((x) => /Choose your AI/.test(x), 'the choice');
  await wait(800);
  await click('[role=radiogroup][aria-label="Reviews your PRs"] label', 'Claude');
  await wait(200);
  await click('button', 'Open PR');
  t = await until((x) => /Merge PR #9 to review with Claude and check with ChatGPT/.test(x), 'live with the pull request');
  expect(/Mergelight is on/.test(t) && !/You're on v0\.2\.0/.test(t), "doesn't call the update done, as nobody merged one");
  const put = world.writes.find((w) => w.m === 'PUT');
  expect(unb64(put.body.content).includes(`@${'b'.repeat(40)} # v0.1.19`), 'and the change keeps the version that runs now');
});

await scenario('workflow-without-chatgpt-login', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: 'name: Mergelight\non: pull_request\njobs:\n  review:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: mergelightai/mergelight@v0\n        with:\n          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n          provider: claude\n' }, async ({ world, click, shot, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Add ChatGPT');
  expect(/Your workflow doesn't pass a ChatGPT login to Mergelight\. Add codex-auth-json: \$\{\{ secrets\.CODEX_AUTH_JSON \}\} under with: in it first\./.test(t), 'says which line to add first');
  expect(!/isn't connected yet/.test(t), "and doesn't promise a connection");
  await shot('roles-missing-input');
  await click('button', 'Open PR');
  await wait(600);
  expect(world.writes.length === 0, 'and opens nothing');
});

await scenario('back-while-opening', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, slowPut: 2500 }, async ({ until, click, reachLive, choose, text }) => {
  await reachLive();
  await choose('Change');
  await click('button', 'Open PR');
  await until((x) => /Opening your PR/.test(x), 'the PR opening');
  await click('button', 'Back');
  await wait(300);
  expect(/Opening your PR/.test(await text()), 'Back waits until the PR is open, so it lands on this repo');
  await until((x) => /Merge PR #9/.test(x), 'live with the pull request');
});

await scenario('public-repo-adds-chatgpt-checker', { isPrivate: false, secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }, async ({ page, world, until, click, shot, reachLive, choose, text }) => {
  await reachLive();
  let t = await choose('Add ChatGPT');
  expect(/This repo is public, so anyone who can see your PR could enter a ChatGPT code\. Next, merge the PR, then save the login from your own computer/.test(t), 'the choice says why the login comes from their computer, after the merge');
  await click('button', 'Open PR');
  t = await until((x) => /Merge your PR first/.test(x), 'the step that waits for the merge');
  expect(!/codex login/.test(t), 'no command before the merge');
  world.merged = true;
  t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  // Every use of the folder is quoted, so a temp path with a space can't make rm -rf remove something else.
  const command = `d="$(mktemp -d)" && echo 'cli_auth_credentials_store = "file"' > "$d/config.toml" && CODEX_HOME="$d" codex login && gh secret set CODEX_AUTH_JSON --repo acme/api < "$d/auth.json" && echo "Saved the ChatGPT login in acme/api."; s=$?; [ -n "$d" ] && rm -rf "$d"; (exit $s)`;
  expect(t.includes(command), 'shows the command, with this repo filled in');
  expect(/This repo is public, so anyone who can see your PR could enter a ChatGPT code/.test(t), 'and says why');
  expect(!/close that PR/.test(t) && /your own Codex stays signed in/.test(t), 'a login of its own, and no extra PR to close');
  expect(/Until it's saved, Claude checks its own reviews/.test(t), 'says what happens until then');
  await click('button', 'Copy');
  await until((x) => /Copied/.test(x), 'the copied label');
  expect((await page.evaluate(() => window.__copied)).at(-1) === command, 'Copy copies the command');
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  await wait(6000);
  t = await text();
  expect(!/Getting your code|Enter the code|Enter this code|Couldn't connect/.test(t), 'never waits for a code, and never calls it a failure');
  await shot('connect-public-checker', true);
  await click('button', 'Continue');
  t = await until((x) => /Mergelight is on/.test(x), 'back to live');
  // The PR named only the reviewer, so ChatGPT checks once its login is saved, and until then it's still to connect.
  expect(/Reviews with Claude, checked by Claude/.test(t) && !/Merge PR #9/.test(t), 'with the merged change, and Claude checking until ChatGPT has a login');
  expect(/ChatGPT isn't connected yet\./.test(t) && /Resume/.test(t), 'and ChatGPT still to connect');
  world.secrets.push('CODEX_AUTH_JSON');
  await until((x) => /Reviews with Claude, checked by ChatGPT/.test(x) && !/Resume/.test(x), 'ChatGPT checking, once its login is saved');
});

const DOCS = 'https://github.com/mergelightai/mergelight/blob/main/docs/github-action.md#two-ais-one-reviews-the-other-checks';
/** The live step's text when the page leaves the choice to the workflow, and nothing to click that changes it. */
const readOnly = async (page, live) => !/Add ChatGPT|Add Claude/.test(live) && !(await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Your AI"] button')].length)) && (await page.evaluate(() => document.querySelector('section[aria-label="Your AI"] a')?.href)) === DOCS;

const OWN_NAME = TEMPLATE.replace('secrets.CODEX_AUTH_JSON', 'secrets.TEAM_CODEX').replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n          auth-secret-name: TEAM_CODEX\n`);
await scenario('customized-workflow-is-read-only', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'TEAM_CODEX'], file: OWN_NAME }, async ({ page, world, shot, reachLive }) => {
  const { live } = await reachLive();
  expect(/Reviews with Claude, checked by ChatGPT/.test(live), 'shows who reviews, which the file says in full');
  expect(/Your workflow is customized, so you set provider and verify-with in it by hand\./.test(live), 'says why it offers no change');
  expect(await readOnly(page, live), 'offers no change, and links to how to set them');
  await shot('live-customized');
  expect(world.writes.length === 0, 'writes nothing');
});

await scenario('customized-roles-unknown', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_AUTH_JSON'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: \${{ vars.WHO }}\n`) }, async ({ page, reachLive }) => {
  const { live } = await reachLive();
  expect(/Who reviews and who checks: unknown/.test(live) && !/Reviews with/.test(live), "an expression can't be read for sure, so it says so");
  expect(/Your workflow is customized/.test(live) && (await readOnly(page, live)), 'and offers no change');
});

await scenario('org-secrets-unreadable', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], orgSecrets: 403 }, async ({ page, reachLive }) => {
  const { live } = await reachLive();
  expect(/Who reviews and who checks: unknown/.test(live), "the defaults depend on logins it can't see");
  expect(/We can't read all of this repo's secrets, so we can't tell which AIs are connected\./.test(live), 'says why');
  expect(await readOnly(page, live), 'and offers no change');
});

await scenario('repo-secrets-unreadable', { secrets: 403, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ page, reachLive }) => {
  const { live } = await reachLive();
  expect(/Reviews with Claude, checked by ChatGPT/.test(live), 'a file that says both is still read');
  expect(/We can't read all of this repo's secrets/.test(live) && (await readOnly(page, live)), 'but nothing is offered to change');
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
  // The run says Claude wasn't connected only for a moment, while the review goes on, so the page may never see it.
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  t = await until((x) => /This link has ended/.test(x), 'the ended link');
  expect(/get a new link/.test(t), 'says how to get a new one');
  await wait(6000);
  t = await text();
  expect(/This link has ended/.test(t) && !/Mergelight is on/.test(t), "the review going on without Claude doesn't count as connected");
  world.secrets.push('CLAUDE_CODE_OAUTH_TOKEN');
  await until((x) => /Mergelight is on/.test(x), "live once Claude's login is there");
});

await scenario('checker-missed-while-it-says-so', { secrets: ['CODEX_AUTH_JSON'], comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until, text }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => /Open Claude/.test(x), 'the Claude step');
  // As the Action writes it: the check stays in progress, since the review goes on.
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: "Claude wasn't connected" } };
  const t = await until((x) => /This link has ended/.test(x), 'the ended link');
  expect(!/Mergelight is on/.test(t), 'not counted as connected');
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  await wait(5000);
  expect(!/Mergelight is on/.test(await text()), 'also once the review is going');
});

await scenario('only-the-ways-the-workflow-takes', { secrets: ['CODEX_AUTH_JSON'], file: TEMPLATE.replace('          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n', '') }, async ({ page, until, click, reachLive, choose, shot }) => {
  await reachLive();
  await choose('Add Claude');
  await click('button', 'Open PR');
  const t = await until((x) => /Connect Claude to check reviews/.test(x), 'the connect step');
  expect(/Add a secret named ANTHROPIC_API_KEY/.test(t), 'the workflow takes Claude through an API key, so that is the way');
  expect(!/Your plan|claude setup-token|Open Claude|CLAUDE_CODE_OAUTH_TOKEN/.test(t) && !(await offers(page, 'ChatGPT')), "and it offers no plan login the workflow doesn't read");
  await shot('connect-key-only');
});

await scenario('chatgpt-pending-can-resume', { secrets: ['CODEX_AUTH_JSON'] }, async ({ until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add Claude');
  await click('button', 'Open PR');
  await until((x) => /Connect Claude to check reviews/.test(x), 'the connect step');
  await wait(600);
  await click('button', 'Back');
  const t = await until((x) => /Mergelight is on/.test(x), 'live, after Back');
  expect(/Claude isn't connected yet\./.test(t) && /Resume/.test(t), 'offers to pick the connection up again');
  await wait(600);
  await click('button', 'Resume');
  await until((x) => /Connect Claude to check reviews/.test(x), 'back on the connection');
});

const BEHIND = TEMPLATE.replace('mergelightai/mergelight@v0', `mergelightai/mergelight@${'b'.repeat(40)} # v0.1.19`);
await scenario('update-pr-then-change', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: BEHIND }, async ({ page, world, until, click }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /Update Mergelight on api/.test(x), 'the update step');
  await wait(800);
  await click('button', 'Update to v0.2.0');
  const t = await until((x) => /Your PR is open/.test(x), 'the update PR');
  expect(/Your AI/.test(t) && /Change/.test(t), 'the open update PR shows who reviews, and the change');
  await wait(800);
  await click('section[aria-label="Your AI"] button', 'Change');
  await until((x) => /Merge or close PR #9 first/.test(x), 'the step that waits for the update PR');
  expect(world.writes.filter((w) => w.m === 'PUT').length === 2, 'and the update PR gets no change of AI');
});

await scenario('no-change-while-an-update-opens', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: BEHIND, slowPut: 2500 }, async ({ page, until, click, text }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /Update Mergelight on api/.test(x), 'the update step');
  await wait(800);
  await click('button', 'Update to v0.2.0');
  await until((x) => /Opening your PR/.test(x), 'the update opening');
  await click('section[aria-label="Your AI"] button', 'Change');
  await wait(400);
  expect(!/Choose your AI/.test(await text()), 'Change waits until the update PR is open');
});

await scenario('old-link-after-the-run-moved-on', { secrets: ['CODEX_AUTH_JSON'], comments: [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }], checks: { rolesha: { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } } } }, async ({ page, until, text }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  const t = await until((x) => /This link has ended/.test(x), 'the ended link');
  expect(/get a new link/.test(t), 'says how to get a new one');
  await wait(5000);
  expect(!/Mergelight is on/.test(await text()), 'never counts the review going on as connected');
});

await scenario('new-commit-asks-for-nothing', { secrets: ['CODEX_AUTH_JSON'], comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => /Open Claude/.test(x), 'the Claude step');
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  await until((x) => /This link has ended/.test(x), 'the ended link');
  // A new commit whose run checks without Claude, as a workflow that stopped asking for it would.
  world.checks.newsha = { status: 'completed', conclusion: 'success', output: { title: '🟢 Safe to merge: Nothing worth fixing' } };
  world.head = 'newsha';
  await until((x) => /Mergelight is on/.test(x), 'live, as the new run asked for nothing');
});

await scenario('roles-set-but-chatgpt-not-connected', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, until, click, reachLive, choose }) => {
  const { live } = await reachLive();
  expect(/Add ChatGPT/.test(live), 'ChatGPT has no login yet');
  const t = await choose('Add ChatGPT');
  expect(/Connect ChatGPT/.test(t) && !/Already set like this|Opens a PR/.test(t), 'the file says this already, so connecting is all that is left');
  await click('button', 'Connect ChatGPT');
  const c = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  expect(world.writes.length === 0, 'with nothing written');
  expect(/Open a new PR, then enter the code its Mergelight comment shows/.test(c), 'with no PR open, a new one is where the code comes from');
  world.secrets.push('CODEX_AUTH_JSON');
  await until((x) => /Mergelight is on/.test(x) && /Reviews with Claude, checked by ChatGPT/.test(x) && !/Resume/.test(x), 'live once ChatGPT is connected');
});

await scenario('no-working-login', { secrets: ['OPENAI_API_KEY'], file: TEMPLATE.replace('          openai-api-key: ${{ secrets.OPENAI_API_KEY }}\n', '') }, async ({ page, until, click }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  // The repo keeps an OpenAI key for its own app, which the workflow never reads.
  const t = await until((x) => /It's already on main/.test(x), 'the add step');
  expect(/No AI is connected yet\./.test(t) && !/Add ChatGPT|Add Claude|Change/.test(t), 'says no AI has a login it reads, and offers no choice');
  await wait(800);
  await click('button', 'Continue');
  await until((x) => /Connect your AI/.test(x), 'the usual connect step, as for a new repo');
});

await scenario('org-shared-chatgpt-login', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], orgSecrets: ['CODEX_AUTH_JSON'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ page, world, until, click, reachLive, choose }) => {
  const { live } = await reachLive();
  expect(/Reviews with Claude, checked by ChatGPT/.test(live), "today's reviews use the organization's login, so it shows who checks now");
  expect(/Add ChatGPT/.test(live), "but it isn't this repo's own, so ChatGPT is still to add");
  let t = await choose('Add ChatGPT');
  expect(/ChatGPT isn't connected yet\. Your organization's ChatGPT login is shared, so this repo gets its own\. Next, you save it from your own computer, and then we open the PR\./.test(t), 'says why the repo gets its own, and that it comes first');
  await click('button', 'Connect ChatGPT');
  t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  expect(world.writes.length === 0, 'no PR yet, so nothing can use the shared login before the repo has its own');
  expect(/Your organization's ChatGPT login is shared, so this repo gets its own\./.test(t) && /codex login && gh secret set CODEX_AUTH_JSON --repo acme\/api/.test(t), "the command saves one of the repo's own");
  expect(/We'll open your PR once it's saved/.test(t), 'and says the PR comes after');
  expect(!/API key|OPENAI_API_KEY/.test(t) && !(await offers(page, 'Claude')), 'and offers no OpenAI key, which the shared login would win over');
  world.secrets.push('CODEX_AUTH_JSON');
  t = await until((x) => /Merge PR #9 to review with Claude and check with ChatGPT/.test(x), 'the PR, once the repo has its own login');
  expect(world.writes.filter((w) => w.m === 'PUT').length === 2, "with the refresh job, for the repo's own login");
  expect(!/Resume/.test(t), 'nothing left to connect');
});

await scenario('org-shared-login-beats-api-key', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'], orgSecrets: ['CODEX_AUTH_JSON'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ reachLive, choose }) => {
  const { live } = await reachLive();
  // The Action uses the ChatGPT login before the key, and that login is the organization's.
  expect(/Add ChatGPT/.test(live), "the repo's OpenAI key doesn't make ChatGPT connected");
  const t = await choose('Add ChatGPT');
  expect(/Your organization's ChatGPT login is shared, so this repo gets its own/.test(t), 'and it still gets its own login');
});

await scenario('model-keeps-the-reviewer', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          model: opus\n`) }, async ({ page, picked, until, click, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Change');
  expect(/Your workflow sets model: for the AI that reviews now\. Change or remove it first to choose another reviewer\./.test(t), 'says why the reviewer stays');
  expect(await page.evaluate(() => [...document.querySelectorAll('[role=radiogroup][aria-label="Reviews your PRs"] input')].find((i) => i.closest('label').textContent.startsWith('ChatGPT'))?.disabled), 'ChatGPT as reviewer is off');
  await click('[role=radiogroup][aria-label="Reviews your PRs"] label', 'ChatGPT');
  await wait(300);
  expect((await picked('Reviews your PRs')) === 'Claude', 'and picking it does nothing');
  await click('[role=radiogroup][aria-label="Checks what it finds"] label', 'Claude');
  await until((x) => /Open PR/.test(x), 'the button');
  expect((await picked('Checks what it finds'))?.startsWith('Claude'), 'the checker can still change');
});

await scenario('internal-repo-checker', { visibility: 'internal', secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ until, click, reachLive, choose }) => {
  await reachLive();
  let t = await choose('Add ChatGPT');
  expect(/This repo is internal, so anyone in your enterprise who can see your PR could enter a ChatGPT code\. Next, you save the login from your own computer\./.test(t), 'an internal repo gets no code either, and is not called public');
  await click('button', 'Open PR');
  t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  expect(/This repo is internal/.test(t) && !/public/.test(t) && /codex login && gh secret set CODEX_AUTH_JSON --repo acme\/api/.test(t), 'shows the command, not a code');
});

const CLAUDE_KEY_ONLY = TEMPLATE.replace('          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n', '');
await scenario('link-reads-the-pr-workflow', { secrets: ['CODEX_AUTH_JSON'], file: CLAUDE_KEY_ONLY, headFile: TEMPLATE, comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  const t = await until((x) => /Open Claude/.test(x), "Claude's link");
  expect(!/couldn't read the workflow/.test(t), "the PR's workflow takes a Claude plan login, though main's doesn't");
});

await scenario('link-workflow-unreadable', { secrets: ['CODEX_AUTH_JSON'], file: CLAUDE_KEY_ONLY, headFile: 500, comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  const t = await until((x) => /Open Claude/.test(x), "Claude's link");
  expect(/We couldn't read the workflow on this PR, so we can't tell which logins it takes\./.test(t), 'says it can tell, rather than going by main');
});

await scenario('branch-changed-before-the-pr', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  // Someone takes ChatGPT's login inputs out of main while the choice is on screen.
  world.file = world.file.replace('          codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}\n', '').replace('          openai-api-key: ${{ secrets.OPENAI_API_KEY }}\n', '');
  await click('button', 'Open PR');
  const t = await until((x) => /changed since this page read it/.test(x), 'the message');
  expect(/Your workflow on main changed since this page read it, so nothing was changed\. Reload this page to see it\./.test(t), 'says what happened');
  expect(world.writes.length === 0, 'and writes nothing');
});

await scenario('refresh-outside-the-default-branch', { defaultBranch: 'trunk', secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Add ChatGPT');
  expect(/Adds the small job that keeps a ChatGPT login fresh\. It only runs on a schedule from trunk, so merge it there too\./.test(t), "says the job won't run from main by itself");
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  const pull = world.writes.find((w) => w.m === 'POST' && w.p === '/pulls');
  expect(pull?.body.base === 'main' && /That job only runs on a schedule from trunk, so merge it there too\./.test(pull?.body.body ?? ''), 'and so does the PR');
});

await scenario('expired-chatgpt-code', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  world.checks.rolesha = waitingToCheck('ChatGPT');
  world.comments = [askToCheck({ url: 'https://auth.openai.com/codex/device', code: CODE, claudeUrl: null })];
  await until((x) => x.includes(CODE), 'the code');
  // The run gave up waiting, and its comment still holds the code until the review replaces it.
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: "ChatGPT wasn't connected" } };
  const t = await until((x) => /Then push a new commit to your pull request to get a new code/.test(x), 'how to get a new code');
  expect(!t.includes(CODE) && !/Waiting for you to enter the code/.test(t), 'the old code is gone');
});

await scenario('claude-link-ended-after-merge', { secrets: ['CODEX_AUTH_JSON'] }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add Claude');
  await click('button', 'Open PR');
  await until((x) => /Connect Claude to check reviews/.test(x), 'the connect step');
  world.checks.rolesha = waitingToCheck('Claude');
  world.comments = [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })];
  await until((x) => /Open Claude/.test(x), "Claude's link");
  world.merged = true;
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  const t = await until((x) => /This link has ended/.test(x), 'the ended link');
  expect(/Open a new PR to get a new link/.test(t) && !/Push a new commit/.test(t), 'a merged PR starts no run, so it says to open a new one');
});

await scenario('environment-is-customized', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    environment: ai\n') }, async ({ page, reachLive }) => {
  const { live } = await reachLive();
  expect(/Your workflow is customized/.test(live) && (await readOnly(page, live)), "a job's environment has secrets this page can't see, so it offers no change");
});

await scenario('link-methods-follow-a-new-commit', { secrets: ['CODEX_AUTH_JSON'], headFile: CLAUDE_KEY_ONLY, comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  let t = await until((x) => /Add a secret named ANTHROPIC_API_KEY/.test(x), 'the API key steps');
  expect(!/Open Claude/.test(t), "this commit's workflow takes only Claude's API key");
  // A new commit puts Claude's plan login back in.
  world.headFile = TEMPLATE;
  world.checks.newsha = waitingToCheck('Claude');
  world.head = 'newsha';
  t = await until((x) => /Open Claude/.test(x), "the plan login, which the new commit's workflow takes");
});

await scenario('link-login-counts-against-the-pr-workflow', { secrets: ['CODEX_AUTH_JSON'], file: CLAUDE_KEY_ONLY, headFile: TEMPLATE, comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => /Open Claude/.test(x), "Claude's link");
  // The login is saved, and the run goes on before the page sees it say it connected.
  world.secrets.push('CLAUDE_CODE_OAUTH_TOKEN');
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  const t = await until((x) => /Mergelight is on|This link has ended/.test(x), 'the outcome');
  expect(/Mergelight is on/.test(t), "the PR's workflow reads that login, though main's doesn't");
});

await scenario('update-merged-then-change', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: BEHIND }, async ({ page, world, until, click }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /Update Mergelight on api/.test(x), 'the update step');
  await wait(800);
  await click('button', 'Update to v0.2.0');
  await until((x) => /Your PR is open/.test(x), 'the update PR');
  // The update is merged: main now has what the PR held.
  world.file = world.branchFile;
  world.open = null;
  world.merged = true;
  await until((x) => /You're on v0\.2\.0/.test(x), 'the update, merged');
  world.merged = false;
  await wait(800);
  await click('section[aria-label="Your AI"] button', 'Change');
  await until((x) => /Choose your AI/.test(x), 'the choice');
  await wait(800);
  await click('[role=radiogroup][aria-label="Reviews your PRs"] label', 'Claude');
  await wait(200);
  await click('button', 'Open PR');
  const t = await until((x) => /Merge PR #9 to review|changed since this page read it/.test(x), 'the outcome');
  expect(/Merge PR #9 to review with Claude and check with ChatGPT/.test(t), 'goes by the merged workflow, so it changed nothing behind the page');
  const put = world.writes.filter((w) => w.m === 'PUT').at(-1);
  expect(put && unb64(put.body.content).includes(`@${SHA} # v0.2.0`), 'and keeps the new version');
});

await scenario('closed-role-pr-allows-a-change', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Change');
  await click('[role=radiogroup][aria-label="Reviews your PRs"] label', 'ChatGPT');
  await wait(200);
  await click('button', 'Open PR');
  await until((x) => /Merge PR #9 to review with ChatGPT/.test(x), 'the pending change');
  // They close that PR on GitHub.
  world.open = null;
  const t = await choose('Change');
  expect(/Choose your AI/.test(t) && !/Merge or close/.test(t), 'a closed PR no longer holds the choice up');
});

await scenario('chatgpt-key-only-gets-no-refresh-job', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_AUTH_JSON'], file: TEMPLATE.replace('          codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}\n', '').replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  // CODEX_AUTH_JSON belongs to some other tool: the review only reads the API key.
  const t = await choose('Change');
  expect(!/Adds the small job/.test(t), 'promises no refresh job');
  await click('button', 'Open PR');
  await until((x) => /Merge PR #9/.test(x), 'the change');
  expect(world.writes.filter((w) => w.m === 'PUT').length === 1, "and adds none, so that login isn't refreshed");
});

await scenario('back-after-a-late-secrets-read', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_AUTH_JSON'] }, async ({ page, world, until, click, text }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /It's already on main/.test(x), 'the add step');
  // The live step's read of the organization's secrets answers late, and fails.
  world.orgSecrets = 403;
  world.slowOrg = 2500;
  await wait(800);
  await click('button', 'Continue');
  await until((x) => /Mergelight is on/.test(x), 'the live step');
  await wait(800);
  await click('section[aria-label="Your AI"] button', 'Change');
  await until((x) => /Choose your AI/.test(x), 'the choice');
  await wait(3500);
  const t = await text();
  // That read was for the live step, which they left, so its late answer is dropped and the choice stays.
  expect(/Choose your AI/.test(t) && /Open PR/.test(t) && !/We can't read all of this repo's secrets/.test(t), 'the late answer changes nothing on the choice');
  expect(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Back'))), 'and Back is still there');
});

await scenario('merge-first-clears-the-checker', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          verify-with: codex\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Merge your PR first/.test(x), 'the step that waits for the merge');
  const put = world.writes.find((w) => w.m === 'PUT' && w.p.endsWith('/mergelight.yml'));
  // A checker the PR kept would make its run ask for a ChatGPT code before the merge.
  expect(unb64(put.body.content) === TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`), 'names the reviewer and takes the checker out');
});

await scenario('both-missing-one-at-a-time', { secrets: [], orgSecrets: ['CODEX_AUTH_JSON'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: codex\n`) }, async ({ page, world, until, click }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /It's already on main/.test(x), 'the add step');
  // ChatGPT reviews on the organization's login. Neither AI has a login of the repo's own.
  await wait(800);
  await click('section[aria-label="Your AI"] button', 'Change');
  let t = await until((x) => /Choose your AI/.test(x), 'the choice');
  await wait(800);
  await click('button', 'Connect ChatGPT');
  t = await until((x) => /Connect ChatGPT/.test(x) && /codex login/.test(x), 'ChatGPT first, from the command');
  world.secrets.push('CODEX_AUTH_JSON');
  t = await until((x) => /Connect Claude to check reviews/.test(x), 'then Claude, on the PR that opens');
  expect(world.writes.some((w) => w.m === 'POST' && w.p === '/pulls'), 'the PR opened once ChatGPT had its own login');
  await wait(600);
  await click('button', 'Back');
  t = await until((x) => /Resume/.test(x), 'Your AI, after Back');
  expect(/Claude isn't connected yet\./.test(t), 'Resume stays for Claude, the AI still to connect');
  world.secrets.push('CLAUDE_CODE_OAUTH_TOKEN');
  await until((x) => !/Resume/.test(x), 'Resume goes once both are connected');
});

await scenario('roles-set-public-chatgpt', { isPrivate: false, secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Connect ChatGPT');
  const t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  expect(/codex login && gh secret set CODEX_AUTH_JSON --repo acme\/api/.test(t), 'a public repo gets the command, which needs no PR');
  expect(world.writes.length === 0, 'and nothing is written');
});

await scenario('role-pr-edited-before-merge', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Change');
  await click('[role=radiogroup][aria-label="Reviews your PRs"] label', 'ChatGPT');
  await wait(200);
  await click('button', 'Open PR');
  await until((x) => /Merge PR #9 to review with ChatGPT and check with Claude/.test(x), 'the pending change');
  // On GitHub, they make ChatGPT check too before merging.
  world.branchFile = TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: codex\n          verify-with: codex\n`);
  world.open = null;
  world.merged = true;
  const t = await until((x) => !/Merge PR #9/.test(x), 'the merged change');
  expect(/Reviews with ChatGPT, checked by ChatGPT/.test(t), 'shows what merged, not what the page proposed');
});

await scenario('old-link-after-merge', { secrets: ['CODEX_AUTH_JSON'], merged: true, comments: [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }], checks: { rolesha: { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } } } }, async ({ page, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  const t = await until((x) => /This link has ended/.test(x), 'the ended link');
  expect(/Open a new PR to get a new link/.test(t) && !/Push a new commit/.test(t), 'that PR is merged, so it says to open a new one');
});

await scenario('roles-set-adds-the-refresh-job', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Add ChatGPT');
  expect(/Adds the small job that keeps a ChatGPT login fresh/.test(t) && /Opens a PR that adds only that job/.test(t), 'the roles are set, but the job for the new login is missing');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step, on that PR');
  const puts = world.writes.filter((w) => w.m === 'PUT');
  const pull = world.writes.find((w) => w.m === 'POST' && w.p === '/pulls');
  expect(puts.length === 1 && puts[0].p.endsWith('/mergelight-refresh.yml'), 'a PR with only the job, and the workflow untouched');
  expect(pull?.body.title === 'Keep the ChatGPT login fresh for Mergelight' && /The review workflow doesn't change/.test(pull?.body.body ?? ''), 'that says what it is');
  // Its run asks for the code, as the workflow names ChatGPT to check.
  world.checks.rolesha = waitingToCheck('ChatGPT');
  world.comments = [askToCheck({ url: 'https://auth.openai.com/codex/device', code: CODE, claudeUrl: null })];
  await until((x) => x.includes(CODE), 'the code from that run');
});

await scenario('role-pr-edited-to-drop-chatgpt', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  await wait(600);
  await click('button', 'Back');
  await until((x) => /Resume/.test(x), 'Resume for ChatGPT');
  // On GitHub, they make Claude check instead, and merge.
  world.branchFile = TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: claude\n`);
  world.open = null;
  world.merged = true;
  const t = await until((x) => /Reviews with Claude, checked by Claude/.test(x) && !/Merge PR #9/.test(x), 'the merged roles');
  expect(!/Resume|ChatGPT isn't connected/.test(t), 'and no ChatGPT left to connect, as the merged workflow never uses it');
});

await scenario('new-run-asks-for-a-reviewer', { secrets: ['CODEX_AUTH_JSON'], comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => /Connect Claude to check reviews/.test(x), 'the checker step');
  // A new commit makes Claude the reviewer, and its run asks for Claude's login to review.
  world.comments = [{ user: { login: BOT }, body: withState(connectBody(null, 'https://github.com/acme/api/actions/runs/2', CLAUDE), undefined) }];
  world.checks.newsha = { status: 'in_progress', conclusion: null, output: { title: 'Waiting for you to connect Claude' } };
  world.head = 'newsha';
  const t = await until((x) => /Connect Claude/.test(x) && !/to check reviews/.test(x), 'the reviewer step');
  expect(!/checks its findings/.test(t), 'no longer says Claude checks');
});

await scenario('link-unreadable-checks-the-secret', { secrets: ['CODEX_AUTH_JSON'], file: CLAUDE_KEY_ONLY, headFile: 500, comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => /Open Claude/.test(x) && /We couldn't read the workflow on this PR/.test(x), "Claude's link, with the PR's workflow unknown");
  // The login is saved, and the run goes on before the page sees it say so. main's workflow doesn't read it.
  world.secrets.push('CLAUDE_CODE_OAUTH_TOKEN');
  world.comments = [{ user: { login: BOT }, body: withState(pendingSummaryBody(), undefined) }];
  world.checks.rolesha = { status: 'in_progress', conclusion: null, output: { title: 'Reviewing' } };
  const t = await until((x) => /Mergelight is on|This link has ended/.test(x), 'the outcome');
  expect(/Mergelight is on/.test(t), "an unknown workflow isn't swapped for main's, so the saved login counts");
});

await scenario('link-read-is-tried-again', { secrets: ['CODEX_AUTH_JSON'], file: CLAUDE_KEY_ONLY, headFile: 500, comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => /We couldn't read the workflow on this PR/.test(x), 'the unknown workflow');
  world.headFile = CLAUDE_KEY_ONLY;
  await until((x) => /Add a secret named ANTHROPIC_API_KEY/.test(x) && !/couldn't read the workflow/.test(x), "the PR's workflow, once it can be read");
});

await scenario('late-workflow-read-is-ignored', { secrets: ['CODEX_AUTH_JSON'], headFile: CLAUDE_KEY_ONLY, mergeDelays: [4000], comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until, text }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'domcontentloaded' });
  // While the first read is slow, a new commit takes Claude's plan login back in, and its read is quick.
  await until((x) => /Connect Claude/.test(x), 'the Claude step');
  world.headFile = TEMPLATE;
  world.checks.newsha = waitingToCheck('Claude');
  world.head = 'newsha';
  await until((x) => /Open Claude/.test(x), "the new commit's plan login");
  await wait(5000);
  expect(/Open Claude/.test(await text()) && !/ANTHROPIC_API_KEY/.test(await text()), "the old commit's late answer changes nothing");
});

await scenario('workflow-pr-far-down-the-list', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], otherOpen: 120, open: { ...PR, ref: 'mergelight-setup-old', title: 'Update Mergelight to v0.2.0' } }, async ({ world, until, click, reachLive }) => {
  await reachLive();
  await wait(800);
  await click('button', 'Add ChatGPT');
  await until((x) => /Merge or close PR #9 first/.test(x), 'the PR on the second page, found', 30000);
  expect(world.writes.length === 0, 'and no second workflow PR');
});

await scenario('late-pr-lookup-is-ignored', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, open: { ...PR, ref: 'mergelight-setup-old' }, openDelays: [4000] }, async ({ world, until, click, reachLive, text }) => {
  await reachLive();
  await wait(800);
  // The first look finds an open workflow PR, but only answers late. They go back, the PR is closed, and they look again.
  await click('section[aria-label="Your AI"] button', 'Change');
  await until((x) => /Choose your AI/.test(x), 'the choice, still looking');
  await wait(800);
  await click('button', 'Back');
  world.open = null;
  await until((x) => /Mergelight is on/.test(x), 'live');
  await wait(800);
  await click('section[aria-label="Your AI"] button', 'Change');
  await until((x) => /Choose your AI/.test(x) && /Open PR/.test(x), 'the choice');
  await wait(4500);
  expect(!/Merge or close PR #9 first/.test(await text()), "the first look's late answer changes nothing");
});

await scenario('merge-first-edited-keeps-the-command', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Merge your PR first/.test(x), 'the step that waits for the merge');
  // On GitHub, a comment is added before merging. The checker is still left to the default.
  world.branchFile = `# Ours\n${world.branchFile}`;
  world.open = null;
  world.merged = true;
  const t = await until((x) => /codex login/.test(x), 'the command, once merged');
  expect(!/Open a new PR, then enter the code/.test(t), 'no code is coming, so it never asks for one');
});

await scenario('role-pr-new-commit-changes-the-ways', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  let t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  expect(/Enable device code sign-in/.test(t), 'the PR takes a ChatGPT plan login');
  // A new commit on the PR takes the plan login out, and keeps the API key.
  world.headFile = world.branchFile.replace('          codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}\n', '');
  world.checks.newsha = waitingToCheck('ChatGPT');
  world.head = 'newsha';
  t = await until((x) => /Add a secret named OPENAI_API_KEY/.test(x), "the API key, which the PR's new commit takes");
  expect(!/Enable device code sign-in/.test(t), 'and no plan login it would never read');
});

await scenario('late-role-pr-for-another-repo', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], orgSecrets: ['CODEX_AUTH_JSON'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`), slowPut: 3000 }, async ({ world, until, click, reachLive, choose, text }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Connect ChatGPT');
  await until((x) => /codex login/.test(x), 'the command');
  // The repo's own login is saved, so the PR starts to open by itself, slowly.
  world.secrets.push('CODEX_AUTH_JSON');
  const end = Date.now() + 14000;
  while (Date.now() < end && !world.writes.some((w) => w.m === 'POST' && w.p === '/git/refs')) await wait(150);
  // Meanwhile they leave for another repo.
  await click('button', 'Back');
  await until((x) => /Set up another repo/.test(x), 'live');
  await wait(800);
  await click('button', 'Set up another repo');
  await until((x) => x.includes('zzz-other'), 'the list');
  await click('[role=option]', 'zzz-other');
  // The fake GitHub has nothing for that repo, so its own screen says it couldn't be read.
  await until((x) => /Couldn't read zzz-other/.test(x), 'the other repo');
  await wait(8000);
  const t = await text();
  expect(/Couldn't read zzz-other/.test(t) && !/Merge PR #9|Mergelight is on|Connect ChatGPT|Connect Claude|codex login/.test(t), `the late PR for api never moves the other repo on (${t.slice(0, 80)})`);
});

await scenario('workflow-pr-with-many-files', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], manyFiles: true, open: { ...PR, ref: 'mergelight-setup-old', title: 'Bump everything' } }, async ({ world, until, click, reachLive }) => {
  await reachLive();
  await wait(800);
  await click('button', 'Add ChatGPT');
  await until((x) => /Merge or close PR #9 first/.test(x), 'the workflow PR, found on its second page of files');
  expect(world.writes.length === 0, 'and no second workflow PR');
});

await scenario('refresh-only-checks-the-workflow', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  // The review workflow is taken away while the choice is on screen.
  world.fileGone = true;
  await click('button', 'Open PR');
  await until((x) => /couldn't find \.github\/workflows\/mergelight\.yml on main/.test(x), 'the message');
  expect(world.writes.length === 0, 'no refresh job for a review that is gone');
});

await scenario('refresh-job-added-meanwhile', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  // Someone else adds the refresh job while the choice is on screen, so the PR would change nothing.
  world.refresh = REFRESH;
  await click('button', 'Open PR');
  const t = await until((x) => /Connect ChatGPT to check reviews/.test(x), 'still on to connect ChatGPT');
  expect(world.writes.length === 0 && /Open a new PR, then enter the code its Mergelight comment shows/.test(t), 'with nothing written, and the way to finish it');
});

await scenario('old-pinned-offers-the-update', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace('mergelightai/mergelight@v0', `mergelightai/mergelight@${'c'.repeat(40)} # v0.1.18`) }, async ({ page, until, click }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  const t = await until((x) => /Update Mergelight on api/.test(x) && /Choosing your AI here/.test(x), 'the update step');
  expect(/Choosing your AI here needs Mergelight v0\.1\.19 or newer\./.test(t), 'v0.1.18 has no checker sign-in, so it says what it needs');
  expect(!(await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Your AI"] button')].length)) && /Update to v0\.2\.0/.test(t), 'no change of AI, and the update that brings it');
});

await scenario('old-v0-waits-for-the-release', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], v0: 'c'.repeat(40) }, async ({ page, reachLive }) => {
  const { live } = await reachLive();
  expect(/Choosing your AI here needs Mergelight v0\.1\.19 or newer\. It arrives by itself once v0 moves to v0\.1\.19\./.test(live), 'v0 is still v0.1.18, which the page says, and when that changes');
  expect(!(await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Your AI"] button')].length)), 'and offers no change');
});

await scenario('unknown-commit-is-too-old', { secrets: ['CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace('mergelightai/mergelight@v0', `mergelightai/mergelight@${'d'.repeat(40)}`) }, async ({ page, until, click }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  const t = await until((x) => /Choosing your AI here/.test(x), 'Your AI');
  expect(/We can't tell which version this workflow runs\./.test(t), 'a commit in no release is treated as too old');
});

await scenario('late-poll-for-an-earlier-pick', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ page, world, until, click, text }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /It's already on main/.test(x), 'the add step');
  // The live step's first read of the secrets answers late, with what was true then: Claude only.
  world.orgDelays = [5000];
  await wait(800);
  await click('button', 'Continue');
  await until((x) => /Set up another repo/.test(x), 'live');
  // Meanwhile ChatGPT gets a login, and they pick the repo again.
  world.secrets = ['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_AUTH_JSON'];
  await wait(800);
  await click('button', 'Set up another repo');
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /It's already on main/.test(x) && /Change/.test(x), 'the add step, with both connected');
  await wait(6000);
  const t = await text();
  expect(/Change/.test(t) && !/Add ChatGPT/.test(t), 'the earlier read, answering late, changes nothing');
});

await scenario('closed-role-pr-clears-the-change', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  await wait(600);
  await click('button', 'Back');
  await until((x) => /Merge PR #9/.test(x) && /Resume/.test(x), 'the pending change');
  // They close the PR on GitHub without merging.
  world.closed = true;
  world.open = null;
  const t = await until((x) => !/Merge PR #9/.test(x), 'the pending change, gone');
  expect(!/Resume/.test(t) && /Add ChatGPT/.test(t), 'with nothing left to resume, and the choice back');
});

await scenario('branch-moved-before-the-pr', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  // main moves on to a commit without the workflow, which is the one a new branch would start from.
  world.baseShaGone = true;
  await click('button', 'Open PR');
  await until((x) => /couldn't find \.github\/workflows\/mergelight\.yml on main/.test(x), 'the message');
  expect(world.writes.length === 0, 'the commit the branch starts from is the one checked, so nothing is written');
});

await scenario('role-pr-edited-drops-the-need', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  await wait(600);
  await click('button', 'Back');
  await until((x) => /Resume/.test(x), 'Resume for ChatGPT');
  // A new commit on the PR makes Claude check instead, before any merge.
  world.headFile = TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: claude\n`);
  world.head = 'newsha';
  const t = await until((x) => !/Resume/.test(x), 'Resume, gone');
  expect(!/ChatGPT isn't connected/.test(t), 'the PR no longer uses ChatGPT, so nothing asks for it');
});

await scenario('slow-retry-finishes', { secrets: ['CODEX_AUTH_JSON'], file: CLAUDE_KEY_ONLY, headFile: 500, comments: [askToCheck({ url: '', code: '', claudeUrl: CLAUDE })], checks: { rolesha: waitingToCheck('Claude') } }, async ({ page, world, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => /We couldn't read the workflow on this PR/.test(x), 'the unknown workflow');
  // It can be read now, but each read takes longer than a poll.
  world.headFile = TEMPLATE;
  world.mergeDelays = Array.from({ length: 20 }, () => 6000);
  await until((x) => !/couldn't read the workflow/.test(x), 'the workflow, once a slow read finishes', 20000);
});

await scenario('refresh-job-taken-out-before-merge', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  expect(world.writes.some((w) => w.p.endsWith('/mergelight-refresh.yml')), 'the PR adds the refresh job');
  // On GitHub, the job is taken out of the PR before it's merged.
  world.branchRefresh = null;
  world.open = null;
  world.merged = true;
  world.secrets.push('CODEX_AUTH_JSON');
  await until((x) => /Mergelight is on/.test(x) && /Change/.test(x), 'live, merged');
  world.merged = false;
  const t = await choose('Change');
  expect(/Adds the small job that keeps a ChatGPT login fresh/.test(t), 'the job that never merged is offered again');
});

await scenario('new-run-offers-both-in-a-link', { secrets: ['CODEX_AUTH_JSON'], comments: [{ user: { login: BOT }, body: withState(connectBody(null, 'https://github.com/acme/api/actions/runs/1', CLAUDE), undefined) }], checks: { rolesha: { status: 'in_progress', conclusion: null, output: { title: 'Waiting for you to connect Claude' } } } }, async ({ page, world, until }) => {
  await page.goto(`${base}/setup/?repo=acme/api&pr=9&connect=claude`, { waitUntil: 'networkidle2' });
  await until((x) => /Open Claude/.test(x), "Claude's link, the only one this run has");
  // A new commit's run offers a ChatGPT code too.
  world.comments = [{ user: { login: BOT }, body: withState(connectBody({ url: 'https://auth.openai.com/codex/device', code: CODE }, 'https://github.com/acme/api/actions/runs/2', CLAUDE), undefined) }];
  world.checks.newsha = WAITING;
  world.head = 'newsha';
  await until(() => true, 'a moment');
  const end = Date.now() + 14000;
  let ok = false;
  while (Date.now() < end && !ok) {
    ok = await offers(page, 'ChatGPT');
    await wait(200);
  }
  expect(ok, 'ChatGPT is offered again on the new run');
});

await scenario('named-reviewer-needs-its-own-login', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], orgSecrets: ['CODEX_AUTH_JSON'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: codex\n`) }, async ({ page, world, until, click }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /It's already on main/.test(x), 'the add step');
  await wait(800);
  await click('button', 'Continue');
  // ChatGPT reviews, on the organization's login. Claude's own login doesn't make reviews work.
  const t = await until((x) => /Connect ChatGPT/.test(x), "the reviewer's own login");
  expect(/codex login/.test(t) && !(await offers(page, 'Claude')), "from the command, and only ChatGPT's");
  world.secrets.push('CODEX_AUTH_JSON');
  await until((x) => /Mergelight is on/.test(x), "done once ChatGPT has the repo's own login");
});

await scenario('merge-first-holds-through-edits', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH }, async ({ world, until, click, reachLive, choose, text }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Merge your PR first/.test(x), 'the step that waits for the merge');
  // Someone names ChatGPT as checker on the PR before it's merged, so its run asks for a code.
  world.headFile = TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n          verify-with: codex\n`);
  world.checks.newsha = waitingToCheck('ChatGPT');
  world.comments = [askToCheck({ url: 'https://auth.openai.com/codex/device', code: CODE, claudeUrl: null })];
  world.head = 'newsha';
  await wait(9000);
  const t = await text();
  expect(/Merge your PR first/.test(t) && !t.includes(CODE), "main still doesn't name Claude, so connecting still waits for the merge");
});

await scenario('role-pr-read-retried', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /Enable device code sign-in/.test(x), 'the plan login');
  // A new commit on the PR, whose workflow can't be read for a while.
  world.headFile = 500;
  world.checks.newsha = waitingToCheck('ChatGPT');
  world.head = 'newsha';
  await until((x) => /We couldn't read the workflow on this PR/.test(x), 'the unknown workflow');
  // It can be read again: the commit took the plan login out.
  world.headFile = world.branchFile.replace('          codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}\n', '');
  const t = await until((x) => /Add a secret named OPENAI_API_KEY/.test(x), "the API key, which the PR's workflow takes now");
  expect(!/couldn't read the workflow/.test(t), 'once it could be read');
});

await scenario('pr-files-unreadable-stops', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`), open: { ...PR, ref: 'mergelight-setup-old', title: 'Some change' }, filesFail: true }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  await choose('Add ChatGPT');
  await click('button', 'Open PR');
  await until((x) => /That didn't work\. Please try again\./.test(x), 'the message');
  expect(world.writes.length === 0, "an open PR whose files can't be read stops it, as it may change the workflow");
});

await scenario('refresh-job-deleted-before-the-pr', { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], refresh: REFRESH, file: TEMPLATE.replace(LAST_INPUT, `${LAST_INPUT}          provider: claude\n`) }, async ({ world, until, click, reachLive, choose }) => {
  await reachLive();
  const t = await choose('Add ChatGPT');
  expect(!/Adds the small job/.test(t), 'the job is there when the page reads main');
  // Someone deletes it while the choice is on screen.
  world.refresh = null;
  await click('button', 'Open PR');
  await until((x) => /Connect ChatGPT to check reviews/.test(x), 'the connect step');
  expect(world.writes.some((w) => w.m === 'PUT' && w.p.endsWith('/mergelight-refresh.yml')), 'the PR brings it back');
});

await scenario('workflow-takes-no-login', { secrets: [], file: TEMPLATE.replace('          codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}\n          openai-api-key: ${{ secrets.OPENAI_API_KEY }}\n          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}\n', '') }, async ({ page, until, click }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await until((x) => x.includes('Which repo'), 'the list');
  await click('[role=option]', 'api');
  await until((x) => /It's already on main/.test(x), 'the add step');
  await wait(800);
  await click('button', 'Continue');
  const t = await until((x) => /Connect your AI/.test(x), 'the connect step');
  expect(/Your workflow doesn't pass an AI login to Mergelight\. Add codex-auth-json: \$\{\{ secrets\.CODEX_AUTH_JSON \}\} or claude-code-oauth-token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\} under with: in it first\./.test(t), 'says which line to add');
  expect(!/Enable device code sign-in|claude setup-token|Add a secret named/.test(t), 'and offers no sign-in that could never reach the review');
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
