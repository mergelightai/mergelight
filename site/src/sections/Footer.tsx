import { EMAIL, GITHUB } from '../links';
import { Container } from '../ui';

export default function Footer() {
  return (
    <footer className="border-t border-line/70 py-10 text-sm text-faint">
      <Container className="flex flex-col items-center justify-between gap-4 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" width={20} height={20} className="size-5 rounded-[5px]" />
          <span>&copy; 2026 Mergelight</span>
        </div>
        <div className="flex items-center gap-6">
          <a href={GITHUB} className="transition-colors hover:text-fg">GitHub</a>
          <a href="/privacy/" className="transition-colors hover:text-fg">Privacy</a>
          <a href={`mailto:${EMAIL}`} className="transition-colors hover:text-fg">{EMAIL}</a>
        </div>
      </Container>
    </footer>
  );
}
