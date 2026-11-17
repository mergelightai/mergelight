// Builds the docs pages at /docs/ from the Markdown files in the repository's docs/ folder.
// Each page is finished HTML before the browser runs anything, so search engines and AI tools read the whole text.
// The pages are written to site/docs/ (ignored by git) and Vite builds them like the site's other pages.
// Each page also gets a plain Markdown copy at /docs/<page>.md, and /llms.txt lists them for AI tools.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import markdownIt from 'markdown-it';
import type { MarkdownIt, Token } from 'markdown-it';
import { createHighlighter } from 'shiki';
import type { Plugin } from 'vite';
import { EXTRA, GROUPS, REPO, SITE, descriptionFor, groupFor, headingId, labelFor, ordered, pageHref, rawMarkdown, shorten, slugFor } from './pages.ts';
import type { Group } from './pages.ts';

type Heading = { level: 2 | 3; id: string; text: string };
export type Doc = { file: string; slug: string; group: Group; title: string; label: string; description: string; html: string; toc: Heading[]; raw: string };

const THEME = 'github-dark-default';
const LANGS = ['bash', 'json', 'markdown', 'yaml', 'typescript', 'javascript'];
const ALIASES: Record<string, string> = { sh: 'bash', shell: 'bash', zsh: 'bash', md: 'markdown', yml: 'yaml', ts: 'typescript', js: 'javascript' };
const EMAIL = 'hello@mergelight.dev';

let highlighter: ReturnType<typeof createHighlighter> | undefined;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The text a heading or paragraph shows, without its Markdown. */
function plain(inline: Token | undefined): string {
  return (inline?.children ?? [])
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('');
}

async function markdown(): Promise<MarkdownIt> {
  highlighter ??= createHighlighter({ themes: [THEME], langs: LANGS });
  const shiki = await highlighter;
  // Raw HTML in a docs file shows as text: the pages only hold what Markdown makes.
  const md = markdownIt({ html: false, linkify: false, typographer: false });
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const asked = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const lang = ALIASES[asked] ?? asked;
    const code = shiki.codeToHtml(token.content.replace(/\n$/, ''), { lang: LANGS.includes(lang) ? lang : 'text', theme: THEME });
    return `<div class="doc-code"><button type="button" class="doc-copy" data-copy data-pagefind-ignore>Copy</button>${code}</div>\n`;
  };
  // A wide table scrolls on its own, so it never widens the page on a phone.
  md.renderer.rules.table_open = () => '<div class="doc-table"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  return md;
}

/** Reads every Markdown file in `dir` and turns each into a page's article, menu name, outline and plain copy. */
export async function renderDocs(dir: string): Promise<Doc[]> {
  const md = await markdown();
  const files = ordered(readdirSync(dir).filter((f) => f.endsWith('.md')));
  return files.map((file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    const tokens = md.parse(source, {});
    const seen = new Map<string, number>();
    const toc: Heading[] = [];
    let title = '';
    let description = '';
    tokens.forEach((token, i) => {
      if (token.type === 'heading_open') {
        const text = plain(tokens[i + 1]);
        const id = headingId(text, seen);
        token.attrSet('id', id);
        if (token.tag === 'h1' && !title) title = text;
        if (token.tag === 'h2' || token.tag === 'h3') toc.push({ level: token.tag === 'h2' ? 2 : 3, id, text });
      }
      if (token.type === 'paragraph_open' && !description) description = shorten(plain(tokens[i + 1]));
      for (const child of token.children ?? []) {
        const href = child.type === 'link_open' ? child.attrGet('href') : null;
        if (href) child.attrSet('href', pageHref(String(href), files));
      }
    });
    title ||= slugFor(file);
    return {
      file,
      slug: slugFor(file),
      group: groupFor(file),
      title,
      label: labelFor(file, title),
      description: descriptionFor(file, description),
      html: md.renderer.render(tokens, md.options, {}),
      toc,
      raw: rawMarkdown(source, files),
    };
  });
}

const SEARCH_ICON =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="size-4 shrink-0"><circle cx="7" cy="7" r="4.75" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="size-4"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

/** The menu of every docs page, in its groups, with the open one marked. */
function menu(docs: Doc[], current: string): string {
  const item = (href: string, label: string, here: boolean) =>
    `<li><a href="${href}"${here ? ' aria-current="page"' : ''} class="${
      here ? 'block rounded-lg bg-white/[0.06] px-3 py-1.5 text-fg' : 'block rounded-lg px-3 py-1.5 text-muted transition-colors hover:text-fg'
    }">${esc(label)}</a></li>`;
  const groups = GROUPS.map((group) => {
    const items = [
      ...docs.filter((d) => d.group === group).map((d) => item(`/docs/${d.slug}/`, d.label, current === d.slug)),
      ...(EXTRA[group] ?? []).map((l) => item(l.href, l.label, false)),
    ];
    return items.length ? `<p class="mb-1.5 mt-6 px-3 text-xs font-medium text-faint">${esc(group)}</p><ul class="space-y-0.5">${items.join('')}</ul>` : '';
  });
  return `<div class="text-sm"><ul class="space-y-0.5">${item('/docs/', 'Overview', current === '')}</ul>${groups.join('')}</div>`;
}

function outline(toc: Heading[]): string {
  if (toc.length < 2) return '';
  const links = toc
    .map(
      (h) =>
        `<li><a href="#${h.id}" data-toc class="${
          h.level === 3 ? '-ml-px block border-l border-transparent py-0.5 pl-6' : '-ml-px block border-l border-transparent py-0.5 pl-3'
        } text-faint transition-colors hover:text-fg data-active:border-lilac data-active:text-fg">${esc(h.text)}</a></li>`,
    )
    .join('');
  return `<aside class="hidden w-52 shrink-0 xl:block"><nav aria-label="On this page" class="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto py-14"><p class="text-sm font-medium text-fg">On this page</p><ul class="mt-3 space-y-1.5 border-l border-line text-[13px] leading-snug">${links}</ul></nav></aside>`;
}

function page({ title, description, path, docs, current, body, toc = [], markdownCopy }: { title: string; description: string; path: string; docs: Doc[]; current: string; body: string; toc?: Heading[]; markdownCopy?: string }): string {
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
${markdownCopy ? `<link rel="alternate" type="text/markdown" href="${markdownCopy}">\n` : ''}<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/icon-192.png">
<meta name="theme-color" content="#07060d">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
</head>
<body class="bg-ink text-muted">
<header class="sticky top-0 z-30 border-b border-line bg-ink/85 backdrop-blur">
  <div class="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-5 sm:px-8">
    <a href="/" class="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-fg"><img src="/logo.png" alt="" width="24" height="24" class="size-6 rounded-md">Mergelight</a>
    <span aria-hidden="true" class="text-faint">/</span>
    <a href="/docs/" class="text-[15px] font-medium text-muted transition-colors hover:text-fg">Docs</a>
    <div class="flex-1"></div>
    <button type="button" data-search-open aria-label="Search the docs" class="flex h-9 items-center gap-2 rounded-full bg-white/[0.04] px-3 text-sm text-faint shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] transition-colors hover:text-fg sm:w-60 sm:px-3.5">${SEARCH_ICON}<span class="hidden sm:inline">Search the docs</span><kbd data-shortcut class="ml-auto hidden rounded-md px-1.5 py-0.5 font-sans text-xs text-faint shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] sm:inline">Ctrl K</kbd></button>
    <nav aria-label="Mergelight" class="hidden items-center gap-6 pl-3 text-sm text-muted md:flex">
      <a href="/setup/" class="transition-colors hover:text-fg">Set up</a>
      <a href="${REPO}" class="flex items-center gap-1.5 transition-colors hover:text-fg">${GITHUB_ICON}GitHub</a>
    </nav>
    <button type="button" data-menu aria-expanded="false" aria-controls="docs-menu" class="flex h-9 items-center rounded-full px-3 text-sm text-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] transition-colors hover:text-fg lg:hidden">Menu</button>
  </div>
  <nav id="docs-menu" aria-label="Docs" hidden class="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line px-3 py-4 sm:px-6 lg:hidden">${menu(docs, current)}
    <ul class="mt-4 space-y-0.5 border-t border-line pt-4 text-sm md:hidden"><li><a href="/setup/" class="block rounded-lg px-3 py-1.5 text-muted transition-colors hover:text-fg">Set up</a></li><li><a href="${REPO}" class="block rounded-lg px-3 py-1.5 text-muted transition-colors hover:text-fg">GitHub</a></li></ul>
  </nav>
</header>
<div class="mx-auto flex w-full max-w-7xl gap-10 px-5 sm:px-8">
  <aside class="hidden w-56 shrink-0 lg:block"><nav aria-label="Docs" class="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto py-12">${menu(docs, current)}</nav></aside>
  <main class="min-w-0 flex-1 pb-24 pt-10 sm:pt-14">
${body}
  </main>
${outline(toc)}
</div>
<footer class="border-t border-line/70 py-10 text-sm text-faint">
  <div class="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-4 px-5 sm:flex-row sm:px-8">
    <div class="flex items-center gap-2.5"><img src="/logo.png" alt="" width="20" height="20" class="size-5 rounded-[5px]"><span>&copy; 2026 Mergelight</span></div>
    <div class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2"><a href="/docs/" class="transition-colors hover:text-fg">Docs</a><a href="${REPO}" class="transition-colors hover:text-fg">GitHub</a><a href="/privacy/" class="transition-colors hover:text-fg">Privacy</a><a href="/terms/" class="transition-colors hover:text-fg">Terms</a><a href="/refunds/" class="transition-colors hover:text-fg">Refunds</a><a href="mailto:${EMAIL}" class="transition-colors hover:text-fg">${EMAIL}</a></div>
  </div>
</footer>
<dialog id="docs-search" aria-label="Search the docs" class="mx-auto mb-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl bg-panel-2 text-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08),0_32px_64px_-24px_rgb(0_0_0/0.9)] backdrop:bg-black/60 backdrop:backdrop-blur-sm">
  <div class="flex items-center gap-3 border-b border-line px-4 text-faint">${SEARCH_ICON}<input type="search" data-search-input placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false" class="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"><kbd class="rounded-md px-1.5 py-0.5 font-sans text-xs shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">Esc</kbd></div>
  <div data-search-results role="listbox" aria-label="Results" class="max-h-[60vh] overflow-y-auto p-2 empty:hidden"></div>
</dialog>
<script type="module" src="/src/docs/main.ts"></script>
</body>
</html>
`;
}

function docPage(doc: Doc, docs: Doc[]): string {
  const i = docs.indexOf(doc);
  const before = docs[i - 1];
  const after = docs[i + 1];
  const card = (d: Doc, side: 'Previous' | 'Next') =>
    `<a href="/docs/${d.slug}/" class="${
      side === 'Next' ? 'sm:col-start-2 sm:text-right' : ''
    } rounded-2xl bg-white/[0.03] p-4 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-colors hover:bg-white/[0.05]"><span class="block text-xs text-faint">${side}</span><span class="mt-1 block font-medium text-fg">${esc(d.label)}</span></a>`;
  const body = `    <article class="doc mx-auto max-w-3xl" data-pagefind-body>
${doc.html}    </article>
    <div class="mx-auto mt-16 flex max-w-3xl flex-wrap gap-x-6 gap-y-2 border-t border-line pt-6 text-sm text-faint">
      <a href="${REPO}/blob/main/docs/${doc.file}" class="transition-colors hover:text-fg">Edit this page on GitHub</a>
      <a href="/docs/${doc.slug}.md" class="transition-colors hover:text-fg">View as Markdown</a>
    </div>
    ${before || after ? `<nav aria-label="More docs" class="mx-auto mt-8 grid max-w-3xl gap-3 sm:grid-cols-2">${before ? card(before, 'Previous') : ''}${after ? card(after, 'Next') : ''}</nav>` : ''}`;
  return page({
    title: `${doc.title} · Mergelight docs`,
    description: doc.description,
    path: `/docs/${doc.slug}/`,
    docs,
    current: doc.slug,
    body,
    toc: doc.toc,
    markdownCopy: `/docs/${doc.slug}.md`,
  });
}

const INTRO = 'What Mergelight is, how to set it up, what each review does, how your team shapes what it reports, and how your code and data stay safe.';

function overviewPage(docs: Doc[]): string {
  const card = (d: Doc) =>
    `<a href="/docs/${d.slug}/" class="rounded-2xl bg-white/[0.03] p-5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-colors hover:bg-white/[0.05]"><span class="block font-medium text-fg">${esc(d.label)}</span><span class="mt-2 block text-sm leading-relaxed text-muted">${esc(d.description)}</span></a>`;
  const sections = GROUPS.map((group) => {
    const inGroup = docs.filter((d) => d.group === group);
    if (!inGroup.length) return '';
    return `      <h2 class="mt-12 text-sm font-medium text-faint">${esc(group)}</h2>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">${inGroup.map(card).join('')}</div>`;
  }).join('\n');
  const start = docs.find((d) => d.slug === 'quickstart');
  const body = `    <div class="mx-auto max-w-3xl">
      <h1 class="text-3xl font-semibold tracking-[-0.03em] text-fg sm:text-4xl">Mergelight docs</h1>
      <p class="mt-5 text-lg leading-relaxed">${INTRO}</p>
      ${
        start
          ? `<a href="/docs/${start.slug}/" class="mt-8 inline-flex items-center rounded-full bg-fg px-5 py-2.5 text-[15px] font-medium text-ink transition-colors hover:bg-white">Get started</a>`
          : `<a href="/setup/" class="mt-8 inline-flex items-center rounded-full bg-fg px-5 py-2.5 text-[15px] font-medium text-ink transition-colors hover:bg-white">Set up Mergelight</a>`
      }
${sections}
      <p class="mt-12 text-sm text-faint">Every page is also plain Markdown for your AI tools: add .md to its address, or start from <a href="/llms.txt" class="text-muted underline decoration-line underline-offset-4 hover:decoration-fg">llms.txt</a>.</p>
    </div>`;
  return page({ title: 'Docs · Mergelight', description: INTRO, path: '/docs/', docs, current: '', body });
}

/** The list of docs for AI tools, as llmstxt.org describes it: a title, a summary, then a link to each page's Markdown. */
export function llmsTxt(docs: Doc[]): string {
  const lines = docs.map((d) => `- [${d.title}](${SITE}/docs/${d.slug}.md): ${d.description}`);
  return `# Mergelight\n\n> Mergelight reviews every pull request with your own Claude or ChatGPT subscription, in your own GitHub Actions.\n\n## Docs\n\n${lines.join('\n')}\n`;
}

/**
 * Writes the overview and one page per doc to `<root>/docs/`, after removing what an earlier run wrote there, and
 * returns them as Vite's build inputs. `root` is the site's folder; the docs are read from the folder next to it.
 */
export async function writeDocs(root: string): Promise<Record<string, string>> {
  const docs = await renderDocs(join(root, '..', 'docs'));
  const out = join(root, 'docs');
  rmSync(out, { recursive: true, force: true });
  const inputs: Record<string, string> = {};
  const write = (name: string, dir: string, html: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html);
    inputs[name] = join(dir, 'index.html');
  };
  write('docs', out, overviewPage(docs));
  for (const doc of docs) write(`docs-${doc.slug}`, join(out, doc.slug), docPage(doc, docs));
  return inputs;
}

/** Adds the plain Markdown copies and llms.txt to the build, and rebuilds the pages when a doc changes during `npm run dev`. */
export function docsPlugin(root: string): Plugin {
  const dir = join(root, '..', 'docs');
  return {
    name: 'mergelight-docs',
    configureServer(server) {
      server.watcher.add(dir);
      const rebuild = async (file: string) => {
        if (!file.startsWith(dir) || !file.endsWith('.md')) return;
        await writeDocs(root);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('change', rebuild);
      server.watcher.on('add', rebuild);
      server.watcher.on('unlink', rebuild);
    },
    async generateBundle() {
      const docs = await renderDocs(dir);
      for (const doc of docs) this.emitFile({ type: 'asset', fileName: `docs/${doc.slug}.md`, source: doc.raw });
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: llmsTxt(docs) });
    },
  };
}
