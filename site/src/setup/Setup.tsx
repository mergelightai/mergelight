import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import approveFile from '../../../examples/mergelight-approve.yml?raw';
import refreshFile from '../../../examples/mergelight-refresh.yml?raw';
import workflowFile from '../../../examples/mergelight.yml?raw';
import { GITHUB } from '../links';
import Ambient from '../sections/Ambient';
import { Check, GitHubIcon, SURFACE, WELL } from '../ui';

const INSTALL_URL = 'https://github.com/apps/mergelight-ai/installations/new';
const CODEX_AUTH_DOCS = 'https://developers.openai.com/codex/auth';
const SKIP_MARKER = 'github.event.pull_request.head.repo.full_name == github.repository';

/** Accepts owner/repo or a pasted GitHub link. */
export function parseRepo(text: string): string | null {
  const repo = text
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

function withSkippedBranches(content: string, skip: string): string {
  const branches = skip.split(',').map((b) => b.trim()).filter(Boolean);
  if (!branches.length) return content;
  return content.replace(SKIP_MARKER, `${SKIP_MARKER} &&\n      !contains(fromJSON('${JSON.stringify(branches)}'), github.head_ref)`);
}

/** GitHub's own editor, already filled in. Nothing is written until the person commits it there. */
function newFileUrl(repo: string, branch: string, name: string, content: string): string {
  const path = branch.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/new/${path}?filename=.github/workflows/${name}&value=${encodeURIComponent(content)}`;
}

function remembered(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private window: it just won't be remembered. */
  }
}

const PRIMARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-fg px-5 text-sm font-medium text-ink transition-[background-color,transform] duration-150 hover:bg-white active:scale-[0.97]';
const DISABLED = 'pointer-events-none opacity-40';
const QUIET = 'text-sm text-muted underline-offset-4 transition-colors hover:text-fg hover:underline';
const FIELD =
  'h-11 w-full rounded-xl bg-black/30 px-3.5 font-mono text-[13px] text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] outline-none transition-shadow placeholder:text-faint focus:shadow-[inset_0_0_0_1.5px_var(--color-lilac)]';

type Mode = 'chatgpt' | 'apikey';

export default function Setup() {
  const cameBackFromInstall = useMemo(() => new URLSearchParams(window.location.search).has('installation_id'), []);
  const [step, setStep] = useState(cameBackFromInstall ? 1 : 0);
  const [repoText, setRepoText] = useState(() => remembered('mergelight.setup.repo', ''));
  const [branch, setBranch] = useState(() => remembered('mergelight.setup.branch', 'main'));
  const [skip, setSkip] = useState('');
  const [opened, setOpened] = useState(false);
  const [mode, setMode] = useState<Mode>('chatgpt');

  const repo = parseRepo(repoText);
  const workflow = useMemo(() => withSkippedBranches(workflowFile, skip), [skip]);

  useEffect(() => remember('mergelight.setup.repo', repoText), [repoText]);
  useEffect(() => remember('mergelight.setup.branch', branch), [branch]);

  const pulls = repo ? `https://github.com/${repo}/pulls` : '#';

  return (
    <div className="relative min-h-screen overflow-x-clip">
      <Ambient />
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
          <img src="/logo.png" alt="" width={28} height={28} className="size-7 rounded-[7px]" />
          Mergelight
        </a>
        <a href={GITHUB} className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg">
          <GitHubIcon /> GitHub
        </a>
      </header>

      <main className="mx-auto grid max-w-6xl gap-10 px-4 pb-24 pt-8 sm:px-8 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16">
        <div>
          <h1 className="text-4xl font-semibold tracking-[-0.035em] [text-wrap:balance] sm:text-5xl">Turn on Mergelight</h1>
          <p className="mt-4 text-lg text-muted">Three steps, all in your browser. Nothing to install on your machine.</p>

          <ol className="mt-10">
            <Step n={1} title="Install the app on GitHub" current={step} onOpen={setStep}>
              <p className="text-muted">Pick the repos you want reviewed. You'll come straight back here.</p>
              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
                <a href={INSTALL_URL} className={PRIMARY}>
                  <GitHubIcon /> Install on GitHub
                </a>
                <button type="button" className={QUIET} onClick={() => setStep(1)}>
                  It's already installed
                </button>
              </div>
            </Step>

            <Step n={2} title="Add the review workflow" current={step} onOpen={setStep}>
              <p className="text-muted">GitHub opens with the file already filled in. You only commit it.</p>
              <label className="mt-5 block">
                <span className="text-[13px] font-medium text-muted">Repository</span>
                <input
                  className={`${FIELD} mt-1.5`}
                  placeholder="owner/repo"
                  value={repoText}
                  onChange={(e) => setRepoText(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {repoText.trim() !== '' && !repo && <p className="mt-2 text-[13px] text-risk">Use owner/repo, or paste the repo's link.</p>}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[13px] font-medium text-muted">Branch most PRs go to</span>
                  <input className={`${FIELD} mt-1.5`} value={branch} onChange={(e) => setBranch(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium text-muted">Skip PRs from (optional)</span>
                  <input className={`${FIELD} mt-1.5`} placeholder="staging, main" value={skip} onChange={(e) => setSkip(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
                <a
                  href={repo ? newFileUrl(repo, branch.trim() || 'main', 'mergelight.yml', workflow) : undefined}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={!repo}
                  className={`${PRIMARY} ${repo ? '' : DISABLED}`}
                  onClick={() => setOpened(true)}
                >
                  Open it in GitHub
                </a>
                {opened && (
                  <button type="button" className={QUIET} onClick={() => setStep(2)}>
                    I've committed it
                  </button>
                )}
              </div>
              <p className="mt-4 text-[13px] leading-relaxed text-muted">
                When you commit, choose <span className="text-fg">Create a new branch</span> and open the pull request. It reviews itself, so you see it working before you merge.
              </p>

              {repo && (
                <details className="mt-4 text-[13px] text-muted">
                  <summary className="cursor-pointer select-none transition-colors hover:text-fg">Two optional files</summary>
                  <ul className="mt-2.5 space-y-2">
                    <li>
                      <a className="text-fg underline underline-offset-4" target="_blank" rel="noreferrer" href={newFileUrl(repo, branch.trim() || 'main', 'mergelight-approve.yml', approveFile)}>
                        Approvals
                      </a>{' '}
                      turn a yellow check green when someone approves. For teams.
                    </li>
                    <li>
                      <a className="text-fg underline underline-offset-4" target="_blank" rel="noreferrer" href={newFileUrl(repo, branch.trim() || 'main', 'mergelight-refresh.yml', refreshFile)}>
                        Keep the login fresh
                      </a>{' '}
                      if your repo goes quiet for weeks. Goes on your default branch.
                    </li>
                  </ul>
                </details>
              )}
            </Step>

            <Step n={3} title="Connect your AI" current={step} onOpen={setStep}>
              <div role="tablist" aria-label="How to connect" className="inline-flex rounded-full bg-black/30 p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
                {(
                  [
                    ['chatgpt', 'ChatGPT plan'],
                    ['apikey', 'OpenAI API key'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={mode === value}
                    onClick={() => setMode(value)}
                    className={`h-9 rounded-full px-4 text-[13px] font-medium transition-colors ${mode === value ? 'bg-white/[0.12] text-fg' : 'text-muted hover:text-fg'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {mode === 'chatgpt' ? (
                <div className="mt-5">
                  <p className="text-muted">Open your pull request. Mergelight posts a link and a code there. Enter the code, and the review starts.</p>
                  <p className="mt-3 text-[13px] leading-relaxed text-muted">
                    <span className="text-fg">First:</span> turn on device code login in your ChatGPT security settings. It's in beta, and workspace admins turn it on for their team.{' '}
                    <a className="underline underline-offset-4 hover:text-fg" target="_blank" rel="noreferrer" href={CODEX_AUTH_DOCS}>
                      OpenAI's guide
                    </a>
                  </p>
                  <p className="mt-2 text-[13px] text-faint">Private repos only, by OpenAI's rules.</p>
                  <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
                    <a href={pulls} target="_blank" rel="noreferrer" className={`${PRIMARY} ${repo ? '' : DISABLED}`}>
                      Open my pull requests
                    </a>
                    <button type="button" className={QUIET} onClick={() => setStep(3)}>
                      I'm connected
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-5">
                  <p className="text-muted">
                    Paste your key into GitHub and name it <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[13px] text-fg">OPENAI_API_KEY</code>. It stays in your repo.
                  </p>
                  <p className="mt-3 text-[13px] leading-relaxed text-muted">OpenAI bills it per use instead of your ChatGPT plan. It also works on public repos.</p>
                  <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
                    <a href={repo ? `https://github.com/${repo}/settings/secrets/actions/new` : undefined} target="_blank" rel="noreferrer" className={`${PRIMARY} ${repo ? '' : DISABLED}`}>
                      Add the key in GitHub
                    </a>
                    <button type="button" className={QUIET} onClick={() => setStep(3)}>
                      I've added it
                    </button>
                  </div>
                </div>
              )}
            </Step>

            <Orb lit={step >= 3}>
              {step >= 3 ? (
                <div>
                  <p className="text-lg font-medium text-fg">You're set.</p>
                  <p className="mt-1 text-muted">Merge the workflow, and every new pull request gets a review.</p>
                  <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
                    <a href={pulls} target="_blank" rel="noreferrer" className={`${PRIMARY} ${repo ? '' : DISABLED}`}>
                      See it on GitHub
                    </a>
                    <button
                      type="button"
                      className={QUIET}
                      onClick={() => {
                        setRepoText('');
                        setOpened(false);
                        setStep(0);
                      }}
                    >
                      Set up another repo
                    </button>
                  </div>
                </div>
              ) : (
                <p className="pt-1 text-faint">Reviews start here.</p>
              )}
            </Orb>
          </ol>
        </div>

        <div className="lg:sticky lg:top-8 lg:self-start">
          <p className="mb-3 text-[13px] text-faint">What you'll see on GitHub</p>
          <Preview step={step} mode={mode} workflow={workflow} />
          <p className="mt-4 text-[13px] leading-relaxed text-faint">Your login stays in your repo's secrets, and reviews run on your own GitHub Actions. Nothing goes through Mergelight.</p>
        </div>
      </main>
    </div>
  );
}

/** One stop on the merge rail. The lit part of the rail shows how far along you are. */
function Step({ n, title, current, onOpen, children }: { n: number; title: string; current: number; onOpen: (step: number) => void; children: ReactNode }) {
  const index = n - 1;
  const done = current > index;
  const active = current === index;
  return (
    <li className="relative pb-9 pl-11" aria-current={active ? 'step' : undefined}>
      <span aria-hidden="true" className={`absolute bottom-0 left-[13px] top-7 w-0.5 transition-colors duration-300 ${done ? 'bg-gradient-to-b from-lilac to-mint' : 'bg-white/[0.08]'}`} />
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0 grid size-7 place-items-center rounded-full text-[13px] font-semibold tabular-nums transition-colors duration-300 ${
          done ? 'bg-mint text-ink' : active ? 'bg-fg text-ink' : 'bg-white/[0.06] text-faint'
        }`}
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      {done ? (
        <button type="button" onClick={() => onOpen(index)} className="pt-0.5 text-left text-[17px] font-medium text-muted transition-colors hover:text-fg">
          {title}
        </button>
      ) : (
        <h2 className={`pt-0.5 text-[17px] font-medium ${active ? 'text-fg' : 'text-faint'}`}>{title}</h2>
      )}
      {active && <div className="mt-3">{children}</div>}
    </li>
  );
}

/** The end of the rail: the mint orb from the logo, lit once everything's connected. */
function Orb({ lit, children }: { lit: boolean; children: ReactNode }) {
  return (
    <li className="relative pl-11">
      <span
        aria-hidden="true"
        className={`absolute left-[3px] top-0.5 size-[22px] rounded-full transition-all duration-500 ${lit ? 'bg-mint shadow-[0_0_28px_6px_rgb(63_232_184/0.45)]' : 'bg-white/[0.06]'}`}
      />
      {children}
    </li>
  );
}

function Preview({ step, mode, workflow }: { step: number; mode: Mode; workflow: string }) {
  const reduce = useReducedMotion();
  const key = step === 2 ? `2-${mode}` : String(step);
  return (
    <div aria-hidden="true" className={`${SURFACE} overflow-hidden`}>
      <div className="flex h-10 items-center gap-2 border-b border-line px-4">
        <GitHubIcon className="size-4 text-faint" />
        <span className="truncate font-mono text-xs text-faint">{['github.com/apps/mergelight-ai', '.github/workflows/mergelight.yml', mode === 'chatgpt' ? 'Add order discounts #128' : 'Settings / Secrets / Actions', 'Add order discounts #128'][Math.min(step, 3)]}</span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={key} initial={{ opacity: 0, y: reduce ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }} className="p-5">
          {step === 0 && <InstallMock />}
          {step === 1 && <EditorMock workflow={workflow} />}
          {step === 2 && (mode === 'chatgpt' ? <ConnectMock /> : <SecretMock />)}
          {step >= 3 && <ReviewMock />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Bot({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <img src="/logo.png" alt="" width={32} height={32} className="size-8 shrink-0 rounded-md" />
      <div className={`${WELL} min-w-0 flex-1 p-4`}>
        <p className="mb-2.5 text-[13px]">
          <span className="font-semibold text-fg">mergelight-ai</span> <span className="rounded-full px-1.5 text-[11px] text-faint shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]">bot</span>
        </p>
        {children}
      </div>
    </div>
  );
}

function CheckRow({ state, text }: { state: 'waiting' | 'blocked'; text: string }) {
  return (
    <div className={`${WELL} mt-3 flex items-center gap-2.5 px-4 py-3 text-[13px]`}>
      {state === 'waiting' ? <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-risk" /> : <span className="size-2.5 shrink-0 rounded-full bg-bug" />}
      <span className="font-medium text-fg">Mergelight</span>
      <span className="truncate text-muted">{text}</span>
    </div>
  );
}

function InstallMock() {
  const rows: [string, string][] = [
    ['Read', 'code and metadata'],
    ['Write', 'comments and checks on pull requests'],
    ['Write', "secrets, to save your login. It can't read them"],
  ];
  return (
    <div>
      <div className="flex items-center gap-3">
        <img src="/logo.png" alt="" width={44} height={44} className="size-11 rounded-[10px]" />
        <div>
          <p className="font-semibold text-fg">Install Mergelight AI</p>
          <p className="text-[13px] text-muted">Only on the repos you pick</p>
        </div>
      </div>
      <ul className={`${WELL} mt-4 divide-y divide-white/[0.06]`}>
        {rows.map(([level, what]) => (
          <li key={what} className="flex gap-3 px-4 py-3 text-[13px]">
            <span className="w-10 shrink-0 font-medium text-fg">{level}</span>
            <span className="text-muted">{what}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[13px] text-muted">It can't push code.</p>
      <span className="mt-4 inline-flex h-9 items-center rounded-md bg-[#238636] px-4 text-[13px] font-medium text-white">Install</span>
    </div>
  );
}

function EditorMock({ workflow }: { workflow: string }) {
  return (
    <div>
      <pre className={`${WELL} max-h-[340px] overflow-auto p-4 font-mono text-[12px] leading-[1.65] text-muted`}>
        {workflow
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n')
          .trim()
          .split('\n')
          .map((line, i) => (
            <div key={i} className={line.includes('uses:') ? 'text-mint' : ''}>
              {line || ' '}
            </div>
          ))}
      </pre>
      <div className="mt-4 flex justify-end">
        <span className="inline-flex h-9 items-center rounded-md bg-[#238636] px-4 text-[13px] font-medium text-white">Commit changes</span>
      </div>
    </div>
  );
}

function ConnectMock() {
  return (
    <div>
      <Bot>
        <p className="text-[15px] font-semibold text-fg">🔌 Connect ChatGPT to start reviewing</p>
        <ol className="mt-2.5 space-y-1.5 text-[13px] text-muted">
          <li>
            1. Open <span className="text-lilac">auth.openai.com/codex/device</span>
          </li>
          <li>
            2. Enter this code: <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-fg">ABCD-1234E</code>
          </li>
        </ol>
        <p className="mt-2.5 text-[13px] text-faint">The review starts by itself once you're connected.</p>
      </Bot>
      <CheckRow state="waiting" text="Waiting for you to connect ChatGPT" />
    </div>
  );
}

function SecretMock() {
  return (
    <div>
      <p className="text-[15px] font-semibold text-fg">New repository secret</p>
      <p className="mt-4 text-[13px] font-medium text-muted">Name</p>
      <div className={`${WELL} mt-1.5 px-3.5 py-2.5 font-mono text-[13px] text-fg`}>OPENAI_API_KEY</div>
      <p className="mt-3 text-[13px] font-medium text-muted">Secret</p>
      <div className={`${WELL} mt-1.5 px-3.5 py-2.5 font-mono text-[13px] tracking-widest text-faint`}>••••••••••••••••••••</div>
      <span className="mt-4 inline-flex h-9 items-center rounded-md bg-[#238636] px-4 text-[13px] font-medium text-white">Add secret</span>
    </div>
  );
}

function ReviewMock() {
  return (
    <div>
      <Bot>
        <p className="text-[15px] font-semibold text-fg">🔴 Mergelight: Blocked</p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">It's unsafe to merge because ordinary discount calculations return the wrong amount.</p>
        <p className="mt-3 text-[13px] font-medium text-fg">1 bug, 1 risk to fix</p>
        <ul className="mt-1.5 space-y-1.5 text-[13px] text-muted">
          <li>🔴 Percentage discounts subtract 100 times too much</li>
          <li>🟡 Negative discounts are accepted as surcharges</li>
        </ul>
        <p className="mt-3 text-[13px] text-faint">Left alone on purpose: 2 small things not worth fixing</p>
      </Bot>
      <CheckRow state="blocked" text="1 bug to fix before merging" />
    </div>
  );
}
