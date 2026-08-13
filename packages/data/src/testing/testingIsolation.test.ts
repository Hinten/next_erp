import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `src/testing/` is test-only. Nothing that ships may import it.
 *
 * The subpath has to live under `src/` because a package's `exports` map can
 * only point at paths that ship, and four workspaces import it. That makes the
 * separation a matter of import hygiene rather than of layout — which is
 * exactly the situation `adminBundleSafety.test.ts` exists for one directory
 * over, and for the same reason: a stray import here would be invisible until
 * something downstream shipped a test double to production.
 *
 * Scope note: this checks `packages/data`'s OWN modules. A consumer workspace
 * importing `@delfrance/data/testing` from shipped code is not visible from
 * here; that is what the subpath's name is for.
 */
const SRC_DIR = resolve(import.meta.dirname, '..');
const TESTING_DIR = import.meta.dirname;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFilesUnder(full);
    return entry.endsWith('.ts') || entry.endsWith('.tsx') ? [full] : [];
  });
}

/** Every module under `src/` that is neither test-only nor inside `src/testing/`. */
function shippedModules(): string[] {
  return tsFilesUnder(SRC_DIR).filter(
    (f) => !f.startsWith(TESTING_DIR) && !/\.test\.tsx?$/.test(f),
  );
}

/**
 * `import … from './testing'` / `'../testing/occTransaction'` /
 * `'@delfrance/data/testing'`, in any of the three spellings that pull a module
 * in at runtime: a plain import, a bare side-effect import, and `export … from`
 * (a re-export is an import that also widens the surface).
 */
const TESTING_IMPORT =
  /(?:^|\n)\s*(?:import|export)\b[^;]*?['"](?:@delfrance\/data\/testing|(?:\.{1,2}\/)+testing(?:\/[\w./-]*)?)['"]/;

const hasTestingImport = (source: string): boolean => TESTING_IMPORT.test(source);

describe('src/testing is test-only', () => {
  const modules = shippedModules();

  it('finds the modules to check (guards against an empty scan)', () => {
    // A vacuous pass is the failure mode this whole file is built to avoid.
    expect(modules.length).toBeGreaterThan(10);
  });

  it('is not imported by any shipped module in this package', () => {
    const offenders = modules
      .filter((f) => hasTestingImport(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC_DIR.length + 1).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('bites — the matcher catches each import spelling', () => {
    expect(hasTestingImport("import { OccEngine } from './testing';")).toBe(true);
    expect(hasTestingImport("import { OccEngine } from '../../testing/occTransaction';")).toBe(
      true,
    );
    expect(hasTestingImport("import '@delfrance/data/testing';")).toBe(true);
    expect(hasTestingImport("export { OccEngine } from './testing/index';")).toBe(true);
    expect(hasTestingImport("import {\n  OccEngine,\n} from './testing';")).toBe(true);
    // Near misses that must NOT trip it.
    expect(hasTestingImport("import { x } from './testingUtils';")).toBe(false);
    expect(hasTestingImport("// see './testing' for the OCC engine")).toBe(false);
  });
});
