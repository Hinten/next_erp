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
 * Every query the sweep actually executed, with the projection it asked for.
 *
 * Exists for #960: the field-range query MUST project its order key or the
 * snapshot cursor cannot be built, while the id-range query must stay keys-only.
 * A fake cannot reproduce the SDK's `_extractFieldValues` throw — that is real
 * SDK code this never runs — so the guard is "was the query built correctly",
 * which is the regression a human would actually reintroduce.
 */
interface QueryLog {
  /** `fields` is `.select(...)`'s arguments — `[]` means keys-only. */
  gets: Array<{ path: string; fields: string[] }>;
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
  /** Every `.get()`-ed query, in order — see {@link QueryLog}. Optional. */
  queryLog?: QueryLog,
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

  /** Chain state. Each builder returns a NEW query so pages don't share a cursor. */
  interface QueryState {
    after?: string;
    take?: number;
    fields: string[];
  }

  const snapshotFor = (path: string, state: QueryState) => {
    const all = idsAt(path);
    const from = state.after === undefined ? 0 : all.indexOf(state.after) + 1;
    const ids = all.slice(from, state.take === undefined ? undefined : from + state.take);
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

  // A broken cursor makes `collectPage` re-request page 1 forever. That loop is
  // pure microtasks (`Promise.resolve`), so it starves the event loop and
  // vitest's own `testTimeout` — a macrotask timer — never fires: the run HANGS
  // instead of failing. This ceiling converts that into a legible failure.
  // Generous on purpose: a full sweep is ~20 targets x 2 passes x <=3 queries.
  const MAX_GETS = 400;
  let gets = 0;

  // ⚠️ `startAfter` HONOURS its argument and `select` RECORDS its arguments.
  // The previous fake made both no-ops, which meant `collectPage`'s paging loop
  // was never exercised by any test — and a naive >PAGE_SIZE fixture would have
  // spun forever (same page returned every time, `size < PAGE_SIZE` never true)
  // instead of failing. That blind spot is why #960 shipped.
  const query = (path: string, state: QueryState = { fields: [] }) => {
    const q: Record<string, unknown> = {
      where: () => query(path, state),
      limit: (take: number) => query(path, { ...state, take }),
      startAfter: (cursor: { id?: string }) => query(path, { ...state, after: cursor?.id }),
      select: (...fields: string[]) => query(path, { ...state, fields }),
      get: () => {
        if ((gets += 1) > MAX_GETS) {
          throw new Error(
            `fakeDb: ${MAX_GETS} queries exceeded on "${path}" — the paging loop is not ` +
              'advancing. Almost always `startAfter` no longer honours its cursor.',
          );
        }
        queryLog?.gets.push({ path, fields: state.fields });
        return Promise.resolve(snapshotFor(path, state));
      },
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

  /**
   * Pin Pass A (predecessor reclaim) OFF. `concurrencyGroupId()` returns null
   * when either var is falsy, and it is the only thing gating that pass.
   *
   * ⚠️ Needed because a test cannot rely on these being ABSENT: GitHub Actions
   * sets all three for real, so "I did not call `stubCiEnv`" means one pass
   * locally and two in CI. That is precisely how the paging test below first
   * shipped green here and failed with `expected 602 to be 301` on the runner.
   */
  function stubNoCiEnv() {
    vi.stubEnv('GITHUB_WORKFLOW', '');
    vi.stubEnv('GITHUB_REF', '');
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

  // ---- #960 ---------------------------------------------------------------
  // The field-range query was keys-only while its inequality forced an implicit
  // `orderBy(nome)`, so `collectPage`'s SNAPSHOT cursor could not be built and
  // `startAfter` threw on the SECOND page — killing globalSetup for every PR.

  it('projects the order key on a field range, and keeps the id range keys-only (#960)', () => {
    stubNoCiEnv();
    const log: QueryLog = { gets: [] };

    return sweepOrphanedE2EFixtures(
      true,
      fakeDb(noWrites(), { depositos: ['e2e-111-dep-001'] }, '111', {}, log) as never,
    ).then(() => {
      const depositos = log.gets.filter((g) => g.path === 'depositos');

      // The id range stays keys-only on purpose: its only order key is
      // `__name__`, which the SDK reads off `snapshot.ref` — that survives an
      // empty projection, so this is both correct and the cheapest possible.
      expect(depositos).toContainEqual({ path: 'depositos', fields: [] });

      // The field range must carry `nome`, or the cursor cannot be built.
      // `depositos` declares `fields: ['nome']` in E2E_FIXTURE_TARGETS.
      expect(depositos).toContainEqual({ path: 'depositos', fields: ['nome'] });
    });
  });

  it('pages past PAGE_SIZE instead of stopping at, or spinning on, the first page (#960)', async () => {
    // 301 > PAGE_SIZE (300), so this needs exactly two pages. It is also the
    // guard on the FAKE: if `startAfter` ever stops honouring its cursor, page 2
    // repeats page 1 forever and this test hangs rather than quietly passing.
    const ids = Array.from({ length: 301 }, (_, i) => `e2e-111-dep-${String(i).padStart(4, '0')}`);

    // Pass A pinned OFF, so the count below is unambiguously ONE pass over one
    // collection. Merely omitting `stubCiEnv()` is not enough — see the helper.
    stubNoCiEnv();
    const report = await sweepOrphanedE2EFixtures(
      true,
      fakeDb(noWrites(), { depositos: ids }, '111') as never,
    );

    expect(report.byCollection.depositos).toBe(301);
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
