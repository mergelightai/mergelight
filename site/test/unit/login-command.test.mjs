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

test('the login line quotes every use of its folder', () => {
  assert.ok(line, 'the page builds the line here');
  const command = line.replace('${LOGIN_SECRET[LOGIN_INPUTS.codex[0]]}', 'CODEX_AUTH_JSON').replace('${repo.fullName}', 'acme/api');
  assert.equal(command, `d="$(mktemp -d)"; echo 'cli_auth_credentials_store = "file"' > "$d/config.toml"; CODEX_HOME="$d" codex login && gh secret set CODEX_AUTH_JSON --repo acme/api < "$d/auth.json"; rm -rf "$d"`);
});

test('run with a temp folder whose path has a space, it removes only its own folder', () => {
  const command = line.replace('${LOGIN_SECRET[LOGIN_INPUTS.codex[0]]}', 'CODEX_AUTH_JSON').replace('${repo.fullName}', 'acme/api');
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
    execFileSync('bash', ['-c', command], { cwd: root, env: { ...process.env, TMPDIR: spaced, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(readFileSync(saved, 'utf8'), '{"tokens":"t"}', 'gh got the new login');
    assert.ok(existsSync(join(victim, 'keep.txt')), 'the folder beside it is untouched');
    assert.equal(execFileSync('ls', ['-A', spaced]).toString(), '', 'and its own folder is gone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
