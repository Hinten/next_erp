// Tests for the `.old/` protection hook. No dependencies — Node's built-in
// runner, so it works from a bare checkout with no pnpm install:
//
//   node --test .claude/hooks/protect-old-reference.test.mjs
//
// (Pass the file, not the directory: `node --test .claude/hooks/` resolves the
// directory as a module on Node 22 + Windows and fails with MODULE_NOT_FOUND.)
//
// The false-NEGATIVE cases are the point of the file (a hook that silently
// stops matching is worse than no hook), but the false-POSITIVE cases matter
// nearly as much: a protective hook that refuses ordinary commands gets worked
// around, and then protects nothing.
import { deepStrictEqual, ok } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'protect-old-reference.mjs');

/** Run the hook against one payload; returns the deny reason, or null if allowed. */
function run(payload) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  if (out.trim() === '') return null;
  return JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
}

const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } });

describe('git clean — the flag that deletes ignored files', () => {
  // `.old/` is gitignored, so -x/-X remove it *because* it is ignored. This is
  // the most likely way the directory was lost, and no deny rule covered it.
  for (const cmd of [
    'git clean -fdx',
    'git clean -xdf',
    'git clean -fdX',
    'git clean -x',
    'git clean --force -d -x',
    'pnpm build && git clean -fdx',
  ]) {
    it(`blocks \`${cmd}\``, () => ok(bash(cmd)?.includes('IGNORED files')));
  }

  for (const cmd of ['git clean -fd', 'git clean -n', 'git clean']) {
    it(`allows \`${cmd}\` — cannot reach ignored files`, () => deepStrictEqual(bash(cmd), null));
  }
});

describe('destructive commands reaching the directory', () => {
  const dir = ['.', 'old'].join(''); // built, so this file never contains a literal target
  for (const [label, cmd] of [
    ['rm -rf at the root', `rm -rf ${dir}`],
    ['rm without -f', `rm -r ${dir}`],
    // A deny rule matches a command PREFIX, so this form slipped past
    // `Bash(rm -rf *)` — splitting on && is what catches it.
    ['rm after a cd', `cd packages && rm -rf ../${dir}`],
    ['rm behind sudo', `sudo rm -rf ${dir}/packages`],
    ['rm behind an env assignment', `FOO=bar rm -rf ${dir}`],
    ['mv away', `mv ${dir} /tmp/x`],
    ['sed -i inside', `sed -i s/a/b/ ${dir}/lib/models.dart`],
    ['find -delete', `find ${dir} -name '*.dart' -delete`],
    ['redirect into', `echo hi > ${dir}/f.txt`],
    ['append into', `echo hi >> ${dir}/f.txt`],
    ['a nested path', `rm -rf packages/${dir}/lib`],
    ['a windows separator', `rm -rf .claude\\..\\${dir}`],
  ]) {
    it(`blocks ${label}`, () => ok(bash(cmd), `expected a block for: ${cmd}`));
  }

  it('blocks Remove-Item from PowerShell', () => {
    ok(run({ tool_name: 'PowerShell', tool_input: { command: `Remove-Item ${dir} -Recurse` } }));
  });
});

describe('reads stay allowed — the whole point of keeping the directory', () => {
  const dir = ['.', 'old'].join('');
  for (const cmd of [
    `grep -rn forceEndereco ${dir} --include=*.dart`,
    `cat ${dir}/packages/clientes/lib/src/models.dart`,
    `ls ${dir}`,
    `find ${dir} -name models.dart`,
    `rg forceEndereco ${dir}`,
    `wc -l ${dir}/a.dart`,
  ]) {
    it(`allows \`${cmd.slice(0, 44)}…\``, () => deepStrictEqual(bash(cmd), null));
  }
});

describe('does not fire on lookalikes', () => {
  for (const cmd of [
    'rm -rf .older/cache', // different directory
    'rm -rf dist/bundle.old', // a backup FILE, not the directory
    'rm -rf node_modules',
    'git commit -m "drop the .old copy"', // prose, not a command
  ]) {
    it(`allows \`${cmd}\``, () => deepStrictEqual(bash(cmd), null));
  }

  it('ignores a heredoc body that merely describes deleting it', () => {
    const body = ['rm -rf ', '.', 'old'].join('');
    deepStrictEqual(bash(`git commit -F- <<'EOF'\nWe must never ${body}\nEOF`), null);
  });
});

describe('file tools', () => {
  const dir = ['.', 'old'].join('');
  it('blocks Write into the directory', () => {
    ok(run({ tool_name: 'Write', tool_input: { file_path: `C:/r/next_erp/${dir}/a.dart` } }));
  });
  it('blocks Edit into the directory', () => {
    ok(run({ tool_name: 'Edit', tool_input: { file_path: `/repo/${dir}/lib/models.dart` } }));
  });
  it('allows Write elsewhere', () => {
    deepStrictEqual(run({ tool_name: 'Write', tool_input: { file_path: '/repo/src/a.ts' } }), null);
  });
});

describe('never blocks on its own bug', () => {
  it('passes an unparseable payload through', () => {
    const out = execFileSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    deepStrictEqual(out.trim(), '');
  });
  it('passes an empty payload through', () => deepStrictEqual(run({}), null));
});
