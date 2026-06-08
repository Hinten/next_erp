import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hoists `.env` + `.env.local` from the monorepo root into a record
// suitable for vitest's `test.env`. The shell environment (process.env)
// is layered on top by callers, so a one-off
// `$env:NFE_CERT_BASE64 = '…'` still wins.
//
// Why this lives here instead of in each `vitest.config.ts`:
// `apps/nfe` + `packages/integrations/nfe` both need the same logic to
// run live SEFAZ homologação tests without a `dotenv -e ../../.env.local`
// wrapper at every call site. Keeping the parser in one file means the
// path-resolution rules (which keys are filesystem-paths, what they
// resolve against) stay in lockstep across both configs.

/**
 * @param {string} file
 * @returns {Record<string, string>}
 */
function parseDotenv(file) {
  if (!existsSync(file)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Walks up from `startDir` until it finds the directory containing
 * `pnpm-workspace.yaml`. Throws if it walks off the filesystem root —
 * means the helper is being called from outside the monorepo.
 * @param {string} startDir
 * @returns {string}
 */
function findRepoRoot(startDir) {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`@delfrance/config-vitest: could not find pnpm-workspace.yaml above ${startDir}`);
}

/**
 * Load `.env` + `.env.local` from the monorepo root.
 *
 * `.env.local` overrides `.env`. Callers typically spread the result
 * before `process.env` so the shell wins:
 *   `env: { ...loadRepoRootEnv({ configFileUrl: import.meta.url }), ...process.env }`
 *
 * @param {object} options
 * @param {string} options.configFileUrl
 *   Pass `import.meta.url` from the caller's `vitest.config.ts`.
 *   The repo root is discovered by walking up from this file.
 * @param {readonly string[]} [options.resolveRelativePaths]
 *   Env keys whose values are filesystem paths and should be resolved
 *   against the repo root when relative. Example: `NFE_CERT_PATH` —
 *   users write `./.ignore/cert.pfx` thinking from the project root,
 *   not vitest's CWD (the package dir). Absolute paths pass through.
 * @returns {Record<string, string>}
 */
export function loadRepoRootEnv(options) {
  const configDir = dirname(fileURLToPath(options.configFileUrl));
  const repoRoot = findRepoRoot(configDir);
  /** @type {Record<string, string>} */
  const env = {
    ...parseDotenv(resolve(repoRoot, '.env')),
    ...parseDotenv(resolve(repoRoot, '.env.local')),
  };
  for (const key of options.resolveRelativePaths ?? []) {
    const value = env[key];
    if (value && !isAbsolute(value)) {
      env[key] = resolve(repoRoot, value);
    }
  }
  return env;
}
