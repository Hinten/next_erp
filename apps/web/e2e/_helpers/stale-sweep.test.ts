import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2E_FIXTURE_TARGETS, prefixEnd, sweepOrphanedE2EFixtures } from './stale-sweep';

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

/**
 * Every write the sweep attempts, so a "dry" run can be shown to make none.
 *
 * `recursiveDeletes` is still recorded even though nothing should ever land in
 * it — that is the point. It is the tripwire for #728/#729: `recursiveDelete`
 * issues a kindless all-descendants query that Firestore Enterprise cannot
 * index, and reintroducing it here would silently cost ~5,123 read units per
 * swept produto, four times per push, with no runtime signal whatsoever.
 */
interface Writes {
  batchDeletes: string[];
  commits: number;
  recursiveDeletes: string[];
  sets: string[];
}

/**
 * Minimal Firestore stand-in. Returns `docs` for any query against a named
 * collection and records every mutating call. `previousRunId` is what the
 * concurrency-group marker reports, which is what drives Pass A.
 */
function fakeDb(
  writes: Writes,
  docs: Record<string, string[]>,
  previousRunId: string,
  /** Subcollections a swept doc owns, keyed by doc path. Drives `listCollections()`. */
  subcollections: Record<string, Record<string, readonly string[]>> = {},
  /** Every `select(...)` the sweep built, paired with its `where` fields. */
  projections: Array<{ wheres: unknown[]; selected: unknown[] }> = [],
) {
  const oneDayAgo = () => Date.now() - 24 * 60 * 60 * 1000;

  // A swept doc is reached twice: once as a candidate (from the root query) and
  // once by the subtree walk, which calls `listCollections()` on its ref. Both
  // paths must hand back the same shape.
  const docRef = (path: string) => ({
    path,
    parent: { id: path.slice(0, path.lastIndexOf('/')) },
    listCollections: () =>
      Promise.resolve(
        Object.keys(subcollections[path] ?? {}).map((child) => collectionRef(`${path}/${child}`)),
      ),
  });

  const idsAt = (path: string) => {
    if (!path.includes('/')) return docs[path] ?? [];
    const parent = path.slice(0, path.lastIndexOf('/'));
    const child = path.slice(path.lastIndexOf('/') + 1);
    return subcollections[parent]?.[child] ?? [];
  };

  const snapshotFor = (path: string) => {
    const ids = idsAt(path);
    return {
      empty: ids.length === 0,
      size: ids.length,
      docs: ids.map((id) => ({
        id,
        ref: docRef(`${path}/${id}`),
        createTime: { toMillis: oneDayAgo },
      })),
    };
  };

  const query = (path: string) => {
    // Per-query so `projections` can pair each `select(...)` with the `where`
    // fields that preceded it — that pairing is the whole point of the
    // keyset-cursor pin below.
    const wheres: unknown[] = [];
    const q: Record<string, unknown> = {
      where: (field: unknown) => {
        wheres.push(field);
        return q;
      },
      limit: () => q,
      startAfter: () => q,
      select: (...fields: unknown[]) => {
        // Every built chain terminates at `select`, so recording and then
        // clearing groups the `where`s with the query they belong to. Without
        // the reset they accumulate across chains (the fake threads one object
        // per collection) and an id range looks like a field range.
        projections.push({ wheres: [...wheres], selected: fields });
        wheres.length = 0;
        return q;
      },
      get: () => Promise.resolve(snapshotFor(path)),
    };
    return q;
  };

  const collectionRef = (path: string) => ({ path, ...query(path) });

  return {
    collection: (name: string) => ({
      ...query(name),
      doc: (id: string) => ({
        get: () => Promise.resolve({ get: () => previousRunId }),
        set: () => {
          writes.sets.push(`${name}/${id}`);
          return Promise.resolve();
        },
      }),
    }),
    batch: () => ({
      delete: (ref: { path: string }) => writes.batchDeletes.push(ref.path),
      commit: () => {
        writes.commits += 1;
        return Promise.resolve();
      },
    }),
    bulkWriter: () => ({
      delete: (ref: { path: string }) => {
        writes.batchDeletes.push(ref.path);
        return Promise.resolve();
      },
      close: () => {
        writes.commits += 1;
        return Promise.resolve();
      },
    }),
    recursiveDelete: (ref: { path: string }) => {
      writes.recursiveDeletes.push(ref.path);
      return Promise.resolve();
    },
  };
}

describe('sweepOrphanedE2EFixtures dry run', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const noWrites = (): Writes => ({
    batchDeletes: [],
    commits: 0,
    recursiveDeletes: [],
    sets: [],
  });

  // `depositos` carries no subcollections, `pedidos` does — both have to stay
  // quiet under `dryRun`, and both go through the same subtree walk now.
  const staleDocs = { depositos: ['e2e-111-dep-001'], pedidos: ['e2e-111-ped-001'] };
  const staleSubcollections = {
    'pedidos/e2e-111-ped-001': { itens: ['it-1'], historicoEstadoPedido: ['h-1'] },
  };

  function stubCiEnv() {
    vi.stubEnv('GITHUB_WORKFLOW', 'e2e-vendas');
    vi.stubEnv('GITHUB_REF', 'refs/pull/715/merge');
    vi.stubEnv('GITHUB_RUN_ID', '222');
  }

  it('issues no writes at all — not even the concurrency-group marker', async () => {
    stubCiEnv();
    const writes = noWrites();

    const report = await sweepOrphanedE2EFixtures(
      true,
      fakeDb(writes, staleDocs, '111', staleSubcollections) as never,
    );

    // It must still find and report the candidates…
    expect(report.deleted).toBeGreaterThan(0);
    // …while touching nothing. Both passes take the same flag: forwarding it to
    // only one of them is what made `sweep:e2e` delete while reporting
    // "would delete" (#715 review).
    expect(writes).toEqual(noWrites());
  });

  /**
   * A field-range query implies `orderBy(<field>)`, and `collectPage` paginates
   * with `startAfter(<last snapshot>)`. Firestore rejects that cursor outright —
   * *"Field \"nome\" is missing in the provided DocumentSnapshot"* — unless the
   * snapshot carries the ordered field, so a keys-only projection blew the whole
   * sweep up on its SECOND page.
   *
   * It hid for as long as every prefix matched under `PAGE_SIZE` docs, which is
   * why this pins the PROJECTION rather than trying to stage 300+ fake docs: the
   * projection is the actual invariant, and it holds on page one too.
   */
  it('projects the ordered field on a field-range query, so the keyset cursor is valid', async () => {
    stubCiEnv();
    const projections: Array<{ wheres: unknown[]; selected: unknown[] }> = [];

    await sweepOrphanedE2EFixtures(
      true,
      fakeDb(noWrites(), staleDocs, '111', staleSubcollections, projections) as never,
    );

    const fieldRanges = projections.filter((p) =>
      p.wheres.some((w) => typeof w === 'string' && w.length > 0),
    );
    expect(fieldRanges.length).toBeGreaterThan(0);
    for (const p of fieldRanges) {
      const campo = p.wheres.find((w): w is string => typeof w === 'string');
      expect(p.selected).toEqual([campo]);
    }
    // …and the id range stays keys-only: a document key is always on the
    // snapshot, so projecting a field there would be pure scanned-data waste.
    const idRanges = projections.filter(
      (p) => !p.wheres.some((w) => typeof w === 'string' && w.length > 0),
    );
    expect(idRanges.length).toBeGreaterThan(0);
    for (const p of idRanges) expect(p.selected).toEqual([]);
  });

  it('does delete once the flag is off, so the assertion above is not vacuous', async () => {
    stubCiEnv();
    const writes = noWrites();

    await sweepOrphanedE2EFixtures(
      false,
      fakeDb(writes, staleDocs, '111', staleSubcollections) as never,
    );

    expect(writes.batchDeletes).toContain('depositos/e2e-111-dep-001');
    expect(writes.batchDeletes).toContain('pedidos/e2e-111-ped-001');
    expect(writes.sets).toContain('e2e_runMarkers/e2e-vendas__refs_pull_715_merge');
  });

  it('reclaims the subcollections under a swept fixture, not just the parent doc', async () => {
    // Firestore never cascades. A parent-only delete strands these under a
    // deleted doc where no root query can ever reach them again (#257) — which
    // is exactly what happened to `metodo_pgto/{id}/credenciais` for as long as
    // the sweep asked `ALL_DOMAINS` which parents had children.
    stubCiEnv();
    const writes = noWrites();

    await sweepOrphanedE2EFixtures(
      false,
      fakeDb(writes, staleDocs, '111', staleSubcollections) as never,
    );

    expect(writes.batchDeletes).toContain('pedidos/e2e-111-ped-001/itens/it-1');
    expect(writes.batchDeletes).toContain('pedidos/e2e-111-ped-001/historicoEstadoPedido/h-1');
  });

  it('reports candidates the wall-clock budget left behind instead of silently dropping them', async () => {
    // `deleted: 12, remaining: 0` reads as "nothing left" when there may be
    // hundreds — the same silent-truncation trap the per-collection cap already
    // guards against. A deadline already in the past cuts the delete phase off
    // before its first document.
    stubCiEnv();
    const writes = noWrites();

    const report = await sweepOrphanedE2EFixtures(
      false,
      fakeDb(writes, staleDocs, '111', staleSubcollections) as never,
      Date.now() - 1,
    );

    expect(report.deleted).toBe(0);
    expect(report.remaining).toBeGreaterThan(0);
    expect(writes.batchDeletes).toEqual([]);
  });

  it('NEVER calls recursiveDelete — it is unindexable on Enterprise (#728/#729)', async () => {
    // The regression guard. `db.recursiveDelete` issues a kindless
    // all-descendants query: no index can serve it, nothing throws, and the only
    // symptom is ~5,123 read units per swept produto on the invoice. It is a
    // one-word change away at all times, so the fake keeps recording it.
    stubCiEnv();
    const writes = noWrites();

    await sweepOrphanedE2EFixtures(
      false,
      fakeDb(writes, staleDocs, '111', staleSubcollections) as never,
    );

    expect(writes.recursiveDeletes).toEqual([]);
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
