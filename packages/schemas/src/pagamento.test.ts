import { describe, expect, it } from 'vitest';
import {
  FORMA_PAGAMENTO,
  LIQUIDACAO_FONTE,
  STATUS_PAGAMENTO,
  isPagamentoPagante,
  liquidacaoFonteSchema,
  liquidacaoPagamentoSchema,
  marketplacePagamentoSchema,
  marketplacePagamentoTaxasSchema,
  metodoPagamentoSchema,
  pagamentoSchema,
  statusToEstadoPedido,
  sumPagamentosPagos,
} from './pedido';

describe('pagamentoSchema', () => {
  it('parses a minimal Pagamento with defaults', () => {
    const out = pagamentoSchema.parse({ valor: 100 });
    expect(out.forma_de_pagamento).toBe(FORMA_PAGAMENTO.dinheiro);
    expect(out.parcelas).toBe(1);
    expect(out.aVista).toBe(true);
    expect(out.duplicata).toBe(false);
  });

  it('rejects negative valor', () => {
    expect(pagamentoSchema.safeParse({ valor: -1 }).success).toBe(false);
  });

  it('rejects parcelas < 1', () => {
    expect(pagamentoSchema.safeParse({ valor: 100, parcelas: 0 }).success).toBe(false);
  });

  it('rejects unknown forma_de_pagamento integers', () => {
    expect(pagamentoSchema.safeParse({ valor: 100, forma_de_pagamento: 7 }).success).toBe(false);
  });

  it('accepts every status from STATUS_PAGAMENTO', () => {
    for (const s of Object.values(STATUS_PAGAMENTO)) {
      expect(pagamentoSchema.safeParse({ valor: 100, status_pagamento: s }).success).toBe(true);
    }
  });

  it('keeps cartao/cheque untyped (z.unknown() opaque fields)', () => {
    const cartao = { last4: '1234', bandeira: 'visa' };
    const out = pagamentoSchema.parse({ valor: 50, cartao });
    expect(out.cartao).toEqual(cartao);
  });

  // No `.passthrough()` (#463): an unmodeled key is stripped on a lenient
  // parse (the read path, `parseSoftRead` in `@delfrance/data`) — this is what
  // keeps a legacy corpus doc carrying a since-retired field readable (root
  // `CLAUDE.md` rule 8) — but throws on the write path, which re-parses
  // strictly whenever the lenient parse dropped a caller-supplied key
  // (`parseForWrite`/`parseMergePatch`, `packages/data/src/zodParse.ts`).
  it('silently strips a genuinely unknown top-level key on a lenient (read) parse', () => {
    const parsed = pagamentoSchema.parse({ valor: 100, someRetiredLegacyField: 'whatever' });
    expect(parsed).not.toHaveProperty('someRetiredLegacyField');
  });

  it('rejects a genuinely unknown top-level key on a strict (write) parse', () => {
    // Mirrors the `.strict()` re-parse `parseForWrite`/`parseMergePatch` run
    // internally once they notice the lenient parse above dropped a key.
    // Asserts the issue CODE, not the message: this repo installs a pt-BR Zod
    // error map, so the rendered message is locale text ("Chave desconhecida:
    // ..."), not the English "unrecognized" a message-regex would look for.
    const result = pagamentoSchema.strict().safeParse({ valor: 100, someUnknownField: 'whatever' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['someUnknownField'],
    });
  });
});

describe('statusToEstadoPedido', () => {
  it('aprovado → pago', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.aprovado)).toBe('pago');
  });
  it('recusado → pagamentoNaoRealizado', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.recusado)).toBe('pagamentoNaoRealizado');
  });
  it('cancelado → cancelado', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.cancelado)).toBe('cancelado');
  });
  it('estornado_parcialmente → estornadoParcialmente', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.estornado_parcialmente)).toBe(
      'estornadoParcialmente',
    );
  });
  it('pendente → aguardandoConfirmacaoDePagamento', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.pendente)).toBe(
      'aguardandoConfirmacaoDePagamento',
    );
  });
  it('em_disputa → pago — a mediation is a HOLD, not a reversal', () => {
    // Pinned because it is half of an invariant that spans two functions: this
    // one says a disputed payment keeps the pedido paid, and
    // `isPagamentoPagante` below has to agree. They disagreed until #1322.
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.em_disputa)).toBe('pago');
  });
});

describe('isPagamentoPagante / sumPagamentosPagos', () => {
  it('counts null, aprovado and em_disputa — and nothing else', () => {
    // An explicit allow/deny split rather than a loop over the enum: a loop
    // would re-derive the rule from the implementation and could not catch a
    // member silently changing sides.
    const pagantes = [null, undefined, STATUS_PAGAMENTO.aprovado, STATUS_PAGAMENTO.em_disputa];
    for (const s of pagantes) {
      expect(isPagamentoPagante(s), `status ${String(s)} must count as paid`).toBe(true);
    }
    const naoPagantes = [
      STATUS_PAGAMENTO.pendente,
      STATUS_PAGAMENTO.em_revisao,
      STATUS_PAGAMENTO.pago_parcialmente,
      STATUS_PAGAMENTO.em_processo_aprovacao,
      STATUS_PAGAMENTO.recusado,
      STATUS_PAGAMENTO.cancelado,
      STATUS_PAGAMENTO.estornado,
      STATUS_PAGAMENTO.devolvido,
      STATUS_PAGAMENTO.estornado_parcialmente,
      STATUS_PAGAMENTO.estornado_totalmente,
    ];
    for (const s of naoPagantes) {
      expect(isPagamentoPagante(s), `status ${String(s)} must NOT count as paid`).toBe(false);
    }
    // Every member is accounted for on one side or the other — so a NEW status
    // added to the enum fails here instead of silently defaulting to unpaid.
    expect(pagantes.filter((s) => s != null).length + naoPagantes.length).toBe(
      Object.keys(STATUS_PAGAMENTO).length,
    );
  });

  it('a disputed payment still covers the pedido total', () => {
    // ⚠️ The regression. `em_disputa` used to sum to ZERO, so a mediation
    // dropped `valorPago` below the total and `nextPedidoEstado` downgraded a
    // fully-paid pedido to `aguardandoConfirmacaoDePagamento` — on the Mercado
    // Pago webhook path and on the operator's own "reconciliar" button. ML has
    // not moved the money at that point; it holds it as `retained`.
    expect(
      sumPagamentosPagos([{ valor: 100, status_pagamento: STATUS_PAGAMENTO.em_disputa }]),
    ).toBe(100);
    // A real refund is the one that stops covering it — and it arrives through
    // the payments topic, not the claims path.
    expect(sumPagamentosPagos([{ valor: 100, status_pagamento: STATUS_PAGAMENTO.estornado }])).toBe(
      0,
    );
  });
});

describe('metodoPagamentoSchema', () => {
  it('parses a Mercado Pago entry', () => {
    const out = metodoPagamentoSchema.parse({ tipo: 1, nome: 'MP Loja' });
    expect(out.tipo).toBe(1);
    expect(out.hasLinkPagamento).toBe(false);
  });
  it('rejects unknown tipo', () => {
    expect(metodoPagamentoSchema.safeParse({ tipo: 999, nome: 'X' }).success).toBe(false);
  });
  it('rejects empty nome', () => {
    expect(metodoPagamentoSchema.safeParse({ tipo: 1, nome: '' }).success).toBe(false);
  });
  it('defaults user_id to null when not OAuth-connected yet', () => {
    const out = metodoPagamentoSchema.parse({ tipo: 1, nome: 'MP Loja' });
    expect(out.user_id).toBeNull();
  });
  it('accepts a denormalized Mercado Pago collector user_id', () => {
    const out = metodoPagamentoSchema.parse({ tipo: 1, nome: 'MP Loja', user_id: 123456789 });
    expect(out.user_id).toBe(123456789);
  });
});

/* -------------------------------------------------------------------------- */
/*        Marketplace money diary + settlement stamp (#1514, step 6)           */
/* -------------------------------------------------------------------------- */

/**
 * The Shopee SG sandbox escrow, as the mapper folds it (order 260910KJBHUJDM):
 * `buyer_total_amount 31.99`, `escrow_amount 30.7`,
 * `escrow_amount_after_adjustment 30.7`, and the three Income-Report fee columns
 * `commission_fee 0.65 + service_fee 0 + seller_transaction_fee 0.64` = 1.29 —
 * the same 1.29 the spread composition answers on this order.
 */
const TAXAS_SG = {
  comissao: 0.65,
  servico: 0,
  transacaoVendedor: 0.64,
  campanha: 0,
  protecaoFrete: 0,
  processamento: 0,
  ajustes: 0,
  devolucoes: 0,
};

/** The order clock of the delivery that wrote the diary (µs) — never `nowUs`. */
const ATUALIZADO_EM_US = 1_757_500_000_000_000;
/** `escrow_release_time` as Shopee sends it: SECONDS. */
const RELEASE_S = 1_757_500_000;
/** The same instant in the µs the stamp stores. */
const RELEASE_US = RELEASE_S * 1_000_000;

const MARKETPLACE_SG = {
  tipo: 'shopee',
  orderSn: '260910KJBHUJDM',
  buyerTotalAmount: 31.99,
  escrowAmount: 30.7,
  escrowAmountAfterAdjustment: 30.7,
  tarifasBrutas: 1.29,
  taxas: TAXAS_SG,
  atualizadoEm: ATUALIZADO_EM_US,
};

const LIQUIDACAO_SG = {
  payoutAmount: 30.7,
  escrowReleaseTimeUs: RELEASE_US,
  liquidadoEmUs: 1_757_600_000_000_000,
  fonte: LIQUIDACAO_FONTE.escrowList,
};

describe('pagamentoSchema — marketplace + liquidacao (step 6)', () => {
  it('defaults BOTH blocks to null on a pagamento that never saw a marketplace', () => {
    const out = pagamentoSchema.parse({ valor: 1 });
    expect(out.marketplace).toBeNull();
    expect(out.liquidacao).toBeNull();
  });

  it('round-trips both blocks through the write path with every VALUE preserved', () => {
    // `.strict()` is the re-parse `parseForWrite` / `parseMergePatch` run once
    // the lenient parse drops a caller-supplied key (packages/data's
    // zodParse.ts). packages/schemas cannot import packages/data — the
    // dependency runs the other way — so the strict re-parse is exercised
    // directly here, exactly as the unknown-key tests above do.
    const doc = { valor: 31.99, marketplace: MARKETPLACE_SG, liquidacao: LIQUIDACAO_SG };
    const parsed = pagamentoSchema.strict().parse(doc);
    expect(parsed.marketplace).toEqual(MARKETPLACE_SG);
    expect(parsed.liquidacao).toEqual(LIQUIDACAO_SG);
    // A patch naming ONLY one of the two keys validates on its own — that is
    // what makes the two writers' update masks disjoint at all. `parseMergePatch`
    // validates through `.partial()` (so every other field takes its default)
    // and then narrows the result back down to the keys the caller SUPPLIED;
    // that second step is the mask, and it is reproduced here because
    // packages/schemas cannot import packages/data.
    const supplied: Record<string, unknown> = { liquidacao: LIQUIDACAO_SG };
    const validado = pagamentoSchema.partial().strict().parse(supplied) as Record<string, unknown>;
    const patch = Object.fromEntries(Object.keys(supplied).map((k) => [k, validado[k]]));
    expect(patch).toEqual({ liquidacao: LIQUIDACAO_SG });
    // The mask really is a mask: the sweep's patch does not name `marketplace`,
    // so the task's diary cannot be overwritten by it.
    expect(Object.keys(patch)).not.toContain('marketplace');
    expect(validado.marketplace).toBeNull(); // the anchor: `.partial()` alone WOULD have
  });

  it('keeps an unknown NESTED key (passthrough) but throws on an unknown TOP-LEVEL one', () => {
    // The two halves are one decision: the blocks mirror a provider payload
    // that grows without telling us, so an unmodeled escrow field must survive
    // a re-write; the document's own top level must not.
    const comExtra = {
      valor: 31.99,
      marketplace: { ...MARKETPLACE_SG, campoNovoDoShopee: 'x' },
      liquidacao: { ...LIQUIDACAO_SG, campoNovoDaLiquidacao: 7 },
    };
    const parsed = pagamentoSchema.strict().parse(comExtra);
    expect(parsed.marketplace).toMatchObject({ campoNovoDoShopee: 'x' });
    expect(parsed.liquidacao).toMatchObject({ campoNovoDaLiquidacao: 7 });
    // The anchor: the SAME parse refuses an unknown key one level up.
    const top = pagamentoSchema
      .strict()
      .safeParse({ valor: 31.99, liquidacaoShopee: LIQUIDACAO_SG });
    expect(top.success).toBe(false);
    expect(top.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['liquidacaoShopee'],
    });
  });

  it('a negative fee survives as tarifasBrutas while top-level tarifas refuses it', () => {
    // The clamp's SCOPE. `tarifas` is what the ERP charges and is `.min(0)`;
    // `tarifasBrutas` is the PRE-clamp raw, so a Shopee credit stays visible as
    // data instead of vanishing into a 0. Both directions asserted — a schema
    // that clamped both would pass a test that only checked one.
    expect(
      marketplacePagamentoSchema.parse({ ...MARKETPLACE_SG, tarifasBrutas: -1.29 }).tarifasBrutas,
    ).toBe(-1.29);
    expect(pagamentoSchema.safeParse({ valor: 1, tarifas: -1.29 }).success).toBe(false);
    expect(pagamentoSchema.parse({ valor: 1, tarifas: 1.29 }).tarifas).toBe(1.29);
  });

  it('marketplace requires tipo and holds it to the enum', () => {
    const { tipo: _tipo, ...semTipo } = MARKETPLACE_SG;
    expect(marketplacePagamentoSchema.safeParse(semTipo).success).toBe(false);
    expect(marketplacePagamentoSchema.parse(MARKETPLACE_SG).tipo).toBe('shopee');
    // Near-miss: a typo is not a marketplace.
    expect(
      marketplacePagamentoSchema.safeParse({ ...MARKETPLACE_SG, tipo: 'shopeee' }).success,
    ).toBe(false);
  });

  it('defaults every escrow number to null when only tipo is known', () => {
    expect(marketplacePagamentoSchema.parse({ tipo: 'shopee' })).toEqual({
      tipo: 'shopee',
      orderSn: null,
      buyerTotalAmount: null,
      escrowAmount: null,
      escrowAmountAfterAdjustment: null,
      tarifasBrutas: null,
      taxas: null,
      atualizadoEm: null,
    });
    expect(marketplacePagamentoTaxasSchema.parse({})).toEqual({
      comissao: null,
      servico: null,
      transacaoVendedor: null,
      campanha: null,
      protecaoFrete: null,
      processamento: null,
      ajustes: null,
      devolucoes: null,
    });
  });

  it('keeps a fee of exactly 0 as 0 — it is a real fee, not an absent one', () => {
    // `service_fee: 0` is what the SG fixture actually carries. A reader that
    // folded 0 to null would make "we were charged nothing" and "we never
    // asked" the same value.
    const parsed = marketplacePagamentoTaxasSchema.parse(TAXAS_SG);
    expect(parsed.servico).toBe(0);
    expect(parsed.servico).not.toBeNull();
  });
});

describe('liquidacaoPagamentoSchema (step 6)', () => {
  it('defaults every field to null', () => {
    expect(liquidacaoPagamentoSchema.parse({})).toEqual({
      payoutAmount: null,
      escrowReleaseTimeUs: null,
      liquidadoEmUs: null,
      fonte: null,
    });
  });

  it('accepts escrow_list as the source and refuses a near-miss token', () => {
    expect(liquidacaoPagamentoSchema.parse({ fonte: 'escrow_list' }).fonte).toBe('escrow_list');
    // Near-miss: the DETAIL endpoint is where the fees come from and it carries
    // no release time at all, so it can never be a settlement source.
    expect(liquidacaoPagamentoSchema.safeParse({ fonte: 'escrow_detail' }).success).toBe(false);
    // The companion constant covers the enum exactly — a member added to one
    // and not the other fails here rather than at a call site.
    expect(Object.values(LIQUIDACAO_FONTE)).toEqual(liquidacaoFonteSchema.options);
  });

  it('escrowReleaseTimeUs is MICROseconds — a raw SECONDS value silently reads 1970', () => {
    // The near-miss the whole `S`/`Us` suffix discipline exists for. The field
    // is tolerant (microsSinceEpoch coerces a ms-magnitude number by ×1000), so
    // handing it Shopee's seconds does NOT throw: it stores 1970-01-21, which
    // would make every stored stamp older than every incoming one for ever.
    const errado = liquidacaoPagamentoSchema.parse({ escrowReleaseTimeUs: RELEASE_S });
    expect(errado.escrowReleaseTimeUs).toBe(RELEASE_S * 1000);
    expect(new Date((errado.escrowReleaseTimeUs ?? 0) / 1000).getUTCFullYear()).toBe(1970);
    // The correct conversion round-trips untouched...
    const certo = liquidacaoPagamentoSchema.parse({ escrowReleaseTimeUs: RELEASE_US });
    expect(certo.escrowReleaseTimeUs).toBe(RELEASE_US);
    expect(new Date(RELEASE_US / 1000).getUTCFullYear()).toBe(2025);
    // ...and the two stay DISTINCT, which is the whole point.
    expect(errado.escrowReleaseTimeUs).not.toBe(certo.escrowReleaseTimeUs);
  });

  it('keeps payoutAmount VERBATIM — the unit is unresolved, so nothing converts it', () => {
    // Both readings of Shopee's own page reach the document unchanged: the
    // sweep logs the ratio against escrowAmount, and that is what will answer it.
    expect(liquidacaoPagamentoSchema.parse({ payoutAmount: 30.7 }).payoutAmount).toBe(30.7);
    expect(liquidacaoPagamentoSchema.parse({ payoutAmount: 3070 }).payoutAmount).toBe(3070);
  });
});
