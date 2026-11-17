import { LegalPage, List, P, linkClass, mail, type Section } from '../legal/Legal';

// Keep this page and the refund parts of the terms the same. When one changes, change the other in the
// same pull request.
const UPDATED = 'November 17, 2026';

const SECTIONS: Section[] = [
  {
    id: 'short',
    title: 'The short version',
    body: (
      <List
        items={[
          'Ask within 14 days of a payment, and you get that payment back in full. You need no reason.',
          'You can cancel at any time. The plan stays on until the end of the month you paid for, and you pay nothing more.',
          'The Free plan costs nothing, so there is nothing to refund.',
        ]}
      />
    ),
  },
  {
    id: 'how',
    title: 'How to ask',
    body: (
      <>
        <P>Write to {mail} with the name of your GitHub organization and the date of the payment. You can also reply to the receipt from Paddle.</P>
        <P>
          To cancel, an owner opens the dashboard's Settings page, then Billing, then "Invoices, card and cancel". That page is Paddle's, and it also
          has your invoices. Cancel before you uninstall the Mergelight AI app: the dashboard can't show your organization without it. If it is
          gone already, use the link in Paddle's receipt, or write to {mail}.
        </P>
        <P>
          Paddle.com, our reseller and the Merchant of Record for every order, sends the refund to the card or account you paid with. The{' '}
          <a href="/terms/#reseller" className={linkClass}>
            terms
          </a>{' '}
          say more about Paddle's part.
        </P>
      </>
    ),
  },
  {
    id: 'after',
    title: 'After 14 days',
    body: (
      <>
        <P>After 14 days we don't refund the rest of a month, with two exceptions:</P>
        <List
          items={[
            'We remove a paid feature, and you cancel because of it.',
            "We stop your paid account, and you didn't break the terms.",
          ]}
        />
        <P>In both cases, you get back what you paid for the rest of that month.</P>
        <P>When you lower the number of developers on your plan, your next payment is lower.</P>
      </>
    ),
  },
  {
    id: 'law',
    title: 'Your rights by law',
    body: (
      <P>
        If you buy as a consumer in the EU or the UK, the law gives you 14 days to withdraw from the purchase. This policy gives you at least the
        same. Nothing here takes away a right the law gives you.
      </P>
    ),
  },
];

export default function Refunds() {
  return (
    <LegalPage
      title="Refund policy"
      updated={UPDATED}
      intro="When you get your money back for a Mergelight plan, and how to ask."
      sections={SECTIONS}
    />
  );
}
