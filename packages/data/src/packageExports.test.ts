import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `exports` map is the package's public surface, and it is the ONE part of
 * this workspace that no other tool checks: `tsc` never reads it (every intra-
 * package import is relative), and a subpath with no consumer yet — a freshly
 * added primitive, say — would ship broken and stay invisible until the first
 * app tried to import it.
 *
 * So: every declared target must exist on disk.
 */
const PKG_DIR = resolve(import.meta.dirname, '..');

interface PackageManifest {
  readonly exports: Readonly<Record<string, unknown>>;
}

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as PackageManifest;
const entries = Object.entries(pkg.exports);

describe('@delfrance/data exports map', () => {
  it('finds the subpaths to check (guards against an empty read)', () => {
    expect(entries.length).toBeGreaterThan(5);
  });

  it('declares every target as a plain string', () => {
    // A conditional-exports object would silently skip the existence check below.
    const nonString = entries.filter(([, target]) => typeof target !== 'string');
    expect(nonString).toEqual([]);
  });

  it.each(entries)('%s points at a file that exists', (_subpath, target) => {
    expect(existsSync(join(PKG_DIR, String(target)))).toBe(true);
  });

  it('bites — a bogus target does not exist', () => {
    expect(existsSync(join(PKG_DIR, './src/admin/definitely-not-a-module.ts'))).toBe(false);
  });

  it('keeps the admin subpaths consumers import', () => {
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining([
        '.',
        './admin',
        './admin/cache',
        './admin/clientes',
        './admin/collections',
        './admin/notifications',
      ]),
    );
  });
});
