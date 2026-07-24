import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `@delfrance/data` must never pull `firebase-admin` into a bundle.
 *
 * Every `firebase-admin` import under `src/admin/` is `import type` only —
 * erased at emit by `verbatimModuleSyntax` + `isolatedModules` — and no module
 * here makes a runtime `firebase-admin` call: they operate on the `db` the app
 * passes in. `defineAdminCollection.ts` documents this for itself; this test
 * makes it a property of the whole subtree.
 *
 * It matters beyond bundle size. `packages/data` is imported by `apps/web`
 * (client-first, `@delfrance/data` + `@delfrance/data/hooks`), and while the
 * `./admin` subpaths aren't reachable from there today, that separation rests on
 * import hygiene rather than on tooling. A runtime import added here would be
 * invisible until something downstream broke.
 *
 * This test is why the shared notification pipeline is transport-agnostic and
 * the per-channel Cloud Tasks schedulers (`mlTasks`/`mpTasks`/`waTasks`) stay in
 * their apps: unifying them would need a runtime `firebase-admin/functions`
 * import, which is exactly what this forbids.
 */

const ADMIN_DIR = join(import.meta.dirname, '.');

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFilesUnder(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

describe('packages/data admin subtree bundle safety', () => {
  const files = tsFilesUnder(ADMIN_DIR);

  it('finds the admin modules to check (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.slice(f.indexOf('src/')), f] as const))(
    '%s imports firebase-admin as types only',
    (_label, file) => {
      const source = readFileSync(file, 'utf8');
      const offenders = source
        .split('\n')
        .map((line) => line.trimStart())
        // Prose mentions firebase-admin constantly in this subtree.
        .filter((line) => !line.startsWith('//') && !line.startsWith('*'))
        .filter((line) => /from ['"]firebase-admin/.test(line))
        .filter((line) => !line.startsWith('import type'))
        // A multi-line `import type { … } from 'firebase-admin/…'` puts its
        // `from` clause on its own line; the `import type` head is above it.
        .filter((line) => !line.startsWith('}'));
      expect(offenders).toEqual([]);
    },
  );

  it.each(files.map((f) => [f.slice(f.indexOf('src/')), f] as const))(
    '%s makes no runtime firebase-admin call',
    (_label, file) => {
      const source = readFileSync(file, 'utf8');
      // `getFirestore` / `getFunctions` / `getStorage` / `initializeApp` are the
      // entry points that would bind a real SDK instance in here instead of
      // taking one from the caller.
      expect(source).not.toMatch(/\b(getFirestore|getFunctions|getStorage|initializeApp)\s*\(/);
    },
  );
});
