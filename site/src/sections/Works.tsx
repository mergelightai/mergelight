import { siClaude, siCursor, siGithub, siGithubactions, siModelcontextprotocol } from 'simple-icons';
import LogoLoop from '../components/reactbits/LogoLoop';
import { CODEX_PATH } from '../brandIcons';

type Tool = { name: string; path?: string; hex?: string; glyph?: string; evenodd?: boolean };

const tools: Tool[] = [
  { name: 'Claude Code', path: siClaude.path, hex: '#D97757' },
  { name: 'Codex', path: CODEX_PATH, hex: '#ffffff', evenodd: true },
  { name: 'Cursor', path: siCursor.path, hex: '#ffffff' },
  { name: 'GitHub', path: siGithub.path, hex: '#ffffff' },
  { name: 'GitHub Actions', path: siGithubactions.path, hex: '#2088FF' },
  { name: 'T3 Code', glyph: 'T3' },
  { name: 'Any MCP agent', path: siModelcontextprotocol.path, hex: '#ffffff' },
];

function ToolMark({ t }: { t: Tool }) {
  return (
    <span className="group flex items-center gap-3 whitespace-nowrap text-muted transition-colors duration-300 hover:text-fg">
      {t.path ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-current transition-colors duration-300" style={{ ['--brand' as string]: t.hex }}>
          <path d={t.path} fillRule={t.evenodd ? 'evenodd' : undefined} clipRule={t.evenodd ? 'evenodd' : undefined} className="group-hover:fill-[var(--brand)]" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7">
          <rect x="1.5" y="3" width="21" height="18" rx="4.5" fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5" />
          <text x="12" y="15.6" textAnchor="middle" fill="currentColor" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="8.5" fontWeight="700">{t.glyph}</text>
        </svg>
      )}
      <span className="text-lg font-medium tracking-tight">{t.name}</span>
    </span>
  );
}

export default function Works() {
  return (
    <section className="border-y border-line/70 bg-ink py-10">
      <p className="mb-7 text-center text-sm text-faint">Works with the tools you already use</p>
      <LogoLoop
        logos={tools.map((t) => ({ node: <ToolMark t={t} />, title: t.name }))}
        speed={42}
        gap={72}
        logoHeight={32}
        fadeOut
        fadeOutColor="#0a0913"
        pauseOnHover
        scaleOnHover
        ariaLabel="Tools Mergelight works with"
      />
    </section>
  );
}
