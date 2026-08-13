import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type RequiredIndex,
  formatIndexJson,
  indexSatisfies,
} from '@delfrance/config-eslint/rules/lib/required-index.js';

/**
 * Guardrails for the failures-only notification pipeline (#684 / follow-up to
 * #360).
 *
 * #360 collapsed three hand-rolled persist/retry/sweep copies into
 * `defineNotificationPipeline`. Skills document the pattern; these tests
 * enforce the two structural invariants that keep it collapsed:
 *
 *   B. every admin `notificacoes*` collection handle is wired into a
 *      `defineNotificationPipeline({ collection: <ident> })` call somewhere
 *      outside this package's notification core — explicit `collection: name`
 *      only; property-shorthand `collection,` (used by synthetic pipeline
 *      tests) is intentionally ignored. A new channel that hand-rolls its
 *      own store without the shared disposition matrix fails CI;
 *   C. every such collection has its `(status ASC, processedAt ASC)` composite
 *      in `firestore.indexes.json`. Enterprise auto-creates zero indexes and
 *      does NOT throw on an unindexed query — it silently full-scans and
 *      bills data scanned. `delfrance/default-query-needs-index` cannot cover
 *      these collections (no `meta.defaultQuery`, not in `ALL_DOMAINS`).
 *
 * Shape mirrors `adminBundleSafety.test.ts`: source-text discovery + detector
 * self-pins so a broken glob cannot manufacture a green run.
 */

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = resolve(THIS_DIR, '..');
const COLLECTIONS_DIR = join(ADMIN_DIR, 'collections');
const NOTIFICATIONS_DIR = join(ADMIN_DIR, 'notifications');

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find pnpm-workspace.yaml above ' + startDir);
}

const REPO_ROOT = findRepoRoot(THIS_DIR);

/** Directories we never descend into while walking the monorepo for consumers. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.git',
  '.old',
]);

interface NotificacoesHandle {
  handleName: string;
  path: string;
  file: string;
}

const SCHEMAS_SRC = join(REPO_ROOT, 'packages', 'schemas', 'src');

/**
 * Resolve a `path:` argument that points at `someMeta.collectionPath` by
 * reading the schema source that exports that meta. Prefer this over a
 * runtime import so the guardrail stays a pure source scan (no firebase-admin).
 */
function resolveMetaCollectionPath(metaName: string): string | null {
  if (!existsSync(SCHEMAS_SRC)) return null;
  for (const file of tsFilesUnder(SCHEMAS_SRC)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes(`export const ${metaName}`)) continue;
    // The meta object is small; take the first collectionPath after the export.
    const re = new RegExp(
      `export\\s+const\\s+${metaName}\\b[\\s\\S]*?collectionPath\\s*:\\s*['"]([^'"]+)['"]`,
    );
    const m = src.match(re);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Path string for a collection module: either a string literal
 * (`path: 'notificacoesX'`) or a meta reference (`path: xMeta.collectionPath`).
 * Returns null when neither form is present.
 */
function collectionPathOf(src: string): string | null {
  const lit = src.match(/\bpath\s*:\s*['"]([^'"]+)['"]/);
  if (lit) return lit[1]!;
  const meta = src.match(/\bpath\s*:\s*(\w+)\.collectionPath\b/);
  if (!meta) return null;
  return resolveMetaCollectionPath(meta[1]!);
}

/**
 * Every `defineAdminCollection` whose `path` is a top-level `notificacoes*`
 * collection — the failures-only store each channel owns.
 *
 * Matched over the collections registry sources rather than the barrel exports
 * so a handle that exists but is not yet re-exported still participates (and
 * still needs a pipeline + index). Path may be a string literal (ML/MP) or
 * `*Meta.collectionPath` (WhatsApp) — both are resolved.
 */
function discoverNotificacoesHandles(): NotificacoesHandle[] {
  const out: NotificacoesHandle[] = [];
  for (const entry of readdirSync(COLLECTIONS_DIR)) {
    if (entry === 'index.ts' || !entry.endsWith('.ts')) continue;
    const file = join(COLLECTIONS_DIR, entry);
    const src = readFileSync(file, 'utf8');
    const path = collectionPathOf(src);
    if (!path || !path.startsWith('notificacoes')) continue;
    const handleMatch = src.match(/export\s+const\s+(\w+)\s*=\s*defineAdminCollection\s*\(/);
    if (!handleMatch) {
      throw new Error(
        `${entry} declares path '${path}' but has no \`export const X = defineAdminCollection(\``,
      );
    }
    out.push({ handleName: handleMatch[1]!, path, file });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Extract handle names passed as `collection: <ident>` to
 * `defineNotificationPipeline(...)` in a source string.
 *
 * Only the explicit `collection: name` form is accepted — property shorthand
 * (`collection,`) is the synthetic-channel test shape and is intentionally
 * ignored so unit-test fakes never count as production coverage.
 */
export function pipelineCollectionRefs(source: string): string[] {
  if (!source.includes('defineNotificationPipeline')) return [];
  const refs: string[] = [];
  // Bound each call roughly: from `defineNotificationPipeline` to the matching
  // close is hard without a parser; scanning `collection: Ident` only inside
  // files that mention the factory is enough — the three live adapters put the
  // property on the same object literal, and a stray `collection:` elsewhere
  // in those files is extremely unlikely (and would still need a real handle).
  for (const m of source.matchAll(/\bcollection\s*:\s*([A-Za-z_]\w*)/g)) {
    refs.push(m[1]!);
  }
  return refs;
}

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const full = join(dir, entry);
    // Race-safe: entry vanished between readdir and stat — skip it.
    if (!existsSync(full)) return [];
    const st = statSync(full);
    if (st.isDirectory()) return tsFilesUnder(full);
    return entry.endsWith('.ts') || entry.endsWith('.tsx') ? [full] : [];
  });
}

/**
 * Walk apps/ + packages/ for production `defineNotificationPipeline` call sites.
 * Excludes this notifications package dir (core + contract tests use fakes).
 */
function discoverPipelineConsumers(): { handleName: string; file: string }[] {
  const roots = [join(REPO_ROOT, 'apps'), join(REPO_ROOT, 'packages')];
  const hits: { handleName: string; file: string }[] = [];
  const notifNorm = NOTIFICATIONS_DIR.replace(/\\/g, '/');
  for (const root of roots) {
    for (const file of tsFilesUnder(root)) {
      // Core + its own tests define pipelines against FakeDb / synthetic handles.
      const norm = file.replace(/\\/g, '/');
      if (norm === notifNorm || norm.startsWith(notifNorm + '/')) continue;

      const src = readFileSync(file, 'utf8');
      if (!src.includes('defineNotificationPipeline')) continue;
      for (const handleName of pipelineCollectionRefs(src)) {
        hits.push({ handleName, file });
      }
    }
  }
  return hits;
}

const SWEEP_INDEX_FIELDS: RequiredIndex['fields'] = [
  { fieldPath: 'status', order: 'ASCENDING' },
  { fieldPath: 'processedAt', order: 'ASCENDING' },
];

function sweepIndexFor(path: string): RequiredIndex {
  return {
    collectionGroup: path,
    queryScope: 'COLLECTION',
    fields: SWEEP_INDEX_FIELDS,
  };
}

/**
 * The second equality field of a channel's CONNECT RE-DRIVE query, or null when
 * the channel has none.
 *
 * Guard C covers the sweep's `(status, processedAt)`. A channel with a
 * `defer` arm also needs a second, differently-shaped query: the re-drive that
 * pulls a seller's deferred backlog back into the hot lane the moment their
 * account lands (`redriveDeferredForUserId`, #808). That one is
 * `where('status','==').where('<field>','==')` and needs its own composite —
 * which nothing generic guarded.
 *
 * Detected from source rather than required of every channel, because it is
 * genuinely optional: Mercado Pago and WhatsApp have no `defer` arm and no
 * connect-observing trigger, so demanding the index of them would be noise.
 * The sweep's own lane query cannot match — its second predicate is `'<'`, not
 * `'=='` — and `resolveIntegracaoByUserId`'s three-equality query cannot
 * either, since it does not lead with `status`.
 */
export function redriveEqualityField(source: string): string | null {
  const m = /\.where\(\s*'status'\s*,\s*'=='[\s\S]{0,300}?\.where\(\s*'(\w+)'\s*,\s*'=='/.exec(
    source,
  );
  return m?.[1] ?? null;
}

function redriveIndexFor(path: string, field: string): RequiredIndex {
  return {
    collectionGroup: path,
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: field, order: 'ASCENDING' },
    ],
  };
}

// ── discovery (once per file load) ──────────────────────────────────────────

const handles = discoverNotificacoesHandles();
const consumers = discoverPipelineConsumers();
const consumerHandleNames = new Set(consumers.map((c) => c.handleName));
const knownHandleNames = new Set(handles.map((h) => h.handleName));

const indexesFile = resolve(REPO_ROOT, 'firestore.indexes.json');
const indexesParsed = JSON.parse(readFileSync(indexesFile, 'utf8')) as {
  indexes?: unknown[];
};
const indexes = Array.isArray(indexesParsed.indexes) ? indexesParsed.indexes : [];

// ── B: every notificacoes* handle is a pipeline consumer ────────────────────

describe('notification pipeline coverage (B)', () => {
  it('discovers at least one notificacoes* admin collection handle', () => {
    expect(handles.length).toBeGreaterThan(0);
  });

  it('discovers at least one production defineNotificationPipeline consumer', () => {
    expect(consumers.length).toBeGreaterThan(0);
  });

  it('every notificacoes* admin collection is wired into defineNotificationPipeline', () => {
    const missing = handles.filter((h) => !consumerHandleNames.has(h.handleName));
    if (missing.length === 0) return;
    const lines = missing.map(
      (h) =>
        `  - ${h.handleName} (path: ${h.path}) — wire it via defineNotificationPipeline({ collection: ${h.handleName} }) in the channel adapter (see webhook-notifications skill)`,
    );
    expect.fail(
      `These notificacoes* admin handles have no defineNotificationPipeline consumer.\n` +
        `Hand-rolling the persist/retry/sweep is forbidden — use @delfrance/data/admin/notifications:\n` +
        lines.join('\n'),
    );
  });

  it('every defineNotificationPipeline collection: arg is a known notificacoes* handle', () => {
    const orphans = consumers.filter((c) => !knownHandleNames.has(c.handleName));
    if (orphans.length === 0) return;
    const lines = orphans.map(
      (c) => `  - collection: ${c.handleName} in ${relative(REPO_ROOT, c.file)}`,
    );
    expect.fail(
      `defineNotificationPipeline is wired to a collection that is not a notificacoes* admin handle:\n` +
        lines.join('\n'),
    );
  });

  describe('the collection: detector itself', () => {
    it('extracts collection: HandleName from a pipeline call', () => {
      const src = `
        import { defineNotificationPipeline } from '@delfrance/data/admin/notifications';
        return defineNotificationPipeline({
          channel: 'x',
          collection: notificacoesFooCollection,
          taskSchema,
        });
      `;
      expect(pipelineCollectionRefs(src)).toEqual(['notificacoesFooCollection']);
    });

    it('ignores property-shorthand collection (synthetic test fakes)', () => {
      const src = `
        defineNotificationPipeline({
          channel: 'teste',
          collection,
          taskSchema,
        });
      `;
      // `collection,` has no `: Ident` — must not count as coverage.
      expect(pipelineCollectionRefs(src)).toEqual([]);
    });

    it('returns empty when defineNotificationPipeline is absent', () => {
      expect(pipelineCollectionRefs(`const collection: Foo = bar;`)).toEqual([]);
    });
  });
});

// ── C: every notificacoes* has the sweep composite index ────────────────────

describe('notification sweep indexes (C)', () => {
  it('firestore.indexes.json is readable', () => {
    expect(indexes.length).toBeGreaterThan(0);
  });

  it('every notificacoes* collection has (status ASC, processedAt ASC)', () => {
    const missing: RequiredIndex[] = [];
    for (const { path } of handles) {
      const required = sweepIndexFor(path);
      if (!indexes.some((idx) => indexSatisfies(idx, required))) {
        missing.push(required);
      }
    }
    if (missing.length === 0) return;
    expect.fail(
      `Missing Firestore index(es) for notificacoes* sweep queries. Firestore Enterprise ` +
        `creates no indexes automatically — add these to the "indexes" array of ` +
        `firestore.indexes.json and run \`firebase deploy --only firestore:indexes\`:\n` +
        missing.map(formatIndexJson).join(',\n'),
    );
  });
});

// ── D: a channel with a connect re-drive has ITS composite index too ─────────

describe('notification connect re-drive indexes (D)', () => {
  const handlePaths = new Map(handles.map((h) => [h.handleName, h.path]));

  /** Consumers whose source contains a `status` + second-equality re-drive query. */
  const redrivers = consumers
    .map((c) => ({ ...c, field: redriveEqualityField(readFileSync(c.file, 'utf8')) }))
    .filter((c): c is typeof c & { field: string } => c.field !== null);

  it('every connect re-drive query has its (status ASC, <field> ASC) composite', () => {
    const missing: RequiredIndex[] = [];
    for (const r of redrivers) {
      const path = handlePaths.get(r.handleName);
      if (!path) continue; // guard B already fails on an unknown handle
      const required = redriveIndexFor(path, r.field);
      if (!indexes.some((idx) => indexSatisfies(idx, required))) missing.push(required);
    }
    if (missing.length === 0) return;
    expect.fail(
      `Missing Firestore index(es) for a notification connect re-drive query. On Enterprise a ` +
        `missing index does NOT throw — it silently full-scans and bills the scan, so this is the ` +
        `only place it surfaces (the emulator auto-creates composites, so ci-mercado-livre.yml ` +
        `cannot catch it either). Add these to firestore.indexes.json:\n` +
        missing.map(formatIndexJson).join(',\n'),
    );
  });

  describe('the re-drive detector itself', () => {
    // A regex that silently matches nothing manufactures a green guard — the
    // same failure mode guard B pins `pipelineCollectionRefs` against.
    it('captures the second equality field', () => {
      const src = `
        collection.ref(db, {})
          .where('status', '==', NOTIFICACAO_RESILIENCIA_STATUS.deferred)
          .where('user_id', '==', userId)
          .limit(limit);
      `;
      expect(redriveEqualityField(src)).toBe('user_id');
    });

    it('ignores the sweep lane query, whose second predicate is a range', () => {
      const src = `
        collection.ref(db, {})
          .where('status', '==', status)
          .where('processedAt', '<', cutoff)
          .orderBy('processedAt')
          .limit(limit);
      `;
      expect(redriveEqualityField(src)).toBeNull();
    });

    it('ignores an equality pair that does not lead with status', () => {
      // resolveIntegracaoByUserId's tipo/user_id/ativo query lives in the same
      // file as the re-drive; it must not be mistaken for one.
      const src = `
        integracaoCollection.ref(db, {})
          .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
          .where('user_id', '==', userId)
          .where('ativo', '==', true);
      `;
      expect(redriveEqualityField(src)).toBeNull();
    });

    it('returns null when there is no query at all', () => {
      expect(redriveEqualityField('const status = "failed";')).toBeNull();
    });
  });

  it('detects the Mercado Livre re-drive, so this guard is not vacuously empty', () => {
    // Without this, deleting redriveDeferredForUserId (or breaking the regex)
    // would leave `redrivers` empty and the guard above passing over nothing.
    // ⚠️ If ML ever legitimately loses its connect re-drive, delete this `it`
    // deliberately rather than letting the suite quietly stop checking anything.
    expect(redrivers.map((r) => `${handlePaths.get(r.handleName)}:${r.field}`)).toContain(
      'notificacoesMercadoLivre:user_id',
    );
  });
});
