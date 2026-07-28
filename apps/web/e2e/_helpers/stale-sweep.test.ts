import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { E2E_FIXTURE_TARGETS, PARENTS_WITH_SUBCOLLECTIONS, prefixEnd } from './stale-sweep';

/**
 * Drift backstop for the orphan sweep (#712).
 *
 * The sweep can only reclaim collections it knows about, and the suite gains new
 * fixtures regularly — a registry that silently falls behind reintroduces the
 * exact failure it exists to prevent. So: derive the truth from the per-spec
 * cleanups (which a new fixture cannot skip without leaking on green runs too)
 * and fail the build when the two disagree.
 *
 * This test must live in `apps/web`: turbo gives the `test` task no `inputs`, so
 * it hashes only the owning package's files. The same test in
 * `tools/test-fixtures` would read these sources off disk while being cache-hit
 * stale after every `apps/web` change — i.e. it would quietly stop failing.
 */
const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A collection swept by prefix, and the field the prefix is matched on. */
interface CleanupSite {
  collection: string;
  field: string;
  source: string;
}

function readSources(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.auth') continue;
      out.push(...readSources(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push({ path: full, text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/**
 * Every prefix-scoped cleanup in the suite. Three shapes, because two helpers
 * and a hand-rolled range query are all in use — `cleanupOperacoes` and
 * `cleanupConversas` inline their own query, and the latter is the only place
 * `chat` is swept at all.
 */
function findCleanupSites(): CleanupSite[] {
  const sites: CleanupSite[] = [];

  for (const { path, text } of readSources(E2E_DIR)) {
    if (path.endsWith('stale-sweep.ts') || path.endsWith('stale-sweep.test.ts')) continue;
    const source = path.slice(E2E_DIR.length + 1);

    for (const m of text.matchAll(/cleanupByNamePrefix\(\s*'([^']+)'/g)) {
      sites.push({ collection: m[1]!, field: 'nome', source });
    }
    for (const m of text.matchAll(/cleanupByFieldPrefix\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
      sites.push({ collection: m[1]!, field: m[2]!, source });
    }
    // Inline range query: `.collection('x') … .where('f', '>=', prefix)`. The
    // `.doc(` guard keeps a subcollection walk from being read as a root sweep.
    for (const m of text.matchAll(
      /\.collection\(\s*'([^']+)'\s*\)([\s\S]{0,240}?)\.where\(\s*'([^']+)'\s*,\s*'>='/g,
    )) {
      if (m[2]!.includes('.doc(')) continue;
      sites.push({ collection: m[1]!, field: m[3]!, source });
    }
  }

  return sites;
}

/**
 * Registered but with no cleanup call site, on purpose:
 *  - `arquivos` is swept by doc id only (its fields carry the prefix inside a
 *    filename, not as a value prefix) and is cleaned per-spec by captured id.
 *  - `cargos` / `usuarios` are created by `configuracoes.spec.ts`, which cleans
 *    up by captured id — precisely the cleanup a cancelled run loses, which is
 *    why they are registered here.
 */
const REGISTRY_ONLY = new Set(['arquivos', 'cargos', 'usuarios']);

describe('E2E_FIXTURE_TARGETS', () => {
  const sites = findCleanupSites();

  it('finds the cleanup sites it is meant to check', () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true.
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.map((s) => s.collection)).toContain('chat');
  });

  it('covers every collection the suite sweeps by prefix', () => {
    const registered = new Map(E2E_FIXTURE_TARGETS.map((t) => [t.collection, t]));
    const missing = sites.filter((s) => !registered.has(s.collection));
    expect(
      missing.map((s) => `${s.collection} (${s.source})`),
      'a collection cleaned per-run but absent from E2E_FIXTURE_TARGETS leaks forever ' +
        'when a run is cancelled — add it to the registry',
    ).toEqual([]);
  });

  it('matches on every field the suite sweeps on', () => {
    const registered = new Map(E2E_FIXTURE_TARGETS.map((t) => [t.collection, t]));
    const uncovered = sites.filter((s) => {
      const target = registered.get(s.collection);
      return target ? !(target.fields ?? []).includes(s.field) : false;
    });
    expect(
      uncovered.map((s) => `${s.collection}.${s.field} (${s.source})`),
      'the sweep matches different fields than the per-run cleanup, so UI-created ' +
        'rows with auto-ids would survive it',
    ).toEqual([]);
  });

  it('has no dead entries', () => {
    const swept = new Set(sites.map((s) => s.collection));
    const dead = E2E_FIXTURE_TARGETS.filter(
      (t) => !swept.has(t.collection) && !REGISTRY_ONLY.has(t.collection),
    );
    expect(dead.map((t) => t.collection)).toEqual([]);
  });

  it('is sorted and free of duplicates', () => {
    const names = E2E_FIXTURE_TARGETS.map((t) => t.collection);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('PARENTS_WITH_SUBCOLLECTIONS', () => {
  it('covers every parent the suite seeds subcollections under', () => {
    // Derived from `ALL_DOMAINS`, so a registry refactor could silently demote
    // one of these to a plain batch delete — which would leave its children
    // stranded under a deleted parent, unreachable from any root query (#257).
    for (const parent of ['pedidos', 'produtos', 'clientes', 'chat', 'operacao', 'filiais']) {
      expect(PARENTS_WITH_SUBCOLLECTIONS.has(parent), `${parent} must delete recursively`).toBe(
        true,
      );
    }
  });
});

describe('prefixEnd', () => {
  it('is the exact successor of the prefix, with no U+FFFF in a resource name', () => {
    expect(prefixEnd('e2e-')).toBe('e2e.');
    expect(prefixEnd('E2E-')).toBe('E2E.');
    expect(prefixEnd('e2e-30379616273-')).toBe('e2e-30379616273.');
  });

  it('bounds exactly the ids that start with the prefix', () => {
    const end = prefixEnd('e2e-');
    expect('e2e-' < end).toBe(true);
    expect('e2e-99999999-log-001' < end).toBe(true);
    // The first id that must fall outside the range.
    expect('e2e.' < end).toBe(false);
    expect('e2f' < end).toBe(false);
  });
});
