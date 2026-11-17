import { GITHUB } from '../links';
import { LegalPage, List, P, linkClass, mail, type Section } from '../legal/Legal';

// Keep this page true to the product: plans, prices and who sells them. When the pricing section,
// the refund policy or the payment flow changes, change this page in the same pull request.
const UPDATED = 'November 17, 2026';

const link = (href: string, text: string) => (
  <a href={href} className={linkClass}>
    {text}
  </a>
);

const SECTIONS: Section[] = [
  {
    id: 'who',
    title: 'Who we are',
    body: (
      <>
        <P>Mergelight is the code review service on mergelight.dev: the GitHub Action, the CLI, the Mergelight AI app on GitHub, the dashboard and this website.</P>
        <P>Write to {mail} with any question about these terms.</P>
      </>
    ),
  },
  {
    id: 'agree',
    title: 'Agreeing to these terms',
    body: (
      <P>
        By using Mergelight, you agree to these terms. If you use Mergelight for an organization, you agree to them for that organization, and you
        confirm that you may do so.
      </P>
    ),
  },
  {
    id: 'plans',
    title: 'Plans and prices',
    body: (
      <>
        <List
          items={[
            'Free: reviews in your own GitHub Actions, the CLI, the Mergelight AI app, the MCP server and the agent skill. Free has no time limit.',
            'Light and Pro: the prices per developer a month are on the pricing section of this website. Light is free for public repositories.',
            'You pick how many developers you pay for when you buy, and you can change the number at any time.',
            'A paid plan renews each month until you cancel it. When you cancel, the plan stays on until the end of the month you paid for.',
            'We tell paying customers at least 30 days before a price changes. The new price applies from the next month after that.',
          ]}
        />
        <P>Paid plans are not on sale yet. Until they are, we turn the dashboard on for organizations we invite, at no cost.</P>
      </>
    ),
  },
  {
    id: 'reseller',
    title: 'Who sells the paid plans',
    body: (
      <>
        <P>
          Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle takes
          the payment, adds the right sales tax or VAT, sends the invoice and handles refunds.
        </P>
        <P>
          Paddle's own buyer terms also apply to a purchase. Our {link('/refunds/', 'refund policy')} says when you get your money back.
        </P>
      </>
    ),
  },
  {
    id: 'your-plan',
    title: 'Your AI plan and your code',
    body: (
      <List
        items={[
          'Reviews and jobs run in your own GitHub Actions runner, on your own Claude or ChatGPT plan. You need your own plan, and you must follow the terms of your AI provider and of GitHub.',
          "Your AI plan's usage and cost are yours. Mergelight doesn't pay for them and doesn't control them.",
          <>Your code stays yours. The {link('/privacy/', 'privacy policy')} says what reaches us and what never does.</>,
        ]}
      />
    ),
  },
  {
    id: 'use',
    title: 'Fair use',
    body: (
      <>
        <P>Don't use Mergelight to:</P>
        <List
          items={[
            'break the law, or harm other people or their systems',
            'attack, overload or probe the Mergelight server, the token server or the Mergelight AI app',
            "get around a plan's limits, or use paid features without a paid plan",
            'sell or give access to the dashboard, the server or the Mergelight AI app to others without our written OK',
          ]}
        />
        <P>
          The source code of the Action and the CLI is under the license in{' '}
          {link(GITHUB, 'its GitHub repository')}. That license, not these terms, says what you may do with the code.
        </P>
      </>
    ),
  },
  {
    id: 'ai',
    title: 'AI reviews can be wrong',
    body: (
      <P>
        Reviews and jobs come from AI models. They can be wrong, and they can miss problems. A review is advice, not a guarantee: you decide what to
        merge.
      </P>
    ),
  },
  {
    id: 'service',
    title: 'Keeping the service running',
    body: (
      <P>
        We work to keep Mergelight up, but we can't promise it never stops. We may change or remove features. If we remove a paid feature, you can
        cancel and get back what you paid for the rest of that month.
      </P>
    ),
  },
  {
    id: 'liability',
    title: 'Liability',
    body: (
      <>
        <P>
          Mergelight is provided as it is. As far as the law allows, we are not liable for indirect loss, such as lost profit or lost data, and our
          total liability is at most what you paid us in the 12 months before the claim.
        </P>
        <P>Nothing in these terms limits a liability that the law doesn't let us limit, or takes away your rights as a consumer.</P>
      </>
    ),
  },
  {
    id: 'ending',
    title: 'Ending',
    body: (
      <>
        <P>
          You can stop at any time: cancel a paid plan, remove the Mergelight workflow and uninstall the Mergelight AI app. An organization owner
          can delete all of the organization's data on the dashboard's Settings page.
        </P>
        <P>
          We can stop an account that breaks these terms. We tell you why, unless the law doesn't let us. If we stop a paid account that didn't
          break these terms, you get back what you paid for the rest of that month.
        </P>
      </>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to these terms',
    body: (
      <P>
        We tell paying customers at least 30 days before a change that matters to them. The date at the top shows the last change, and every
        earlier version is in{' '}
        <a href={`${GITHUB}/commits/main/site/src/terms/Terms.tsx`} className={linkClass}>
          the history on GitHub
        </a>
        .
      </P>
    ),
  },
];

export default function Terms() {
  return (
    <LegalPage
      title="Terms of service"
      updated={UPDATED}
      intro="These terms are the agreement between you and Mergelight. They say what you get on each plan, who sells the paid plans, and what we each promise."
      sections={SECTIONS}
    />
  );
}
