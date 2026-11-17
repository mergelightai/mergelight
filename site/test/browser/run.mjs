// Runs the browser test files side by side, the two long ones in parts, and fails if any part fails. Each part has its
// own Chrome, and its fake GitHub lives in its own pages, so the parts share nothing but the machine.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const dir = new URL('.', import.meta.url).pathname;
const parts = (file, n) => Array.from({ length: n }, (_, i) => ({ file, shard: `${i + 1}/${n}` }));
// The longest first, so the last to start isn't the one everything waits for.
const jobs = [...parts('two-ais.mjs', Number(process.env.TWO_AIS_PARTS ?? 4)), ...parts('connect-code.mjs', 2), { file: 'full-flow.mjs' }, { file: 'dashboard.mjs' }, { file: 'return-trip.mjs' }, { file: 'docs.mjs' }];
// Two at a time: with four Chromes at once on a Mac, every part slowed down about sixfold (984 s against about
// 160 s each), so more at once only made the whole run longer. BROWSER_JOBS sets another number.
const limit = Number(process.env.BROWSER_JOBS ?? Math.min(2, Math.max(1, availableParallelism())));
const started = Date.now();
const seconds = (since) => `${Math.round((Date.now() - since) / 1000)}s`;

function run({ file, shard }) {
  const since = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${dir}${file}`], { env: { ...process.env, ...(shard && { SHARD: shard }) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      // Each part's output comes out whole, once it's done, so parts never interleave.
      console.log(`\n### ${file}${shard ? ` (part ${shard})` : ''}: ${code === 0 ? 'passed' : 'FAILED'} in ${seconds(since)}\n${out.trim()}`);
      resolve(code === 0);
    });
  });
}

const queue = [...jobs];
let failed = 0;
await Promise.all(
  Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (queue.length) if (!(await run(queue.shift()))) failed++;
  }),
);
console.log(`\n${failed ? `${failed} of ${jobs.length} parts FAILED` : `all ${jobs.length} parts passed`} in ${seconds(started)}, ${limit} at a time`);
process.exitCode = failed ? 1 : 0;
