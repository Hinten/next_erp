import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repo invariant: `@delfrance/ai`'s ROOT entry never reaches a server-only SDK.
 *
 * `packages/ai` ships two entries. `./admin` may pull `@google/genai` and
 * `firebase-admin`; the root `.` may not, because `apps/web` reaches it
 * **transitively** — `@delfrance/integrations-mercado-livre` re-exports
 * `AiPromptRequest`/`AiInlineImage`/`JsonSchemaNode` from it, and that package is
 * imported by the produto and medidas screens.
 *
 * ## Why this is a test and not a comment
 *
 * The header of `packages/ai/src/index.ts` states the rule and calls a violation
 * "a silent bundle regression", which is exactly right and exactly why a comment
 * is not enough: **nothing fails when it breaks**. `apps/web` still typechecks,
 * still lints, still passes its suite, still builds — it just starts shipping the
 * Firebase Admin SDK to the browser. The person who breaks it will be adding a
 * legitimate-looking export to `src/index.ts`, which is the least suspicious edit
 * in the package.
 *
 * The repo has a precedent for exactly this shape. `apphosting-next-pinned.test.js`
 * exists because PR #410's fix was silently undone by the catalog migration and
 * nobody noticed for months — an invariant that is stated, true today, and
 * invisible when violated. Same signature here.
 *
 * A test rather than an ESLint rule because the invariant is **transitive**: it is
 * not "this file must not import X" but "nothing reachable from this entry may
 * import X", and ESLint sees one file at a time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const aiSrc = resolve(repoRoot, 'packages/ai/src');

/** Packages the root entry must never reach, at any depth. */
const SERVER_ONLY = ['@google/genai', 'firebase-admin'];

/** `import … from 'x'`, `export … from 'x'`, and `import('x')`. */
const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function specifiersOf(file) {
  const source = readFileSync(file, 'utf8');
  const out = [];
  for (const m of source.matchAll(SPECIFIER)) out.push(m[1]);
  return out;
}

/** Resolve a relative specifier to a real file, trying the usual suffixes. */
function resolveLocal(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

/**
 * Every file reachable from `entry` by local imports, plus every bare package
 * specifier seen along the way.
 */
function walk(entry) {
  const seen = new Set();
  const bare = new Map(); // specifier → the file that imported it
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('.')) {
        const next = resolveLocal(file, specifier);
        // A local import that does not resolve is a real problem, but not this
        // test's problem — typecheck already fails on it.
        if (next) queue.push(next);
        continue;
      }
      if (!bare.has(specifier)) bare.set(specifier, file);
    }
  }
  return { files: seen, bare };
}

describe('@delfrance/ai — the root entry stays browser-safe', () => {
  it('reaches no server-only SDK, at any depth', () => {
    const { bare } = walk(resolve(aiSrc, 'index.ts'));

    const offenders = [...bare]
      .filter(([spec]) => SERVER_ONLY.some((p) => spec === p || spec.startsWith(`${p}/`)))
      .map(([spec, file]) => `${spec} (imported by ${file.slice(repoRoot.length + 1)})`);

    expect(
      offenders,
      'packages/ai/src/index.ts must not reach @google/genai or firebase-admin — ' +
        'apps/web imports this entry transitively through ' +
        '@delfrance/integrations-mercado-livre, so anything reachable here ships to ' +
        'the browser. Move the module under src/admin/ and export it from ' +
        'src/admin/index.ts instead.',
    ).toEqual([]);
  });

  it('the walk actually reaches the modules it is meant to police', () => {
    // Guards the guard: a resolver that silently returns null for every local
    // import would make the assertion above vacuously true, and this test would
    // keep passing while checking nothing.
    const { files } = walk(resolve(aiSrc, 'index.ts'));
    const names = [...files].map((f) => f.slice(aiSrc.length + 1).replaceAll('\\', '/'));

    expect(names).toContain('index.ts');
    expect(names).toContain('models.ts');
    expect(names).toContain('prompt.ts');
    expect(names).toContain('text.ts');
    expect(names).toContain('singleFlight.ts');
  });

  it('the admin entry DOES reach them — the split is real, not accidental', () => {
    // If this ever came back empty, the root entry passing would prove nothing:
    // it would mean the package had simply stopped using the SDKs anywhere.
    const { bare } = walk(resolve(aiSrc, 'admin/index.ts'));
    const reached = SERVER_ONLY.filter((p) =>
      [...bare.keys()].some((spec) => spec === p || spec.startsWith(`${p}/`)),
    );
    expect(reached.sort()).toEqual([...SERVER_ONLY].sort());
  });
});
