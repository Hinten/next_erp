/**
 * Live Firestore concurrency contract for the numeração helpers.
 *
 * **Fiscal-critical regression test.** SEFAZ tracks the per-(filial, serie)
 * nNF sequence; duplicates → one emission rejected; gaps → an `inutNFe`
 * filing is required. The in-memory tests in `numeracao.test.ts` prove
 * the library's transactional contract; this test proves Firestore's
 * optimistic-locking semantics honor it under real parallel load.
 *
 * Skipped automatically unless **all** of these are set:
 *   - `FIREBASE_PROJECT_ID`
 *   - `FIREBASE_SERVICE_ACCOUNT` (inline JSON) OR
 *     `FIREBASE_SERVICE_ACCOUNT_PATH` (filesystem path)
 *
 * These are the same names used by the rest of the repo (`.env.example`,
 * `apps/integrations`, `apps/nfe`); CI maps the staging GitHub secret
 * `FIREBASE_PROJECT_ID_STAGING` onto `FIREBASE_PROJECT_ID` at the workflow
 * level — see `e2e.yml` and `ci-nfe.yml`.
 *
 * Run locally with:
 *   $env:FIREBASE_PROJECT_ID = "your-staging-project-id"
 *   $env:FIREBASE_SERVICE_ACCOUNT_PATH = "C:\path\to\sa.json"
 *   pnpm --filter @delfrance/integrations-nfe test numeracao.staging
 *
 * Each test seeds a fresh `NFeConfig` doc at a unique
 * `filiais/_test/nfeconfig/<run-id>` path, runs the parallel load,
 * asserts the contiguous-range property, and deletes the doc.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cert, deleteApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  type NFeConfig,
  AMBIENTE_NFE,
  CONTINGENCIA_MODO,
  nfeConfigSchema,
} from '@delfrance/schemas';

import { nextIdLote, nextNumeracao, nextNumeracaoBulk } from '../../src/numeracao/index';
import {
  nfeConfigStoreFromFirestore,
  type AdminFirestoreLike,
} from '../../src/numeracao/firestore-adapter';

const hasCreds =
  Boolean(process.env.FIREBASE_PROJECT_ID) &&
  (process.env.FIREBASE_SERVICE_ACCOUNT != null ||
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH != null);

const describeOrSkip = hasCreds ? describe : describe.skip;

function loadServiceAccount(): Record<string, unknown> {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) return JSON.parse(inline);
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH!;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Bare-minimum NFeConfig seed for the test filial. */
const SEED: NFeConfig = {
  numeracao_atual: 0,
  serie: 99, // dedicated test série so we never collide with real data
  idLote: 0,
  ambiente: AMBIENTE_NFE.homologacao,
  contingencia_modo: CONTINGENCIA_MODO.none,
  contingencia_justificativa: null,
  contingencia_dataInicio: null,
  emitirReformaTributaria: false,
  timestamp: null,
};

describeOrSkip('numeração — live Firestore concurrency contract', () => {
  let app: App;
  let fs: Firestore;

  beforeAll(async () => {
    const projectId = process.env.FIREBASE_PROJECT_ID!;
    // Match `apps/nfe/lib/firebase/admin.ts`: Firebase Enterprise names
    // the default DB `default` (no parens); free-tier projects use
    // `(default)`. Default to `default` if unset.
    const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
    const existing = getApps().find((a) => a.name === 'numeracao-staging');
    app =
      existing ??
      initializeApp(
        { credential: cert(loadServiceAccount() as never), projectId },
        'numeracao-staging',
      );
    fs = getFirestore(app, databaseId);
  });

  afterAll(async () => {
    // Best-effort: deleteApp closes the firestore client; ignore errors so
    // a flaky teardown doesn't mask the actual test result.
    try {
      await deleteApp(app);
    } catch {
      // already deleted or never initialised — fine
    }
  });

  /** Helper: returns a unique test-filial id so parallel CI runs don't collide. */
  function newFilial(): string {
    return `_test_${randomUUID().slice(0, 8)}`;
  }

  /** Seed the NFeConfig doc and return the path + a per-run store. */
  async function seedAndStore(filialId: string): Promise<{
    path: string;
    store: ReturnType<typeof nfeConfigStoreFromFirestore>;
  }> {
    const path = `filiais/${filialId}/nfeconfig/default`;
    await fs.doc(path).set(SEED);
    const store = nfeConfigStoreFromFirestore(fs as unknown as AdminFirestoreLike);
    return { path, store };
  }

  async function teardown(path: string) {
    try {
      await fs.doc(path).delete();
    } catch {
      // ignore — best-effort cleanup
    }
  }

  // 180s timeout: 50 contenders × 1 doc means the last winner must lose
  // 49 times via optimistic-retry. SDK round-trips (~100-300ms each) +
  // our jittered outer backoff (0-1s × up to 5 attempts) can push wall
  // time past 60s under network jitter. Vitest only waits as long as
  // the test actually takes; the bulk + idLote tests below inherit the
  // same budget for symmetry but typically finish in 10-20s.
  it('nextNumeracao × 50 parallel → exactly {1..50}, no dups, no gaps', async () => {
    const filialId = newFilial();
    const { path, store } = await seedAndStore(filialId);
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => nextNumeracao(store, filialId)),
      );
      const nNFs = results.map((r) => r.nNF).sort((a, b) => a - b);
      expect(new Set(nNFs).size).toBe(50);
      expect(nNFs[0]).toBe(1);
      expect(nNFs[49]).toBe(50);
      expect(nNFs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

      const snap = await fs.doc(path).get();
      const persisted = nfeConfigSchema.parse(snap.data());
      expect(persisted.numeracao_atual).toBe(50);
    } finally {
      await teardown(path);
    }
  }, 180_000);

  it('nextNumeracaoBulk(5) × 10 parallel → contiguous {1..50}', async () => {
    const filialId = newFilial();
    const { path, store } = await seedAndStore(filialId);
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => nextNumeracaoBulk(store, filialId, 5)),
      );
      const allNNFs = results.flatMap((r) => r.nNFs).sort((a, b) => a - b);
      expect(new Set(allNNFs).size).toBe(50);
      expect(allNNFs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

      // Each batch must itself be contiguous (a single tx allocates `count`
      // adjacent numbers; if Firestore retried and merged, the contract
      // breaks).
      for (const r of results) {
        const sorted = [...r.nNFs].sort((a, b) => a - b);
        expect(sorted).toEqual([
          sorted[0],
          sorted[0]! + 1,
          sorted[0]! + 2,
          sorted[0]! + 3,
          sorted[0]! + 4,
        ]);
      }

      const snap = await fs.doc(path).get();
      const persisted = nfeConfigSchema.parse(snap.data());
      expect(persisted.numeracao_atual).toBe(50);
    } finally {
      await teardown(path);
    }
  }, 180_000);

  // 180s timeout rationale: 50 contenders × 1 doc means the last winner must
  // lose 49 times via optimistic-retry. SDK round-trips (~100–300ms each) + our
  // jittered outer backoff (0–1s × up to 5 attempts) can push wall time past 60s
  // under network jitter. 180s gives generous headroom without slowing fast runs
  // — Vitest only waits as long as the test takes.
  it('nextIdLote × 50 parallel → exactly {1..50}, independent of nNF counter', async () => {
    const filialId = newFilial();
    const { path, store } = await seedAndStore(filialId);
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => nextIdLote(store, filialId)),
      );
      const sorted = [...results].sort((a, b) => a - b);
      expect(new Set(sorted).size).toBe(50);
      expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

      const snap = await fs.doc(path).get();
      const persisted = nfeConfigSchema.parse(snap.data());
      expect(persisted.idLote).toBe(50);
      // numeracao_atual MUST remain at 0 — nNF and lote counters are
      // independent.
      expect(persisted.numeracao_atual).toBe(0);
    } finally {
      await teardown(path);
    }
  }, 180_000);
});
