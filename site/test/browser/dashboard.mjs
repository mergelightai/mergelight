// Runs the real built dashboard on its real origin in headless Chrome, from sign-in to the reviews,
// against a fake GitHub, a fake token server and a fake Mergelight server. No real login is involved.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const dist = process.env.DIST ?? new URL('../../dist', import.meta.url).pathname;
const out = `${mkdtempSync(join(tmpdir(), 'mergelight-dashboard-'))}/`;
const base = 'https://mergelight.dev';
const SERVER = 'https://mergelight-server.onrender.com';
const GITHUB_TOKEN = `ghu_${'g'.repeat(36)}`;
const SESSION_TOKEN = 'session-token-of-the-server';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const cors = { 'access-control-allow-origin': base, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const SESSION = {
  token: SESSION_TOKEN,
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  user: { id: 11, login: 'ada' },
  orgs: [
    { id: 1001, login: 'acme', connected: true, repos: 2 },
    { id: 3003, login: 'quiet', connected: false, repos: 1 },
    { id: 4004, login: 'fresh', connected: true, repos: 1 },
  ],
};
const review = (over) => ({ repo_id: 501, repo: 'acme/widgets', pr: 42, sha: 'a'.repeat(40), light: 'yellow', bugs: 2, risks: 1, hardening: 3, major: 1, provider: 'claude', model: 'opus', duration_ms: 412_000, created_at: hoursAgo(1), ...over });
const DECISIONS = {
  1001: [
    { id: 12, repo_id: 501, repo: 'acme/widgets', title: 'Cart total is rounded before tax', file: 'src/cart.ts', line: 40, end_line: 44, reason: 'The payment provider needs whole cents.', by: 'ada', pr: 37, created_at: hoursAgo(50), last_used_at: hoursAgo(2), uses: 3, can_forget: true },
    { id: 13, repo_id: 502, repo: 'acme/api', title: 'Retry has no upper bound', file: 'src/retry.ts', line: 8, end_line: null, reason: 'The queue caps it.', by: 'bo', pr: 5, created_at: hoursAgo(80), last_used_at: null, uses: 0, can_forget: false },
  ],
};
const RULES = {
  1001: {
    can_set_org_rules: true,
    repos: [{ id: 501, name: 'acme/widgets', can_set_rules: true }, { id: 502, name: 'acme/api', can_set_rules: false }],
    rules: [
      { id: 3, kind: 'rule', text: 'Ignore style and naming.', paths: [], by: 'ada', created_at: hoursAgo(200), repo_id: null, repo: null, can_remove: true },
      { id: 4, kind: 'needs_human', text: 'Billing changes need a second pair of eyes.', paths: ['src/billing/**', '*.sql'], by: 'bo', created_at: hoursAgo(30), repo_id: 502, repo: 'acme/api', can_remove: false },
    ],
  },
  4004: { can_set_org_rules: false, repos: [{ id: 801, name: 'fresh/app', can_set_rules: false }], rules: [] },
};
const SKILLS = {
  1001: {
    repos: [{ id: 501, name: 'acme/widgets', can_pick_skills: true }, { id: 502, name: 'acme/api', can_pick_skills: false }],
    skills: [
      { id: 7, repo_id: 501, repo: 'acme/widgets', path: '.claude/skills/migrations', by: 'ada', created_at: hoursAgo(90), can_remove: true },
      { id: 8, repo_id: 502, repo: 'acme/api', path: '.agents/skills/payments', by: 'bo', created_at: hoursAgo(20), can_remove: false },
    ],
  },
  4004: { repos: [{ id: 801, name: 'fresh/app', can_pick_skills: false }], skills: [] },
};
const CHECKS = {
  1001: {
    repos: [{ id: 501, name: 'acme/widgets', can_set_checks: true }, { id: 502, name: 'acme/api', can_set_checks: false }],
    checks: [
      { id: 21, repo_id: 501, repo: 'acme/widgets', name: 'Translations', text: 'Every new text in en.json has a translation in da.json.', paths: ['src/i18n/**'], by: 'ada', created_at: hoursAgo(70), can_remove: true },
      { id: 22, repo_id: 502, repo: 'acme/api', name: 'Refunds', text: 'A refund is never larger than its invoice.', paths: ['src/billing/**', '*.sql'], by: 'bo', created_at: hoursAgo(10), can_remove: false },
    ],
  },
  4004: { repos: [{ id: 801, name: 'fresh/app', can_set_checks: false }], checks: [] },
};
const WRITTEN = {
  1001: {
    repos: [{ id: 501, name: 'acme/widgets', can_write_skills: true }, { id: 502, name: 'acme/api', can_write_skills: false }],
    skills: [
      { id: 31, repo_id: 501, repo: 'acme/widgets', name: 'Payments', description: 'Use when a pull request changes src/billing.', text: '# Payments\n\nAmounts are whole cents, never fractions.', by: 'ada', created_at: hoursAgo(60), can_remove: true },
      { id: 32, repo_id: 502, repo: 'acme/api', name: 'Queues', description: 'Use for retry and queue code.', text: 'Each retry has an upper bound.', by: 'bo', created_at: hoursAgo(5), can_remove: false },
    ],
  },
  4004: { repos: [{ id: 801, name: 'fresh/app', can_write_skills: false }], skills: [] },
};
const OVERVIEWS = {
  1001: {
    org: { id: 1001, login: 'acme' },
    repos: [{ id: 501, name: 'acme/widgets', last_review_at: hoursAgo(1), reviews: 2 }, { id: 502, name: 'acme/api', last_review_at: hoursAgo(30), reviews: 1 }],
    reviews: [review({}), review({ pr: 41, light: 'green', bugs: 0, risks: 0, hardening: 0, major: 0, provider: 'codex', model: null, duration_ms: 95_000, created_at: hoursAgo(5) }), review({ repo_id: 502, repo: 'acme/api', pr: 7, light: 'red', bugs: 1, risks: 0, hardening: 0, created_at: hoursAgo(30) })],
  },
  4004: { org: { id: 4004, login: 'fresh' }, repos: [], reviews: [] },
};

let failures = 0;
const expect = (ok, what) => { console.log(`  ${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function open(name, { signedOutAfter = Infinity, serverDown = false, forgetFails = false, signedOutOnAdd = false, signedOutOnWrite = false, noOrgs = false } = {}) {
  /** Whether the one Add that finds the session ran out has happened. */
  let addSignedOut = false;
  /** Decisions the page asked the server to forget. */
  const forgotten = [];
  /** Rules the page asked the server to add and to remove. */
  const added = [];
  const removed = [];
  /** Skill folders the page asked the server to add and to remove. */
  const skillsAdded = [];
  const skillsRemoved = [];
  /** Skills the page asked the server to save and to delete. */
  const written = [];
  const writtenRemoved = [];
  /** Checks the page asked the server to add and to remove. */
  const checksAdded = [];
  const checksRemoved = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  /** Every request to the Mergelight server, with the token it carried. */
  const calls = [];
  /** How many sign-in codes were sent to the token server to be swapped for a GitHub token. */
  const exchanges = [];
  /** Trips to GitHub's sign-in that the page started. */
  const renewals = [];
  const json = (req, body, code = 200) => req.respond({ status: code, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    const m = req.method();
    if (u.origin === 'https://api.mergelight.dev') {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (u.pathname === '/sign-in') {
        exchanges.push(req.postData());
        return json(req, { token: GITHUB_TOKEN });
      }
      return req.respond({ status: 200, headers: cors, body: 'ok' });
    }
    if (u.origin === SERVER) {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      calls.push({ m, path: u.pathname, auth: req.headers().authorization ?? '' });
      if (serverDown) return json(req, { error: 'server_error' }, 500);
      // Like the real server: a sign-in with nothing to show gets no session token.
      if (u.pathname === '/v1/session' && m === 'POST') return json(req, noOrgs ? { ...SESSION, token: null, expires_at: null, orgs: [] } : SESSION, 201);
      if (u.pathname === '/v1/session' && m === 'DELETE') return req.respond({ status: 204, headers: cors });
      const rules = /^\/v1\/orgs\/(\d+)\/rules(?:\/(\d+))?$/.exec(u.pathname);
      if (rules && !RULES[rules[1]]) return json(req, { error: 'not_connected' }, 404);
      if (rules && m === 'POST') {
        if (signedOutOnAdd && !addSignedOut) {
          addSignedOut = true;
          return json(req, { error: 'signed_out' }, 401);
        }
        const body = JSON.parse(req.postData());
        if (body.text.includes('refuse me')) return json(req, { error: 'read_only', message: 'Only an owner of the org can set rules for the whole org.' }, 403);
        added.push(body);
        return json(req, { id: 100 + added.length }, 201);
      }
      if (rules && m === 'DELETE') {
        removed.push(Number(rules[2]));
        return req.respond({ status: 204, headers: cors });
      }
      if (rules) {
        const own = RULES[rules[1]];
        const fresh = added.map((r, i) => ({ id: 101 + i, ...r, by: 'ada', created_at: new Date().toISOString(), repo: r.repo_id ? 'acme/widgets' : null, can_remove: true }));
        return json(req, { ...own, rules: [...own.rules, ...(rules[1] === '1001' ? fresh : [])].filter((r) => !removed.includes(r.id)) });
      }
      const skills = /^\/v1\/orgs\/(\d+)\/skills(?:\/(\d+))?$/.exec(u.pathname);
      if (skills && !SKILLS[skills[1]]) return json(req, { error: 'not_connected' }, 404);
      if (skills && m === 'POST') {
        const body = JSON.parse(req.postData());
        if (body.path.includes('..')) return json(req, { error: 'bad_request', message: "Name the skill's folder in the repository, like .claude/skills/migrations." }, 400);
        skillsAdded.push(body);
        return json(req, { id: 200 + skillsAdded.length }, 201);
      }
      if (skills && m === 'DELETE') {
        skillsRemoved.push(Number(skills[2]));
        return req.respond({ status: 204, headers: cors });
      }
      if (skills) {
        const own = SKILLS[skills[1]];
        const fresh = skillsAdded.map((s, i) => ({ id: 201 + i, ...s, repo: 'acme/widgets', by: 'ada', created_at: new Date().toISOString(), can_remove: true }));
        return json(req, { ...own, skills: [...own.skills, ...(skills[1] === '1001' ? fresh : [])].filter((s) => !skillsRemoved.includes(s.id)) });
      }
      const ownSkills = /^\/v1\/orgs\/(\d+)\/written-skills(?:\/(\d+))?$/.exec(u.pathname);
      if (ownSkills && !WRITTEN[ownSkills[1]]) return json(req, { error: 'not_connected' }, 404);
      if (ownSkills && m === 'POST') {
        if (signedOutOnWrite && !addSignedOut) {
          addSignedOut = true;
          return json(req, { error: 'signed_out' }, 401);
        }
        const body = JSON.parse(req.postData());
        if (body.name === 'Payments') return json(req, { error: 'exists', message: 'This repository already has a skill of that name.' }, 409);
        written.push(body);
        return json(req, { id: 400 + written.length }, 201);
      }
      if (ownSkills && m === 'DELETE') {
        writtenRemoved.push(Number(ownSkills[2]));
        return req.respond({ status: 204, headers: cors });
      }
      if (ownSkills) {
        const own = WRITTEN[ownSkills[1]];
        const fresh = written.map((s, i) => ({ id: 401 + i, ...s, repo: 'acme/widgets', by: 'ada', created_at: new Date().toISOString(), can_remove: true }));
        return json(req, { ...own, skills: [...own.skills, ...(ownSkills[1] === '1001' ? fresh : [])].filter((s) => !writtenRemoved.includes(s.id)) });
      }
      const checks = /^\/v1\/orgs\/(\d+)\/checks(?:\/(\d+))?$/.exec(u.pathname);
      if (checks && !CHECKS[checks[1]]) return json(req, { error: 'not_connected' }, 404);
      if (checks && m === 'POST') {
        const body = JSON.parse(req.postData());
        if (body.name === 'Translations') return json(req, { error: 'exists', message: 'This repository already has a check of that name.' }, 409);
        checksAdded.push(body);
        return json(req, { id: 300 + checksAdded.length }, 201);
      }
      if (checks && m === 'DELETE') {
        checksRemoved.push(Number(checks[2]));
        return req.respond({ status: 204, headers: cors });
      }
      if (checks) {
        const own = CHECKS[checks[1]];
        const fresh = checksAdded.map((c, i) => ({ id: 301 + i, ...c, repo: 'acme/widgets', by: 'ada', created_at: new Date().toISOString(), can_remove: true }));
        return json(req, { ...own, checks: [...own.checks, ...(checks[1] === '1001' ? fresh : [])].filter((c) => !checksRemoved.includes(c.id)) });
      }
      const memories = /^\/v1\/orgs\/(\d+)\/memories(?:\/(\d+))?$/.exec(u.pathname);
      if (memories && m === 'DELETE') {
        if (forgetFails) return json(req, { error: 'server_error' }, 500);
        forgotten.push(Number(memories[2]));
        return req.respond({ status: 204, headers: cors });
      }
      // Like the real server: an org that hasn't turned the dashboard on has no list at all.
      if (memories && !OVERVIEWS[memories[1]]) return json(req, { error: 'not_connected' }, 404);
      if (memories) return json(req, { memories: (DECISIONS[memories[1]] ?? []).filter((d) => !forgotten.includes(d.id)) });
      const org = /^\/v1\/orgs\/(\d+)\/overview$/.exec(u.pathname)?.[1];
      if (org) {
        if (calls.filter((c) => c.path.endsWith('/overview')).length > signedOutAfter) return json(req, { error: 'signed_out' }, 401);
        return OVERVIEWS[org] ? json(req, OVERVIEWS[org]) : json(req, { error: 'not_connected' }, 404);
      }
      return json(req, { error: 'not_found' }, 404);
    }
    // GitHub, for a person who is signed in and has authorized the app before: straight back, with a new code.
    if (u.origin === 'https://github.com' && u.pathname === '/login/oauth/authorize') {
      renewals.push(u.searchParams.get('state'));
      return req.respond({ status: 302, headers: { location: `${base}/setup/?code=again&state=${encodeURIComponent(u.searchParams.get('state'))}` } });
    }
    if (u.hostname === 'github.com' || u.hostname === 'avatars.githubusercontent.com') return req.respond({ status: 404, headers: cors, body: '' });
    if (u.origin === base) {
      const file = join(dist, u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname);
      if (existsSync(file)) return req.respond({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    }
    return req.continue();
  });
  const text = () => page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' '));
  const click = async (selector, label) => {
    const at = await page.evaluate((s, t) => {
      // Only what is on screen: a phone and a wide screen each hide one copy of the menu.
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim() === t && e.getClientRects().length > 0);
      if (!el) return null;
      // A real mouse can only click what is on screen.
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, selector, label);
    if (!at) throw new Error(`no ${selector} "${label}": ${await text()}`);
    await page.mouse.click(at.x, at.y);
  };
  /** Clicks the item of a menu whose text ends with the label: an org's picture letter may come first. */
  const menu = async (trigger, item) => {
    await page.click(`[aria-label="${trigger}"]`);
    await wait(350);
    const at = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('[role=menuitem]')].find((e) => e.textContent.trim().endsWith(t));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, item);
    if (!at) throw new Error(`no menu item "${item}" under "${trigger}"`);
    await page.mouse.click(at.x, at.y);
    await wait(500);
  };
  /** Opens a view from the menu on the left. */
  const view = async (label) => {
    await click('[data-sidebar=menu-button]', label);
    await wait(400);
  };
  /** The choices a list offers, and picking one. */
  const options = async (label) => {
    await page.click(`[aria-label="${label}"]`);
    await wait(350);
    const found = await page.evaluate(() => [...document.querySelectorAll('[data-slot=select-content][data-open] [role=option]')].map((o) => ({ text: o.textContent.trim(), disabled: o.getAttribute('aria-disabled') === 'true' || o.hasAttribute('data-disabled') })));
    await page.keyboard.press('Escape');
    await wait(250);
    return found;
  };
  const choose = async (label, option) => {
    await page.click(`[aria-label="${label}"]`);
    await wait(350);
    await click('[data-slot=select-content][data-open] [role=option]', option);
    await wait(300);
  };
  /** The text of the open form window, which sits outside the page's main region. */
  const dialog = () => page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' ') ?? '');
  /** What GitHub does after "Continue with GitHub": it sends the person to the setup page with a code and the state. */
  const comeBackFromGitHub = async (state) => {
    await page.goto(`${base}/setup/?code=c&state=${encodeURIComponent(state)}`, { waitUntil: 'networkidle2' });
    await wait(700);
  };
  const signIn = async () => {
    await page.goto(`${base}/dashboard/`, { waitUntil: 'networkidle2' });
    const href = await page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Continue with GitHub'))?.href);
    const state = new URL(href).searchParams.get('state');
    await comeBackFromGitHub(state);
    return { href, state };
  };
  console.log(`\n== ${name}`);
  return { page, calls, exchanges, renewals, forgotten, added, removed, skillsAdded, skillsRemoved, written, writtenRemoved, checksAdded, checksRemoved, errors, text, click, menu, view, options, choose, dialog, signIn, comeBackFromGitHub, shot: (file) => page.screenshot({ path: `${out}${file}.png`, fullPage: true }).catch(() => {}) };
}
const done = async (t) => {
  if (t.errors.length) { console.log('  page errors', t.errors.slice(0, 3)); failures++; }
  await t.page.close();
};

{
  const t = await open('sign-in');
  await t.page.goto(`${base}/dashboard/`, { waitUntil: 'networkidle2' });
  expect(/Your reviews, in one place/.test(await t.text()), 'a signed-out visitor sees the sign-in screen');
  expect(/numbers about each review, and the findings your team declined, with who declined each one and why/.test(await t.text()) && /Never your code/.test(await t.text()), 'it says what the dashboard holds');
  expect(t.calls.length === 0, 'nothing is asked of the server before a sign-in');
  await t.shot('1-signed-out');
  const { href, state } = await t.signIn();
  expect(href.startsWith('https://github.com/login/oauth/authorize?client_id=') && state.startsWith('dash.'), 'the sign-in goes to GitHub, marked as the dashboard\'s');
  expect(new URL(t.page.url()).pathname === '/dashboard/', `the setup page passes the sign-in on to the dashboard (${t.page.url()})`);
  expect(!/code=|state=/.test(t.page.url()), 'the code is taken out of the address bar');
  const after = await t.text();
  expect(/acme/.test(after) && /acme\/widgets #42/.test(after), 'the org and its latest reviews show');
  expect(/2 bugs, 1 risk, 3 hardening/.test(after) && /Nothing worth fixing/.test(after), 'each review says what was found');
  expect(/opus, 6m 52s/.test(after) && /codex, 1m 35s/.test(after), 'and which AI ran it and how long it took');
  expect(/Latest 3 reviews 3 Since 1 day ago Safe to merge 1 33% of them Needs a human 1 33% of them Blocked 1 33% of them/.test(after), `the counts add up, and say over which time (${after.slice(0, 200)})`);
  expect(/acme\/widgets Last review 1 hour ago 2/.test(after) && /acme\/api Last review 1 day ago 1/.test(after), 'the repositories are listed, with their number of reviews');
  await t.page.click('[aria-label=More]');
  await wait(350);
  const addLink = await t.page.evaluate(() => { const a = [...document.querySelectorAll('a')].find((x) => x.textContent.includes('Add it on GitHub')); return a && { href: a.href, target: a.target }; });
  expect(addLink?.href === 'https://github.com/apps/mergelight-setup/installations/new', 'the way to add a missing org or repository is in the page menu');
  expect(addLink?.target === '_blank', 'and it opens in a new tab, so the dashboard stays where it is');
  await t.page.keyboard.press('Escape');
  await wait(300);
  const link = await t.page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('#42'))?.href);
  expect(link === 'https://github.com/acme/widgets/pull/42', 'a review links to its pull request on GitHub');
  const cursors = await t.page.evaluate(() => [...document.querySelectorAll('button:not(:disabled), a[href], tbody tr')].filter((e) => getComputedStyle(e).cursor !== 'pointer').map((e) => e.outerHTML.slice(0, 80)));
  expect(cursors.length === 0, `everything that can be clicked shows the hand (${cursors.join(' | ')})`);
  await t.shot('2-reviews');

  expect(t.calls[0].m === 'POST' && t.calls[0].path === '/v1/session' && t.calls[0].auth === `Bearer ${GITHUB_TOKEN}`, 'the GitHub token goes to the server once, to sign in');
  expect(t.calls.slice(1).every((c) => c.auth === `Bearer ${SESSION_TOKEN}`), 'every later call carries only the server\'s own session');
  const stored = await t.page.evaluate(() => JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage), document.cookie]));
  expect(!stored.includes(GITHUB_TOKEN), 'the page keeps no GitHub token, in no kind of storage');
  expect(t.exchanges.length === 1, 'the sign-in code is used once');

  // Decisions.
  await t.view('Decisions');
  const decided = await t.text();
  expect(/Cart total is rounded before tax/.test(decided) && /ada: The payment provider needs whole cents\./.test(decided), 'what the team decided shows, with who said why');
  expect(/acme\/widgets · src\/cart\.ts:40/.test(decided) && /Left out of 3 reviews since/.test(decided) && /Not needed since/.test(decided), 'and where it is and how often it was used');
  expect(/A decision nobody needed for 90 days is dropped/.test(decided), 'it says when a decision is dropped');
  const forgetButtons = await t.page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Forget').length);
  expect(forgetButtons === 1, 'only a decision in a repository the person can push to has a Forget button');
  await t.click('button', 'Forget');
  await wait(400);
  expect(t.forgotten.length === 0, 'Forget asks first, and does nothing yet');
  const asked = await t.page.evaluate(() => document.querySelector('[data-slot=popover-content]')?.innerText ?? '');
  expect(/can't be undone/.test(asked) && /may raise this finding again/.test(asked), 'and says it cannot be undone');
  await t.click('button', 'Yes, forget');
  await wait(600);
  expect(t.forgotten.join() === '12' && !/Cart total is rounded/.test(await t.text()) && /Retry has no upper bound/.test(await t.text()), 'Forget removes that one decision, on the server and on the page');
  expect(/Decision forgotten/.test(await t.text()), 'and says it is done');

  // Rules.
  await t.view('Rules');
  const withRules = await t.text();
  expect(/Ignore style and naming\. set by ada, 8 days ago Every repository All files/.test(withRules), `a rule of the whole org shows, with who set it (${withRules.match(/Rule Where.{0,80}/)?.[0]})`);
  expect(/Billing changes need a second pair of eyes\. Always needs a human set by bo, 1 day ago acme\/api src\/billing\/\*\*, \*\.sql/.test(withRules), 'files that always need a human show with their repository and patterns');
  expect(/stops a merge only where the Mergelight check is required and the workflow sets yellow-blocks: true\. Without that it is a warning/.test(withRules), 'the view says when "needs a human" stops a merge');
  const removeButtons = await t.page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Remove').length);
  expect(removeButtons === 1, 'only a rule this person may remove has a Remove button');
  await t.click('button', 'New rule');
  await wait(500);
  const places = await t.options('Where it applies');
  expect(places.map((o) => o.text).join() === 'Every repository,acme/widgets' && places.every((o) => !o.disabled), `a new rule can go where this person may set rules, and nowhere else (${JSON.stringify(places)})`);
  const placeShown = await t.page.evaluate(() => document.querySelector('[aria-label="Where it applies"]').textContent);
  expect(/Pick a repository/.test(placeShown), 'with more than one place to pick, the form does not pick one for the person');

  const fill = async (label, value) => {
    await t.page.evaluate((l) => document.querySelector(`[aria-label="${l}"]`).scrollIntoView({ block: 'center', behavior: 'instant' }), label);
    await t.page.click(`[aria-label="${label}"]`, { clickCount: 3 });
    await t.page.keyboard.type(value);
  };
  const submitOff = (label) => t.page.evaluate((l) => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === l).disabled, label);
  await t.choose('What it is', 'Files that always need a human');
  await fill('The rule', 'Migrations are reviewed by the data team.');
  await t.choose('Where it applies', 'acme/widgets');
  expect(await submitOff('Add'), 'files that always need a human can\'t be added without naming files');
  await fill('Files', 'db/migrations/**, *.sql');
  await t.click('[role=dialog] button', 'Add');
  await wait(800);
  expect(JSON.stringify(t.added) === JSON.stringify([{ kind: 'needs_human', text: 'Migrations are reviewed by the data team.', paths: ['db/migrations/**', '*.sql'], repo_id: 501 }]), `the new rule is sent as typed (${JSON.stringify(t.added)})`);
  expect(/Migrations are reviewed by the data team\. Always needs a human set by ada, just now acme\/widgets db\/migrations\/\*\*, \*\.sql/.test(await t.text()), 'and shows in the list');
  expect(!(await t.page.$('[role=dialog]')) && /Files added/.test(await t.text()), 'the form closes and says it is done');
  await t.click('button', 'New rule');
  await wait(500);
  const cleared = await t.page.evaluate(() => document.querySelector('[aria-label="The rule"]').value + document.querySelector('[aria-label="Files"]').value);
  expect(cleared === '', 'the form is empty again');
  const remembered = await t.page.evaluate(() => document.querySelector('[aria-label="Where it applies"]').textContent);
  expect(/acme\/widgets/.test(remembered), 'and starts on the repository picked last time');

  await fill('The rule', 'refuse me');
  await fill('Files', 'src/**');
  await t.click('[role=dialog] button', 'Add');
  await wait(700);
  expect(/Only an owner of the org can set rules for the whole org\./.test(await t.dialog()), 'when the server says no, the form shows why');
  await t.page.keyboard.press('Escape');
  await wait(400);

  expect(!(await t.page.$('[role=dialog]')), `Escape closes the form (${await t.dialog()})`);
  await t.click('button', 'Remove');
  await wait(400);
  expect(t.removed.length === 0, 'Remove asks first');
  await t.shot('4-remove-asks');
  await t.click('button', 'Yes, remove');
  await wait(600);
  expect(t.removed.join() === '3' && !/Ignore style and naming\. set by/.test(await t.text()), `Remove takes the rule off the server and the page (${t.removed} | ${(await t.text()).slice(0, 300)})`);

  // Skills.
  await t.view('Skills');
  const withSkills = await t.text();
  expect(/\.claude\/skills\/migrations picked by ada, 3 days ago acme\/widgets/.test(withSkills) && /\.agents\/skills\/payments picked by bo, 20 hours ago acme\/api/.test(withSkills), `the picked skill folders show, with their repository and who picked them (${withSkills.match(/Skill folder.{0,80}/)?.[0]})`);
  expect(/a pull request can't change the skill that reviews it/.test(withSkills) && /The skill's text stays in your repository/.test(withSkills) && /Only the folder's path is stored here/.test(withSkills) && /Name the real folder, not a link to it/.test(withSkills), 'the view says where a skill is read from, and that its text is not stored');
  const skillRemoves = await t.page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Remove skill').length);
  expect(skillRemoves === 1, 'only a skill in a repository this person is an admin of has a Remove button');
  await t.click('button', 'New skill');
  await wait(500);
  const skillPlaces = await t.options('Skill repository');
  expect(skillPlaces.map((o) => o.text).join() === 'acme/widgets', `a skill can be picked for repositories this person is an admin of, and no other (${JSON.stringify(skillPlaces)})`);
  expect(/acme\/widgets/.test(await t.page.evaluate(() => document.querySelector('[aria-label="Skill repository"]').textContent)), 'with one repository to pick, the form starts on it');
  expect(await submitOff('Add skill'), 'a skill can\'t be added without a folder');
  await fill('Skill folder', '  .agents/skills/billing ');
  await t.click('[role=dialog] button', 'Add skill');
  await wait(800);
  expect(JSON.stringify(t.skillsAdded) === JSON.stringify([{ repo_id: 501, path: '.agents/skills/billing' }]), `the new skill is sent with its repository and its folder (${JSON.stringify(t.skillsAdded)})`);
  expect(/\.agents\/skills\/billing picked by ada, just now acme\/widgets/.test(await t.text()) && /Skill added/.test(await t.text()), 'and shows in the list, and the page says it is done');
  await t.click('button', 'New skill');
  await wait(500);
  expect((await t.page.evaluate(() => document.querySelector('[aria-label="Skill folder"]').value)) === '', 'the form is empty again');
  await fill('Skill folder', '../other/skills');
  await t.click('[role=dialog] button', 'Add skill');
  await wait(700);
  expect(/Name the skill's folder in the repository/.test(await t.dialog()), 'when the server refuses a folder, the form shows why');
  await t.page.keyboard.press('Escape');
  await wait(400);
  await t.click('button', 'Remove skill');
  await wait(400);
  await t.click('button', 'Yes, remove');
  await wait(600);
  expect(t.skillsRemoved.join() === '7' && !/\.claude\/skills\/migrations picked by/.test(await t.text()), 'Remove takes the skill off the server and the page');

  // Skills written on the dashboard.
  const withWritten = await t.text();
  expect(/Payments Use when a pull request changes src\/billing\. written by ada, 2 days ago acme\/widgets/.test(withWritten) && /Queues Use for retry and queue code\. written by bo, 5 hours ago acme\/api/.test(withWritten), `a written skill shows with its name, when to use it, its repository and who wrote it (${withWritten.match(/Written here.{0,120}/)?.[0]})`);
  expect(/The text of a skill written here is stored on the Mergelight server/.test(withWritten) && /It can't change how a review treats the code in a pull request/.test(withWritten), 'the view says that the text of a written skill is stored on the server, and what a skill can\'t do');
  expect(!/Amounts are whole cents/.test(withWritten), 'the text of a skill is closed until someone opens it');
  await t.click('button', 'Show text');
  await wait(300);
  expect(/Amounts are whole cents, never fractions\./.test(await t.text()), 'Show text opens the skill\'s text');
  await t.click('button', 'Hide text');
  await wait(300);
  const writtenDeletes = await t.page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Delete skill').length);
  expect(writtenDeletes === 1, 'only a skill in a repository this person is an admin of has a Delete button');
  await t.click('button', 'Write a skill');
  await wait(500);
  const writtenPlaces = await t.options('Written skill repository');
  expect(writtenPlaces.map((o) => o.text).join() === 'acme/widgets', `a skill can be written for repositories this person is an admin of, and no other (${JSON.stringify(writtenPlaces)})`);
  await fill('Written skill name', 'Migrations');
  await fill('Written skill description', 'Use when a pull request changes db/migrations.');
  expect(await submitOff('Save skill'), 'a skill can\'t be saved without its text');
  await t.page.click('[aria-label="Written skill text"]');
  await t.page.keyboard.type('Every migration has a down step.');
  await t.page.keyboard.press('Enter');
  await t.page.keyboard.type('Never drop a column in the same release.');
  expect(/73 of 8000 characters/.test(await t.dialog()), 'the form counts the characters of the text');
  await t.click('[role=dialog] button', 'Save skill');
  await wait(800);
  expect(JSON.stringify(t.written) === JSON.stringify([{ repo_id: 501, name: 'Migrations', description: 'Use when a pull request changes db/migrations.', text: 'Every migration has a down step.\nNever drop a column in the same release.' }]), `the new skill is sent as typed, line break included (${JSON.stringify(t.written)})`);
  expect(/Migrations Use when a pull request changes db\/migrations\. written by ada, just now acme\/widgets/.test(await t.text()) && /Skill saved/.test(await t.text()), 'and shows in the list, and the page says it is done');
  await t.click('button', 'Write a skill');
  await wait(500);
  const writtenCleared = await t.page.evaluate(() => ['Written skill name', 'Written skill description', 'Written skill text'].map((l) => document.querySelector(`[aria-label="${l}"]`).value).join(''));
  expect(writtenCleared === '', 'the form is empty again');
  await fill('Written skill name', 'Payments');
  await fill('Written skill description', 'Again.');
  await t.page.click('[aria-label="Written skill text"]');
  await t.page.keyboard.type('Text.');
  await t.click('[role=dialog] button', 'Save skill');
  await wait(700);
  expect(/This repository already has a skill of that name\./.test(await t.dialog()), 'when the server refuses a skill, the form shows why');
  // A session lasts 15 minutes and a new sign-in reloads the page. What is being written must still be there.
  await t.page.reload({ waitUntil: 'networkidle2' });
  await wait(700);
  await t.view('Skills');
  await t.click('button', 'Write a skill');
  await wait(500);
  const draftKept = await t.page.evaluate(() => ['Written skill name', 'Written skill description', 'Written skill text'].map((l) => document.querySelector(`[aria-label="${l}"]`).value).join(' | '));
  expect(draftKept === 'Payments | Again. | Text.', `a skill that is being written is still in the form after the page loads again (${draftKept})`);
  await t.page.keyboard.press('Escape');
  await wait(400);
  await t.click('button', 'Delete skill');
  await wait(400);
  expect(t.writtenRemoved.length === 0, 'Delete asks first');
  await t.click('button', 'Yes, delete');
  await wait(600);
  expect(t.writtenRemoved.join() === '31' && !/Payments Use when a pull request changes src\/billing/.test(await t.text()), 'Delete takes the skill off the server and the page');

  // Checks.
  await t.view('Checks');
  const withChecks = await t.text();
  expect(/Translations Every new text in en\.json has a translation in da\.json\. set by ada, 2 days ago acme\/widgets src\/i18n\/\*\*/.test(withChecks), `a check shows with its name, its text, its repository and its files (${withChecks.match(/Check Repository.{0,80}/)?.[0]})`);
  expect(/Refunds A refund is never larger than its invoice\. set by bo, 10 hours ago acme\/api src\/billing\/\*\*, \*\.sql/.test(withChecks), 'and so does one in a repository this person only reads');
  expect(/runs only when a pull request changes its files/.test(withChecks) && /one more AI run on your own plan/.test(withChecks) && /never changes code/.test(withChecks) && /require that check in your branch rules/.test(withChecks) && /couldn't tell or couldn't run holds the merge too/.test(withChecks), 'the view says when a check runs, what it costs, that it only reports, and how to make it stop a merge');
  const checkRemoves = await t.page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Remove check').length);
  expect(checkRemoves === 1, 'only a check in a repository this person is an admin of has a Remove button');
  await t.click('button', 'New check');
  await wait(500);
  const checkPlaces = await t.options('Check repository');
  expect(checkPlaces.map((o) => o.text).join() === 'acme/widgets', `a check can be set for repositories this person is an admin of, and no other (${JSON.stringify(checkPlaces)})`);
  await fill('Check name', 'Migrations');
  await fill('The check', 'Every migration has a down step.');
  expect(await submitOff('Add check'), 'a check can\'t be added without the files it is about');
  expect(/Mergelight: Migrations/.test(await t.dialog()), 'the form shows the name the check will have on the pull request');
  await fill('Check files', 'db/migrations/**, *.sql');
  await t.click('[role=dialog] button', 'Add check');
  await wait(800);
  expect(JSON.stringify(t.checksAdded) === JSON.stringify([{ repo_id: 501, name: 'Migrations', text: 'Every migration has a down step.', paths: ['db/migrations/**', '*.sql'] }]), `the new check is sent as typed (${JSON.stringify(t.checksAdded)})`);
  expect(/Migrations Every migration has a down step\. set by ada, just now acme\/widgets db\/migrations\/\*\*, \*\.sql/.test(await t.text()) && /Check added/.test(await t.text()), 'and shows in the list, and the page says it is done');
  await t.click('button', 'New check');
  await wait(500);
  const checkFormCleared = await t.page.evaluate(() => ['Check name', 'The check', 'Check files'].map((l) => document.querySelector(`[aria-label="${l}"]`).value).join(''));
  expect(checkFormCleared === '', 'the form is empty again');
  await fill('Check name', 'Translations');
  await fill('The check', 'Another one.');
  await fill('Check files', 'src/**');
  await t.click('[role=dialog] button', 'Add check');
  await wait(700);
  expect(/This repository already has a check of that name\./.test(await t.dialog()), 'when the server refuses a check, the form shows why');
  await t.page.keyboard.press('Escape');
  await wait(400);
  await t.click('button', 'Remove check');
  await wait(400);
  await t.click('button', 'Yes, remove');
  await wait(600);
  expect(t.checksRemoved.join() === '21' && !/Translations Every new text/.test(await t.text()), 'Remove takes the check off the server and the page');

  await t.menu('Switch org', 'quiet');
  expect(/The dashboard isn't on for quiet/.test(await t.text()), 'an org that hasn\'t turned it on says so');
  await t.menu('Switch org', 'fresh');
  expect(/Only an admin of a repository can set its checks\./.test(await t.text()) && !(await t.page.$('[aria-label="The check"]')) && !/New check/.test(await t.text()), 'someone who is no admin sees no check form, and is told who can');
  await t.view('Rules');
  expect(/Only an owner of the org or an admin of a repository can change the rules\./.test(await t.text()) && !/New rule/.test(await t.text()), 'someone who may not set rules sees no form, and is told who can');
  await t.view('Skills');
  expect(/Only an admin of a repository can pick its skills\./.test(await t.text()) && !/New skill/.test(await t.text()), 'someone who is no admin sees no skill form, and is told who can');
  expect(/Only an admin of a repository can write its skills\./.test(await t.text()) && !/Write a skill/.test(await t.text()), `and no form to write a skill (${(await t.text()).slice(-400)})`);
  await t.view('Reviews');
  expect(/No reviews to show yet/.test(await t.text()) && /repositories this sign-in can't see/.test(await t.text()) && (await t.text()).includes(`server: ${SERVER}`) && /It never sends code/.test(await t.text()), 'an org with no reviews yet shows the one line to add, and what a review sends');
  await t.shot('3-nothing-yet');

  await t.page.evaluate(() => { window.location.hash = 'checks'; });
  await wait(400);
  expect(/Only an admin of a repository can set its checks\./.test(await t.text()), 'typing another #view in the address goes to that view');
  await t.view('Reviews');
  const tripsBefore = t.renewals.length;
  await t.page.reload({ waitUntil: 'networkidle2' });
  await wait(500);
  expect(/No reviews to show yet/.test(await t.text()) && /fresh/.test(await t.page.evaluate(() => document.querySelector('[aria-label="Switch org"]').textContent)) && t.renewals.length === tripsBefore, 'a reload keeps the session and the org, with no trip to GitHub');
  await t.menu('Switch org', 'acme');
  expect(/acme\/widgets #42/.test(await t.text()), 'and switching back shows that org again');

  // On a phone the menu is a sheet over the page. Picking a view closes it.
  await t.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await wait(400);
  await t.page.click('[data-sidebar=trigger]');
  await wait(500);
  expect(await t.page.evaluate(() => !!document.querySelector('[data-mobile=true]')), 'on a phone, the menu button opens the menu');
  await t.view('Checks');
  await wait(400);
  const sheetOpen = await t.page.evaluate(() => !!document.querySelector('[data-mobile=true]'));
  expect(!sheetOpen && /Only a real pass gets through/.test(await t.text()), 'on a phone, picking a view closes the menu and shows the view');
  await t.page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await wait(400);
  await t.view('Reviews');

  const keptBefore = await t.page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.includes('draft') || k.includes('written-skill') || k.endsWith('.org') || k.endsWith('.view')));
  expect(keptBefore.length > 0, `before signing out, the tab keeps drafts, the org and the view (${keptBefore})`);
  await t.menu('Your account', 'Sign out');
  const keptAfter = await t.page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.includes('draft') || k.includes('written-skill') || k.endsWith('.org') || k.endsWith('.view') || k.endsWith('.resume')));
  expect(keptAfter.length === 0, `signing out forgets the drafts, the org and the view, so the next person starts clean (${keptAfter})`);
  expect(/Continue with GitHub/.test(await t.text()), 'signing out goes back to the sign-in screen');
  expect(t.calls.at(-1).m === 'DELETE' && t.calls.at(-1).path === '/v1/session', 'and ends the session on the server');
  await t.page.reload({ waitUntil: 'networkidle2' });
  expect(/Continue with GitHub/.test(await t.text()), 'and a reload stays signed out');
  await done(t);
}

{
  const t = await open('forget-fails', { forgetFails: true });
  await t.signIn();
  await t.view('Decisions');
  await t.click('button', 'Forget');
  await wait(400);
  await t.click('button', 'Yes, forget');
  await wait(600);
  expect(/Cart total is rounded before tax/.test(await t.text()) && /That didn't work/.test(await t.text()), 'a Forget that fails leaves the decision on the page, and says so');
  await done(t);
}

{
  const t = await open('wrong-state');
  await t.page.goto(`${base}/dashboard/`, { waitUntil: 'networkidle2' });
  await t.comeBackFromGitHub('dash.someone-elses-state');
  expect(/Continue with GitHub/.test(await t.text()), 'a code with a state this tab never sent is not used');
  expect(t.exchanges.length === 0, 'the code is not even swapped for a GitHub token');
  expect(t.calls.length === 0, 'and nothing is sent to the server');
  await done(t);
}

{
  const t = await open('cancelled');
  await t.page.goto(`${base}/dashboard/`, { waitUntil: 'networkidle2' });
  const state = await t.page.evaluate(() => new URL([...document.querySelectorAll('a')].find((a) => a.textContent.includes('Continue with GitHub')).href).searchParams.get('state'));
  // What GitHub does when the person presses Cancel: an error, the state, and no code.
  await t.page.goto(`${base}/setup/?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=${encodeURIComponent(state)}`, { waitUntil: 'networkidle2' });
  await wait(500);
  expect(new URL(t.page.url()).pathname === '/dashboard/', 'a cancelled sign-in comes back to the dashboard, not the setup page');
  expect(/Sign-in was cancelled/.test(await t.text()) && /Continue with GitHub/.test(await t.text()), 'and says so, with the way to try again');
  expect(!/error=/.test(t.page.url()), 'the error is taken out of the address bar');
  expect(t.exchanges.length === 0 && t.calls.length === 0, 'nothing is sent anywhere');
  await done(t);
}

{
  const t = await open('setup-untouched');
  await t.page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await t.page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
  await t.page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
  expect(new URL(t.page.url()).pathname === '/setup/', 'a sign-in the setup page started stays on the setup page');
  await done(t);
}

{
  const t = await open('session-ran-out', { signedOutAfter: 1 });
  await t.signIn();
  expect(/acme\/widgets #42/.test(await t.text()), 'signed in');
  await t.menu('Switch org', 'fresh');
  await wait(1300);
  expect(t.renewals.length === 1 && t.renewals[0].startsWith('dash.'), 'when the session runs out, the page goes to GitHub by itself to sign in again');
  expect(t.exchanges.length === 2 && t.calls.filter((c) => c.path === '/v1/session' && c.m === 'POST').length === 2, 'and comes back with a new session');
  expect(/Continue with GitHub/.test(await t.text()), 'a session that fails again straight after is not renewed in a loop: the page asks for a sign-in');
  expect(t.renewals.length === 1, 'so GitHub is visited once');
  await done(t);
}

{
  const t = await open('add-after-session-ran-out', { signedOutOnAdd: true });
  await t.signIn();
  await t.view('Rules');
  await t.click('button', 'New rule');
  await wait(500);
  await t.page.click('[aria-label="The rule"]');
  await t.page.keyboard.type('Keep this text.');
  await t.page.click('[aria-label="Where it applies"]');
  await wait(350);
  await t.click('[data-slot=select-content][data-open] [role=option]', 'acme/widgets');
  await wait(300);
  await t.click('[role=dialog] button', 'Add');
  await wait(2500);
  expect(t.renewals.length === 1 && t.exchanges.length === 2, 'when the session ran out during an Add, the page signs in again by itself');
  expect(t.added.length === 0, 'the rule that hit the old session was not added');
  const kept = await t.page.evaluate(() => document.querySelector('[aria-label="The rule"]')?.value);
  expect(kept === 'Keep this text.', `after the new sign-in the form is open again, with the text (${kept})`);
  expect(/You were signed in again/.test(await t.text()), 'and the page says what happened');
  await t.click('[role=dialog] button', 'Add');
  await wait(800);
  expect(t.added.length === 1 && t.added[0].text === 'Keep this text.', 'one more click adds it');
  await done(t);
}

{
  const t = await open('write-after-session-ran-out', { signedOutOnWrite: true });
  await t.signIn();
  await t.view('Skills');
  await t.click('button', 'Write a skill');
  await wait(500);
  await t.page.click('[aria-label="Written skill name"]');
  await t.page.keyboard.type('Migrations');
  await t.page.click('[aria-label="Written skill description"]');
  await t.page.keyboard.type('Use for db/migrations.');
  await t.page.click('[aria-label="Written skill text"]');
  await t.page.keyboard.type('Every migration has a down step.');
  await t.click('[role=dialog] button', 'Save skill');
  await wait(2500);
  expect(t.renewals.length === 1 && t.written.length === 0, 'when the session ran out while saving a written skill, the page signs in again and nothing was saved');
  const keptText = await t.page.evaluate(() => document.querySelector('[aria-label="Written skill text"]')?.value);
  expect(keptText === 'Every migration has a down step.', `after the new sign-in the written skill's form is open again, with its text (${keptText})`);
  await t.click('[role=dialog] button', 'Save skill');
  await wait(800);
  expect(t.written.length === 1 && t.written[0].name === 'Migrations', 'one more click saves it');
  await done(t);
}

{
  const t = await open('no-orgs', { noOrgs: true });
  await t.signIn();
  expect(/No repositories to show/.test(await t.text()), 'a sign-in with no org to show says so');
  await t.click('button', 'Sign out');
  await wait(400);
  expect(/Continue with GitHub/.test(await t.text()), 'and can sign out from there');
  await done(t);
}

{
  const t = await open('server-down', { serverDown: true });
  await t.signIn();
  expect(/Sign-in didn't work/.test(await t.text()), 'a server that is down fails the sign-in, and says so');
  await done(t);
}

console.log(failures ? `\n${failures} FAILED` : `\nall good (screenshots in ${out})`);
await browser.close();
process.exitCode = failures ? 1 : 0;
