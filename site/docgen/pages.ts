// Which docs pages the site has, in what order, and how a link in a docs file becomes a link on the site.
// Plain Node: no imports and only erasable types, so the unit tests load it as it is.

export const SITE = 'https://mergelight.dev';
export const REPO = 'https://github.com/mergelightai/mergelight';

/** The menu's groups, in order. A doc that isn't in ORDER goes in More, which only shows when it has one. */
export const GROUPS = ['Get started', 'Use it', 'Reference', 'Security', 'More'] as const;
export type Group = (typeof GROUPS)[number];

/**
 * The docs in the menu's order, each in a group, with a short name for the menu and a one-line description for
 * search engines, the overview and llms.txt. A file in docs/ that isn't listed comes last, described by its first paragraph.
 */
export const ORDER: { file: string; group: Group; label: string; description?: string }[] = [
  {
    file: 'introduction.md',
    group: 'Get started',
    label: 'What is Mergelight',
    description: 'An AI code reviewer for GitHub pull requests that runs in your own GitHub Actions, on the Claude or ChatGPT plan you already pay for.',
  },
  {
    file: 'quickstart.md',
    group: 'Get started',
    label: 'Get started',
    description: 'Turn on Mergelight for one repository and see its first review, on the setup page or from a terminal.',
  },
  {
    file: 'how-it-works.md',
    group: 'Get started',
    label: 'How a review works',
    description: 'What happens in a review, what the summary, the comments and the check mean, and how to answer a finding.',
  },
  {
    file: 'customize.md',
    group: 'Use it',
    label: "Your team's rules",
    description: 'Teach reviews what your team cares about with rule files, dashboard rules, skills, custom checks and team memory.',
  },
  {
    file: 'agents.md',
    group: 'Use it',
    label: 'Your coding agent',
    description: 'Let Claude Code, Codex or Cursor read the findings on a pull request and fix them with your own tests and rules.',
  },
  {
    file: 'jobs.md',
    group: 'Use it',
    label: 'Jobs',
    description: 'Tasks your team writes once in its repository. On each pull request that needs one, the AI does it and Mergelight pushes one commit.',
  },
  {
    file: 'github-action.md',
    group: 'Reference',
    label: 'GitHub Action',
    description: 'What each review posts, which AI login to use, how to set it up, and every option of the Action.',
  },
  {
    file: 'security.md',
    group: 'Security',
    label: 'Security and data',
    description: 'Where your code goes, what the AI can and can\'t do during a review, what reaches Mergelight, and the limits.',
  },
];

/** Links in the menu that aren't docs pages, by group. */
export const EXTRA: Partial<Record<Group, { href: string; label: string }[]>> = {
  Security: [{ href: '/privacy/', label: 'Privacy policy' }],
};

export function groupFor(file: string): Group {
  return ORDER.find((o) => o.file === file)?.group ?? GROUPS[GROUPS.length - 1];
}

export function slugFor(file: string): string {
  return file.replace(/\.md$/, '');
}

export function labelFor(file: string, title: string): string {
  return ORDER.find((o) => o.file === file)?.label ?? title;
}

export function descriptionFor(file: string, firstParagraph: string): string {
  return ORDER.find((o) => o.file === file)?.description ?? firstParagraph;
}

/** The files in the menu's order: the listed ones first, then the rest by name. */
export function ordered(files: string[]): string[] {
  const listed = ORDER.map((o) => o.file).filter((f) => files.includes(f));
  const rest = files.filter((f) => !listed.includes(f)).sort();
  return [...listed, ...rest];
}

/**
 * The id GitHub gives a heading, so a link like `github-action.md#two-ais-one-reviews-the-other-checks` works on
 * GitHub and on the site alike: lower case, punctuation dropped, each space a dash. `seen` numbers a repeat, as GitHub does.
 */
export function headingId(text: string, seen: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** A path from docs/ to another file in the repository, like `../examples/mergelight.yml`, as a path from the root. */
function repoPath(href: string): string | null {
  const parts: string[] = ['docs'];
  for (const part of href.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function isAbsolute(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#');
}

function split(href: string): [string, string] {
  const i = href.indexOf('#');
  return i === -1 ? [href, ''] : [href.slice(0, i), href.slice(i)];
}

/** Where a file of the repository opens on GitHub: a folder as a tree, a file as a blob. */
function onGitHub(path: string, hash: string): string {
  const last = path.split('/').pop() ?? '';
  return `${REPO}/${last.includes('.') ? 'blob' : 'tree'}/main/${path}${hash}`;
}

/**
 * A link in a docs file as a link on the site's docs pages: another doc becomes its page, any other file of the
 * repository its page on GitHub, and a full address or an anchor stays as it is.
 */
export function pageHref(href: string, docs: string[]): string {
  if (isAbsolute(href)) return href;
  const [path, hash] = split(href);
  const target = repoPath(path);
  if (target === null) return href;
  const file = target.startsWith('docs/') ? target.slice('docs/'.length) : '';
  if (docs.includes(file)) return `/docs/${slugFor(file)}/${hash}`;
  return onGitHub(target, hash);
}

/** The same link for the plain Markdown copy of a page, where every link has to work on its own: always a full address. */
export function rawHref(href: string, docs: string[]): string {
  if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith('/')) return `${SITE}${href}`;
  const [path, hash] = split(href);
  const target = repoPath(path);
  if (target === null) return href;
  const file = target.startsWith('docs/') ? target.slice('docs/'.length) : '';
  if (docs.includes(file)) return `${SITE}/docs/${slugFor(file)}/${hash}`;
  return onGitHub(target, hash);
}

/** A Markdown file with every relative link made a full address, for the copy that AI tools read. */
export function rawMarkdown(markdown: string, docs: string[]): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/\]\(([^)\s]+)\)/g, (_, href: string) => `](${rawHref(href, docs)})`);
    })
    .join('\n');
}

/** The first sentence or two of a page, cut at a word, for the search engines' description and the overview's cards. */
export function shorten(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.]$/, '')}…`;
}
