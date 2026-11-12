import type { ReactNode } from 'react';
import Footer from '../sections/Footer';
import { EMAIL, GITHUB } from '../links';

// Every sentence here must stay true to the code. When a change touches what the token server,
// the server, the Action or the pages send or keep, change this page in the same pull request.
const UPDATED = 'November 12, 2026';

type Section = { id: string; title: string; body: ReactNode };

const mail = <a href={`mailto:${EMAIL}`} className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg">{EMAIL}</a>;

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-4 space-y-2.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden="true" className="mt-[0.7em] size-1 shrink-0 rounded-full bg-faint" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mt-4">{children}</p>;
}

const SECTIONS: Section[] = [
  {
    id: 'who',
    title: 'Who we are',
    body: (
      <>
        <P>Mergelight decides how the data on this page is used. Under the EU's General Data Protection Regulation (GDPR), that makes Mergelight the data controller.</P>
        <P>Write to {mail} with any question about this page or your data.</P>
      </>
    ),
  },
  {
    id: 'short',
    title: 'The short version',
    body: (
      <List
        items={[
          'Your code, your diffs and your AI login never reach Mergelight.',
          'Reviews run in your own GitHub Actions runner, and talk to OpenAI or Anthropic directly, under your own account.',
          'This website has no analytics, no ads and no tracking.',
          'We only keep data for an organization that uses the Mergelight dashboard. The list of what we keep is below.',
          'We never sell data, and we never use it to train AI.',
        ]}
      />
    ),
  },
  {
    id: 'never',
    title: 'What never reaches us',
    body: (
      <List
        items={[
          'Your source code and your diffs.',
          'Your Claude or ChatGPT login, and every other secret in your repository.',
          <>The titles and text of your pull requests, and what the AI writes about your code. The one exception is a finding your team declines with a reason, when your organization uses the dashboard (see <a href="#dashboard" className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg">The dashboard</a>).</>,
        ]}
      />
    ),
  },
  {
    id: 'action',
    title: 'Reviews in GitHub Actions',
    body: (
      <>
        <List
          items={[
            'The Mergelight Action runs in your own GitHub Actions runner. There, Codex or Claude Code sends your code to OpenAI or Anthropic under your account and their terms. We are not part of that.',
            <>So that reviews can post as the Mergelight AI app, each run asks our token server for a GitHub token. To prove where it runs, the run sends a pass that GitHub signs (an OIDC token). The pass names the repository, its owner, the GitHub account that started the run, the branch, the workflow and the run.</>,
            'The token server checks the pass, asks GitHub for a short-lived token for that one repository, and sends it back to the run. It keeps nothing: it has no database and writes no files, its logs hold only the names of errors, and it does not read IP addresses.',
            'To keep your AI login fresh, the run saves it to your own repository secrets. The login goes from your runner to GitHub, never to us.',
            'After you connect a ChatGPT login, the Action posts part of the account\'s email address on the pull request, so your team can see whose plan pays for reviews. That comment lives on GitHub, not with us.',
            <>When your organization uses the dashboard, the Action's <code className="font-mono text-[0.92em] text-fg">server</code> input is set. Then each run also sends a pass that GitHub signs to our dashboard server, with the review's numbers and the findings your team declined (see <a href="#dashboard" className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg">The dashboard</a>).</>,
            <>You can leave us out: set the Action's <code className="font-mono text-[0.92em] text-fg">token-server</code> and <code className="font-mono text-[0.92em] text-fg">server</code> inputs to empty. The run then posts as github-actions[bot], and nothing at all reaches us.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'setup',
    title: 'The setup page',
    body: (
      <List
        items={[
          'You sign in with GitHub. Your browser sends GitHub\'s sign-in code to our token server, which trades it for your GitHub token and hands that back to your browser. The token server does not keep it.',
          'To check if the Mergelight AI app is on the repository you picked, the page sends your GitHub token and the repository\'s name to our token server. It asks GitHub, answers, and keeps neither.',
          'Your browser then talks to GitHub directly to add the workflow file and open the pull request. Your GitHub token stays in the page\'s memory, and is gone when you close the tab.',
          'The page keeps the repository you picked and the sign-in state in your browser\'s session storage. The browser deletes it when you close the tab.',
          'When you sign in to Claude, the page puts the sign-in code in your repository as a hidden git reference, so the run can pick it up. Anyone who can read the repository can see it. The page deletes it after 60 seconds. If you close the tab before that, it stays until your next Claude sign-in for that repository. The code works only once, and only for a short time.',
          'When the page opens, it calls our token server once to wake it up. That call carries no data about you.',
        ]}
      />
    ),
  },
  {
    id: 'dashboard',
    title: 'The dashboard',
    body: (
      <>
        <P>We only keep the data below for an organization that uses the dashboard. Today we turn it on for an organization on request.</P>
        <List
          items={[
            'The names and GitHub ids of the organization and its repositories.',
            'Numbers for each review: the run, the pull request number, the commit, the result (green, yellow or red), the number of findings, which AI and model reviewed, how long it took and how many lines changed. No names and no text.',
            'Decisions: when someone declines a finding with a reason, we keep the finding\'s title, file and lines, the reason, the pull request, the time, and the GitHub username of the person who declined it. Later reviews use this so they do not raise the same thing again.',
            'Rules, checks and skills that your team writes on the dashboard: their name and text, the files they cover, and the GitHub username and account id of who added them. For a skill folder picked from a repository, we keep its path instead of any text.',
            'A log of changes: who added or deleted a rule, check or skill, or forgot a decision, with their GitHub username and account id, when, and what changed. For a rule or check, this includes its text. For a skill, its name and description, or its path.',
          ]}
        />
        <P>
          You sign in to the dashboard with GitHub. We use your GitHub token once, to learn your username and which organizations and repositories you can
          see, and then drop it. Your session is a random key that our server keeps in memory for 15 minutes. Your browser keeps it in session storage,
          with drafts of what you type into the dashboard's forms.
        </P>
        <P>
          The dashboard sets one cookie, <code className="font-mono text-[0.92em] text-fg">sidebar_state</code>, which remembers for 7 days whether the
          menu is open. Profile pictures load from GitHub.
        </P>
      </>
    ),
  },
  {
    id: 'keep',
    title: 'How long we keep it',
    body: (
      <List
        items={[
          'A decision that no review has used for 90 days is deleted on its own. A repository keeps 500 decisions at most.',
          'Forget on the dashboard deletes a decision\'s title and reason at once. A marker without text stays: the finding\'s id, its line and the pull request.',
          'A rule, check or skill you delete stops being used at once. The log of changes keeps the text of a deleted rule or check, and the name and description of a deleted skill, until your organization\'s data is deleted.',
          'Everything else stays until your organization asks us to delete it.',
          <>To delete all of your organization's data, write to {mail}. We check on GitHub that you own the organization, and delete everything within one month.</>,
        ]}
      />
    ),
  },
  {
    id: 'where',
    title: 'Where the data is, and who helps us',
    body: (
      <>
        <List
          items={[
            'Render runs our token server, the dashboard server and its database, in the United States.',
            'GitHub hosts this website (GitHub Pages), the sign-in and the Mergelight apps, in the United States. GitHub can log visits to this website, under GitHub\'s own privacy statement.',
            'Like any host, Render can log the requests that reach our servers, under its own terms. We do not use those logs to track anyone.',
            'We use no other services for your data: no analytics, no error tracking and no ad networks. Fonts are served from this website.',
          ]}
        />
        <P>Data about people in the EU is sent to the United States. For that, we rely on the safeguards in GitHub's and Render's data protection terms.</P>
      </>
    ),
  },
  {
    id: 'why',
    title: 'Why we may use it',
    body: (
      <List
        items={[
          'To run the parts of Mergelight that you or your organization turned on. Under the GDPR, that is a contract (Article 6(1)(b)).',
          'To keep Mergelight safe and to see who changed what, which is why we keep the log of changes. That is our legitimate interest (Article 6(1)(f)).',
        ]}
      />
    ),
  },
  {
    id: 'rights',
    title: 'Your rights',
    body: (
      <>
        <P>
          You can ask to see the data we have about you, and to correct it, delete it, limit how we use it, object to how we use it, or get a copy of it.
          Write to {mail}, and we answer within one month.
        </P>
        <P>
          Your GitHub username and account id can be in your organization's decisions, rules, checks, skills and log of changes. If you ask, we
          delete them or replace them with a placeholder.
        </P>
        <P>You can also complain to the data protection authority where you live or work.</P>
      </>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to this page',
    body: (
      <P>
        We update this page when Mergelight changes what it sends or keeps. The date at the top shows the last change, and every earlier version is in{' '}
        <a href={`${GITHUB}/commits/main/site/src/privacy/Privacy.tsx`} className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg">
          the history on GitHub
        </a>
        .
      </P>
    ),
  },
];

export default function Privacy() {
  return (
    <div className="flex min-h-dvh flex-col bg-ink text-muted">
      <header className="mx-auto flex h-16 w-full max-w-3xl items-center px-5 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-fg">
          <img src="/logo.png" alt="" width={24} height={24} className="size-6 rounded-md" />
          Mergelight
        </a>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-24 pt-10 text-[15px] leading-relaxed sm:px-8 sm:pt-16">
        <h1 className="text-3xl font-semibold tracking-[-0.03em] text-fg sm:text-4xl">Privacy policy</h1>
        <p className="mt-3 text-sm text-faint">Last updated {UPDATED}</p>
        <p className="mt-8 text-lg text-muted">
          Mergelight is AI code review that runs in your own GitHub Actions, on the Claude or ChatGPT plan you already pay for. This page says what data
          reaches us, what we keep, for how long, and what we never see.
        </p>
        {SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className="mt-12 scroll-mt-8">
            <h2 className="text-xl font-semibold tracking-tight text-fg">{s.title}</h2>
            {s.body}
          </section>
        ))}
      </main>
      <Footer />
    </div>
  );
}
