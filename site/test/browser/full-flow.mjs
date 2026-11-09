// Runs the real built page on its real origin in headless Chrome, sign-in to first review, against a fake GitHub.
// Records every write the page makes. No real login or repo is involved.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const dist = process.env.DIST ?? new URL('../../dist', import.meta.url).pathname;
const out = `${mkdtempSync(join(tmpdir(), 'mergelight-browser-'))}/`;
const base = 'https://mergelight.dev';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const RELEASE = { tag: 'v0.2.0', sha: 'a'.repeat(40) };
const OLD_SHA = 'b'.repeat(40);
const b64 = (s) => Buffer.from(s).toString('base64');
const customized = (use) => `# Our own note, keep this\nname: Mergelight\njobs:\n  review:\n    runs-on: self-hosted\n    steps:\n      - uses: mergelightai/mergelight@${use}\n        with:\n          effort: medium\n`;

let failures = 0;
const expect = (ok, what) => { console.log(`  ${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function run(name, { login = false, apiKey = false, refuse = null, onBase = null, prFile = null, prRefresh = null, baseRefresh = null, noRelease = false, reviewDone = false, scope = 'new', button = 'Add to api' } = {}, check = () => {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const writes = [];
  let release = !noRelease;
  const json = (req, body, code = 200) => req.respond({ status: code, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    const m = req.method();
    if (u.origin === 'https://api.mergelight.dev') {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (u.pathname === '/sign-in') return json(req, { token: 'fake-token' });
      return req.respond({ status: 200, headers: cors, body: 'ok' });
    }
    if (u.origin === 'https://api.github.com') {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (u.pathname === '/repos/mergelightai/mergelight/releases/latest') return release ? json(req, { tag_name: RELEASE.tag }) : json(req, {}, 503);
      if (u.pathname === `/repos/mergelightai/mergelight/commits/${RELEASE.tag}`) return json(req, { sha: RELEASE.sha });
      const p = u.pathname.replace('/repos/acme/api', '');
      if (m !== 'GET') {
        const body = req.postData() ? JSON.parse(req.postData()) : null;
        writes.push({ m, p, body });
        if (refuse && p.endsWith(refuse)) return json(req, { message: 'Resource not accessible by integration' }, 403);
        if (m === 'POST' && p === '/git/refs') return json(req, { ref: body.ref }, 201);
        if (m === 'PUT' && p.startsWith('/contents/')) return json(req, { content: {}, commit: { sha: 'newsha' } }, 201);
        if (m === 'POST' && p === '/pulls') return json(req, { number: 7, html_url: 'https://github.com/acme/api/pull/7', head: { sha: 'headsha' } }, 201);
        if (m === 'DELETE') return req.respond({ status: 204, headers: cors });
        return json(req, {}, 404);
      }
      if (u.pathname === '/user/installations') return json(req, { installations: [{ id: 1, html_url: 'https://github.com/settings/installations/1', account: { login: 'acme', avatar_url: `${base}/logo.png` } }] });
      if (u.pathname === '/user/installations/1/repositories') return json(req, { repositories: [{ full_name: 'acme/api', private: true, default_branch: 'main', archived: false }, { full_name: 'acme/zzz-other', private: true, default_branch: 'main', archived: false }] });
      if (p === '/branches') return json(req, [{ name: 'main' }, { name: 'staging' }, { name: 'feat/x' }]);
      if (p === '/pulls' && u.searchParams.get('state') === 'all') return json(req, [{ base: { ref: 'staging' }, head: { ref: 'feat/x' } }]);
      if (p === '/pulls') return json(req, prFile ? [{ number: 5, html_url: 'https://github.com/acme/api/pull/5', head: { sha: 'oldsha', ref: 'mergelight-setup-old', repo: { full_name: 'acme/api' } } }] : []);
      if (p === '/pulls/5/files') return json(req, [{ filename: '.github/workflows/mergelight.yml' }]);
      if (p === '/pulls/5') return json(req, { merged: false, head: { sha: writes.some((w) => w.m === 'PUT') ? 'newsha' : 'oldsha' } });
      if (p === '/pulls/7') return json(req, { merged: false, head: { sha: 'headsha' } });
      if (p === '/issues/5/comments' || p === '/issues/7/comments') return json(req, []);
      if (p === '/actions/secrets') return json(req, { secrets: [...(login ? [{ name: 'CODEX_AUTH_JSON' }] : []), ...(apiKey ? [{ name: 'OPENAI_API_KEY' }] : [])] });
      if (p.startsWith('/contents/')) {
        // A new branch starts with whatever the branch it came from has.
        const raw = u.searchParams.get('ref');
        const ref = raw.startsWith('mergelight-setup-') && raw !== 'mergelight-setup-old' ? 'staging' : raw;
        const isRefresh = p.endsWith('mergelight-refresh.yml');
        if (ref === 'mergelight-setup-old') {
          const body = isRefresh ? prRefresh : prFile;
          return body ? json(req, { sha: isRefresh ? 'prrefreshblob' : 'prblob', content: b64(body) }) : json(req, {}, 404);
        }
        if (ref === 'staging' && isRefresh && baseRefresh) return json(req, { sha: 'baserefreshblob', content: b64(baseRefresh) });
        if (ref === 'staging' && !isRefresh && onBase) return json(req, { sha: 'baseblob', content: b64(onBase) });
        return json(req, {}, 404);
      }
      if (p === '/git/ref/heads/staging' || p === '/git/ref/heads/main') return json(req, { object: { sha: 'basesha' } });
      if (p.includes('/check-runs') && reviewDone) return json(req, { check_runs: [{ status: 'completed', conclusion: 'success', output: { title: '🟢 Safe to merge: Nothing worth fixing' } }] });
      if (p.includes('/check-runs')) return json(req, { check_runs: [{ status: 'in_progress', conclusion: null, output: { title: login ? 'Reviewing' : 'Waiting for you to connect ChatGPT' } }] });
      return json(req, {}, 404);
    }
    if (dist && u.origin === base) {
      const file = join(dist, u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname);
      if (existsSync(file)) return req.respond({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    }
    return req.continue();
  });

  const click = async (selector, text) => {
    const at = await page.evaluate((s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, selector, text);
    if (!at) throw new Error(`no ${selector} with ${text}: ${await text2()}`);
    await page.mouse.click(at.x, at.y);
  };
  const text2 = () => page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' '));

  console.log(`\n== ${name}`);
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  await wait(900);
  const addLink = await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes("Don't see your repo"))?.href);
  expect(addLink === 'https://github.com/apps/mergelight-setup/installations/new', `add repo link goes to the account picker (${addLink})`);
  await click('[role=option]', 'api');
  await wait(1000);
  if (scope === 'all') {
    await click('label', 'Every PR');
    await wait(400);
  }
  const before = await text2();
  await page.screenshot({ path: `${out}flow-${name}-1-add.png` });
  if (button) {
    await click('button', button);
    await wait(2200);
  }
  const after = await text2();
  await page.screenshot({ path: `${out}flow-${name}-2-after.png` });
  const puts = writes.filter((w) => w.m === 'PUT');
  const put = puts[0];
  const file = put ? Buffer.from(put.body.content, 'base64').toString() : null;
  const refreshPut = puts.find((w) => w.p.endsWith('mergelight-refresh.yml'));
  const refresh = refreshPut ? Buffer.from(refreshPut.body.content, 'base64').toString() : null;
  if (file) writeFileSync(`${out}flow-${name}.yml`, file);
  if (refresh) writeFileSync(`${out}flow-${name}-refresh.yml`, refresh);
  await check({ before, after, writes, puts, refresh, put, file, pull: writes.find((w) => w.m === 'POST' && w.p === '/pulls'), page, click, text2, setRelease: (v) => { release = v; } });
  if (errors.length) { console.log('  page errors', errors.slice(0, 3)); failures++; }
  await page.close();
  return { file, refresh };
}

const pinnedUse = `mergelightai/mergelight@${RELEASE.sha} # ${RELEASE.tag}`;
const fresh = await run('new-repo', {}, ({ writes, file, refresh, pull, after }) => {
  expect(refresh?.includes(`uses: ${pinnedUse}\n`), 'the refresh job comes along, pinned too');
  expect(file?.includes(`uses: ${pinnedUse}\n`), 'the file is pinned to the latest release');
  expect(!/Not pinned/.test(file ?? '') && !/Not pinned/.test(refresh ?? ''), 'neither says it is not pinned');
  expect(/# Pinned to a release/.test(file ?? '') && /# Pinned to a release/.test(refresh ?? ''), 'both say why they are pinned');
  expect(writes.map((w) => w.m).join() === 'POST,PUT,PUT,POST', 'branch, two files, pull request');
  expect(pull?.body.title === 'Add Mergelight code review', 'titled as an add');
  expect(/Connect your AI/.test(after), 'moves on to connecting');
});
await run('has-login', { login: true }, ({ after }) => {
  expect(/Your PR is open/.test(after) && /First review running/.test(after), 'goes straight to the timeline');
  expect(/reviewing this same PR/.test(after), 'explains what it is reviewing');
  expect(/You can close this page/.test(after), 'says the page can be closed');
  expect(/The review keeps running/.test(after), 'says the review keeps running while it runs');
});
await run('update-review-done', { onBase: customized(`${OLD_SHA} # v0.1.0`), login: true, reviewDone: true, button: 'Update to v0.2.0' }, ({ after }) => {
  expect(/Review done/.test(after) && /It reviewed this PR with v0\.2\.0/.test(after), 'says the review is done, with the new version');
  expect(!/First review/.test(after), "doesn't call it the first review");
});
await run('review-done', { login: true, reviewDone: true }, ({ after }) => {
  expect(/First review done/.test(after), 'shows the review as done');
  expect(/The PR stays open until you merge it/.test(after), 'says what happens if the page is closed now');
  expect(!/keeps running/.test(after), "doesn't say a finished review keeps running");
});
await run('api-key-repo', { apiKey: true }, ({ puts }) => {
  expect(puts.length === 1 && puts[0].p.endsWith('/mergelight.yml'), "an API key doesn't get the refresh job");
});
await run('open-pr-on-old-version', { prFile: customized('v0'), login: true }, ({ writes, puts, put, after }) => {
  expect(writes.every((w) => w.m === 'PUT') && puts.length === 2, 'only updates files on the open pull request');
  expect(put?.body.branch === 'mergelight-setup-old' && put?.body.sha === 'prblob', 'on its own branch, with the right blob');
  expect(/PR #5 opened/.test(after), 'keeps the same pull request');
});
await run('open-pr-already-current', { prFile: fresh.file, prRefresh: fresh.refresh, login: true }, ({ writes, after }) => {
  expect(writes.length === 0, 'writes nothing');
  expect(/PR #5 opened/.test(after), 'reuses it');
});
await run('installed-on-moving-tag', { onBase: customized('v0'), login: true, button: 'Continue' }, ({ before, writes, after }) => {
  expect(/It's already on staging/.test(before) && /Gets new versions by itself/.test(before), 'says it is on and keeps up by itself');
  expect(!/Update Mergelight/.test(before), 'offers no update');
  expect(writes.length === 0, 'writes nothing');
  expect(/Mergelight is on/.test(after), 'and it really is on');
});
await run('pinned-behind', { onBase: customized(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ before, file, pull, put, after }) => {
  expect(/Update Mergelight on api/.test(before) && /It's pinned to v0\.1\.0, and v0\.2\.0 is out/.test(before), 'offers an update and says why');
  expect(file === customized(`${RELEASE.sha} # ${RELEASE.tag}`), 'changes that one line and keeps everything else');
  expect(put?.body.sha === 'baseblob', 'updates the existing file');
  expect(pull?.body.title === 'Update Mergelight to v0.2.0' && pull?.body.base === 'staging', 'titled as an update, into the same branch');
  expect(/It moves the workflow to v0\.2\.0/.test(after), 'the timeline talks about the update');
  expect(/Review running/.test(after) && /reviewing this PR with v0\.2\.0/.test(after), 'says it is reviewing with the new version');
  expect(!/First review/.test(after) && !/see what a review looks like/.test(after), "doesn't call it the first review");
  expect(/Changes that one line, and nothing else in your file/.test(before) && /Adds the small job/.test(before), 'one existing file, and says it adds the job');
  expect(/Only that line changes/.test(pull?.body.body) && /also adds a small job/.test(pull?.body.body), 'the PR says the same');
});
await run('pinned-with-refresh-missing', { onBase: customized(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ puts, refresh }) => {
  expect(puts.length === 2, 'adds the refresh job');
  expect(refresh?.includes(`mergelight@${RELEASE.sha} # ${RELEASE.tag}`), 'pinned like the rest');
  expect(!/Not pinned/.test(refresh ?? ''), "without the note saying it isn't");
});
await run('old-refresh-job-too', { onBase: customized(`${OLD_SHA} # v0.1.0`), baseRefresh: customized(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ before, puts, refresh, pull }) => {
  expect(/Changes that one line in both files, and nothing else/.test(before), 'says both files');
  expect(!/Adds the small job/.test(before), "doesn't claim to add the job");
  expect(/Only that line changes/.test(pull?.body.body) && !/also adds/.test(pull?.body.body), 'the PR says the same');
  expect(puts.length === 2 && puts[1].body.sha === 'baserefreshblob', 'updates the refresh job that was there');
  expect(refresh === customized(`${RELEASE.sha} # ${RELEASE.tag}`), 'and keeps the rest of that file too');
});
await run('already-current', { onBase: customized(`${RELEASE.sha} # ${RELEASE.tag}`), login: true, button: 'Continue' }, ({ before, writes, after }) => {
  expect(/It's already on staging/.test(before), 'says so');
  expect(/Pinned to v0\.2\.0, so you choose when to update/.test(before), 'says it is pinned');
  expect(writes.length === 0, 'writes nothing');
  expect(/Mergelight is on/.test(after), 'and it really is on');
});
await run('cant-read-release', { noRelease: true }, ({ writes, file }) => {
  expect(writes.map((w) => w.m).join() === 'POST,PUT,PUT,POST', "a new repo doesn't need the release");
  expect(file?.includes('uses: mergelightai/mergelight@v0\n'), 'and follows v0');
});
await run('cant-read-release-pinned', { noRelease: true, onBase: customized(`${OLD_SHA} # v0.1.0`), login: true, button: 'Continue' }, ({ before, writes }) => {
  expect(/Pinned to v0\.1\.0/.test(before), 'a pinned repo just says it is pinned');
  expect(writes.length === 0, 'and writes nothing');
});
await run('refused-at-branch', { refuse: '/git/refs' }, ({ writes, after }) => {
  expect(writes.length === 1, 'stops at the branch');
  expect(/Approve on GitHub/.test(after) && /Add the file yourself/.test(after), 'offers both ways out');
});
await run('refused-at-file', { refuse: '/contents/.github/workflows/mergelight.yml' }, ({ writes }) => {
  expect(writes.at(-1)?.m === 'DELETE', 'removes the branch it made');
});
await run('update-refused', { onBase: customized(`${OLD_SHA} # v0.1.0`), refuse: '/contents/.github/workflows/mergelight.yml', button: 'Update to v0.2.0' }, ({ after, writes }) => {
  expect(/Approve on GitHub/.test(after), 'offers to approve');
  expect(!/Add the file yourself/.test(after), "doesn't offer to add a file that's already there");
  expect(writes.at(-1)?.m === 'DELETE', 'removes the branch it made');
});

console.log(failures ? `\n${failures} FAILED` : '\nall good');
await browser.close();
process.exitCode = failures ? 1 : 0;
