import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as moduloEstoqueShopeeSync from './estoqueShopeeSync';
import { ALL_DOMAINS } from './registry';

const {
  MODO_VARREDURA_ESTOQUE,
  estoqueShopeeSyncMeta,
  estoqueShopeeSyncSchema,
  modoVarreduraEstoqueSchema,
} = moduloEstoqueShopeeSync;

/** Fixture ids only — never a real integração, shop or item id. */
const INTEGRACAO = 'int-1';

describe('estoqueShopeeSyncSchema', () => {
  it('parses an empty doc with all defaults (conta never swept)', () => {
    expect(estoqueShopeeSyncSchema.parse({})).toEqual({
      cursorMs: null,
      lastSweepAtMs: null,
      lastDailyAtMs: null,
      lastReconciliacaoAtMs: null,
      lastError: null,
      lastErrorAtMs: null,
      pausadoAte: null,
      pausaMotivo: null,
      pausaCodigo: null,
      pauseCount: 0,
      ultimoMotivoConta: null,
      ultimoMotivoContaEmMs: null,
      continuacao: null,
    });
  });

  it('every optional field defaults to null and the counter to 0 — never undefined', () => {
    // `undefined` would be rejected by the Firebase SDK on an addDoc/setDoc.
    const parsed = estoqueShopeeSyncSchema.parse({}) as Record<string, unknown>;
    const NULAVEIS = [
      'cursorMs',
      'lastSweepAtMs',
      'lastDailyAtMs',
      'lastReconciliacaoAtMs',
      'lastError',
      'lastErrorAtMs',
      'pausadoAte',
      'pausaMotivo',
      'pausaCodigo',
      'ultimoMotivoConta',
      'ultimoMotivoContaEmMs',
      'continuacao',
    ] as const;
    expect(NULAVEIS).toHaveLength(12);
    for (const campo of NULAVEIS) {
      expect(parsed).toHaveProperty(campo);
      expect(parsed[campo]).toBeNull();
      expect(parsed[campo]).not.toBeUndefined();
    }
    expect(parsed.pauseCount).toBe(0);
  });

  it('round-trips a FULL doc — every field set at once, in milliseconds', () => {
    const doc = {
      cursorMs: 1_758_000_000_000,
      lastSweepAtMs: 1_758_000_900_000,
      lastDailyAtMs: 1_757_916_000_000,
      lastReconciliacaoAtMs: 1_756_684_800_000,
      lastError: 'Shopee recusou o envio de estoque desta conta.',
      lastErrorAtMs: 1_758_000_900_000,
      pausadoAte: 1_758_087_300_000,
      pausaMotivo: 'loja-em-ferias',
      pausaCodigo: 'error_busi_shop_holiday_mode',
      pauseCount: 3,
      ultimoMotivoConta: 'conta-sem-deposito',
      ultimoMotivoContaEmMs: 1_758_000_900_000,
      continuacao: {
        afterAnchorId: 'PROD-42',
        changedSinceMs: 1_757_999_100_000,
        modo: 'incremental',
        movimentosDesdeMs: 1_757_999_100_000,
        startedAtMs: 1_758_000_900_000,
      },
    };
    expect(estoqueShopeeSyncSchema.parse(doc)).toEqual(doc);
  });

  it('a TRUNCATED incremental freezes the continuação and leaves cursorMs where it was', () => {
    const parsed = estoqueShopeeSyncSchema.parse({
      cursorMs: 1_758_000_000_000,
      continuacao: {
        afterAnchorId: 'PROD-7',
        changedSinceMs: 1_757_999_100_000,
        modo: MODO_VARREDURA_ESTOQUE.incremental,
        movimentosDesdeMs: 1_757_999_100_000,
        startedAtMs: 1_758_000_900_000,
      },
    });
    expect(parsed.cursorMs).toBe(1_758_000_000_000);
    expect(parsed.continuacao?.startedAtMs).toBe(1_758_000_900_000);
  });

  it('lastReconciliacaoAtMs is its OWN field and defaults to null beside lastDailyAtMs', () => {
    // Report only, never a baseline: reusing lastDailyAtMs would tell an
    // operator a full pass ran when only the nightly one did.
    const parsed = estoqueShopeeSyncSchema.parse({ lastDailyAtMs: 1_757_916_000_000 });
    expect(parsed.lastDailyAtMs).toBe(1_757_916_000_000);
    expect(parsed.lastReconciliacaoAtMs).toBeNull();
  });

  it('pausadoAte is the ONE gate — pausaMotivo carries the distinction, not a second field', () => {
    const parsed = estoqueShopeeSyncSchema.parse({
      pausadoAte: 1_758_087_300_000,
      pausaMotivo: 'cota-diaria',
      pausaCodigo: null,
      pauseCount: 1,
    }) as Record<string, unknown>;
    expect(parsed.pausadoAte).toBe(1_758_087_300_000);
    expect(parsed.pausaMotivo).toBe('cota-diaria');
    // A daily-quota pause is armed by US, so there is no Shopee code to store.
    expect(parsed.pausaCodigo).toBeNull();
    // ⚠️ No second gate field exists: two would be two readers that can disagree.
    expect(parsed).not.toHaveProperty('cotaDiariaAteMs');
  });
});

describe('estoqueShopeeSyncSchema.continuacao — the reconciliação sentinels', () => {
  const BASE = {
    afterAnchorId: 'PROD-7',
    modo: MODO_VARREDURA_ESTOQUE.reconciliacao,
    startedAtMs: 1_758_000_900_000,
  };

  it('✅ PAIR: a reconciliação freezes changedSinceMs -1 AND movimentosDesdeMs null', () => {
    // `-1` is the force-all sentinel for the discovery window, NOT an instant —
    // `millisSinceEpoch()` has to accept it, and it does (the tolerant
    // preprocess truncates a finite number below the ms upper bound).
    // `movimentosDesdeMs: null` says there is no ledger baseline to sum
    // against, which is ALWAYS the case on this tier because it force-sends.
    const parsed = estoqueShopeeSyncSchema.parse({
      continuacao: { ...BASE, changedSinceMs: -1, movimentosDesdeMs: null },
    });
    expect(parsed.continuacao).toEqual({
      ...BASE,
      changedSinceMs: -1,
      movimentosDesdeMs: null,
    });
  });

  it('✅ PAIR: an incremental freezes a real instant AND a real ledger window', () => {
    const parsed = estoqueShopeeSyncSchema.parse({
      continuacao: {
        ...BASE,
        modo: MODO_VARREDURA_ESTOQUE.incremental,
        changedSinceMs: 1_757_999_100_000,
        movimentosDesdeMs: 1_757_999_100_000,
      },
    });
    expect(parsed.continuacao?.changedSinceMs).toBe(1_757_999_100_000);
    expect(parsed.continuacao?.movimentosDesdeMs).toBe(1_757_999_100_000);
  });

  it('⛔ NEAR-MISS: an ABSENT movimentosDesdeMs is REFUSED — null is not the same as missing', () => {
    // The key is REQUIRED from day one: no previous release of this document
    // exists, so a continuação without it is malformed, not inheritable. If it
    // were optional, a reconciliação continuation that lost the key would
    // silently resume as if it had a baseline.
    expect(
      estoqueShopeeSyncSchema.safeParse({
        continuacao: { ...BASE, changedSinceMs: -1 },
      }).success,
    ).toBe(false);
    // …while the explicit null parses (the pair above), so the two are distinct.
    expect(
      estoqueShopeeSyncSchema.safeParse({
        continuacao: { ...BASE, changedSinceMs: -1, movimentosDesdeMs: null },
      }).success,
    ).toBe(true);
  });

  it('⛔ NEAR-MISS: an unknown modo is REFUSED, and so is the ML spelling "daily"', () => {
    // ⚠️ This channel spells the nightly tier `diario`. `daily` is Mercado
    // Livre's member and would resume under a policy this document never froze.
    for (const modo of ['nao-existe', 'daily', 'Incremental', '']) {
      expect(
        estoqueShopeeSyncSchema.safeParse({
          continuacao: { ...BASE, modo, changedSinceMs: -1, movimentosDesdeMs: null },
        }).success,
      ).toBe(false);
    }
    expect(
      estoqueShopeeSyncSchema.safeParse({
        continuacao: {
          ...BASE,
          modo: MODO_VARREDURA_ESTOQUE.diario,
          changedSinceMs: 1_757_916_000_000,
          movimentosDesdeMs: 1_757_916_000_000,
        },
      }).success,
    ).toBe(true);
  });

  it('⛔ NEAR-MISS: an EMPTY afterAnchorId is refused — a continuação with no keyset position', () => {
    expect(
      estoqueShopeeSyncSchema.safeParse({
        continuacao: { ...BASE, afterAnchorId: '', changedSinceMs: -1, movimentosDesdeMs: null },
      }).success,
    ).toBe(false);
  });
});

describe('modoVarreduraEstoqueSchema', () => {
  it('carries exactly the three tiers, and MODO_VARREDURA_ESTOQUE covers them', () => {
    expect([...modoVarreduraEstoqueSchema.options].sort()).toEqual([
      'diario',
      'incremental',
      'reconciliacao',
    ]);
    expect([...Object.values(MODO_VARREDURA_ESTOQUE)].sort()).toEqual([
      'diario',
      'incremental',
      'reconciliacao',
    ]);
  });
});

describe('estoqueShopeeSyncMeta', () => {
  it('targets the top-level estoqueShopeeSync collection with 0n perms', () => {
    expect(estoqueShopeeSyncMeta.collectionPath).toBe('estoqueShopeeSync');
    expect(estoqueShopeeSyncMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });

  it('the doc id is the integração id, so one conta owns exactly one state doc', () => {
    // Nothing in the schema can assert this — it is the handle's contract — but
    // pinning the shape of the path here keeps the two readable together.
    expect(`${estoqueShopeeSyncMeta.collectionPath}/${INTEGRACAO}`).toBe('estoqueShopeeSync/int-1');
  });

  it('declares no defaultQuery — no client ever lists this collection', () => {
    expect(estoqueShopeeSyncMeta.defaultQuery).toBeUndefined();
  });
});

describe('estoqueShopeeSync admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only sweep state doc)', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(estoqueShopeeSyncSchema);
    const collectionPaths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(collectionPaths).not.toContain(estoqueShopeeSyncMeta.collectionPath);
  });

  it('exports NO DomainSchema object — nothing here carries both .schema and .meta', () => {
    // `registry.test.ts`'s `isDomainSchema()` sweeps in any single export that
    // carries both properties. Two BARE constants are what keeps this document
    // out of the ruleset generator, so the shape is worth asserting rather than
    // assuming.
    // Same predicate as `registry.test.ts`, deliberately duplicated here so
    // this module's shape is pinned at the module itself.
    const ehDomainSchema = (valor: unknown): boolean => {
      if (typeof valor !== 'object' || valor === null) return false;
      const candidato = valor as { schema?: unknown; meta?: unknown };
      if (!(candidato.schema instanceof z.ZodType)) return false;
      if (typeof candidato.meta !== 'object' || candidato.meta === null) return false;
      return typeof (candidato.meta as { collectionPath?: unknown }).collectionPath === 'string';
    };
    const exportados = Object.entries(moduloEstoqueShopeeSync as Record<string, unknown>);
    expect(exportados.filter(([, v]) => ehDomainSchema(v)).map(([nome]) => nome)).toEqual([]);
    // …and the two bare constants ARE both exported, so the pair is complete.
    expect(exportados.map(([nome]) => nome)).toEqual(
      expect.arrayContaining(['estoqueShopeeSyncSchema', 'estoqueShopeeSyncMeta']),
    );
  });
});
