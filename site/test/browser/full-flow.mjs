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
const ourRefresh = (use) => `# Ours: every day\n${customized(use)}`;
const customized = (use) => `# Our own note, keep this\nname: Mergelight\njobs:\n  review:\n    runs-on: self-hosted\n    steps:\n      - uses: mergelightai/mergelight@${use}\n        with:\n          effort: medium\n          codex-auth-json: \${{ secrets.CODEX_AUTH_JSON }}\n`;

let failures = 0;
const expect = (ok, what) => { console.log(`  ${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// ONLY=name,name runs just those, to try one while changing it.
const only = process.env.ONLY?.split(',');

async function run(name, { login = false, apiKey = false, claude = false, orgSecrets = [], refuse = null, onBase = null, prFile = null, prTitle = 'Add Mergelight code review', prFiles = ['.github/workflows/mergelight.yml'], prRefresh = null, baseRefresh = null, noRelease = false, reviewDone = false, manyOpen = 0, headFails = 0, checkTitle = null, scope = 'new', button = 'Add to api', baseApprove = null } = {}, check = () => {}) {
  if (only && !only.includes(name)) return {};
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const writes = [];
  // How many times the open PRs were looked through from the start, and how many PRs' files were read.
  let scans = 0;
  let fileReads = 0;
  // A commit a test pushes to PR #5, and the workflow it holds.
  let pushed = null;
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
      // GitHub's newest release is v0.3.0, whose canary hasn't passed, so @v0 is still on v0.2.0. The page goes by @v0.
      if (u.pathname === '/repos/mergelightai/mergelight/releases/latest') return release ? json(req, { tag_name: 'v0.3.0' }) : json(req, {}, 503);
      if (u.pathname === `/repos/mergelightai/mergelight/commits/${RELEASE.tag}`) return json(req, { sha: RELEASE.sha });
      if (u.pathname === '/repos/mergelightai/mergelight/commits/v0') return release ? json(req, { sha: RELEASE.sha }) : json(req, {}, 503);
      if (u.pathname === '/repos/mergelightai/mergelight/tags') return json(req, [{ name: 'v0.3.0', commit: { sha: 'c'.repeat(40) } }, { name: RELEASE.tag, commit: { sha: RELEASE.sha } }, { name: 'v0', commit: { sha: RELEASE.sha } }, { name: 'v0.1.0', commit: { sha: OLD_SHA } }]);
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
      if (p === '/pulls' && (u.searchParams.get('page') ?? '1') === '1') scans++;
      // Many other open PRs, a page at a time. Infinity is more than the page looks through.
      if (p === '/pulls' && manyOpen) {
        const from = (Number(u.searchParams.get('page') ?? 1) - 1) * 100;
        return json(req, Array.from({ length: Math.max(0, Math.min(100, manyOpen - from)) }, (_, i) => ({ number: 300 + from + i, html_url: `https://github.com/acme/api/pull/${300 + from + i}`, title: 'Some feature', base: { ref: 'staging' }, head: { sha: `othersha${from + i}`, ref: `feat/${from + i}`, repo: { full_name: 'acme/api' } } })));
      }
      if (p === '/pulls') return json(req, prFile ? [{ number: 5, html_url: 'https://github.com/acme/api/pull/5', title: prTitle, base: { ref: 'staging' }, head: { sha: 'oldsha', ref: 'mergelight-setup-old', repo: { full_name: 'acme/api' } } }] : []);
      if (p === '/pulls/5/files') return json(req, prFiles.map((filename) => ({ filename })));
      if (/^\/pulls\/\d{3,}\/files$/.test(p) && Number(p.split('/')[2]) >= 300) {
        fileReads++;
        return json(req, [{ filename: 'src/app.ts' }]);
      }
      if (p === '/pulls/5') return json(req, { merged: false, head: { sha: pushed?.sha ?? (writes.some((w) => w.m === 'PUT') ? 'newsha' : 'oldsha') }, base: { ref: 'staging' } });
      if (p === '/pulls/7') return json(req, { merged: false, head: { sha: 'headsha' }, base: { ref: 'staging' } });
      if (p === '/issues/5/comments' || p === '/issues/7/comments') return json(req, []);
      // A list is what the organization shares with the repo. A number is how GitHub answers instead: 422 on a repo a person owns.
      if (p === '/actions/organization-secrets') return Array.isArray(orgSecrets) ? json(req, { secrets: orgSecrets.map((name) => ({ name })) }) : json(req, { message: 'no' }, orgSecrets);
      if (p === '/actions/secrets') return json(req, { secrets: [...(login ? [{ name: 'CODEX_AUTH_JSON' }] : []), ...(apiKey ? [{ name: 'OPENAI_API_KEY' }] : []), ...(claude ? [{ name: 'CLAUDE_CODE_OAUTH_TOKEN' }] : [])] });
      // No workflow files beyond the ones below.
      if (p === '/contents/.github/workflows') return json(req, {}, 404);
      if (p.startsWith('/contents/')) {
        // A new branch starts with whatever the branch it came from has.
        const raw = u.searchParams.get('ref');
        // The base branch's commit is staging's, which a new branch starts from.
        const ref = (raw.startsWith('mergelight-setup-') && raw !== 'mergelight-setup-old') || raw === 'basesha' ? 'staging' : raw;
        const isRefresh = p.endsWith('mergelight-refresh.yml');
        // The approval job is only there where a test puts it, on the base branch.
        if (p.endsWith('mergelight-approve.yml')) return baseApprove && ref === 'staging' ? json(req, { sha: 'baseapproveblob', content: b64(baseApprove) }) : json(req, {}, 404);
        if (pushed && raw === pushed.sha) return isRefresh ? json(req, {}, 404) : json(req, { sha: 'pushedblob', content: b64(pushed.file) });
        // The PR's workflow can't be read at its new commit, the first few times.
        if (raw === 'newsha' && !isRefresh && headFails > 0) {
          headFails--;
          return json(req, {}, 500);
        }
        // The PR's head commit holds what its branch does.
        if (ref === 'mergelight-setup-old' || ref === 'oldsha' || (ref === 'newsha' && prFile)) {
          const body = isRefresh ? prRefresh : prFile;
          return body ? json(req, { sha: isRefresh ? 'prrefreshblob' : 'prblob', content: b64(body) }) : json(req, {}, 404);
        }
        if (ref === 'staging' && isRefresh && baseRefresh) return json(req, { sha: 'baserefreshblob', content: b64(baseRefresh) });
        if (ref === 'staging' && !isRefresh && onBase) return json(req, { sha: 'baseblob', content: b64(onBase) });
        return json(req, {}, 404);
      }
      if (p === '/git/ref/heads/staging' || p === '/git/ref/heads/main') return json(req, { object: { sha: 'basesha' } });
      if (p.includes('/check-runs') && reviewDone) return json(req, { check_runs: [{ status: 'completed', conclusion: 'success', output: { title: '🟢 Safe to merge: Nothing worth fixing' } }] });
      if (p.includes('/check-runs')) return json(req, { check_runs: [{ status: 'in_progress', conclusion: null, output: { title: checkTitle ?? (login ? 'Reviewing' : 'Waiting for you to connect ChatGPT') } }] });
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
      // A real mouse can only click what is on screen, so it scrolls there first, as a person would.
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
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
  await page.screenshot({ path: `${out}flow-${name}-1-add.png` }).catch(() => {});
  if (button) {
    await click('button', button);
    await wait(2200);
  }
  const after = await text2();
  await page.screenshot({ path: `${out}flow-${name}-2-after.png` }).catch(() => {});
  // The job that turns an approval green goes into every setup and update, so the checks below count the other files.
  const approvePut = writes.find((w) => w.m === 'PUT' && w.p.endsWith('/mergelight-approve.yml'));
  const approve = approvePut ? Buffer.from(approvePut.body.content, 'base64').toString() : null;
  const puts = writes.filter((w) => w.m === 'PUT' && w !== approvePut);
  const others = writes.filter((w) => w !== approvePut);
  const put = puts[0];
  const file = put ? Buffer.from(put.body.content, 'base64').toString() : null;
  const refreshPut = puts.find((w) => w.p.endsWith('mergelight-refresh.yml'));
  const refresh = refreshPut ? Buffer.from(refreshPut.body.content, 'base64').toString() : null;
  if (file) writeFileSync(`${out}flow-${name}.yml`, file);
  if (refresh) writeFileSync(`${out}flow-${name}-refresh.yml`, refresh);
  await check({ before, after, writes: others, approve, approvePut, puts, refresh, put, file, pull: writes.find((w) => w.m === 'POST' && w.p === '/pulls'), page, click, text2, scans: () => scans, fileReads: () => fileReads, push: (sha, file) => { pushed = { sha, file }; }, setOnBase: (v) => { onBase = v; }, setRelease: (v) => { release = v; } });
  if (errors.length) { console.log('  page errors', errors.slice(0, 3)); failures++; }
  await page.close();
  return { file, refresh };
}

const pinnedUse = `mergelightai/mergelight@${RELEASE.sha} # ${RELEASE.tag}`;
await run('new-repo', {}, ({ writes, file, refresh, pull, after, approve }) => {
  expect(refresh?.includes(`uses: ${pinnedUse}\n`), 'the refresh job comes along, pinned too');
  expect(file?.includes(`uses: ${pinnedUse}\n`), 'the file is pinned to the release @v0 is on, not a newer one whose canary hasn\'t passed');
  expect(!/Not pinned/.test(file ?? '') && !/Not pinned/.test(refresh ?? ''), 'neither says it is not pinned');
  expect(/# Pinned to a release/.test(file ?? '') && /# Pinned to a release/.test(refresh ?? ''), 'both say why they are pinned');
  expect(writes.map((w) => w.m).join() === 'POST,PUT,PUT,POST', 'branch, two files, pull request');
  expect(approve?.includes(`uses: ${pinnedUse}\n`) && /# Pinned to a release/.test(approve) && !/Not pinned/.test(approve), 'and the approval job, pinned the same way');
  expect(/turns a "needs a human" check green/.test(pull?.body.body), 'the PR says what the approval job does');
  expect(pull?.body.title === 'Add Mergelight code review', 'titled as an add');
  expect(/Connect your AI/.test(after), 'moves on to connecting');
  // Which AI they connect comes after the pull request, from its run, so the file can't name one yet.
  expect(!/provider:/.test(file ?? ''), "with no login yet, it doesn't name a reviewer");
  // A comment that mentions @mergelight-ai reviews the pull request again. Skipping branches is about pull requests only.
  expect(/\n  issue_comment:\n    types: \[created\]\n/.test(file ?? ''), 'a comment that mentions Mergelight reviews the pull request again');
  expect(/github\.repository &&\n      !contains\(fromJSON\('\["main"\]'\), github\.head_ref\)\)\n/.test(file ?? ''), "the branches it skips go into the pull request part of the condition, not the comment's");
});
const withLogin = await run('has-login', { login: true }, ({ after, file }) => {
  expect(file?.includes('          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}\n          provider: codex\n'), 'names ChatGPT as the reviewer, so a second login later changes nothing');
  expect(/Your PR is open/.test(after) && /First review running/.test(after), 'goes straight to the timeline');
  expect(/reviewing this same PR/.test(after), 'explains what it is reviewing');
  expect(/You can close this page/.test(after), 'says the page can be closed');
  expect(/The review keeps running/.test(after), 'says the review keeps running while it runs');
});
await run('update-review-done', { onBase: customized(`${OLD_SHA} # v0.1.0`), login: true, reviewDone: true, button: 'Update to v0.2.0' }, ({ after }) => {
  expect(/Review done/.test(after) && /It reviewed this PR with v0\.2\.0/.test(after), 'says the review is done, with the new version');
  expect(!/First review/.test(after), "doesn't call it the first review");
});
await run('claude-login', { claude: true }, ({ puts, file, after }) => {
  expect(file?.includes('          provider: claude\n') && !/verify-with/.test(file ?? ''), 'names Claude as the reviewer, and leaves the checker to the default');
  expect(puts.length === 1, 'a Claude login needs no refresh job');
  expect(/Your PR is open/.test(after), 'goes straight to the timeline');
});
await run('org-shares-chatgpt', { claude: true, orgSecrets: ['CODEX_AUTH_JSON'] }, ({ file, after }) => {
  expect(file?.includes('          provider: codex\n'), "counts the organization's ChatGPT login, so it names the reviewer the Action would pick");
  // That reviewer's login is the organization's, so the repo needs its own, though it has Claude's.
  expect(/Connect ChatGPT/.test(after) && /Your organization's ChatGPT login is shared, so this repo gets its own\./.test(after) && /codex login/.test(after), "goes on to the reviewer's own login, from the command");
});
await run('org-shares-only-chatgpt', { orgSecrets: ['CODEX_AUTH_JSON'] }, ({ puts, after }) => {
  // A review can't refresh the organization's login without signing out the other repos, so this repo saves its own.
  expect(/Connect ChatGPT/.test(after), "the organization's ChatGPT login isn't this repo's own, so it goes on to connect ChatGPT, the reviewer it names");
  expect(/Your organization's ChatGPT login is shared, so this repo gets its own\./.test(after) && /codex login && gh secret set CODEX_AUTH_JSON --repo acme\/api/.test(after), 'with the command, as no run asks while the shared one is there');
  expect(puts.length === 2, "and the refresh job, for the repo's own login");
});
await run('org-secrets-unreadable', { claude: true, orgSecrets: 403 }, ({ file, after }) => {
  expect(file && !/provider:/.test(file), "can't see what the organization shares, so it names no reviewer");
  expect(/Your PR is open/.test(after), 'and still opens the PR');
});
await run('repo-a-person-owns', { claude: true, orgSecrets: 422 }, ({ file }) => {
  expect(file?.includes('          provider: claude\n'), 'a repo with no organization has nothing more to see');
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
const roleLines = '          provider: claude\n          verify-with: codex\n';
await run('update-waits-for-a-roles-pr', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: customized(`${OLD_SHA} # v0.1.0`) + roleLines, prTitle: 'Set who reviews and who checks in Mergelight', login: true, button: 'Update to v0.2.0' }, ({ writes, after, page }) => {
  expect(writes.length === 0, 'an update never goes into the PR that changes who reviews');
  expect(/PR #5 changes your Mergelight workflow already\. Merge or close it first, then update\./.test(after), 'says to merge or close it first');
  return page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Open PR #5'))?.href).then((href) => expect(href === 'https://github.com/acme/api/pull/5', 'and links it'));
});
await run('update-checks-every-file-first', { onBase: customized(`${OLD_SHA} # v0.1.0`), baseRefresh: customized(`${OLD_SHA} # v0.1.0`), prFile: customized(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ writes, after }) => {
  // The open PR took the refresh job out, so it can't be updated: that's known before anything is written.
  expect(writes.length === 0, 'writes nothing, not even the file it could update');
  expect(/That didn't work/.test(after), 'and says it failed');
});
await run('update-waits-for-a-refresh-pr', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: customized(`${OLD_SHA} # v0.1.0`), prTitle: 'Keep the ChatGPT login fresh for Mergelight', login: true, button: 'Update to v0.2.0' }, ({ writes, after }) => {
  expect(writes.length === 0, 'an update never goes into the PR that adds the refresh job');
  expect(/PR #5 changes your Mergelight workflow already\. Merge or close it first, then update\./.test(after), 'says to merge or close it first');
});
await run('update-waits-for-a-renamed-refresh-pr', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: customized(`${OLD_SHA} # v0.1.0`), prTitle: 'chore: keep the login fresh', prFiles: ['.github/workflows/mergelight-refresh.yml'], login: true, button: 'Update to v0.2.0' }, ({ writes, after }) => {
  expect(writes.length === 0, 'a PR that changes only the refresh job is told apart by its files, whatever its title');
  expect(/PR #5 changes your Mergelight workflow already\. Merge or close it first, then update\./.test(after), 'and says to merge or close it first');
});
await run('setup-keeps-the-prs-refresh-job', { baseRefresh: customized('v0'), prFile: customized('v0'), prRefresh: ourRefresh('v0') }, ({ puts }) => {
  const job = puts.find((w) => w.p.endsWith('/mergelight-refresh.yml'));
  const content = job && Buffer.from(job.body.content, 'base64').toString();
  expect(job?.body.branch === 'mergelight-setup-old', 'updates the open PR');
  expect(content === ourRefresh(`${RELEASE.sha} # ${RELEASE.tag}`), "keeps that PR's own refresh job, and moves only its version");
});
await run('finish-ignores-a-refresh-pr', { prFile: customized('v0'), prFiles: ['.github/workflows/mergelight-refresh.yml'], refuse: '/contents/.github/workflows/mergelight.yml' }, async ({ page, text2 }) => {
  // Adding the file fails, so they add it by hand. The open PR only has the refresh job, which installs no review.
  // GitHub's editor opens in a tab of its own, and this one goes on to wait for the PR.
  await page.evaluate(() => {
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Add the file yourself'));
    link.removeAttribute('target');
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
  });
  await new Promise((r) => setTimeout(r, 6000));
  const t = await text2();
  expect(/Waiting for your pull request/.test(t) && !/Found pull request #5/.test(t), "a PR with only the refresh job isn't taken for the one that adds the review");
});
await run('finish-stops-at-the-scan-limit', { manyOpen: Infinity }, async ({ page, text2, scans, setOnBase }) => {
  // The repo has too many open PRs to open one, so they add the file by hand.
  await page.evaluate(() => {
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Add the file yourself'));
    link.removeAttribute('target');
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
  });
  const before = scans();
  await new Promise((r) => setTimeout(r, 10000));
  expect(/more open PRs than we look through, so we'll see yours once it's merged into staging/.test(await text2()), 'says why it waits for the merge');
  expect(scans() - before === 1, `looks through the open PRs once, not on every check (${scans() - before})`);
  // They merge it, so the workflow is on staging.
  setOnBase(customized('v0'));
  await new Promise((r) => setTimeout(r, 6000));
  expect(!/Finish on GitHub/.test(await text2()), 'goes on once the workflow is on the branch');
});
await run('finish-reads-each-prs-files-once', { manyOpen: 120, refuse: '/contents/.github/workflows/mergelight.yml' }, async ({ page, text2, fileReads }) => {
  await page.evaluate(() => {
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Add the file yourself'));
    link.removeAttribute('target');
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
  });
  // Under the limit, so it looks again on each check, but 120 other PRs with the same commits have the same files.
  await new Promise((r) => setTimeout(r, 14000));
  expect(/Waiting for your pull request/.test(await text2()), 'still waiting');
  expect(fileReads() <= 120, `reads each PR's files once (${fileReads()})`);
});
await run('finish-loads-the-merged-workflow', { login: true, refuse: '/contents/.github/workflows/mergelight.yml' }, async ({ page, text2, setOnBase }) => {
  await page.evaluate(() => {
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Add the file yourself'));
    link.removeAttribute('target');
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
  });
  // They commit the file straight to staging, so there's no PR to find.
  setOnBase(customized('v0'));
  let t = '';
  for (let i = 0; i < 20 && !/Your AI/.test(t); i++) t = await (new Promise((r) => setTimeout(r, 1000)).then(text2));
  expect(/Your AI/.test(t) && /Reviews with ChatGPT/.test(t), 'goes on with the workflow that is there now, and who reviews');
});
await run('chatgpt-and-claude-logins', { login: true, claude: true }, ({ puts }) => {
  expect(puts.length === 2 && puts[1].p.endsWith('/mergelight-refresh.yml'), "a ChatGPT login gets the refresh job, whatever Claude's login is");
});
const claudeOnPr = customized(`${OLD_SHA} # v0.1.0`).replace('          codex-auth-json:', '          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n          provider: claude\n          codex-auth-json:');
await run('update-goes-by-the-prs-reviewer', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: claudeOnPr, login: true, button: 'Update to v0.2.0' }, ({ after }) => {
  // The open PR makes Claude the reviewer, so after the update Claude is the AI to connect.
  expect(/Connect Claude/.test(after), "goes by the PR's own reviewer, not main's");
});
await run('update-pr-read-fails-then-works', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: claudeOnPr, login: true, button: 'Update to v0.2.0', headFails: 2, checkTitle: 'Waiting for you to connect Claude' }, async ({ after, text2 }) => {
  // main's ChatGPT is connected, but the PR's workflow, which makes Claude review, can't be read for now.
  expect(/couldn't read the workflow on this PR/.test(after) && !/Mergelight is on/.test(after), "doesn't go by main's workflow, which would call it ready");
  let t = '';
  for (let i = 0; i < 20 && !/Connect Claude/.test(t); i++) t = await (new Promise((r) => setTimeout(r, 1000)).then(text2));
  expect(/Connect Claude/.test(t) && !/couldn't read the workflow/.test(t), "reads it again, and goes by the PR's reviewer");
});
await run('update-pr-commit-changes-the-login', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: claudeOnPr, login: true, button: 'Update to v0.2.0', checkTitle: 'Waiting for you to connect Claude' }, async ({ after, text2, push }) => {
  expect(/Connect Claude/.test(after) && !/ANTHROPIC_API_KEY/.test(after), "Claude's plan login, which the PR's workflow takes");
  // A commit on the PR takes Claude's plan login out, and takes an API key instead.
  push('pushedsha', claudeOnPr.replace('claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}', 'anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}'));
  let t = '';
  for (let i = 0; i < 20 && !/ANTHROPIC_API_KEY/.test(t); i++) t = await (new Promise((r) => setTimeout(r, 1000)).then(text2));
  expect(/Add a secret named ANTHROPIC_API_KEY/.test(t), "follows the PR's workflow after the commit");
});
await run('update-keeps-the-prs-refresh-job', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: customized(`${OLD_SHA} # v0.1.0`), prRefresh: ourRefresh(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ puts }) => {
  const job = puts.find((w) => w.p.endsWith('/mergelight-refresh.yml'));
  const content = job && Buffer.from(job.body.content, 'base64').toString();
  expect(job?.body.branch === 'mergelight-setup-old' && job?.body.sha === 'prrefreshblob', "updates the refresh job that PR has, though main has none");
  expect(content === ourRefresh(`${RELEASE.sha} # ${RELEASE.tag}`), 'moves only its version lines, and keeps the rest of it');
});
await run('update-moves-the-prs-refresh-job-whatever-main-reads', { onBase: customized(`${OLD_SHA} # v0.1.0`).replace('secrets.CODEX_AUTH_JSON', 'secrets.TEAM_CODEX'), prFile: customized(`${OLD_SHA} # v0.1.0`), prRefresh: ourRefresh(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ puts }) => {
  // main reads TEAM_CODEX, but the open PR moves the review to CODEX_AUTH_JSON and adds the job that keeps it fresh.
  const job = puts.find((w) => w.p.endsWith('/mergelight-refresh.yml'));
  expect(job?.body.branch === 'mergelight-setup-old' && Buffer.from(job.body.content, 'base64').toString() === ourRefresh(`${RELEASE.sha} # ${RELEASE.tag}`), "moves the PR's refresh job to the new version too");
});
await run('open-pr-already-current', { prFile: withLogin.file, prRefresh: withLogin.refresh, login: true }, ({ writes, after }) => {
  expect(writes.length === 0, 'writes nothing');
  expect(/PR #5 opened/.test(after), 'reuses it');
});
await run('installed-on-moving-tag', { onBase: customized('v0'), login: true, button: 'Continue' }, ({ before, writes, after }) => {
  expect(/It's already on staging/.test(before) && /Gets new versions by itself/.test(before), 'says it is on and keeps up by itself');
  expect(!/Update Mergelight/.test(before), 'offers no update');
  expect(writes.length === 0, 'writes nothing');
  expect(/Mergelight is on/.test(after), 'and it really is on');
});
await run('pinned-behind', { onBase: customized(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ before, file, pull, put, after, approve }) => {
  expect(/Update Mergelight on api/.test(before) && /It's pinned to v0\.1\.0, and v0\.2\.0 is out/.test(before), 'offers an update and says why');
  expect(file === customized(`${RELEASE.sha} # ${RELEASE.tag}`), 'changes that one line and keeps everything else');
  expect(put?.body.sha === 'baseblob', 'updates the existing file');
  expect(pull?.body.title === 'Update Mergelight to v0.2.0' && pull?.body.base === 'staging', 'titled as an update, into the same branch');
  expect(/It moves the workflow to v0\.2\.0/.test(after), 'the timeline talks about the update');
  expect(/Review running/.test(after) && /reviewing this PR with v0\.2\.0/.test(after), 'says it is reviewing with the new version');
  expect(!/First review/.test(after) && !/see what a review looks like/.test(after), "doesn't call it the first review");
  expect(/Changes only the Mergelight version lines in your file/.test(before) && /Adds the small job/.test(before), 'one existing file, and says it adds the job');
  expect(/Only the Mergelight version lines change/.test(pull?.body.body) && /also adds a small job that keeps/.test(pull?.body.body), 'the PR says the same');
  // A workflow changed by hand doesn't get the comment trigger, and the card says how to add it.
  expect(/Your workflow was changed by hand, so answering the findings in a comment needs its trigger added by hand too\./.test(before) && !/issue_comment/.test(file ?? ''), 'a workflow changed by hand is pointed to the trigger, not changed');
  // The approval job goes in where it's missing, on the same release.
  expect(/Adds the small job that turns a "needs a human" check green when someone approves/.test(before) && approve?.includes(`uses: ${pinnedUse}\n`), 'adds the approval job, pinned to the release');
  expect(/turns a "needs a human" check green/.test(pull?.body.body), 'and the PR says so');
});
const withJobs = (use) => `${customized(use)}  push:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: mergelightai/mergelight/push-jobs@${use}\n`;
await run('pinned-jobs-workflow', { onBase: withJobs(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ file }) => {
  expect(file === withJobs(`${RELEASE.sha} # ${RELEASE.tag}`), 'moves the push-jobs step to the release too, and keeps its path');
});
await run('push-jobs-first', { onBase: `name: Mergelight\njobs:\n  push:\n    steps:\n      - uses: mergelightai/mergelight/push-jobs@v0\n  review:\n    steps:\n      - uses: mergelightai/mergelight@${OLD_SHA} # v0.1.0\n`, login: true, button: 'Update to v0.2.0' }, ({ before }) => {
  expect(/It's pinned to v0\.1\.0, and v0\.2\.0 is out/.test(before), 'reads the version from the review step, even when the push step comes first');
});
await run('pinned-with-refresh-missing', { onBase: customized(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ puts, refresh }) => {
  expect(puts.length === 2, 'adds the refresh job');
  expect(refresh?.includes(`mergelight@${RELEASE.sha} # ${RELEASE.tag}`), 'pinned like the rest');
  expect(!/Not pinned/.test(refresh ?? ''), "without the note saying it isn't");
});
await run('update-leaves-another-login-alone', { onBase: customized(`${OLD_SHA} # v0.1.0`).replace('secrets.CODEX_AUTH_JSON', 'secrets.TEAM_CODEX'), login: true, button: 'Update to v0.2.0' }, ({ before, puts }) => {
  // The review reads TEAM_CODEX, so CODEX_AUTH_JSON is some other tool's, which the refresh job would sign out.
  expect(puts.length === 1 && puts[0].p.endsWith('/mergelight.yml'), 'adds no refresh job');
  expect(!/Adds the small job that keeps a ChatGPT login fresh/.test(before), "and doesn't say it would");
});
await run('update-goes-by-the-prs-login-for-the-refresh-job', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: customized(`${OLD_SHA} # v0.1.0`).replace('secrets.CODEX_AUTH_JSON }}\n', 'secrets.TEAM_CODEX }}\n          auth-secret-name: TEAM_CODEX\n'), login: true, button: 'Update to v0.2.0' }, ({ puts }) => {
  // main's review reads CODEX_AUTH_JSON, but the open PR moves it to TEAM_CODEX, so CODEX_AUTH_JSON may be another tool's.
  expect(puts.length === 1 && puts[0].p.endsWith('/mergelight.yml') && puts[0].body.branch === 'mergelight-setup-old', 'updates the PR, and adds no refresh job');
});
await run('update-stops-when-the-prs-step-is-gone', { onBase: customized(`${OLD_SHA} # v0.1.0`), prFile: 'name: Mergelight\njobs:\n  review:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@v4\n', login: true, button: 'Update to v0.2.0' }, ({ writes, after }) => {
  // The open PR swapped the Mergelight step for another action, so it has no version to move.
  expect(!writes.some((w) => w.m === 'PUT'), 'writes nothing');
  expect(/The workflow on your open PR has no Mergelight step, so nothing was changed\./.test(after) && !/Your PR is open/.test(after), "says so, rather than that it's updated");
});
/** The review workflow this page wrote before the comment trigger (until Nov 17 2026), pinned to an old release. */
const beforeComments = (() => {
  const now = readFileSync(new URL('../../../examples/mergelight.yml', import.meta.url), 'utf8');
  const swaps = [
    ["  # A comment that mentions @mergelight-ai on a pull request reviews it again, reading the comment as your\n  # team's answer to the findings: what's fixed, and what to leave and why. Only people who can push count.\n  issue_comment:\n    types: [created]\n", ''],
    ["    # target branch changed, so a new title doesn't start a review. A comment counts when it mentions\n    # Mergelight on a pull request, and isn't a bot's.\n", "    # target branch changed, so a new title doesn't start a review.\n"],
    ["      (github.event_name == 'issue_comment' &&\n      github.event.issue.pull_request &&\n      contains(github.event.comment.body, '@mergelight-ai') &&\n      github.event.comment.user.type != 'Bot') ||\n      (github.event_name == 'pull_request' &&\n", ''],
    ['github.event.pull_request.head.repo.full_name == github.repository)\n', 'github.event.pull_request.head.repo.full_name == github.repository\n'],
    ["    # A new push cancels the older review of the same PR. A comment's review has a group of its own, so\n    # neither cancels the other.\n", '    # A new push cancels the older review of the same PR.\n'],
    ["group: mergelight-pr-${{ github.event.pull_request.number || github.event.issue.number }}${{ github.event_name == 'issue_comment' && format('-comment-{0}', github.event.comment.id) || '' }}", 'group: mergelight-pr-${{ github.event.pull_request.number }}'],
    ['mergelightai/mergelight@v0', `mergelightai/mergelight@${OLD_SHA} # v0.1.0`],
  ];
  return swaps.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`examples/mergelight.yml changed: ${from.slice(0, 60)}`);
    return text.replace(from, to);
  }, now);
})();
await run('update-adds-the-comment-trigger', { onBase: beforeComments, login: true, button: 'Update to v0.2.0' }, ({ before, file, pull }) => {
  expect(/Changes the Mergelight version lines in your file, and adds the trigger that lets a comment that mentions @mergelight-ai answer the findings/.test(before), 'says it adds the comment trigger');
  expect(/\n  issue_comment:\n    types: \[created\]\n/.test(file ?? '') && /format\('-comment-\{0\}'/.test(file ?? '') && file?.includes(`uses: ${pinnedUse}\n`), 'the update adds the trigger, its condition and group, and moves the version');
  expect(/Besides the Mergelight version lines, the review workflow changes in one way\./.test(pull?.body.body) && /@mergelight-ai/.test(pull?.body.body), 'the PR says what else changes');
  // The update goes into staging, and GitHub runs a comment's workflow from main, the default branch.
  expect(/GitHub runs that trigger from main, so it works once the change is there too/.test(before) && /GitHub runs that trigger from main, so it works once this change is there too\./.test(pull?.body.body), 'says comments start reviews once the change is on main too');
});
await run('update-moves-the-approval-job', { onBase: customized(`${OLD_SHA} # v0.1.0`), baseApprove: `name: Mergelight approval\njobs:\n  approve:\n    steps:\n      - uses: mergelightai/mergelight@${OLD_SHA} # v0.1.0\n`, login: true, button: 'Update to v0.2.0' }, ({ before, approve, approvePut, pull }) => {
  expect(approvePut?.body.sha === 'baseapproveblob' && approve === `name: Mergelight approval\njobs:\n  approve:\n    steps:\n      - uses: ${pinnedUse}\n`, 'moves the approval job to the release too, and keeps the rest of it');
  expect(!/turns a "needs a human" check green/.test(before) && !/turns a "needs a human" check green/.test(pull?.body.body), "doesn't say it adds a job that's there");
});
// Pinned to v0.3.0, which this page pinned to before it went by @v0. @v0 is on v0.2.0, which is older, so it's no update.
await run('pinned-ahead-of-v0', { onBase: customized(`${'c'.repeat(40)} # v0.3.0`), login: true, button: null }, ({ before, writes }) => {
  expect(!/Update Mergelight on api/.test(before) && !/Update to v0\.2\.0/.test(before), "a repo pinned ahead of @v0 isn't offered an older release");
  expect(!writes.some((w) => w.m === 'PUT'), 'and nothing is written');
});
await run('old-refresh-job-too', { onBase: customized(`${OLD_SHA} # v0.1.0`), baseRefresh: customized(`${OLD_SHA} # v0.1.0`), login: true, button: 'Update to v0.2.0' }, ({ before, puts, refresh, pull }) => {
  expect(/Changes only the Mergelight version lines in both files/.test(before), 'says both files');
  expect(!/Adds the small job that keeps a ChatGPT login fresh/.test(before), "doesn't claim to add the job");
  expect(/Only the Mergelight version lines change/.test(pull?.body.body) && !/also adds a small job that keeps/.test(pull?.body.body), 'the PR says the same');
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
