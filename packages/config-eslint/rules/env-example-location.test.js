import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repo convention: ONE `.env.example`, at the repo root. Every app's dev
 * server loads the repo-root `.env.local` (`dotenv -e ../../.env.local`), so
 * an app-level `.env.example` documents vars in a place nothing reads — and
 * drifts. This backstop is a test rather than an ESLint rule because ESLint
 * only parses JS/TS and never sees `.env.example` files; failing the test
 * fails CI exactly like a lint error would.
 *
 * `ALLOWED_LEGACY` grandfathers the offenders that predate the convention's
 * enforcement — #730 burns the list down to empty. Add NOTHING new here:
 * new vars go into the ROOT `.env.example`, in an app-titled section.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALLOWED_LEGACY = new Set([
  'apps/melhor-envio/.env.example',
  'apps/mercado-pago/.env.example',
  'apps/nfe/.env.example',
  'apps/nfe/functions/.env.example',
  'apps/whatsapp/.env.example',
]);

// Directories that are generated, vendored, or contain nested repo copies
// (`.claude` holds git worktrees in the main checkout).
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.ignore',
  '.secrets',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'generated',
]);

function findEnvExamples(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findEnvExamples(join(dir, entry.name), out);
    } else if (entry.name === '.env.example') {
      out.push(relative(REPO_ROOT, join(dir, entry.name)).split('\\').join('/'));
    }
  }
  return out;
}

describe('.env.example location convention', () => {
  it('allows only the repo-root .env.example (plus the #730 legacy allow-list)', () => {
    const found = findEnvExamples(REPO_ROOT);
    const offenders = found.filter((p) => p !== '.env.example' && !ALLOWED_LEGACY.has(p));
    expect(
      offenders,
      [
        'App-level .env.example files are not allowed — the repo convention is ONE',
        'root .env.example (apps load the repo-root .env.local via dotenv).',
        'Move these vars into an app-titled section of the ROOT .env.example and',
        'delete the file (see #730):',
        ...offenders.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
    // The root file itself must exist — the convention has an anchor.
    expect(found).toContain('.env.example');
  });

  it('the legacy allow-list only shrinks (#730): every entry still exists', () => {
    // A consolidated file whose entry lingers here would silently re-allow a
    // future regression at that path — force the entry's removal in the same
    // change that deletes the file.
    const found = new Set(findEnvExamples(REPO_ROOT));
    const stale = [...ALLOWED_LEGACY].filter((p) => !found.has(p));
    expect(stale, `Remove consolidated entries from ALLOWED_LEGACY: ${stale.join(', ')}`).toEqual(
      [],
    );
  });
});
