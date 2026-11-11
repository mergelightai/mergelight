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

async function open(name, { signedOutAfter = Infinity, serverDown = false } = {}) {
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
      if (u.pathname === '/v1/session' && m === 'POST') return json(req, SESSION, 201);
      if (u.pathname === '/v1/session' && m === 'DELETE') return req.respond({ status: 204, headers: cors });
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
    if (u.origin === base) {
      const file = join(dist, u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname);
      if (existsSync(file)) return req.respond({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    }
    return req.continue();
  });
  const text = () => page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' '));
  const click = async (selector, label) => {
    const at = await page.evaluate((s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim() === t);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, selector, label);
    if (!at) throw new Error(`no ${selector} "${label}": ${await text()}`);
    await page.mouse.click(at.x, at.y);
  };
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
  return { page, calls, exchanges, renewals, errors, text, click, signIn, comeBackFromGitHub, shot: (file) => page.screenshot({ path: `${out}${file}.png`, fullPage: true }).catch(() => {}) };
}
const done = async (t) => {
  if (t.errors.length) { console.log('  page errors', t.errors.slice(0, 3)); failures++; }
  await t.page.close();
};

{
  const t = await open('sign-in');
  await t.page.goto(`${base}/dashboard/`, { waitUntil: 'networkidle2' });
  expect(/Your reviews, in one place/.test(await t.text()), 'a signed-out visitor sees the sign-in screen');
  expect(/Never your code/.test(await t.text()), 'it says what the dashboard holds');
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
  expect(/Latest 3 reviews 3 Safe to merge 1 Needs a human 1 Blocked 1/.test(after), `the counts add up (${after.slice(0, 160)})`);
  expect(/acme\/api 1 review/.test(after) && /acme\/widgets 2 reviews/.test(after), 'the repositories are listed');
  const add = await t.page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Add it on GitHub'))?.href);
  expect(add === 'https://github.com/apps/mergelight-setup/installations/new', 'the way to add a missing org or repository is on the page');
  const newTab = await t.page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Add it on GitHub'))?.target);
  expect(newTab === '_blank', 'and it opens in a new tab, so the dashboard stays where it is');
  const link = await t.page.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('#42'))?.href);
  expect(link === 'https://github.com/acme/widgets/pull/42', 'a review links to its pull request on GitHub');
  await t.shot('2-reviews');

  expect(t.calls[0].m === 'POST' && t.calls[0].path === '/v1/session' && t.calls[0].auth === `Bearer ${GITHUB_TOKEN}`, 'the GitHub token goes to the server once, to sign in');
  expect(t.calls.slice(1).every((c) => c.auth === `Bearer ${SESSION_TOKEN}`), 'every later call carries only the server\'s own session');
  const stored = await t.page.evaluate(() => JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage), document.cookie]));
  expect(!stored.includes(GITHUB_TOKEN), 'the page keeps no GitHub token, in no kind of storage');
  expect(t.exchanges.length === 1, 'the sign-in code is used once');

  await t.click('[role=tab]', 'quiet');
  await wait(500);
  expect(/The dashboard isn't on for quiet/.test(await t.text()), 'an org that hasn\'t turned it on says so');
  await t.click('[role=tab]', 'fresh');
  await wait(500);
  expect(/No reviews to show yet/.test(await t.text()) && /repositories this sign-in can't see/.test(await t.text()) && (await t.text()).includes(`server: ${SERVER}`), 'an org with no reviews yet shows the one line to add');
  await t.shot('3-nothing-yet');

  await t.page.reload({ waitUntil: 'networkidle2' });
  await wait(500);
  expect(/acme\/widgets #42/.test(await t.text()), 'a reload keeps the session, with no trip to GitHub');

  await t.page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sign out').click());
  await wait(500);
  expect(/Continue with GitHub/.test(await t.text()), 'signing out goes back to the sign-in screen');
  expect(t.calls.at(-1).m === 'DELETE' && t.calls.at(-1).path === '/v1/session', 'and ends the session on the server');
  await t.page.reload({ waitUntil: 'networkidle2' });
  expect(/Continue with GitHub/.test(await t.text()), 'and a reload stays signed out');
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
  await t.click('[role=tab]', 'fresh');
  await wait(1800);
  expect(t.renewals.length === 1 && t.renewals[0].startsWith('dash.'), 'when the session runs out, the page goes to GitHub by itself to sign in again');
  expect(t.exchanges.length === 2 && t.calls.filter((c) => c.path === '/v1/session' && c.m === 'POST').length === 2, 'and comes back with a new session');
  expect(/Continue with GitHub/.test(await t.text()), 'a session that fails again straight after is not renewed in a loop: the page asks for a sign-in');
  expect(t.renewals.length === 1, 'so GitHub is visited once');
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
