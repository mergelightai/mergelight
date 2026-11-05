import LogoLoop from '../components/reactbits/LogoLoop';

const tools = ['Claude Code', 'Codex', 'Cursor', 'T3 Code', 'GitHub Actions', 'GitHub Checks', 'Any MCP agent'];

export default function Works() {
  return (
    <section className="border-y border-line/70 bg-white/[0.012] py-9">
      <p className="mb-6 text-center text-sm text-faint">Works with the tools you already use</p>
      <LogoLoop
        logos={tools.map((t) => ({
          node: <span className="whitespace-nowrap text-lg font-medium tracking-tight text-muted/90">{t}</span>,
          title: t,
        }))}
        speed={45}
        gap={64}
        logoHeight={28}
        fadeOut
        fadeOutColor="#07060d"
        pauseOnHover
        ariaLabel="Tools Mergelight works with"
      />
    </section>
  );
}
