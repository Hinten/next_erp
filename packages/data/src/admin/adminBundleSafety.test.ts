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

/** Drop block and line comments — prose in this subtree names firebase-admin constantly. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Every `firebase-admin` import in `source` that is NOT `import type`.
 *
 * Matched over the whole (comment-stripped) source rather than line by line,
 * because a runtime import can be spread across lines exactly like a type one:
 *
 * ```ts
 * import {
 *   getFirestore,      // ← a per-line scan that skips the `} from …` line
 * } from 'firebase-admin/firestore';   //   misses this entirely
 * ```
 *
 * Also catches a bare side-effect import (`import 'firebase-admin/…'`), which
 * has no `from` clause at all but still pulls the module in at runtime.
 */
function firebaseAdminOffenders(source: string): string[] {
  const src = stripComments(source);
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

  // The import clause may span newlines but must not run past the end of its
  // own statement, so it can contain neither a `;` nor a second `import`.
  // Without that bound the match happily starts at an EARLIER import and
  // swallows it, reporting `import {x} from 'zod'; import type {...}` as a
  // non-type import — a false positive on every file that imports anything
  // before firebase-admin.
  const withClause = [
    ...src.matchAll(/import\s+((?:(?!\bimport\b)[^;])*?)\s*from\s*['"]firebase-admin[^'"]*['"]/g),
  ]
    .filter((m) => !/^type\b/.test(m[1]!.trim()))
    .map((m) => normalize(m[0]));

  const sideEffect = [...src.matchAll(/import\s*['"]firebase-admin[^'"]*['"]/g)].map((m) =>
    normalize(m[0]),
  );

  return [...withClause, ...sideEffect];
}

describe('packages/data admin subtree bundle safety', () => {
  // This file is excluded from its own scan: the detector-fixture cases below
  // are violation samples held as string literals, and a source-text scan
  // cannot tell those from the real thing.
  const files = tsFilesUnder(ADMIN_DIR).filter((f) => !f.endsWith('adminBundleSafety.test.ts'));

  it('finds the admin modules to check (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.slice(f.indexOf('src/')), f] as const))(
    '%s imports firebase-admin as types only',
    (_label, file) => {
      expect(firebaseAdminOffenders(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );

  // A guard that cannot fail is worse than no guard — it manufactures
  // confidence. These pin the detector itself against the shapes a real
  // violation takes, including the multi-line one an earlier per-line version
  // of this check let through.
  describe('the detector itself', () => {
    it.each([
      ['single-line runtime import', `import { getFirestore } from 'firebase-admin/firestore';`],
      [
        'multi-line runtime import',
        `import {\n  getFunctions,\n} from 'firebase-admin/functions';`,
      ],
      ['namespace import', `import * as admin from 'firebase-admin';`],
      ['default import', `import admin from 'firebase-admin';`],
      ['bare side-effect import', `import 'firebase-admin/firestore';`],
    ])('flags a %s', (_label, src) => {
      expect(firebaseAdminOffenders(src)).toHaveLength(1);
    });

    it.each([
      ['single-line type import', `import type { Firestore } from 'firebase-admin/firestore';`],
      [
        'multi-line type import',
        `import type {\n  CollectionReference,\n  Firestore,\n} from 'firebase-admin/firestore';`,
      ],
      ['a runtime import of another package', `import { z } from 'zod';`],
      ['prose in a line comment', `// never import getFirestore from 'firebase-admin/firestore'`],
      [
        'prose in a block comment',
        `/**\n * import { getFirestore } from 'firebase-admin/firestore';\n */`,
      ],
    ])('accepts %s', (_label, src) => {
      expect(firebaseAdminOffenders(src)).toEqual([]);
    });
  });

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
