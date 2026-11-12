// Every way back from GitHub to the setup page, on the real built page, against a fake GitHub.
// Unlike full-flow.mjs this leaves the page and comes back, which is where sign-in gets lost.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const dist = process.env.DIST ?? new URL('../../dist', import.meta.url).pathname;
const out = `${mkdtempSync(join(tmpdir(), 'mergelight-browser-'))}/`;
const base = 'https://mergelight.dev';
const INSTALL = 'https://github.com/apps/mergelight-setup/installations/new';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let failures = 0;
const expect = (ok, what) => { console.log(`  ${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function scenario(name, { repos = ['acme/api'], signInFails = false, listFails = false, authorizeDelay = 150 } = {}, body) {
  console.log(`\n== ${name}`);
  const pagesBefore = (await browser.pages()).length;
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const world = { repos: [...repos], authorizes: 0, signIns: [], urls: [], signInFails, listFails };
  const json = (req, data, code = 200) => req.respond({ status: code, contentType: 'application/json', headers: cors, body: JSON.stringify(data) });

  // Notes if the sign-in button ever shows on this page, even for a moment.
  await page.evaluateOnNewDocument((origin) => {
    if (location.origin !== origin) return;
    const look = () => {
      try {
        if (document.body?.innerText.includes('Continue with GitHub')) sessionStorage.setItem('sawButton', location.search || '(none)');
        // The page can't be read from outside while it's on its way to GitHub, so it keeps its own note.
        if (location.search.includes('installation_id') && document.querySelector('main .animate-pulse')) sessionStorage.setItem('sawSkeleton', '1');
      } catch {}
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
  }, base);

  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = new URL(req.url());
    world.urls.push(req.url());
    if (u.origin === 'https://api.mergelight.dev') {
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (u.pathname === '/sign-in') {
        world.signIns.push(JSON.parse(req.postData()).code);
        return world.signInFails ? json(req, {}, 500) : json(req, { token: 'fake-token' });
      }
      return req.respond({ status: 200, headers: cors, body: 'ok' });
    }
    if (u.href === INSTALL) {
      // GitHub's account picker, cut down to the one button that matters here.
      return req.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><title>GitHub</title><h1>Install Mergelight AI</h1><a id="install" href="/fake-install">Install</a><a id="configure" href="/fake-save">Save</a>` });
    }
    if (u.origin === 'https://github.com' && u.pathname === '/fake-install') {
      world.repos.push('acme/new');
      return req.respond({ status: 302, headers: { location: `${base}/setup/?installation_id=9&setup_action=install` } });
    }
    if (u.origin === 'https://github.com' && u.pathname === '/fake-save') {
      world.repos.push('acme/new');
      return req.respond({ status: 302, headers: { location: `${base}/setup/?installation_id=9&setup_action=update` } });
    }
    if (u.origin === 'https://github.com' && u.pathname === '/login/oauth/authorize') {
      world.authorizes++;
      await wait(authorizeDelay);
      return req.respond({ status: 302, headers: { location: `${base}/setup/?code=c&state=${u.searchParams.get('state')}` } });
    }
    if (u.origin === 'https://api.github.com') {
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (world.listFails && u.pathname === '/user/installations') return json(req, {}, 500);
      if (u.pathname === '/user/installations') return json(req, { installations: world.repos.length ? [{ id: 1, html_url: 'https://github.com/settings/installations/1', account: { login: 'acme', avatar_url: `${base}/logo.png` } }] : [] });
      if (u.pathname === '/user/installations/1/repositories') return json(req, { repositories: [...world.repos, 'acme/zzz-other'].map((full_name) => ({ full_name, private: true, default_branch: 'main', archived: false })) });
      return json(req, {}, 404);
    }
    if (dist && u.origin === base) {
      const file = join(dist, u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname);
      if (existsSync(file)) return req.respond({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    }
    return req.continue();
  });

  const text = () => page.evaluate(() => (document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' '));
  const signIn = async () => {
    await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => sessionStorage.setItem('mergelight.setup.state', 's'));
    await page.goto(`${base}/setup/?code=c&state=s`, { waitUntil: 'networkidle2' });
    await wait(700);
    await page.evaluate(() => sessionStorage.removeItem('sawButton'));
  };
  const sawButton = () => page.evaluate(() => sessionStorage.getItem('sawButton'));
  const settle = async () => { await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {}); await wait(500); };
  const clickLink = async (label) => {
    const at = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('a')].find((e) => e.textContent.includes(t));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, target: el.target, href: el.href };
    }, label);
    if (!at) throw new Error(`no link with ${label}: ${await text()}`);
    await page.mouse.click(at.x, at.y);
    return at;
  };
  const shot = (what) => page.screenshot({ path: `${out}return-${name}-${what}.png` }).catch(() => {}); // Only a debugging aid, so it can't fail a run.
  const onList = (t, repo = 'new') => /Which repo should we review\?/.test(t) && t.includes(repo);
  const cleanAddress = () => { const u = new URL(page.url()); return !['code', 'state', 'iss'].some((k) => u.searchParams.has(k)); };

  try {
    await body({ page, world, text, signIn, sawButton, settle, clickLink, shot, onList, cleanAddress });
  } catch (e) {
    expect(false, `stopped early: ${e.message.slice(0, 120)}`);
  }
  expect((await browser.pages()).length === pagesBefore + 1, 'stayed in one tab');
  if (errors.length) { console.log('  page errors', errors.slice(0, 3)); failures++; }
  for (const p of (await browser.pages()).slice(pagesBefore)) await p.close();
}

await scenario('plain-visit', {}, async ({ page, world, text, settle, sawButton }) => {
  await page.goto(`${base}/setup/`, { waitUntil: 'networkidle2' });
  await settle();
  expect(world.authorizes === 0, "doesn't go to GitHub by itself");
  expect(/Real code review/.test(await text()) && Boolean(await sawButton()), 'shows the normal start');
});

await scenario('add-repo-from-the-list', {}, async ({ page, world, text, signIn, sawButton, settle, clickLink, shot, onList, cleanAddress }) => {
  await signIn();
  const link = await clickLink("Don't see your repo");
  expect(link.href === INSTALL, 'the link opens the account picker');
  expect(link.target === '', 'in the same tab');
  await settle();
  expect(page.url() === INSTALL, 'on GitHub now');
  await clickLink('Install');
  await wait(60);
  await shot('landing');
  await settle();
  const t = await text();
  expect(world.authorizes === 1, 'signed in again by itself, once');
  expect(onList(t), `lands on the list with the new repo: ${t.slice(0, 90)}`);
  expect(!(await sawButton()), 'never showed the sign-in button');
  expect(cleanAddress(), 'no code left in the address');
  await shot('list');
  await page.goBack({ waitUntil: 'networkidle2' }).catch(() => {});
  await settle();
  expect(page.url() === INSTALL, `back goes to GitHub, not in a loop (${page.url()})`);
  expect(world.authorizes === 1, 'and signs in no more');
});

await scenario('first-time-no-repos', { repos: [] }, async ({ page, world, text, signIn, sawButton, settle, clickLink, onList }) => {
  await signIn();
  expect(/Pick your repos/.test(await text()), 'asks to pick repos');
  const link = await clickLink('Choose on GitHub');
  expect(link.href === INSTALL && link.target === '', 'goes to the picker in the same tab');
  await settle();
  await clickLink('Install');
  await settle();
  expect(world.authorizes === 1, 'signed in again by itself, once');
  expect(onList(await text()), 'lands on the list with the new repo');
  expect(!(await sawButton()), 'never showed the sign-in button');
});

await scenario('changed-repos-on-github', {}, async ({ page, world, text, signIn, sawButton, settle, clickLink, onList }) => {
  await signIn();
  await clickLink("Don't see your repo");
  await settle();
  await clickLink('Save');
  await settle();
  expect(world.authorizes === 1, 'signed in again by itself, once');
  expect(onList(await text()), 'lands on the list with the added repo');
  expect(!(await sawButton()), 'never showed the sign-in button');
});

await scenario('started-on-github', {}, async ({ page, world, text, sawButton, settle, onList }) => {
  await page.goto(`${base}/setup/?installation_id=999&setup_action=install`, { waitUntil: 'networkidle2' });
  await settle();
  expect(world.authorizes === 1, 'signs in by itself in a new tab with nothing stored');
  expect(onList(await text(), 'api'), 'lands on the list');
  expect(!(await sawButton()), 'never showed the sign-in button');
  // 999 as a whole part of an address, like /installations/999 or id=999. Not inside a random sign-in
  // state or a timestamp, which can hold those digits by chance and made this check fail now and then.
  const usesId = (u) => /(^|[/=])999($|[/&?#])/.test(u.replace('installation_id=999', ''));
  expect(!world.urls.some(usesId), 'never uses the id from the address, which anyone can make up');
});

// With "Request user authorization during installation" on, someone new comes back with a code and no state.
await scenario('new-person-back-with-a-code', {}, async ({ page, world, text, sawButton, settle, onList, cleanAddress }) => {
  await page.goto(`${base}/setup/?code=unproven&installation_id=9&setup_action=install`, { waitUntil: 'networkidle2' });
  await settle();
  expect(world.authorizes === 1, 'gets a sign-in of its own, by itself');
  expect(onList(await text(), 'api'), 'lands on the list');
  expect(!(await sawButton()), 'never showed the sign-in button');
  expect(world.signIns.length === 1 && world.signIns[0] === 'c', `never uses the code it can't prove is theirs (${world.signIns})`);
  expect(cleanAddress(), 'no code left in the address');
});

await scenario('member-request-with-a-code', {}, async ({ page, world, text, settle }) => {
  await page.goto(`${base}/setup/?code=unproven&setup_action=request`, { waitUntil: 'networkidle2' });
  await settle();
  expect(world.authorizes === 0 && /Request sent/.test(await text()), 'a request stays a request');
  expect(world.signIns.length === 0, "and its code isn't used");
});

await scenario('stranger-link-with-a-code', {}, async ({ page, world, text, settle }) => {
  await page.goto(`${base}/setup/?code=theirs&state=wrong`, { waitUntil: 'networkidle2' });
  await settle();
  expect(world.signIns.length === 0 && world.authorizes === 0, "a sign-in link from someone else's code does nothing");
  expect(/Real code review/.test(await text()), 'it just shows the normal start');
});

await scenario('slow-github-keeps-a-spinner', { authorizeDelay: 2500 }, async ({ page, text, sawButton, settle, shot, onList }) => {
  // Not awaited: the page moves on by itself before this would finish.
  const going = page.goto(`${base}/setup/?installation_id=9&setup_action=install`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(1500);
  // Straight from Chrome, because this is the moment the page can't be read the usual way.
  await going;
  await wait(3000);
  await settle();
  const heldSkeleton = await page.evaluate(() => sessionStorage.getItem('sawSkeleton'));
  expect(heldSkeleton === '1', 'shows the skeleton while it waits');
  expect(onList(await text(), 'api'), 'then lands on the list');
  expect(!(await sawButton()), 'never showed the sign-in button');
});

await scenario('member-asks-an-owner', { repos: [] }, async ({ page, world, text, settle, clickLink, shot }) => {
  await page.goto(`${base}/setup/?setup_action=request`, { waitUntil: 'networkidle2' });
  await settle();
  const t = await text();
  await shot('sent');
  expect(world.authorizes === 0, "doesn't sign in by itself");
  expect(/Request sent/.test(t) && /An owner of your org has to approve/.test(t), `says it's with an owner: ${t.slice(0, 70)}`);
  expect(!/Real code review/.test(t), "doesn't look like starting over");
  world.repos.push('acme/new');
  await clickLink('Already approved');
  await settle();
  expect(world.authorizes === 1, 'continues when asked to');
  expect(/Which repo should we review\?/.test(await text()), 'and lands on the list');
});

await scenario('request-with-an-id', {}, async ({ page, world, text, settle }) => {
  await page.goto(`${base}/setup/?installation_id=9&setup_action=request`, { waitUntil: 'networkidle2' });
  await settle();
  expect(world.authorizes === 0 && /Request sent/.test(await text()), 'a request stays a request');
});

await scenario('cancelled-on-github', {}, async ({ page, world, text, settle, sawButton }) => {
  await page.goto(`${base}/setup/?error=access_denied&error_description=denied&state=s`, { waitUntil: 'networkidle2' });
  await settle();
  expect(world.authorizes === 0, "doesn't send them straight back");
  expect(/Real code review/.test(await text()) && Boolean(await sawButton()), 'can start again');
});

await scenario('sign-in-fails-on-return', { signInFails: true }, async ({ page, world, text, settle, sawButton }) => {
  await page.goto(`${base}/setup/?installation_id=9&setup_action=install`, { waitUntil: 'networkidle2' });
  await settle();
  await wait(1200);
  expect(world.authorizes === 1, 'tries once, no loop');
  expect(/GitHub sign-in didn't work/.test(await text()) && Boolean(await sawButton()), 'says so, and offers the button');
});

await scenario('list-fails-on-return', { listFails: true }, async ({ page, world, text, settle }) => {
  await page.goto(`${base}/setup/?installation_id=9&setup_action=install`, { waitUntil: 'networkidle2' });
  await settle();
  await wait(1200);
  expect(world.authorizes === 1, 'tries once, no loop');
  expect(/Couldn't reach GitHub/.test(await text()), 'says so');
});

await scenario('added-in-another-tab', {}, async ({ page, world, text, signIn, settle }) => {
  await signIn();
  world.repos.push('acme/new');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await settle();
  expect((await text()).includes('new'), 'coming back to the tab still picks it up');
  expect(world.authorizes === 0, 'without signing in again');
});

console.log(failures ? `\n${failures} FAILED` : '\nall good');
await browser.close();
process.exitCode = failures ? 1 : 0;
