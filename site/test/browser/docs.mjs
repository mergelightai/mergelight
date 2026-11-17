// Runs the real built docs pages on their real origin in headless Chrome: the menu, the outline, copying code,
// search from the index Pagefind built, the phone menu, and the Markdown copies for AI tools.
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const dist = process.env.DIST ?? new URL('../../dist', import.meta.url).pathname;
const base = 'https://mergelight.dev';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok' : 'FAIL'}: ${what}`);
  if (!ok) failed++;
};

// The files AI tools read, straight from the build.
const llms = readFileSync(join(dist, 'llms.txt'), 'utf8');
check(['github-action', 'agents', 'jobs'].every((slug) => llms.includes(`${base}/docs/${slug}.md`) && existsSync(join(dist, 'docs', `${slug}.md`))), 'llms.txt lists a Markdown copy of each page, and each copy is built');
check(!readFileSync(join(dist, 'docs', 'jobs.md'), 'utf8').includes('](github-action.md)'), 'the Markdown copies link with full addresses');

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = new URL(req.url());
  if (u.origin === base) {
    const file = join(dist, u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname);
    if (existsSync(file)) return req.respond({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    return req.respond({ status: 404, body: '' });
  }
  // Nothing on these pages may need another site to work.
  return req.abort();
});

try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  check(await page.$eval('header nav', (n) => [...n.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/docs/')), 'the landing page links to the docs');
  // Only the docs pages' own errors count from here: the landing page has its own tests.
  errors.length = 0;

  await page.goto(`${base}/docs/`, { waitUntil: 'networkidle0' });
  check((await page.$$eval('main a[href^="/docs/"]', (as) => as.length)) >= 3, 'the overview links to every page');

  await page.goto(`${base}/docs/github-action/`, { waitUntil: 'networkidle0' });
  check((await page.$eval('article h1', (h) => h.textContent)) === 'Mergelight GitHub Action', 'a page is finished HTML with its title');
  check((await page.$eval('aside [aria-current="page"]', (a) => a.textContent)) === 'GitHub Action', 'the menu marks the open page');
  check((await page.$$('[data-toc]')).length > 3, 'the page has an outline');
  check((await page.$$('.doc-code pre.shiki')).length > 0, 'code is colored');

  // Jump to a section from the outline, and the outline marks it.
  await page.click('[data-toc][href="#inputs"]');
  const marked = await page.waitForFunction(() => document.querySelector('[data-toc][href="#inputs"]')?.hasAttribute('data-active'), { timeout: 5000 }).then(() => true, () => false);
  check(marked, 'the outline marks the section being read');

  // Search, from the keyboard.
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await page.keyboard.up('Control');
  check(await page.$eval('#docs-search', (d) => d.open), 'Ctrl K opens search');
  await page.type('[data-search-input]', 'verify-with');
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  const first = await page.$eval('[role="option"]', (a) => a.getAttribute('href'));
  check(first.startsWith('/docs/github-action/'), `search finds verify-with on the Action's page (${first})`);
  await page.keyboard.press('Enter');
  await wait(500);
  check(!(await page.$eval('#docs-search', (d) => d.open)) && page.url().startsWith(`${base}/docs/github-action/`), 'Enter opens the result');

  await page.keyboard.press('/');
  await page.type('[data-search-input]', 'zzqxyw');
  await page.waitForFunction(() => document.querySelector('[data-search-results]')?.textContent?.includes('Nothing found'), { timeout: 5000 });
  check(true, 'a search with no match says so');
  await page.keyboard.press('Escape');

  // A phone: the menu opens from its button, and no page is wider than the screen.
  await page.setViewport({ width: 390, height: 844 });
  for (const slug of ['', 'github-action/', 'agents/', 'jobs/']) {
    await page.goto(`${base}/docs/${slug}`, { waitUntil: 'networkidle0' });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `/docs/${slug} fits a phone's width`);
  }
  check(await page.$eval('#docs-menu', (n) => n.hidden), 'the phone menu starts closed');
  await page.click('[data-menu]');
  check(!(await page.$eval('#docs-menu', (n) => n.hidden)) && (await page.$eval('[data-menu]', (b) => b.getAttribute('aria-expanded'))) === 'true', 'the menu button opens it');

  check(!errors.length, `no errors in the page${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
