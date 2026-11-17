// The docs pages at /docs/, made from the Markdown files in docs/: their ids, their links, and that every link
// between the pages lands on a page and a heading that exist. The docs change often, so this runs on the real files.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderDocs, llmsTxt } from '../../docgen/build.ts';
import { headingId, ordered, pageHref, rawHref, rawMarkdown, shorten } from '../../docgen/pages.ts';

const DOCS_DIR = new URL('../../../docs/', import.meta.url).pathname;
const files = ['github-action.md', 'agents.md', 'jobs.md'];

test('a heading gets the id GitHub gives it, so links work on GitHub and on the site', () => {
  const seen = new Map();
  assert.equal(headingId('Two AIs: one reviews, the other checks', seen), 'two-ais-one-reviews-the-other-checks');
  assert.equal(headingId('Set it up', seen), 'set-it-up');
  assert.equal(headingId('Set it up', seen), 'set-it-up-1');
  assert.equal(headingId("What's `verify-with`?", new Map()), 'whats-verify-with');
});

test('a link to another doc goes to its page, and any other file of the repository to GitHub', () => {
  assert.equal(pageHref('jobs.md', files), '/docs/jobs/');
  assert.equal(pageHref('github-action.md#two-ais-one-reviews-the-other-checks', files), '/docs/github-action/#two-ais-one-reviews-the-other-checks');
  assert.equal(pageHref('./agents.md', files), '/docs/agents/');
  assert.equal(pageHref('../examples/mergelight.yml', files), 'https://github.com/mergelightai/mergelight/blob/main/examples/mergelight.yml');
  assert.equal(pageHref('../examples', files), 'https://github.com/mergelightai/mergelight/tree/main/examples');
  assert.equal(pageHref('../packages/server/README.md', files), 'https://github.com/mergelightai/mergelight/blob/main/packages/server/README.md');
  assert.equal(pageHref('other.md', files), 'https://github.com/mergelightai/mergelight/blob/main/docs/other.md');
  for (const kept of ['#inputs', 'https://mergelight.dev/setup/', 'mailto:hello@mergelight.dev', '/privacy/']) assert.equal(pageHref(kept, files), kept);
});

test('the Markdown copy for AI tools has only full addresses, and leaves code blocks alone', () => {
  assert.equal(rawHref('jobs.md#write-a-job', files), 'https://mergelight.dev/docs/jobs/#write-a-job');
  assert.equal(rawHref('/setup/', files), 'https://mergelight.dev/setup/');
  const md = 'See [jobs](jobs.md) and [the example](../examples/mergelight.yml).\n\n```md\n[kept](jobs.md)\n```\n';
  assert.equal(
    rawMarkdown(md, files),
    'See [jobs](https://mergelight.dev/docs/jobs/) and [the example](https://github.com/mergelightai/mergelight/blob/main/examples/mergelight.yml).\n\n```md\n[kept](jobs.md)\n```\n',
  );
});

test('the menu keeps its order, and a new doc comes after the listed ones', () => {
  assert.deepEqual(ordered(['zeta.md', 'jobs.md', 'alpha.md', 'github-action.md', 'agents.md']), ['github-action.md', 'agents.md', 'jobs.md', 'alpha.md', 'zeta.md']);
});

test('a long first paragraph is cut at a word', () => {
  assert.equal(shorten('short one'), 'short one');
  const cut = shorten('word '.repeat(60));
  assert.ok(cut.length <= 160 && cut.endsWith('word…'));
});

test('every docs page has a title and a description, and llms.txt lists each Markdown copy', async () => {
  const docs = await renderDocs(DOCS_DIR);
  assert.ok(docs.length >= 3);
  for (const doc of docs) {
    assert.ok(doc.title, `${doc.file} has no # title`);
    assert.ok(doc.description.length > 20, `${doc.file} has no description`);
    assert.ok(!/—|–/.test(doc.description), `${doc.file}: no long dashes in product text`);
  }
  const llms = llmsTxt(docs);
  for (const doc of docs) assert.ok(llms.includes(`https://mergelight.dev/docs/${doc.slug}.md`));
});

test('every link between the docs pages lands on a page and a heading that exist', async () => {
  const docs = await renderDocs(DOCS_DIR);
  const ids = new Map(docs.map((d) => [d.slug, new Set([...d.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  const broken = [];
  for (const doc of docs) {
    for (const [, href] of doc.html.matchAll(/<a href="([^"]+)"/g)) {
      const local = /^\/docs\/([^/#]+)\/(?:#(.+))?$/.exec(href) ?? (href.startsWith('#') ? [href, doc.slug, href.slice(1)] : null);
      if (!local) continue;
      const [, slug, id] = local;
      if (!ids.has(slug)) broken.push(`${doc.file}: ${href} (no such page)`);
      else if (id && !ids.get(slug).has(decodeURIComponent(id))) broken.push(`${doc.file}: ${href} (no such heading)`);
    }
    assert.ok(!/href="[^"]*\.md(#[^"]*)?"/.test(doc.html.replace(/https:\/\/github\.com\/[^"]+/g, '')), `${doc.file} links to a .md file that isn't a page`);
  }
  assert.deepEqual(broken, []);
});

test('raw HTML in a doc shows as text, and code is colored at build time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mergelight-docs-'));
  writeFileSync(join(dir, 'try.md'), '# Try\n\nHello <script>alert(1)</script>.\n\n```bash\nnpx @mergelight/cli init\n```\n');
  const [doc] = await renderDocs(dir);
  assert.ok(!doc.html.includes('<script>'));
  assert.ok(doc.html.includes('&lt;script&gt;'));
  assert.match(doc.html, /<div class="doc-code"><button[^>]*data-copy[^>]*>Copy<\/button><pre class="shiki/);
});
