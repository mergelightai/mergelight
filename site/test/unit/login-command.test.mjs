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
/** The shells the line is run in: bash, and zsh where it's there, as on a Mac. */
const shells = ['bash', 'zsh'].filter((sh) => {
  try {
    execFileSync('sh', ['-c', `command -v ${sh}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
/** Runs the line, and gives its output and exit status, which a failed run doesn't throw away. */
function run(shell, command, options) {
  try {
    return { status: 0, out: execFileSync(shell, ['-c', command], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
  } catch (err) {
    return { status: err.status, out: String(err.stdout ?? '') };
  }
}
const commandFor = (repo) => line.replace('${LOGIN_SECRET[LOGIN_INPUTS.codex[0]]}', 'CODEX_AUTH_JSON').replaceAll('${repo.fullName}', repo);

test('the login line quotes every use of its folder', () => {
  assert.ok(line, 'the page builds the line here');
  const command = commandFor('acme/api');
  assert.equal(command, `d="$(mktemp -d)" && echo 'cli_auth_credentials_store = "file"' > "$d/config.toml" && CODEX_HOME="$d" codex login && gh secret set CODEX_AUTH_JSON --repo acme/api < "$d/auth.json" && echo "Saved the ChatGPT login in acme/api."; s=$?; [ -n "$d" ] && rm -rf "$d"; (exit $s)`);
});

/** A folder for one run, with stand-ins for the tools the line calls. */
function sandbox(tools) {
  const root = mkdtempSync(join(tmpdir(), 'ml-login-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, script] of Object.entries(tools(root))) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${script}`);
    chmodSync(join(bin, name), 0o755);
  }
  return { root, bin };
}

for (const shell of shells) {
  test(`${shell}: with a temp folder whose path has a space, it saves the login, says so, and removes only its own folder`, () => {
    const { root, bin } = sandbox((r) => ({
      // mktemp hands out a folder under the spaced path, as it does on Linux with such a TMPDIR. macOS ignores TMPDIR.
      mktemp: `d="${r}/victim folder/tmp.test"\nmkdir -p "$d"\nprintf '%s\\n' "$d"\n`,
      codex: `printf '{"tokens":"t"}' > "$CODEX_HOME/auth.json"\n`,
      gh: `cat > "${r}/saved.json"\n`,
    }));
    try {
      // Unquoted, "<root>/victim folder/tmp.test" would split into "<root>/victim" and "folder/tmp.test".
      mkdirSync(join(root, 'victim'));
      writeFileSync(join(root, 'victim', 'keep.txt'), 'keep');
      const { status, out } = run(shell, commandFor('acme/api'), { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(status, 0, 'the line succeeds');
      assert.equal(readFileSync(join(root, 'saved.json'), 'utf8'), '{"tokens":"t"}', 'gh got the new login');
      assert.match(out, /Saved the ChatGPT login in acme\/api\./, 'and it says so');
      assert.ok(existsSync(join(root, 'victim', 'keep.txt')), 'the folder beside it is untouched');
      assert.equal(execFileSync('ls', ['-A', join(root, 'victim folder')]).toString(), '', 'and its own folder is gone');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${shell}: when mktemp fails, it fails, writes nothing, signs in to nothing, and removes nothing`, () => {
    const { root, bin } = sandbox((r) => ({
      mktemp: 'echo "mktemp: failed" >&2\nexit 1\n',
      // Any of these running would leave a mark.
      codex: `echo codex >> "${r}/ran"\n`,
      gh: `echo gh >> "${r}/ran"\n`,
      rm: `echo rm >> "${r}/ran"\n`,
    }));
    try {
      const keep = join(root, 'keep');
      mkdirSync(keep);
      writeFileSync(join(keep, 'keep.txt'), 'keep');
      const { status } = run(shell, commandFor('acme/api'), { cwd: keep, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
      assert.notEqual(status, 0, 'the line fails');
      assert.equal(existsSync(join(root, 'ran')), false, 'codex, gh and rm never ran');
      assert.equal(execFileSync('ls', ['-A', keep]).toString().trim(), 'keep.txt', 'and nothing was written or removed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${shell}: when gh can't save the login, the line fails with gh's result, never says it saved, and removes its folder`, () => {
    const { root, bin } = sandbox((r) => ({
      mktemp: `d="${r}/temp/tmp.test"\nmkdir -p "$d"\nprintf '%s\\n' "$d"\n`,
      codex: 'printf x > "$CODEX_HOME/auth.json"\n',
      gh: 'echo "HTTP 403: Resource not accessible" >&2\nexit 4\n',
    }));
    try {
      const { status, out } = run(shell, commandFor('acme/api'), { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(status, 4, "the line's result is gh's");
      assert.doesNotMatch(out, /Saved the ChatGPT login/, 'no success line');
      assert.equal(execFileSync('ls', ['-A', join(root, 'temp')]).toString(), '', 'and the login it made is removed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
