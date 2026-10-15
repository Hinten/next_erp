import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ESLINT_IN_WORKSPACE,
  eslintTasks,
  parseTask,
  readGetSpawnedTaskSource,
} from './lib/lint-staged.js';
import { REPO_ROOT } from './lib/repo-scan.js';

// ⚠️ Same reason as the sibling guards: `.lintstagedrc.mjs` reads
// `process.cwd()` at import time because lint-staged always invokes it from the
// repo root.
const cwdBefore = process.cwd();
process.chdir(REPO_ROOT);
const { default: lintStaged } = await import('../../../.lintstagedrc.mjs');
process.chdir(cwdBefore);

/**
 * Repo invariant: every command `.lintstagedrc.mjs` emits means, AFTER
 * lint-staged's own parser has split it, exactly what the config intends.
 *
 * ## Why this needs its own guard
 *
 * The pre-commit ESLint gate never ran. The config emitted
 * `sh -c '<cd ws && eslint --fix --max-warnings 0 …>'` with POSIX `'\''`
 * escaping, but lint-staged does not use a shell: it splits the string with
 * `string-argv`, which has no escape at all, and spawns argv[0]. `sh` received
 * `-c` and the fragment `cd `, changed to `$HOME`, exited 0, and the task showed
 * COMPLETED. That held from the gate's first commit (2026-06-08), so the
 * `--max-warnings 0` ratchet every warn-level rule's comment leans on ("editing
 * that file means resolving it first") had never once been enforced.
 *
 * Both guards that existed missed it for the same reason: they asserted on the
 * command STRING and undid the `'\''` escape themselves — reading it as a
 * shell would, the one thing lint-staged never does. This file reads it the
 * way lint-staged does. `lint-staged-gate-runs.test.js` then runs the real
 * binary end to end, because a model of the parser is still a model.
 */

/** Ask the real config what it would run for these repo-relative paths. */
const commandsFor = (relPaths) => lintStaged(relPaths.map((p) => resolve(REPO_ROOT, p)));

describe('lint-staged receives the argv .lintstagedrc.mjs means', () => {
  it('lint-staged still splits task strings with string-argv (the parser modelled here)', () => {
    // If a lint-staged upgrade changes how a task string becomes argv, every
    // assertion below is checking a parser nobody runs. Fail here instead.
    const src = readGetSpawnedTaskSource();
    expect(src).toMatch(/import \{ parseArgsStringToArgv \} from 'string-argv'/);
    expect(src).toMatch(/= parseArgsStringToArgv\(command\)/);
  });

  it('the parser shreds the old `sh -c` form — the defect, reproduced', () => {
    // Anti-vacuity: proves the parser loaded here is one that catches the bug.
    // The exact shape the config emitted until this guard landed.
    const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    const inner = `cd ${sq('apps/nfe')} && eslint --fix --max-warnings 0 ${sq('app/x.ts')}`;
    const argv = parseTask(`sh -c ${sq(inner)}`);
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    // `sh -c 'cd '`: a bare `cd` to $HOME, exit 0. The rest became `$0`.
    expect(argv[2]).toBe('cd ');
    expect(argv).not.toContain(inner);
  });

  it('spawns no shell: every task is Prettier or the node runner', () => {
    const heads = commandsFor(['apps/web/lib/a.ts', 'README.md', 'packages/ui/src/b.tsx']).map(
      (c) => parseTask(c).slice(0, 2),
    );
    expect(heads).toEqual([
      ['prettier', '--write'],
      ['node', ESLINT_IN_WORKSPACE],
      ['node', ESLINT_IN_WORKSPACE],
    ]);
  });

  it('hands the runner the workspace, the flags and each file as separate argv entries', () => {
    const argv = commandsFor(['apps/web/lib/a.ts', 'apps/web/app/b.tsx']).map(parseTask)[1];
    expect(argv).toEqual([
      'node',
      ESLINT_IN_WORKSPACE,
      'apps/web',
      '--fix',
      '--max-warnings',
      '0',
      '--no-warn-ignored',
      'lib/a.ts',
      'app/b.tsx',
    ]);
  });

  it('groups by owning workspace, one runner task each', () => {
    const tasks = eslintTasks(
      commandsFor([
        'apps/web/lib/a.ts',
        'packages/integrations/nfe/src/b.ts',
        'apps/web/lib/c.ts',
        '.github/scripts/d.mjs',
      ]),
    );
    expect(tasks.map((t) => [t.ws, t.args.slice(4)])).toEqual([
      ['apps/web', ['lib/a.ts', 'lib/c.ts']],
      ['packages/integrations/nfe', ['src/b.ts']],
    ]);
  });

  // Every character class the old `'\''` escaping claimed to protect, plus the
  // ones string-argv treats specially (whitespace and both quotes) and a
  // Portuguese name, since this repo is full of them.
  const AWKWARD = [
    'with space.ts',
    "it's.ts",
    'say "hi".ts',
    "space and 'quotes'.ts",
    '$HOME $(id).ts',
    '`tick`.ts',
    'a;b&c|d>e.ts',
    '(paren) [bracket] {brace}.ts',
    '*glob?.ts',
    'ação é.ts',
    'tab\there.ts',
    'new\nline.ts',
  ];

  it.each(AWKWARD)('round-trips %j through both tasks intact', (name) => {
    const abs = resolve(REPO_ROOT, 'apps/web/lib', name);
    const [prettier, eslint, ...rest] = lintStaged([abs]).map(parseTask);
    expect(rest).toEqual([]);
    expect(prettier).toEqual(['prettier', '--write', '--ignore-unknown', abs]);
    expect(eslint).toEqual([
      'node',
      ESLINT_IN_WORKSPACE,
      'apps/web',
      '--fix',
      '--max-warnings',
      '0',
      '--no-warn-ignored',
      `lib/${name}`,
    ]);
  });

  it('refuses a name no string-argv token can spell, instead of mangling it', () => {
    // string-argv has no escape, so ' and " together have no spelling at all.
    // Throwing makes lint-staged fail the commit with a reason; the alternative
    // is a linter handed some OTHER path, which is how this whole file started.
    expect(() => commandsFor([`apps/web/lib/both ' and ".ts`])).toThrow(/cannot be spelled/);
    expect(() => commandsFor([`README'".md`])).toThrow(/cannot be spelled/);
  });
});
