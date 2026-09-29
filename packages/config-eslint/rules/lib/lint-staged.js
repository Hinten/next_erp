// lint-staged's OWN view of a task string, for the guards that police
// `.lintstagedrc.mjs`.
//
// ## Why this module exists
//
// lint-staged does not run a task through a shell. `lib/getSpawnedTask.js`
// splits the string with `string-argv` and spawns argv[0] directly, and
// string-argv has no escape of any kind — `'…'` and `"…"` drop their quotes,
// whitespace splits, and that is all it knows. The pre-commit ESLint task was
// `sh -c '<cd ws && eslint …>'` with POSIX `'\''` escaping, which string-argv
// shreds into `sh -c 'cd '`: `cd` with no argument, exit 0, ESLint never ran.
// It stayed that way from the gate's first commit (2026-06-08), because both
// guards that existed inspected the command STRING — undoing the `'\''` escape
// themselves, i.e. reading it as a shell would, which is exactly the one thing
// lint-staged never does.
//
// So every lint-staged guard parses through the parser lint-staged itself
// imports: string-argv resolved from lint-staged's REALPATH (pnpm links
// `node_modules/lint-staged` into the store, and its dependencies are
// resolvable only from there), loaded from its ESM entry because that is the
// build lint-staged's `import` gets. `lint-staged-argv.test.js` additionally
// pins that `getSpawnedTask.js` still splits with it, so a lint-staged upgrade
// that changes parsers reds CI instead of silently invalidating the model.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from './repo-scan.js';

/** lint-staged's real install directory, behind pnpm's symlink. */
export const LINT_STAGED_DIR = realpathSync(join(REPO_ROOT, 'node_modules', 'lint-staged'));

/** The runner `.lintstagedrc.mjs` spawns once per workspace (repo-relative). */
export const ESLINT_IN_WORKSPACE = 'packages/config-eslint/lint-staged/eslint-in-workspace.mjs';

/** The file string-argv's `import` condition points at, as lint-staged loads it. */
function stringArgvEsmEntry() {
  // `require.resolve` lands on the CommonJS build (`commonjs/index.js`); walk up
  // to the package root and follow its `import` condition instead.
  const resolved = createRequire(join(LINT_STAGED_DIR, 'package.json')).resolve('string-argv');
  for (let dir = dirname(resolved); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.name !== 'string-argv') continue;
    const dot = pkg.exports?.['.'];
    const entry = typeof dot === 'string' ? dot : dot?.import;
    if (typeof entry !== 'string') {
      throw new Error(`string-argv@${pkg.version} has no plain ESM entry — re-derive this helper`);
    }
    return join(dir, entry);
  }
  throw new Error(`no string-argv package.json above ${resolved}`);
}

const { parseArgsStringToArgv } = await import(pathToFileURL(stringArgvEsmEntry()).href);

/**
 * Split a task string exactly as lint-staged 16's `getSpawnedTask` does before
 * spawning `argv[0]` with the rest as arguments.
 *
 * @param {string} command
 * @returns {string[]}
 */
export const parseTask = (command) => parseArgsStringToArgv(command);

/** The source of lint-staged's task spawner, to pin the parser modelled above. */
export const readGetSpawnedTaskSource = () =>
  readFileSync(join(LINT_STAGED_DIR, 'lib', 'getSpawnedTask.js'), 'utf8');

/**
 * The ESLint invocations among `commands`, as lint-staged will spawn them.
 *
 * @param {string[]} commands what `.lintstagedrc.mjs` returned
 * @returns {{ ws: string, args: string[] }[]} workspace + the argv ESLint gets
 */
export function eslintTasks(commands) {
  return commands
    .map(parseTask)
    .filter((argv) => argv[0] === 'node' && argv[1] === ESLINT_IN_WORKSPACE)
    .map((argv) => ({ ws: argv[2], args: argv.slice(3) }));
}
