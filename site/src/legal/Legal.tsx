import type { ReactNode } from 'react';
import Footer from '../sections/Footer';
import { EMAIL } from '../links';

// The layout the privacy policy, the terms and the refund policy share.

export type Section = { id: string; title: string; body: ReactNode };

export const linkClass = 'text-fg underline decoration-line underline-offset-4 hover:decoration-fg';

export const mail = <a href={`mailto:${EMAIL}`} className={linkClass}>{EMAIL}</a>;

export function List({ items }: { items: ReactNode[] }) {
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

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-4">{children}</p>;
}

export function LegalPage({ title, updated, intro, sections }: { title: string; updated: string; intro: ReactNode; sections: Section[] }) {
  return (
    <div className="flex min-h-dvh flex-col bg-ink text-muted">
      <header className="mx-auto flex h-16 w-full max-w-3xl items-center px-5 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-fg">
          <img src="/logo.png" alt="" width={24} height={24} className="size-6 rounded-md" />
          Mergelight
        </a>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-24 pt-10 text-[15px] leading-relaxed sm:px-8 sm:pt-16">
        <h1 className="text-3xl font-semibold tracking-[-0.03em] text-fg sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-faint">Last updated {updated}</p>
        <p className="mt-8 text-lg text-muted">{intro}</p>
        {sections.map((s) => (
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
