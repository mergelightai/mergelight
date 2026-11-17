// The docs pages are finished HTML; this adds what needs the browser: the phone menu, copying code, marking the open
// section in "On this page", and search. Search reads the index Pagefind writes at build time, so it works without
// a server, and only loads when someone opens it.
import '../index.css';

type Section = { title: string; url: string; excerpt: string; locations?: number[] };
type Found = { url: string; excerpt: string; meta: { title?: string }; sub_results?: Section[] };
type Pagefind = { search(query: string): Promise<{ results: { data(): Promise<Found> }[] }> };

const PAGEFIND = '/pagefind/pagefind.js';
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
for (const key of document.querySelectorAll('[data-shortcut]')) key.textContent = mac ? '⌘K' : 'Ctrl K';

// The phone menu.
const menuButton = document.querySelector<HTMLButtonElement>('[data-menu]');
const menu = document.getElementById('docs-menu');
menuButton?.addEventListener('click', () => {
  if (!menu) return;
  menu.hidden = !menu.hidden;
  menuButton.setAttribute('aria-expanded', String(!menu.hidden));
});

// Copy a code block.
document.addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy]');
  if (!button) return;
  const pre = button.parentElement?.querySelector('pre');
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.innerText.replace(/\n$/, ''));
    button.textContent = 'Copied';
  } catch {
    // No clipboard access here: select the code, so the copy keys work.
    getSelection()?.selectAllChildren(pre);
    button.textContent = mac ? 'Press ⌘C' : 'Press Ctrl C';
  }
  setTimeout(() => (button.textContent = 'Copy'), 1600);
});

// Mark the section being read in "On this page": the last heading that has scrolled past the top bar, or the last
// heading once the page can't scroll further, since a short last section never reaches the top.
const outline = [...document.querySelectorAll<HTMLAnchorElement>('[data-toc]')];
const headings = outline.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))));
function markSection() {
  let current = 0;
  headings.forEach((h, i) => {
    if (h && h.getBoundingClientRect().top < 120) current = i;
  });
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = headings.length - 1;
  outline.forEach((a, i) => a.toggleAttribute('data-active', i === current));
}
if (outline.length) {
  addEventListener('scroll', markSection, { passive: true });
  markSection();
}

// Search.
const dialog = document.getElementById('docs-search') as HTMLDialogElement | null;
const input = document.querySelector<HTMLInputElement>('[data-search-input]');
const list = document.querySelector<HTMLDivElement>('[data-search-results]');
let pagefind: Promise<Pagefind | null> | undefined;
let asked = 0;
// The query the list on screen answers, so Enter never opens a result for an older query.
let shown = '';
let timer: ReturnType<typeof setTimeout> | undefined;

// A load that failed, for example on a dropped connection, is tried again at the next search.
const load = () =>
  (pagefind ??= import(/* @vite-ignore */ PAGEFIND).then(
    (m: Pagefind) => m,
    () => {
      pagefind = undefined;
      return null;
    },
  ));

function openSearch() {
  if (!dialog || dialog.open) return;
  dialog.showModal();
  input?.select();
  void load();
}

function note(text: string) {
  if (!list) return;
  list.replaceChildren();
  const p = document.createElement('p');
  p.className = 'px-3 py-6 text-center text-sm text-faint';
  p.textContent = text;
  list.append(p);
}

function skeleton() {
  if (!list) return;
  list.innerHTML = Array.from({ length: 3 }, () => '<div class="m-1 h-14 animate-pulse rounded-xl bg-white/[0.04]"></div>').join('');
}

function select(option: Element | null) {
  for (const o of list?.querySelectorAll('[role="option"]') ?? []) o.setAttribute('aria-selected', String(o === option));
  option?.scrollIntoView({ block: 'nearest' });
}

async function search(query: string) {
  const ask = ++asked;
  if (!list) return;
  if (!query.trim()) {
    list.replaceChildren();
    shown = query;
    return;
  }
  if (!list.firstElementChild) skeleton();
  const pf = await load();
  if (ask !== asked) return;
  shown = query;
  if (!pf) return note('Search couldn’t load. Check your connection and try again.');
  let pages: Found[];
  try {
    const found = await pf.search(query);
    pages = await Promise.all(found.results.slice(0, 8).map((r) => r.data()));
  } catch {
    if (ask === asked) note('Search couldn’t load. Check your connection and try again.');
    return;
  }
  if (ask !== asked) return;
  if (!pages.length) return note(`Nothing found for “${query.trim()}”.`);
  list.replaceChildren(
    ...pages.map((page) => {
      // Link to the section with the most matches, and name it, unless that is the top of the page.
      const best = [...(page.sub_results ?? [])].sort((x, y) => (y.locations?.length ?? 0) - (x.locations?.length ?? 0))[0];
      const section = best && best.url.includes('#') && best.title !== page.meta.title ? best : undefined;
      const a = document.createElement('a');
      a.href = section?.url ?? page.url;
      a.setAttribute('role', 'option');
      a.setAttribute('aria-selected', 'false');
      a.className = 'block rounded-xl px-3 py-2.5 aria-selected:bg-white/[0.06]';
      const title = document.createElement('span');
      title.className = 'block text-sm font-medium text-fg';
      title.textContent = section ? `${page.meta.title ?? ''} · ${section.title}` : (page.meta.title ?? page.url);
      const excerpt = document.createElement('span');
      excerpt.className = 'mt-0.5 block text-[13px] leading-snug text-faint [&_mark]:bg-transparent [&_mark]:text-lilac';
      // Pagefind escapes the page's text and only adds <mark> around the words that matched.
      excerpt.innerHTML = section?.excerpt ?? page.excerpt;
      a.append(title, excerpt);
      a.addEventListener('mousemove', () => select(a));
      a.addEventListener('click', () => dialog?.close());
      return a;
    }),
  );
  select(list.firstElementChild);
}

input?.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => void search(input.value), 120);
});

input?.addEventListener('keydown', async (event) => {
  // Enter right after typing: search for what is typed now first, then open its best result.
  if (event.key === 'Enter' && input.value !== shown) {
    event.preventDefault();
    clearTimeout(timer);
    await search(input.value);
    list?.querySelector<HTMLAnchorElement>('[role="option"][aria-selected="true"]')?.click();
    return;
  }
  const options = [...(list?.querySelectorAll<HTMLAnchorElement>('[role="option"]') ?? [])];
  const at = options.findIndex((o) => o.getAttribute('aria-selected') === 'true');
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!options.length) return;
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, options.length - 1) : Math.max(at - 1, 0);
    select(options[next]);
  } else if (event.key === 'Enter' && options[at]) {
    event.preventDefault();
    options[at].click();
  }
});

for (const button of document.querySelectorAll('[data-search-open]')) button.addEventListener('click', openSearch);

// A click on the dark area around the box closes it.
dialog?.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
  if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
    event.preventDefault();
    openSearch();
  }
});
