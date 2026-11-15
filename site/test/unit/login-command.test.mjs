// The login line the setup page shows for saving a repo's own ChatGPT login, run for real in bash with stand-ins for
// codex and gh. A temp folder whose path has a space must never make rm -rf remove anything but that folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/setup/Setup.tsx', import.meta.url), 'utf8');
const line = source.match(/const command = `(.*)`;/)?.[1];
const commandFor = (repo) => line.replace('${LOGIN_SECRET[LOGIN_INPUTS.codex[0]]}', 'CODEX_AUTH_JSON').replaceAll('${repo.fullName}', repo);

test('the login line quotes every use of its folder', () => {
  assert.ok(line, 'the page builds the line here');
  const command = commandFor('acme/api');
  assert.equal(command, `d="$(mktemp -d)" && echo 'cli_auth_credentials_store = "file"' > "$d/config.toml" && CODEX_HOME="$d" codex login && gh secret set CODEX_AUTH_JSON --repo acme/api < "$d/auth.json" && echo "Saved the ChatGPT login in acme/api."; [ -n "$d" ] && rm -rf "$d"`);
});

test('run with a temp folder whose path has a space, it removes only its own folder', () => {
  const command = commandFor('acme/api');
  const root = mkdtempSync(join(tmpdir(), 'ml-login-'));
  try {
    // Unquoted, "<root>/victim folder/tmp.X" would split into "<root>/victim" and "folder/tmp.X".
    const victim = join(root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    const spaced = join(root, 'victim folder');
    mkdirSync(spaced);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const saved = join(root, 'saved.json');
    // mktemp hands out a folder under the spaced path, as it does on Linux with such a TMPDIR. macOS ignores TMPDIR.
    writeFileSync(join(bin, 'mktemp'), `#!/bin/bash\nd="${spaced}/tmp.test"\nmkdir -p "$d"\nprintf '%s\\n' "$d"\n`);
    writeFileSync(join(bin, 'codex'), '#!/bin/bash\nprintf \'{"tokens":"t"}\' > "$CODEX_HOME/auth.json"\n');
    writeFileSync(join(bin, 'gh'), `#!/bin/bash\ncat > "${saved}"\n`);
    for (const tool of ['mktemp', 'codex', 'gh']) chmodSync(join(bin, tool), 0o755);
    const out = execFileSync('bash', ['-c', command], { cwd: root, env: { ...process.env, TMPDIR: spaced, PATH: `${bin}:${process.env.PATH}` } }).toString();
    assert.equal(readFileSync(saved, 'utf8'), '{"tokens":"t"}', 'gh got the new login');
    assert.match(out, /Saved the ChatGPT login in acme\/api\./, 'and it says so');
    assert.ok(existsSync(join(victim, 'keep.txt')), 'the folder beside it is untouched');
    assert.equal(execFileSync('ls', ['-A', spaced]).toString(), '', 'and its own folder is gone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('when mktemp fails, it writes nothing, signs in to nothing, and removes nothing', () => {
  const command = commandFor('acme/api');
  const root = mkdtempSync(join(tmpdir(), 'ml-login-'));
  try {
    const keep = join(root, 'keep');
    mkdirSync(keep);
    writeFileSync(join(keep, 'keep.txt'), 'keep');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const ran = join(root, 'ran');
    writeFileSync(join(bin, 'mktemp'), '#!/bin/bash\necho "mktemp: failed" >&2\nexit 1\n');
    // Any of these running would leave a mark.
    for (const tool of ['codex', 'gh', 'rm']) writeFileSync(join(bin, tool), `#!/bin/bash\necho ${tool} >> "${ran}"\n`);
    for (const tool of ['mktemp', 'codex', 'gh', 'rm']) chmodSync(join(bin, tool), 0o755);
    let failed = false;
    try {
      execFileSync('bash', ['-c', command], { cwd: keep, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, stdio: 'pipe' });
    } catch {
      failed = true;
    }
    assert.equal(failed, true, 'the line fails');
    assert.equal(existsSync(ran), false, 'codex, gh and rm never ran');
    assert.ok(existsSync(join(keep, 'keep.txt')), 'and nothing was removed');
    assert.equal(execFileSync('ls', ['-A', keep]).toString().trim(), 'keep.txt', 'nor written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("when gh can't save the login, it never says it did, and still removes its folder", () => {
  const command = commandFor('acme/api');
  const root = mkdtempSync(join(tmpdir(), 'ml-login-'));
  try {
    const temp = join(root, 'temp');
    mkdirSync(temp);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'mktemp'), `#!/bin/bash\nd="${temp}/tmp.test"\nmkdir -p "$d"\nprintf '%s\\n' "$d"\n`);
    writeFileSync(join(bin, 'codex'), '#!/bin/bash\nprintf x > "$CODEX_HOME/auth.json"\n');
    writeFileSync(join(bin, 'gh'), '#!/bin/bash\necho "HTTP 403: Resource not accessible" >&2\nexit 1\n');
    for (const tool of ['mktemp', 'codex', 'gh']) chmodSync(join(bin, tool), 0o755);
    const out = execFileSync('bash', ['-c', command], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    assert.doesNotMatch(out, /Saved the ChatGPT login/, 'no success line');
    assert.equal(execFileSync('ls', ['-A', temp]).toString(), '', 'and the login it made is removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
