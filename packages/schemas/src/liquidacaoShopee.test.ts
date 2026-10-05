import { describe, expect, it } from 'vitest';
import {
  MOTIVO_PENDENTE_SHOPEE,
  liquidacaoPendenteSchema,
  liquidacaoShopeeMeta,
  liquidacaoShopeeSchema,
  motivoPendenteShopeeSchema,
} from './liquidacaoShopee';
import { pagamentoMeta } from './pedido';
import { ALL_DOMAINS } from './registry';

/** `escrow_release_time` as Shopee sends it: SECONDS. */
const RELEASE_S = 1_757_500_000;

describe('liquidacaoShopeeSchema', () => {
  it('parses an empty doc with all defaults (conta never swept)', () => {
    expect(liquidacaoShopeeSchema.parse({})).toEqual({
      cursorMs: null,
      pendingWindowFromMs: null,
      pendingWindowToMs: null,
      pendingPageNo: null,
      lastSweepAtMs: null,
      lastError: null,
      pendentes: [],
    });
  });

  it('round-trips a DRAINED tick (cursor advanced, the pending triple cleared)', () => {
    const doc = {
      cursorMs: 1757500000000,
      pendingWindowFromMs: null,
      pendingWindowToMs: null,
      pendingPageNo: null,
      lastSweepAtMs: 1757500300000,
      lastError: null,
      pendentes: [],
    };
    expect(liquidacaoShopeeSchema.parse(doc)).toEqual(doc);
  });

  it('round-trips a TRUNCATED tick (window + page persisted, cursor NOT advanced)', () => {
    const doc = {
      cursorMs: null,
      pendingWindowFromMs: 1756900000000,
      pendingWindowToMs: 1757500000000,
      pendingPageNo: 3,
      lastSweepAtMs: 1757500300000,
      lastError: null,
      pendentes: [],
    };
    expect(liquidacaoShopeeSchema.parse(doc)).toEqual(doc);
  });

  it('round-trips a contained-error tick (lastError set, cursor untouched)', () => {
    const parsed = liquidacaoShopeeSchema.parse({
      cursorMs: 1757500000000,
      lastSweepAtMs: 1757500300000,
      lastError: 'Token da Shopee inválido. Reconecte a conta.',
    });
    expect(parsed.lastError).toBe('Token da Shopee inválido. Reconecte a conta.');
    expect(parsed.cursorMs).toBe(1757500000000);
    expect(parsed.pendingPageNo).toBeNull();
  });

  it('refuses a pendingPageNo below 1 — Shopee pages from 1, not from 0', () => {
    expect(liquidacaoShopeeSchema.parse({ pendingPageNo: 1 }).pendingPageNo).toBe(1);
    // Near-miss on the one boundary a paging bug lands on.
    expect(liquidacaoShopeeSchema.safeParse({ pendingPageNo: 0 }).success).toBe(false);
    expect(liquidacaoShopeeSchema.safeParse({ pendingPageNo: 1.5 }).success).toBe(false);
  });

  it("does NOT cap pendentes — the ceiling is the sweep's budget, not the schema's", () => {
    // Deliberate: a document that already exceeds the sweep's cap must still
    // PARSE, or the sweep could not read it in order to trim it. The bound is
    // asserted where it is enforced (the sweep), not here.
    const muitos = Array.from({ length: 500 }, (_, i) => ({
      orderSn: `26091000000${i}`,
      payoutAmount: 1,
      escrowReleaseTimeS: RELEASE_S + i,
      motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
      tentativas: 0,
    }));
    const parsed = liquidacaoShopeeSchema.parse({ pendentes: muitos });
    expect(parsed.pendentes).toHaveLength(500);
    // The anchor: the array is not accepted unconditionally — a row missing its
    // identity still fails, so the length assertion above means something.
    expect(liquidacaoShopeeSchema.safeParse({ pendentes: [{ orderSn: '' }] }).success).toBe(false);
  });
});

describe('liquidacaoPendenteSchema', () => {
  it('fills the defaults a fresh pendente is written with', () => {
    expect(
      liquidacaoPendenteSchema.parse({
        orderSn: '260910KJBHUJDM',
        motivo: MOTIVO_PENDENTE_SHOPEE.semPagamento,
      }),
    ).toEqual({
      orderSn: '260910KJBHUJDM',
      payoutAmount: null,
      escrowReleaseTimeS: null,
      motivo: 'sem-pagamento',
      tentativas: 0,
    });
  });

  it('carries escrowReleaseTimeS VERBATIM in SECONDS — an int, never a float', () => {
    // ⚠️ The one second-resolution field stored in this channel. It is held raw
    // for replay and converted ONCE at the settlement write; nothing here
    // rescales it, which is exactly why the `S` suffix is the safety mechanism.
    const parsed = liquidacaoPendenteSchema.parse({
      orderSn: '260910KJBHUJDM',
      motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
      escrowReleaseTimeS: RELEASE_S,
    });
    expect(parsed.escrowReleaseTimeS).toBe(RELEASE_S);
    // Near-miss #1: the µs of the same instant is NOT what this slot holds — it
    // is a different number and it is not what a re-read would produce.
    expect(parsed.escrowReleaseTimeS).not.toBe(RELEASE_S * 1_000_000);
    // Near-miss #2: a fractional second is refused rather than truncated. A
    // silent trunc would make two different release instants compare equal.
    expect(
      liquidacaoPendenteSchema.safeParse({
        orderSn: '260910KJBHUJDM',
        motivo: MOTIVO_PENDENTE_SHOPEE.semPedido,
        escrowReleaseTimeS: RELEASE_S + 0.5,
      }).success,
    ).toBe(false);
  });

  it('requires a non-empty orderSn — a pendente with no identity can never be replayed', () => {
    const base = { motivo: MOTIVO_PENDENTE_SHOPEE.semPedido };
    expect(liquidacaoPendenteSchema.safeParse({ ...base, orderSn: '' }).success).toBe(false);
    expect(liquidacaoPendenteSchema.safeParse(base).success).toBe(false);
    // The anchor: with an id the very same object parses.
    expect(liquidacaoPendenteSchema.safeParse({ ...base, orderSn: 'X' }).success).toBe(true);
  });

  it('accepts BOTH motivo members and nothing else', () => {
    for (const motivo of Object.values(MOTIVO_PENDENTE_SHOPEE)) {
      expect(liquidacaoPendenteSchema.safeParse({ orderSn: 'X', motivo }).success).toBe(true);
    }
    // Near-miss: the sweep's other row dispositions (ilegivel, duplicada,
    // pulado-order-not-found) are NOT pendentes — they are counted and dropped.
    expect(liquidacaoPendenteSchema.safeParse({ orderSn: 'X', motivo: 'ilegivel' }).success).toBe(
      false,
    );
    // The companion constant covers the enum exactly.
    expect(Object.values(MOTIVO_PENDENTE_SHOPEE)).toEqual(motivoPendenteShopeeSchema.options);
  });

  it('refuses a negative tentativas count', () => {
    expect(
      liquidacaoPendenteSchema.parse({ orderSn: 'X', motivo: 'sem-pedido', tentativas: 4 })
        .tentativas,
    ).toBe(4);
    expect(
      liquidacaoPendenteSchema.safeParse({ orderSn: 'X', motivo: 'sem-pedido', tentativas: -1 })
        .success,
    ).toBe(false);
  });
});

describe('liquidacaoShopeeMeta', () => {
  it('targets the top-level liquidacaoShopee collection with 0n perms', () => {
    expect(liquidacaoShopeeMeta.collectionPath).toBe('liquidacaoShopee');
    expect(liquidacaoShopeeMeta.permissions).toEqual({ read: 0n, write: 0n, delete: 0n });
  });

  it('does not start with `notificacoes` — the guardrails prefix it must avoid', () => {
    // `notificationGuardrails`' checks B and C fire on every admin collection
    // whose path starts with that prefix, and would demand a pipeline consumer
    // and a (status, processedAt) composite index this cursor doc has neither
    // of. Pinned so a rename cannot walk into it silently.
    expect(liquidacaoShopeeMeta.collectionPath.startsWith('notificacoes')).toBe(false);
  });
});

describe('liquidacaoShopee admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only sweep cursor doc)', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(liquidacaoShopeeSchema);
    const collectionPaths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(collectionPaths).not.toContain(liquidacaoShopeeMeta.collectionPath);
    // The ANCHOR: the same two lookups DO find a registered domain, so the
    // negatives above are exclusions and not an empty registry. Without it a
    // broken `ALL_DOMAINS` import would make this test pass vacuously.
    expect(collectionPaths).toContain(pagamentoMeta.collectionPath);
    expect(ALL_DOMAINS.length).toBeGreaterThan(20);
  });
});
