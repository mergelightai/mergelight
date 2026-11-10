import { useEffect, useState } from 'react';
import { EARLY, GITHUB, SETUP } from '../links';
import { GitHubIcon } from '../ui';

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-colors duration-300 ${
        scrolled ? 'border-line bg-ink/70 backdrop-blur-xl' : 'border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
          <img src="/logo.png" alt="" width={28} height={28} className="size-7 rounded-[7px]" />
          Mergelight
        </a>
        <nav className="hidden items-center gap-8 text-sm text-muted md:flex">
          <a href="#triage" className="transition-colors hover:text-fg">Why Mergelight</a>
          <a href="#how" className="transition-colors hover:text-fg">How it works</a>
          <a href="#pricing" className="transition-colors hover:text-fg">Pricing</a>
          <a href={SETUP} className="transition-colors hover:text-fg">Set up</a>
          <a href={GITHUB} className="flex items-center gap-1.5 transition-colors hover:text-fg">
            <GitHubIcon /> GitHub
          </a>
        </nav>
        <div className="flex items-center gap-4">
          {/* The links above are hidden on a phone, and this one is why someone came. */}
          <a href={SETUP} className="text-sm text-muted transition-colors hover:text-fg md:hidden">
            Set up
          </a>
          <a href={EARLY} className="rounded-full bg-fg px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-white">
            Get early access
          </a>
        </div>
      </div>
    </header>
  );
}
