import { describe, expect, it } from 'vitest';

import { roundReais } from '@delfrance/core/money';
import {
  CRT,
  CSOSN,
  CST_PIS_COFINS,
  MODALIDADE_FRETE,
  MODO_GRUPOS_IMPOSTO,
  ORIGEM,
  FORMA_PAGAMENTO,
  GRUPO_AJUSTE_RTC,
  INTEGRACAO_TIPO,
  UF_SIGLA,
  freteDoPedidoSchema,
  pagamentoSchema,
  type Endereco,
  type FreteDoPedido,
  type IntegracaoTipo,
} from '@delfrance/schemas';

import { generateNFe } from '@delfrance/integrations-nfe';

import {
  ajusteDoItem,
  apportionDescontos,
  assertNotaBuildable,
  buildGeneratorInput,
  buildGenItems,
  isInterstateFor,
  modoGruposFor,
  rtcDaNota,
} from '../../../lib/nfe/orchestrator/generator-input';
import {
  lerAjusteRtc,
  lerDfeReferenciado,
  type EntregaDoPedido,
  type FiscalItem,
  type PedidoBundle,
} from '../../../lib/nfe/orchestrator/bundle';
import { NFeOrchestratorError } from '../../../lib/nfe/orchestrator/errors';

/**
 * Regression tests for the discount handling in the NF-e generator input.
 *
 * Bugs fixed:
 *  - the wire `<prod><vProd>` must be GROSS (`vUnCom × qCom`) with the discount
 *    in `<prod><vDesc>`, else SEFAZ rejects with cStat 629;
 *  - `pedido.descontoTotal` must be apportioned across items (it was silently
 *    dropped, overstating `vNF` and mismatching payments → cStat 865).
 */

/**
 * Minimal bundle carrying only the fields buildGenItems/apportionDescontos read,
 * plus the UFs `isInterstateFor` compares (assertNotaBuildable derives
 * interstate itself). Both default to 'SP' — an intra-state sale — and the
 * goods go to the fiscal address unless `entrega` says otherwise (#422).
 */
function bundleWith(
  operacao: Record<string, unknown>,
  pedido: Record<string, unknown> = {},
  ufs: { readonly dest?: string; readonly sede?: string } = {},
  entrega: EntregaDoPedido = { tipo: 'enderecoFiscal' },
): PedidoBundle {
  return {
    pedidoId: 'PED-TEST',
    operacao,
    pedido,
    cliente: CLIENTE_PF,
    enderecoDest: { estado: ufs.dest ?? 'SP' },
    entrega,
    filial: { sede: { estado: ufs.sede ?? 'SP' } },
  } as unknown as PedidoBundle;
}

/** A pessoa-física cliente with a valid CPF — the `<entrega>` fallback identity. */
const CLIENTE_PF = { tipo: '0', cpf_cnpj: '52998224725', nome: 'Cliente Teste' };

/** A resolvable delivery address in `uf`, cMun/CEP consistent with it. */
function enderecoEntrega(uf: 'RJ' | 'SP' | 'MG'): Endereco {
  const porUf = {
    RJ: { cidade: 'Rio de Janeiro', codigoMunicipio: '3304557', cep: '20010000' },
    SP: { cidade: 'Sao Paulo', codigoMunicipio: '3550308', cep: '01310100' },
    MG: { cidade: 'Belo Horizonte', codigoMunicipio: '3106200', cep: '30130010' },
  }[uf];
  return {
    logradouro: 'Rua da Entrega',
    numero: '10',
    bairro: 'Centro',
    complemento: null,
    estado: uf,
    cPais: null,
    pais: null,
    nome: null,
    cpf_cnpj: null,
    ...porUf,
  } as unknown as Endereco;
}

function outroEndereco(uf: 'RJ' | 'SP' | 'MG'): EntregaDoPedido {
  return {
    tipo: 'outroEndereco',
    path: `clientes/C-1/enderecos/E-${uf}`,
    endereco: enderecoEntrega(uf),
  };
}

/** Minimal FiscalItem — `vProd` is net-of-unit-discount, `vProdBruto` is gross. */
function item(partial: Partial<FiscalItem>): FiscalItem {
  const precoDeVenda = partial.precoDeVenda ?? 100;
  const quantidade = partial.quantidade ?? 1;
  const descontoUnitario = partial.descontoUnitario ?? null;
  return {
    produtoUid: 'prod-1',
    itemIndex: 0,
    sku: 'SKU-1',
    gtin: null,
    nomeDeVenda: 'Camiseta',
    precoDeVenda,
    descontoUnitario,
    quantidade,
    imposto: {
      origem: ORIGEM.nacional,
      unidade: 'UN',
      NCM: '61091000',
      cfop: '5102',
      configuracaoICMS: { crt: '1', csosn: '102' },
    },
    vProd: roundReais((precoDeVenda - (descontoUnitario ?? 0)) * quantidade),
    vProdBruto: roundReais(precoDeVenda * quantidade),
    ...partial,
  } as FiscalItem;
}

const OP = { cfop: '5102', cfopInterestadual: '6102', NCM: '61091000', unidade: 'UN' };

describe('buildGenItems — discount on the wire', () => {
  it('emits GROSS vProd + vDesc for a per-unit discount (not a net vProd)', () => {
    const it0 = item({ precoDeVenda: 100, quantidade: 2, descontoUnitario: 10 });
    const [gi] = buildGenItems([it0], bundleWith(OP), false);
    // vUnCom × qCom = 100 × 2 = 200 (gross); vDesc = 10 × 2 = 20; net = 180.
    expect(gi!.vProd).toBe(200);
    expect(gi!.vDesc).toBe(20);
    expect(gi!.vUnCom).toBe(100);
    expect(gi!.qCom).toBe(2);
  });

  it('omits vDesc when there is no discount', () => {
    const [gi] = buildGenItems([item({ precoDeVenda: 50, quantidade: 3 })], bundleWith(OP), false);
    expect(gi!.vProd).toBe(150);
    expect(gi!.vDesc).toBeUndefined();
  });

  it('throws when the discount exceeds the gross item value', () => {
    // descontoTotal larger than the whole order → apportioned share blows past gross.
    const it0 = item({ precoDeVenda: 10, quantidade: 1 });
    expect(() => buildGenItems([it0], bundleWith(OP, { descontoTotal: 999 }), false)).toThrow(
      /desconto .* exceeds the gross item value/,
    );
  });
});

describe('apportionDescontos — pedido-level descontoTotal', () => {
  it('splits descontoTotal proportional to net subtotal, remainder on the last item', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }), // net 100
      item({ produtoUid: 'b', precoDeVenda: 300, quantidade: 1 }), // net 300
    ];
    // descontoTotal 40 over net total 400 → 10 to item A (25%), 30 remainder to B.
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 40 }));
    expect(vDescs).toEqual([10, 30]);
    expect(vDescs[0]! + vDescs[1]!).toBe(40);
  });

  it('adds the unit discount to the apportioned order share', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1, descontoUnitario: 5 }), // unit 5, net 95
      item({ produtoUid: 'b', precoDeVenda: 100, quantidade: 1 }), // net 100
    ];
    // order desc 39 over net 195 → A share round(39*95/195)=19 (used), B remainder 20.
    // A total vDesc = 5 + 19 = 24; B total = 0 + 20 = 20.
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 39 }));
    expect(vDescs[0]).toBe(24);
    expect(vDescs[1]).toBe(20);
  });

  it('returns only the unit discounts when descontoTotal is 0/absent', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 2, descontoUnitario: 3 }), // 6
      item({ produtoUid: 'b', precoDeVenda: 100, quantidade: 1 }), // 0
    ];
    expect(apportionDescontos(items, bundleWith(OP))).toEqual([6, 0]);
  });

  it('never leaks a rounding cent: Σ vDesc equals Σ unit discount + descontoTotal', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 33.33, quantidade: 1 }),
      item({ produtoUid: 'b', precoDeVenda: 33.33, quantidade: 1 }),
      item({ produtoUid: 'c', precoDeVenda: 33.34, quantidade: 1 }),
    ];
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 10 }));
    const sum = vDescs.reduce((s, v) => s + v, 0);
    expect(roundReais(sum)).toBe(10);
  });

  it('does not overshoot when equal shares land on a half-cent (Σ stays exact, no negative)', () => {
    // 4 × R$1,00 with a R$0,02 order discount: naïve per-item rounding gives
    // 0,01+0,01+0,01 = 0,03 > 0,02 and a negative last share. The cumulative
    // method must keep Σ = 0,02 with every share ≥ 0.
    const items = Array.from({ length: 4 }, (_, i) =>
      item({ produtoUid: `p${i}`, precoDeVenda: 1, quantidade: 1 }),
    );
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 0.02 }));
    expect(vDescs.every((v) => v >= 0)).toBe(true);
    expect(roundReais(vDescs.reduce((s, v) => s + v, 0))).toBe(0.02);
  });

  it('does not overshoot on the classic 20-item × R$0,50 case (would be R$0,57 naïvely)', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item({ produtoUid: `p${i}`, precoDeVenda: 10, quantidade: 1 }),
    );
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 0.5 }));
    expect(vDescs.every((v) => v >= 0)).toBe(true);
    expect(roundReais(vDescs.reduce((s, v) => s + v, 0))).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Σ vPag ↔ vNF pre-send guard (#394 — NT 2025.001 YA03-10/-20, cStat 865/866)
// ---------------------------------------------------------------------------

/** Bundle full enough for buildGeneratorInput (single SP→SP item, no frete). */
function fullBundle(opts: {
  pagamentos?: unknown[];
  frete?: FreteDoPedido | null;
  pedido?: Record<string, unknown>;
  /**
   * Sales channel — drives the <vTroco> gate. OMITTED on purpose in the older
   * guard tests: an absent tipo is the conservative "unknown channel" arm, so
   * those keep asserting the plain 865/866 throw.
   */
  integracaoTipo?: IntegracaoTipo | null;
}): PedidoBundle {
  return {
    pedidoId: 'PED-GUARD',
    pedido: opts.pedido ?? {},
    operacao: { ...OP, ehExterior: false, indIntermed: '0', infCpl: null },
    filial: { sede: { estado: 'SP' } },
    cliente: {},
    enderecoDest: { estado: 'SP' },
    entrega: { tipo: 'enderecoFiscal' },
    integracao: null,
    integracaoTipo: opts.integracaoTipo,
    frete: opts.frete ?? null,
    pagamentos: (opts.pagamentos ?? []).map((p) => pagamentoSchema.parse(p)),
    regrasImposto: [],
  } as unknown as PedidoBundle;
}

/** One 100-reais item → vNF = 100 (no frete, no discount). */
const ITEM_100 = [item({ precoDeVenda: 100, quantidade: 1 })];

function build(bundle: PedidoBundle) {
  return buildGeneratorInput(bundle, ITEM_100, 7, 1, 'homologacao');
}

describe('buildGeneratorInput — Σ vPag ↔ vNF guard', () => {
  it('Σ vPag < vNF → throws naming both values (would be SEFAZ 865)', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 90, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
    });
    expect(() => build(bundle)).toThrow(/90\.00.*100\.00.*865/s);
  });

  it('the frete-emitente hint fires ONLY on that shape, not on every mismatch', () => {
    // A hint that appears on every failure teaches nothing. Two payments with
    // NO emitente frete, and a single payment WITH one, must both stay silent.
    const semFrete = fullBundle({
      pagamentos: [
        { valor: 40, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 10, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
    });
    expect(() => build(semFrete)).toThrow(/865/);
    expect(() => build(semFrete)).not.toThrow(/emitente/);
  });

  it('Σ vPag > vNF on an UNKNOWN channel → throws (would be SEFAZ 866)', () => {
    // No integracaoTipo: emitting a troco requires KNOWING the channel does not
    // settle the payment for us, so an unreadable tipo keeps the hard throw.
    const bundle = fullBundle({
      pagamentos: [
        { valor: 60, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 60, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
    });
    expect(() => build(bundle)).toThrow(/866/);
    expect(() => build(bundle)).toThrow(/não informa o campo "tipo"/);
  });

  it('Σ vPag == vNF → passes and emits the payments', () => {
    const bundle = fullBundle({
      pagamentos: [
        { valor: 40, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 60, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
    });
    const out = build(bundle);
    expect(out.pagXml).toContain('<vPag>40.00</vPag>');
    expect(out.pagXml).toContain('<vPag>60.00</vPag>');
  });

  it('empty pagamentos (default tPag=90) → guard skipped', () => {
    const out = build(fullBundle({ pagamentos: [] }));
    expect(out.pagXml).toContain('<tPag>90</tPag>');
  });

  it('explicit sem-pagamento record (forma=90, valor>0) → guard skipped, vPag=0', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 50, forma_de_pagamento: FORMA_PAGAMENTO.sem_pagamento }],
    });
    const out = build(bundle);
    expect(out.pagXml).toContain('<vPag>0.00</vPag>');
  });

  it('frete-emitente single-payment override (vPag := vNF) → guard passes', () => {
    // vNF = 100 (item) + 20 (frete emitente) = 120; the single payment's valor
    // (55) is overridden to vNF by the documented Flutter-parity rule.
    const bundle = fullBundle({
      pagamentos: [{ valor: 55, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
      frete: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 20 } as FreteDoPedido,
    });
    const out = build(bundle);
    expect(out.pagXml).toContain('<vPag>120.00</vPag>');
  });

  it('⚠️ frete-emitente + TWO payments → override does NOT apply, and the guard throws', () => {
    // Pinned as a DECISION, not left as a discovery (#1322 review).
    //
    // The override is gated on `pagamentos.length === 1` — a faithful port of
    // Flutter's `pedido_nfe_base.dart:1790-1821`, which only ever handled the
    // single-payment shape. With two payments there is no defined rule for
    // WHICH one absorbs the freight, so the sum falls short of vNF and the
    // Σ vPag ↔ vNF guard throws (SEFAZ 865) rather than emitting a nota whose
    // payment breakdown we invented.
    //
    // ⚠️ This is pre-existing — two `aprovado` payments plus CIF frete throw
    // today. What #1322 changed is REACHABILITY: `isPagamentoPagante` now
    // counts `em_disputa`, so an ML combo payment (card + account money) with
    // one leg in mediation arrives here as two entries where it used to arrive
    // as one. Generalising the override is a FISCAL decision, not a mechanical
    // one, and it would have to be made identically in
    // `buildCobrFromPagamentos` — where the same gate sets duplicata amounts,
    // which are credit instruments. That is deliberately not decided here.
    const bundle = fullBundle({
      pagamentos: [
        { valor: 90, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 10, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
      frete: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 20 } as FreteDoPedido,
    });
    // Σ = 100, vNF = 120 → blocked, loudly, before numeração is allocated.
    expect(() => build(bundle)).toThrow(/100\.00.*120\.00.*865/s);
    // And the message must NAME the override, or an operator staring at two
    // correct pagamentos has no way to reach that explanation.
    expect(() => build(bundle)).toThrow(/frete é por conta do emitente/);
    expect(() => build(bundle)).toThrow(/UM único pagamento/);
  });

  it('a lone em_disputa payment now emits a REAL total, not "sem pagamento"', () => {
    // The other half of the #1322 trade, and the bigger win. Before
    // `isPagamentoPagante` counted `em_disputa`, this pedido reached the
    // orchestrator with ZERO pagamentos, took the empty-list default
    // (`tPag: '90'`, vPag 0), skipped the guard via `allSemPagamento` — and
    // emitted a nota declaring NO PAYMENT for a sale that was really paid.
    // A wrong nota, silently. That is what the widening fixes.
    const bundle = fullBundle({
      pagamentos: [{ valor: 100, forma_de_pagamento: FORMA_PAGAMENTO.pix }],
    });
    const out = build(bundle);
    expect(out.pagXml).toContain('<vPag>100.00</vPag>');
    expect(out.pagXml).not.toContain('<tPag>90</tPag>');
  });
});

// ---------------------------------------------------------------------------
// <vTroco> — an over-payment is LEGAL with change, and only on a channel that
// does not settle the payment for us. cStat 866 (YA03-20) is literally
// "ausência de troco quando o valor dos pagamentos informados for maior que o
// total da nota", so the rejection names its own remedy.
//
// ⚠️ These tests pin the SCOPE of the gate, not just that it fires: every
// "emits a troco" case is paired with an identical over-payment that must NOT.
// ---------------------------------------------------------------------------

/** vNF = 100 (ITEM_100). Customer hands 110 → troco 10. */
const PAGO_110 = [{ valor: 110, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }];

describe('buildGeneratorInput — <vTroco> channel gate', () => {
  it('balcão + over-payment → emits <vTroco>, no throw', () => {
    const out = build(fullBundle({ pagamentos: PAGO_110, integracaoTipo: INTEGRACAO_TIPO.balcao }));
    expect(out.pagXml).toContain('<vPag>110.00</vPag>');
    expect(out.pagXml).toContain('<vTroco>10.00</vTroco>');
  });

  it('⚠️ whatsapp + over-payment → emits <vTroco>: the gate is the CHANNEL, not buyer presence', () => {
    // A WhatsApp order paid in cash to the motoboy is indPres='2' (não
    // presencial) and still hands back real change. This is the case that rules
    // out gating on operacao.indPres — do not "fix" the gate back to it.
    const out = build(
      fullBundle({ pagamentos: PAGO_110, integracaoTipo: INTEGRACAO_TIPO.whatsapp }),
    );
    expect(out.pagXml).toContain('<vTroco>10.00</vTroco>');
  });

  it('nenhuma (no marketplace integration) + over-payment → emits <vTroco>', () => {
    const out = build(
      fullBundle({ pagamentos: PAGO_110, integracaoTipo: INTEGRACAO_TIPO.nenhuma }),
    );
    expect(out.pagXml).toContain('<vTroco>10.00</vTroco>');
  });

  it('⚠️ mercadoLivre + the IDENTICAL over-payment → still throws 866', () => {
    // The near-miss. ML settles the payment, so Σ vPag > vNF there is a data
    // defect (duplicated / over-recorded pagamento), which is what the guard
    // was built for (#394) — never change handed back.
    const bundle = fullBundle({
      pagamentos: PAGO_110,
      integracaoTipo: INTEGRACAO_TIPO.mercadoLivre,
    });
    expect(() => build(bundle)).toThrow(/866/);
    expect(() => build(bundle)).toThrow(/administrado pelo canal de venda/);
  });

  it('shopee — a marketplace this gate was never taught about — also throws', () => {
    const bundle = fullBundle({ pagamentos: PAGO_110, integracaoTipo: INTEGRACAO_TIPO.shopee });
    expect(() => build(bundle)).toThrow(/866/);
  });

  it('a tipo OUTSIDE the enum counts as a marketplace → throws, never emits a troco', () => {
    // ehMarketplace is tolerant on purpose (the migrated legacy corpus carries
    // wire-format enums integracaoTipoSchema does not model). The tolerant
    // answer must be the SAFE one.
    const bundle = fullBundle({
      pagamentos: PAGO_110,
      integracaoTipo: 4242 as unknown as IntegracaoTipo,
    });
    expect(() => build(bundle)).toThrow(/866/);
  });

  it('balcão + UNDER-payment → still throws 865 (a troco is no remedy for a shortfall)', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 90, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
      integracaoTipo: INTEGRACAO_TIPO.balcao,
    });
    expect(() => build(bundle)).toThrow(/865/);
    expect(() => build(bundle)).not.toThrow(/troco/);
  });

  it('balcão + exact payment → no <vTroco> element at all', () => {
    const out = build(
      fullBundle({
        pagamentos: [{ valor: 100, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
        integracaoTipo: INTEGRACAO_TIPO.balcao,
      }),
    );
    expect(out.pagXml).not.toContain('vTroco');
  });

  it('<vTroco> lands AFTER </detPag>, inside <pag> (XSD sequence order)', () => {
    const out = build(fullBundle({ pagamentos: PAGO_110, integracaoTipo: INTEGRACAO_TIPO.balcao }));
    expect(out.pagXml).toContain('</detPag><vTroco>10.00</vTroco></pag>');
  });

  it('a centavos troco keeps 2 decimals', () => {
    const out = build(
      fullBundle({
        pagamentos: [{ valor: 110.5, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
        integracaoTipo: INTEGRACAO_TIPO.balcao,
      }),
    );
    expect(out.pagXml).toContain('<vTroco>10.50</vTroco>');
  });

  it('over-payment split across two pagamentos → ONE troco for the whole excess', () => {
    const out = build(
      fullBundle({
        pagamentos: [
          { valor: 60, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
          { valor: 60, forma_de_pagamento: FORMA_PAGAMENTO.pix },
        ],
        integracaoTipo: INTEGRACAO_TIPO.balcao,
      }),
    );
    expect(out.pagXml).toContain('<vTroco>20.00</vTroco>');
    expect(out.pagXml.match(/<vTroco>/g)).toHaveLength(1);
  });

  // ── Second axis: tPag. The channel says a troco is POSSIBLE; the payment form
  // says how much of it can be REAL. Change comes out of cash. Every row below
  // threw before #1506 and must keep throwing (PR #1506 review).

  it('balcão + CARD over-payment → throws 866: no acquirer hands back change', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 110, forma_de_pagamento: FORMA_PAGAMENTO.cartao_credito }],
      integracaoTipo: INTEGRACAO_TIPO.balcao,
    });
    expect(() => build(bundle)).toThrow(/866/);
    expect(() => build(bundle)).toThrow(/dinheiro/);
  });

  it('balcão + PIX over-payment → throws 866', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 110, forma_de_pagamento: FORMA_PAGAMENTO.pix }],
      integracaoTipo: INTEGRACAO_TIPO.balcao,
    });
    expect(() => build(bundle)).toThrow(/866/);
  });

  it('balcão + VALE over-payment → throws 866', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 110, forma_de_pagamento: FORMA_PAGAMENTO.vale_alimentacao }],
      integracaoTipo: INTEGRACAO_TIPO.balcao,
    });
    expect(() => build(bundle)).toThrow(/866/);
  });

  it('⚠️ balcão + BOLETO duplicata over-payment → throws: no <vTroco> beside a <cobr>', () => {
    // The <pag> ↔ <cobr> ↔ vNF invariant `buildCobrFromPagamentos` documents. It
    // builds the duplicatas from `bundle.pagamentos` and knows nothing about a
    // troco, so a R$ 110 fatura must never ride a R$ 100 nota that also claims
    // R$ 10 of change — a receivable overstated against its own nota, with the
    // change pure fiction on an indPag='1' payment where no money has moved.
    const bundle = fullBundle({
      pagamentos: [
        {
          valor: 110,
          forma_de_pagamento: FORMA_PAGAMENTO.boleto_bancario,
          duplicata: true,
          aVista: false,
        },
      ],
      integracaoTipo: INTEGRACAO_TIPO.balcao,
    });
    expect(() => build(bundle)).toThrow(/866/);
  });

  it('⚠️ mixed: excess ABOVE the cash leg throws — you cannot hand back 20 from a 5', () => {
    // 5 dinheiro + 115 pix on a 100 nota → excess 20 > 5 cash. The pix row is the
    // over-recorded one. This is the near-miss for the boundary test below.
    const bundle = fullBundle({
      pagamentos: [
        { valor: 5, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 115, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
      integracaoTipo: INTEGRACAO_TIPO.balcao,
    });
    expect(() => build(bundle)).toThrow(/866/);
  });

  it('mixed: excess exactly equal to the cash leg is allowed (boundary)', () => {
    // 20 dinheiro + 100 pix on a 100 nota → excess 20 == cash 20.
    const out = build(
      fullBundle({
        pagamentos: [
          { valor: 20, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
          { valor: 100, forma_de_pagamento: FORMA_PAGAMENTO.pix },
        ],
        integracaoTipo: INTEGRACAO_TIPO.balcao,
      }),
    );
    expect(out.pagXml).toContain('<vTroco>20.00</vTroco>');
  });
});

describe('buildGeneratorInput — guard uses the WIRE (rounded) vPag values', () => {
  it('sub-cent valor is rounded before the comparison, matching what SEFAZ sums', () => {
    // 10.005 → wire <vPag>10.01</vPag> (roundReais at source). vNF = 10.00 →
    // the guard must throw 866 exactly like SEFAZ would; comparing the RAW sum
    // (10.005 → roundReais 10.01) happens to agree here, but the invariant we
    // pin is: guard verdict == wire verdict, judged on the rounded values.
    const bundle = fullBundle({
      pagamentos: [{ valor: 10.005, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
    });
    const items = [item({ precoDeVenda: 10, quantidade: 1 })];
    expect(() => buildGeneratorInput(bundle, items, 7, 1, 'homologacao')).toThrow(/866/);
  });

  it('two sub-cent valores that round to the exact vNF pass and emit rounded vPag', () => {
    // 33.334999… rounds to 33.33 each → Σ 66.66 == vNF (item 66.66) → passes,
    // and the emitted XML carries the same rounded values the guard summed.
    const bundle = fullBundle({
      pagamentos: [
        { valor: 33.331, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 33.329, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
    });
    const items = [item({ precoDeVenda: 66.66, quantidade: 1 })];
    const out = buildGeneratorInput(bundle, items, 7, 1, 'homologacao');
    expect(out.pagXml).toContain('<vPag>33.33</vPag>');
  });
});

/** Imposto that opts the item OUT of the NF-e totals (indTot='0', #398). */
const IMPOSTO_FORA_DO_TOTAL = {
  origem: '0',
  unidade: 'UN',
  NCM: '61091000',
  cfop: '5102',
  compoeValorTotalDaNFe: false,
  configuracaoICMS: { crt: '1', csosn: '102' },
} as const;

describe('indTot — compoeValorTotalDaNFe (#398)', () => {
  it("maps compoeValorTotalDaNFe=false to indTot='0'; absent/true to '1'", () => {
    const items = [
      item({ produtoUid: 'a' }), // no flag → composes
      item({ produtoUid: 'b', imposto: IMPOSTO_FORA_DO_TOTAL as never }),
    ];
    const gis = buildGenItems(items, bundleWith(OP), false);
    expect(gis[0]!.indTot).toBe('1');
    expect(gis[1]!.indTot).toBe('0');
  });

  it('excludes non-composing items from ICMSTot vProd and vNF', () => {
    const bundle = fullBundle({});
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }),
      item({
        produtoUid: 'b',
        precoDeVenda: 50,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
    ];
    const out = buildGeneratorInput(bundle, items, 7, 1, 'homologacao');
    expect(out.totalXml).toContain('<vProd>100.00</vProd>');
    expect(out.totalXml).toContain('<vNF>100.00</vNF>');
  });

  it('gives non-composing items no share of descontoTotal (pin lands on the last composing item)', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }),
      item({
        produtoUid: 'b',
        precoDeVenda: 100,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
      item({ produtoUid: 'c', precoDeVenda: 300, quantidade: 1 }),
    ];
    // 40 over composing net 400 → a: 10, b (fora do total): 0, c (pinned): 30.
    expect(apportionDescontos(items, bundleWith(OP, { descontoTotal: 40 }))).toEqual([10, 0, 30]);
  });

  it('pin still lands the exact remainder when the LAST array item is non-composing', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }),
      item({ produtoUid: 'b', precoDeVenda: 300, quantidade: 1 }),
      item({
        produtoUid: 'c',
        precoDeVenda: 100,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
    ];
    const shares = apportionDescontos(items, bundleWith(OP, { descontoTotal: 40 }));
    expect(shares).toEqual([10, 30, 0]);
    expect(shares.reduce((s, v) => s + v, 0)).toBe(40);
  });

  it("keeps a non-composing item's unit discount on its det but out of the totals vDesc", () => {
    const bundle = fullBundle({});
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }),
      item({
        produtoUid: 'b',
        precoDeVenda: 100,
        quantidade: 1,
        descontoUnitario: 5,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
    ];
    const out = buildGeneratorInput(bundle, items, 7, 1, 'homologacao');
    const gis = buildGenItems(items, bundle, false);
    expect(gis[1]!.vDesc).toBe(5); // stays on the det
    expect(out.totalXml).toContain('<vDesc>0.00</vDesc>'); // out of the totals
    expect(out.totalXml).toContain('<vNF>100.00</vNF>');
  });

  it('stamps frete-emitente vFrete on the FIRST COMPOSING det, not a non-composing one', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 55, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
      frete: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 20 } as FreteDoPedido,
    });
    const items = [
      item({
        produtoUid: 'a',
        precoDeVenda: 50,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
      item({ produtoUid: 'b', precoDeVenda: 100, quantidade: 1 }),
    ];
    const out = buildGeneratorInput(bundle, items, 7, 1, 'homologacao');
    expect(out.itens[0]!.vFrete).toBeUndefined();
    expect(out.itens[1]!.vFrete).toBe(20);
    // vNF = composing vProd (100) + frete (20); the single payment overrides to vNF.
    expect(out.totalXml).toContain('<vNF>120.00</vNF>');
    expect(out.pagXml).toContain('<vPag>120.00</vPag>');
  });
});

/**
 * ⚠️ FISCAL GUARD — freight must NOT enter the nota unless the ISSUER paid it.
 *
 * `buildGeneratorInput` computes `vFrete` only for `modalidade='0'` (CIF,
 * contratação por conta do emitente). Every other modalidade — above all `'1'`
 * (destinatário) and `'2'` (terceiros), which is how every marketplace order is
 * imported — must contribute NOTHING: no `det.prod.vFrete`, `ICMSTot.vFrete`
 * 0.00, and no term in `vNF = vProd + … + vFrete + … − vDesc`.
 *
 * Emitting it anyway makes the store pay tax on freight a third party charged —
 * on ICMS via the item base, and again on every `vNF`-derived figure. That is
 * the single most expensive way this file can be wrong, and until these cases
 * existed it was UNPINNED: deleting the `modalidade === cif` condition left the
 * whole apps/nfe suite green (measured, 2026-08-14).
 *
 * The freight is still DECLARED — `<transp><modFrete>` carries the real code —
 * it is simply not CHARGED. Do not "simplify" the condition away.
 */
describe('vFrete only for frete por conta do emitente (fiscal guard)', () => {
  const NAO_EMITENTE = [
    ['1', 'destinatário (FOB) — how marketplace orders are imported'],
    ['2', 'terceiros — the carrier is contracted by the marketplace'],
    ['3', 'transporte próprio por conta do remetente'],
    ['4', 'transporte próprio por conta do destinatário'],
    ['9', 'sem ocorrência de transporte'],
  ] as const;

  for (const [modalidade, why] of NAO_EMITENTE) {
    it(`modalidade='${modalidade}' (${why}) keeps a R$ 20 frete out of the nota`, () => {
      const bundle = fullBundle({
        pagamentos: [],
        frete: { modalidade, valorCobrado: 20 } as unknown as FreteDoPedido,
      });
      const out = buildGeneratorInput(
        bundle,
        [item({ precoDeVenda: 100, quantidade: 1 })],
        7,
        1,
        'homologacao',
      );

      // Item level: nothing stamped on any det.
      expect(out.itens.every((g) => g.vFrete === undefined)).toBe(true);
      // NF-e level: the totals bag reports zero...
      expect(out.totalXml).toContain('<vFrete>0.00</vFrete>');
      // ...and vNF is the goods alone — NOT 120.00.
      expect(out.totalXml).toContain('<vNF>100.00</vNF>');
      // But the nota still DECLARES who contracted the carrier.
      expect(out.transpXml).toContain(`<modFrete>${modalidade}</modFrete>`);
    });
  }

  /**
   * The case the table above cannot reach: a stored block with NO `modalidade`
   * at all. Every case above casts a literal into `FreteDoPedido`, which skips
   * the schema — but the generator never sees a cast, it sees
   * `freteDoPedidoSchema.safeParse` (`bundle.ts:parseFreteFromPedido`). So this
   * one MUST go through the real parse: the value under test is the schema
   * DEFAULT, and a cast here would test nothing (#1090).
   */
  it('a block stored WITHOUT modalidade parses to a non-emitente code and stays out of the nota', () => {
    const frete = freteDoPedidoSchema.parse({ estado: 'iniciado', valorCobrado: 20 });
    expect(frete.modalidade).not.toBe(MODALIDADE_FRETE.cif);

    const bundle = fullBundle({ pagamentos: [], frete });
    const out = buildGeneratorInput(
      bundle,
      [item({ precoDeVenda: 100, quantidade: 1 })],
      7,
      1,
      'homologacao',
    );

    expect(out.itens.every((g) => g.vFrete === undefined)).toBe(true);
    expect(out.totalXml).toContain('<vFrete>0.00</vFrete>');
    expect(out.totalXml).toContain('<vNF>100.00</vNF>');
    expect(out.transpXml).toContain(`<modFrete>${MODALIDADE_FRETE.fob}</modFrete>`);
  });

  it("modalidade='0' (emitente) is the ONLY case that charges it — the contrast that makes the guard meaningful", () => {
    const bundle = fullBundle({
      pagamentos: [],
      frete: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 20 } as FreteDoPedido,
    });
    const out = buildGeneratorInput(
      bundle,
      [item({ precoDeVenda: 100, quantidade: 1 })],
      7,
      1,
      'homologacao',
    );

    expect(out.itens[0]!.vFrete).toBe(20);
    expect(out.totalXml).toContain('<vFrete>20.00</vFrete>');
    expect(out.totalXml).toContain('<vNF>120.00</vNF>');
  });
});

describe('frete-emitente with no composing item (review fix)', () => {
  it('throws instead of stamping vFrete on an indTot=0 det', () => {
    const bundle = fullBundle({
      pagamentos: [],
      frete: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 20 } as FreteDoPedido,
    });
    const items = [
      item({
        produtoUid: 'a',
        precoDeVenda: 50,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
    ];
    // A det-level vFrete on an excluded item breaks the indTot-conditioned
    // Σ rule; with EVERY item excluded there is no coherent NF-e to emit.
    expect(() => buildGeneratorInput(bundle, items, 7, 1, 'homologacao')).toThrow(
      /nenhum item compõe o total/,
    );
  });
});

/**
 * CSOSN 900 with a PARTIAL 'ICMS próprio' group — vBC/pICMS/vICMS but no modBC.
 * `impostoSchema` accepts it (every csosn900 member is optional); only the
 * engine's build-time XSD-group guard rejects it (#506).
 */
const IMPOSTO_900_PARCIAL = {
  origem: ORIGEM.nacional,
  unidade: 'UN',
  NCM: '61091000',
  cfop: '5102',
  configuracaoICMS: {
    crt: CRT.simplesNacional,
    csosn: CSOSN.outros,
    csosn900: { vBC: 100, pICMS: 18, vICMS: 18 },
  },
} as const;

/** The `where` buildGenItems stamps on every per-item error for `item({})`. */
const ITEM_PREFIX = "pedido 'PED-TEST' item 0 (produto 'prod-1'):";

/** The NFeOrchestratorError message `fn` throws; any other throw propagates. */
function orchestratorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof NFeOrchestratorError) return err.message;
    throw err;
  }
  return expect.fail('expected an NFeOrchestratorError, nothing was thrown');
}

describe('assertNotaBuildable — pre-allocation tribute pre-flight (#506)', () => {
  it('passes for a buildable item and leaves the generation projection unchanged', () => {
    const items = [item({ precoDeVenda: 100, quantidade: 2, descontoUnitario: 10 })];
    const bundle = bundleWith(OP);
    const before = buildGenItems(items, bundle, false);
    expect(assertNotaBuildable(bundle, items, false)).toBeUndefined();
    expect(buildGenItems(items, bundle, false)).toEqual(before);
  });

  it('wraps a partial CSOSN 900 group as NFeOrchestratorError prefixed with pedido/item/produto', () => {
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(bundleWith(OP), [item({ imposto: IMPOSTO_900_PARCIAL as never })], false),
    );
    expect(msg.startsWith(ITEM_PREFIX)).toBe(true);
    expect(msg).toContain("CSOSN '900'");
    expect(msg).toContain('ICMS próprio missing: modBC');
  });

  it('keeps generation precedence — a desconto error wins over a partial 900 on the same item', () => {
    // descontoTotal blows past the gross value AND the imposto is unbuildable:
    // buildGenItems checks vDesc before it builds the imposto, and so must the
    // pre-flight, or the operator would be told about the wrong defect first.
    const items = [
      item({ precoDeVenda: 10, quantidade: 1, imposto: IMPOSTO_900_PARCIAL as never }),
    ];
    const bundle = bundleWith(OP, { descontoTotal: 999 });
    const msg = orchestratorMessage(() => assertNotaBuildable(bundle, items, false));
    expect(msg).toMatch(/desconto .* exceeds the gross item value/);
    expect(msg).not.toContain('CSOSN');
    expect(msg).toBe(orchestratorMessage(() => buildGenItems(items, bundle, false)));
  });

  it('derives interstate from the bundle UFs, exactly as generation does', () => {
    // item() stamps only `cfop`; this operação has no cfopInterestadual either,
    // so an interstate sale has no CFOP to project — an intra-state one does.
    const opSemInterestadual = { cfop: '5102', NCM: '61091000', unidade: 'UN' };
    const items = [item({})];
    expect(assertNotaBuildable(bundleWith(opSemInterestadual), items, false)).toBeUndefined();
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(bundleWith(opSemInterestadual, {}, { dest: 'RJ' }), items, false),
    );
    expect(msg).toBe(
      `${ITEM_PREFIX} no cfopInterestadual — neither imposto.cfopInterestadual nor operacao.cfopInterestadual is set`,
    );
  });

  it('wraps an invalid RTC config (RTC on) as NFeOrchestratorError, like any stored tribute defect', () => {
    // `parseRtcConfig` throws the engine's NFeTributeError: a draft
    // configuracaoIBSCBS is an operator-fixable stored config exactly like a
    // partial CSOSN 900 group, so it gets the same item prefix and the same 400.
    const items = [
      item({
        imposto: {
          origem: ORIGEM.nacional,
          unidade: 'UN',
          NCM: '61091000',
          cfop: '5102',
          configuracaoICMS: { crt: CRT.simplesNacional, csosn: CSOSN.tributadaSemCredito },
          configuracaoIBSCBS: { CST: '000' }, // a draft: no cClassTrib, no rates
        } as never,
      }),
    ];
    const bundle = bundleWith(OP);
    const msg = orchestratorMessage(() => assertNotaBuildable(bundle, items, true));
    expect(msg.startsWith(`${ITEM_PREFIX} Invalid configuracaoIBSCBS`)).toBe(true);
    expect(msg).toBe(orchestratorMessage(() => buildGenItems(items, bundle, false, true)));
    // Near-miss: the same item with RTC off never reads the draft, so it passes —
    // the pre-flight honours the filial's emitRtc like generation does.
    expect(assertNotaBuildable(bundle, items, false)).toBeUndefined();
  });

  it('converts ONLY the engine tribute errors — any other throw from the engine propagates untouched (rule 6)', () => {
    // A fault that is not an in-repo tribute class — standing in for an engine
    // bug — raised from INSIDE buildImpostoXml: the engine's input parse reads
    // configuracaoICMS.csosn, and this getter throws there. It must surface
    // as-is (same class, no item prefix), not be relabelled operator-fixable.
    const fault = new RangeError('unexpected engine fault (test)');
    const imposto = {
      origem: ORIGEM.nacional,
      unidade: 'UN',
      NCM: '61091000',
      cfop: '5102',
      configuracaoICMS: {
        crt: CRT.simplesNacional,
        get csosn(): string {
          throw fault;
        },
      },
    };
    const items = [item({ imposto: imposto as never })];
    const bundle = bundleWith(OP);
    for (const run of [
      () => assertNotaBuildable(bundle, items, false),
      () => buildGenItems(items, bundle, false),
    ]) {
      expect(run).toThrow(RangeError);
      expect(run).toThrow(/^unexpected engine fault \(test\)$/);
      expect(run).not.toThrow(NFeOrchestratorError);
    }
  });

  it('wraps a TributeFormatError (a computed value the wire cannot carry) as NFeOrchestratorError', () => {
    // No stored config reaches TributeFormatError directly. The engine's Zod
    // parse already rejects a negative, non-finite or missing required input,
    // and the optional members are null-guarded before they are formatted.
    // What is left is a COMPUTED value leaving the double range. PIS CST 01 derives vPIS = vProd × pPIS /
    // 100, so a finite, nonnegative (schema-valid) vProd of Number.MAX_VALUE
    // overflows it to Infinity, which `fmtMoney` refuses. That exercises the
    // real `buildImpostoXml` path, with no mock.
    const imposto = {
      origem: ORIGEM.nacional,
      unidade: 'UN',
      NCM: '61091000',
      cfop: '5102',
      configuracaoICMS: { crt: CRT.simplesNacional, csosn: CSOSN.tributadaSemCredito },
      configuracaoPIS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 1.65 },
    };
    const overflowing = [item({ precoDeVenda: Number.MAX_VALUE, imposto: imposto as never })];
    const bundle = bundleWith(OP);
    const expected = `${ITEM_PREFIX} vPIS must be finite, got Infinity`;
    expect(orchestratorMessage(() => assertNotaBuildable(bundle, overflowing, false))).toBe(
      expected,
    );
    expect(orchestratorMessage(() => buildGenItems(overflowing, bundle, false))).toBe(expected);
    // Near-miss: the same imposto on an ordinary price builds, so the overflow,
    // not the config, is what trips the format check.
    const ordinary = [item({ precoDeVenda: 100, imposto: imposto as never })];
    expect(assertNotaBuildable(bundle, ordinary, false)).toBeUndefined();
  });

  it('buildGenItems at generation time surfaces the same NFeOrchestratorError', () => {
    const items = [item({ imposto: IMPOSTO_900_PARCIAL as never })];
    const bundle = bundleWith(OP);
    const msg = orchestratorMessage(() => buildGenItems(items, bundle, false));
    expect(msg.startsWith(ITEM_PREFIX)).toBe(true);
    expect(msg).toContain("CSOSN '900'");
    expect(msg).toContain('ICMS próprio missing: modBC');
    expect(msg).toBe(orchestratorMessage(() => assertNotaBuildable(bundle, items, false)));
  });
});

// ---------------------------------------------------------------------------
// #422 — the DELIVERY address decides interstate (CFOP + idDest), and a
// delivery address the nota cannot carry is refused before a número exists.
// ---------------------------------------------------------------------------

describe('isInterstateFor — delivery UF over fiscal UF (#422)', () => {
  // [label, fiscal UF, entrega, expected] — the emitente is SP throughout.
  const CASES: Array<[string, string, EntregaDoPedido, boolean]> = [
    ['fiscal SP, goods to the fiscal address', 'SP', { tipo: 'enderecoFiscal' }, false],
    ['fiscal RJ, goods to the fiscal address', 'RJ', { tipo: 'enderecoFiscal' }, true],
    ['fiscal SP, delivered in RJ', 'SP', outroEndereco('RJ'), true],
    ['fiscal RJ, delivered in SP', 'RJ', outroEndereco('SP'), false],
    ['fiscal MG, delivered in RJ', 'MG', outroEndereco('RJ'), true],
  ];
  it.each(CASES)('%s → interstate %s', (_label, dest, entrega, expected) => {
    expect(isInterstateFor(bundleWith(OP, {}, { dest }, entrega))).toBe(expected);
  });

  it('an export ignores the delivery UF: a forwarder in the emitente UF still picks cfopInterestadual', () => {
    // idDest=3 is decided by ehExterior alone, so the delivery UF must not pick
    // the CFOP either — SP here would have meant `cfop` beside idDest=3.
    const exportacao = { ...OP, ehExterior: true };
    expect(isInterstateFor(bundleWith(exportacao, {}, { dest: 'EX' }, outroEndereco('SP')))).toBe(
      true,
    );
    // Near-miss: the same bundle as a domestic sale does follow the delivery UF.
    expect(isInterstateFor(bundleWith(OP, {}, { dest: 'EX' }, outroEndereco('SP')))).toBe(false);
  });
});

describe('assertNotaBuildable — the delivery address (#422)', () => {
  const opSemInterestadual = { cfop: '5102', NCM: '61091000', unidade: 'UN' };
  const items = [item({})];

  it('a delivery-driven interstate sale needs a cfopInterestadual — refused like any other', () => {
    // Fiscal SP (intra-state on its own) but delivered in RJ: before #422 this
    // emitted 5102 + idDest=1 for goods leaving the state.
    expect(assertNotaBuildable(bundleWith(opSemInterestadual), items, false)).toBeUndefined();
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(
        bundleWith(opSemInterestadual, {}, {}, outroEndereco('RJ')),
        items,
        false,
      ),
    );
    expect(msg).toBe(
      `${ITEM_PREFIX} no cfopInterestadual — neither imposto.cfopInterestadual nor operacao.cfopInterestadual is set`,
    );
  });

  it('refuses an unresolvable delivery address, naming why — no fallback to the fiscal UF', () => {
    const irresolvivel: EntregaDoPedido = {
      tipo: 'irresolvivel',
      motivo:
        "pedido 'PED-TEST'.freteInicial.enderecoFreteOuterReference: endereco 'x/y' not found",
    };
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(bundleWith(OP, {}, {}, irresolvivel), items, false),
    );
    expect(msg).toBe(`pedido 'PED-TEST': ${irresolvivel.motivo}`);
  });

  it('the delivery address is judged BEFORE the items (generation precedence)', () => {
    // Both defects at once: an unresolvable delivery AND an interstate item
    // with no cfopInterestadual. Which CFOP applies depends on the delivery UF,
    // so the delivery address must be reported first.
    const irresolvivel: EntregaDoPedido = { tipo: 'irresolvivel', motivo: 'motivo X' };
    const bundle = bundleWith(opSemInterestadual, {}, { dest: 'RJ' }, irresolvivel);
    expect(orchestratorMessage(() => assertNotaBuildable(bundle, items, false))).toBe(
      "pedido 'PED-TEST': motivo X",
    );
  });

  it('refuses a delivery address the <entrega> group cannot carry, as NFeOrchestratorError', () => {
    // cMun from São Paulo on an RJ address (rule 279). Left to generation this
    // would be an NFePartiesError — a class the batch path does not carry, so it
    // would consume the número (#506).
    const entrega: EntregaDoPedido = {
      tipo: 'outroEndereco',
      path: 'clientes/C-1/enderecos/E-RJ',
      endereco: { ...enderecoEntrega('RJ'), codigoMunicipio: '3550308' },
    };
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(bundleWith(OP, {}, {}, entrega), items, false),
    );
    expect(msg).toMatch(/^pedido 'PED-TEST': delivery address — /);
    expect(msg).toContain("is not a município of UF 'RJ'");
  });

  describe('an export (ehExterior) has no delivery address', () => {
    const exportacao = { ...OP, ehExterior: true };
    /** A foreign buyer: no CPF/CNPJ, so no `<entrega>` recebedor exists. */
    const estrangeiro = { tipo: '2', cpf_cnpj: null, idEstrangeiro: 'P123456', nome: 'Buyer' };
    const entregaExterior: EntregaDoPedido = {
      tipo: 'outroEndereco',
      path: 'clientes/C-1/enderecos/E-EX',
      endereco: {
        ...enderecoEntrega('SP'),
        estado: 'EX',
        codigoMunicipio: '9999999',
        cep: null,
      } as unknown as Endereco,
    };
    const exportBundle = (entrega: EntregaDoPedido) =>
      ({
        ...bundleWith(exportacao, {}, { dest: 'EX' }, entrega),
        cliente: estrangeiro,
      }) as PedidoBundle;

    it('a separate foreign delivery address is not refused', () => {
      expect(assertNotaBuildable(exportBundle(entregaExterior), items, false)).toBeUndefined();
      // Near-miss: the same address on a domestic sale reaches buildEntrega and
      // is refused — the export is exempt, not the address valid.
      const domestico = { ...exportBundle(entregaExterior), operacao: OP } as PedidoBundle;
      expect(orchestratorMessage(() => assertNotaBuildable(domestico, items, false))).toMatch(
        /^pedido 'PED-TEST': delivery address — /,
      );
    });

    it('an unreadable delivery ref refuses nothing — the export never reads it', () => {
      const irresolvivel: EntregaDoPedido = { tipo: 'irresolvivel', motivo: 'motivo X' };
      expect(assertNotaBuildable(exportBundle(irresolvivel), items, false)).toBeUndefined();
    });
  });
});

describe('buildGeneratorInput — enderecoEntrega (#422)', () => {
  const entregaBundle = (entrega: EntregaDoPedido) =>
    ({ ...fullBundle({}), cliente: CLIENTE_PF, entrega }) as PedidoBundle;

  it('hands the generator the delivery address and projects the interstate CFOP', () => {
    const input = build(entregaBundle(outroEndereco('RJ')));
    expect(input.enderecoEntrega).toEqual(enderecoEntrega('RJ'));
    expect(input.itens[0]!.CFOP).toBe('6102');
  });

  it('sets no enderecoEntrega when the goods go to the fiscal address', () => {
    const input = build(entregaBundle({ tipo: 'enderecoFiscal' }));
    expect('enderecoEntrega' in input).toBe(false);
    expect(input.itens[0]!.CFOP).toBe('5102');
  });

  it('an export sets no enderecoEntrega and keeps cfopInterestadual, even delivered in SP', () => {
    const exportacao = {
      ...entregaBundle(outroEndereco('SP')),
      operacao: { ...fullBundle({}).operacao, ehExterior: true },
      enderecoDest: { estado: UF_SIGLA.EX },
    } as PedidoBundle;
    // `exporta` needs the sede city; nothing else of the export path is under test.
    const input = build({
      ...exportacao,
      filial: { sede: { estado: 'SP', cidade: 'Sao Paulo' } },
    } as unknown as PedidoBundle);
    expect('enderecoEntrega' in input).toBe(false);
    expect(input.itens[0]!.CFOP).toBe('6102');
  });
});

// ---------------------------------------------------------------------------
// #330 — item-level references (det/DFeReferenciado): the SAME document rules
// the pedido editor shows (`violacoesDoDocumento`), refused before a número.
// ---------------------------------------------------------------------------

describe('lerDfeReferenciado — best-effort read of the stored item field', () => {
  it('reads the stored shape and absence', () => {
    expect(lerDfeReferenciado(null)).toBeNull();
    expect(lerDfeReferenciado(undefined)).toBeNull();
    expect(lerDfeReferenciado({ chaveAcesso: 'X', nItem: 2 })).toEqual({
      chaveAcesso: 'X',
      nItem: 2,
    });
    expect(lerDfeReferenciado({ chaveAcesso: 'X', nItem: null })).toEqual({
      chaveAcesso: 'X',
      nItem: null,
    });
  });

  it('keeps a malformed value as an UNUSABLE reference — never drops it silently', () => {
    expect(lerDfeReferenciado('X')).toEqual({ chaveAcesso: '', nItem: Number.NaN });
    expect(lerDfeReferenciado({ chaveAcesso: 7, nItem: '3' })).toEqual({
      chaveAcesso: '',
      nItem: Number.NaN,
    });
  });
});

describe('assertNotaBuildable — the document rules (#330)', () => {
  const CHAVE = '35260514200166000187550010000000071000000011';
  const comRef = (dfeReferenciado: FiscalItem['dfeReferenciado']) => [item({ dfeReferenciado })];

  it('passes a valid item reference with the Reforma Tributária on', () => {
    expect(
      assertNotaBuildable(bundleWith(OP), comRef({ chaveAcesso: CHAVE, nItem: 2 }), true),
    ).toBeUndefined();
  });

  it('refuses an item reference with the Reforma Tributária off', () => {
    expect(
      orchestratorMessage(() =>
        assertNotaBuildable(bundleWith(OP), comRef({ chaveAcesso: CHAVE, nItem: 2 }), false),
      ),
    ).toBe(
      "pedido 'PED-TEST': A referência por item (DF-e referenciado) só é emitida com a Reforma Tributária ativa nesta filial.",
    );
  });

  it('lists EVERY blocking violation, with the item and the SEFAZ code', () => {
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(
        bundleWith(OP, { chNFeReferenciadas: [CHAVE] }),
        comRef({ chaveAcesso: CHAVE, nItem: null }),
        true,
      ),
    );
    expect(msg).toContain('(SEFAZ 1010)');
    expect(msg).toContain(
      'Item 1: Informe o número do item da nota referenciada (nItem). (SEFAZ 1048)',
    );
  });

  it('a nota with no item reference is untouched by the rules (NFref alone is fine)', () => {
    expect(
      assertNotaBuildable(bundleWith(OP, { chNFeReferenciadas: [CHAVE] }), [item({})], false),
    ).toBeUndefined();
  });

  it('buildGenItems hands the reference to the generator (nItem only when set)', () => {
    const [comNItem] = buildGenItems(
      comRef({ chaveAcesso: CHAVE, nItem: 2 }),
      bundleWith(OP),
      false,
    );
    expect(comNItem!.dfeReferenciado).toEqual({ chaveAcesso: CHAVE, nItem: 2 });
    const [semNItem] = buildGenItems(
      comRef({ chaveAcesso: CHAVE, nItem: null }),
      bundleWith(OP),
      false,
    );
    expect(semNItem!.dfeReferenciado).toEqual({ chaveAcesso: CHAVE });
    const [semRef] = buildGenItems([item({})], bundleWith(OP), false);
    expect('dfeReferenciado' in semRef!).toBe(false);
  });
});

/**
 * The coupling that matters to SEFAZ (732/733, 772): the orchestrator's CFOP
 * and the generator's idDest come from ONE destination, and `<entrega>` rides
 * exactly when that destination is a separate delivery address. Run through the
 * REAL `generateNFe`, not a mock — a divergence between the two layers is only
 * visible on the wire.
 */
describe('CFOP ↔ idDest ↔ <entrega> on the generated XML (#422)', () => {
  const FILIAL_SP = {
    cnpj: '14200166000187',
    razaoSocial: 'Loja Teste S.A.',
    fantasia: null,
    ie: '111111111111',
    iest: null,
    imun: null,
    cnae: null,
    sede: {
      logradouro: 'Rua Direita',
      numero: '100',
      bairro: 'Centro',
      complemento: null,
      cep: '01001000',
      codigoMunicipio: '3550308',
      cidade: 'Sao Paulo',
      estado: 'SP',
    },
  };
  const OPERACAO_COMPLETA = {
    ...OP,
    naturezaDaOperacao: 'Venda de mercadoria',
    tipo: 1,
    finNFe: 1,
    ehExterior: false,
    ehConsumidorFinal: true,
    indPres: '2',
    indIntermed: '0',
    infCpl: null,
  };
  const completo = (fiscal: 'SP' | 'RJ', entrega: EntregaDoPedido) =>
    ({
      ...fullBundle({}),
      operacao: OPERACAO_COMPLETA,
      filial: FILIAL_SP,
      cliente: {
        ...CLIENTE_PF,
        idEstrangeiro: null,
        ie: null,
        isUF: null,
        imun: null,
        email: null,
      },
      enderecoDest: enderecoEntrega(fiscal),
      entrega,
    }) as unknown as PedidoBundle;

  const CASES: Array<[string, 'SP' | 'RJ', EntregaDoPedido, string, string | null]> = [
    // [label, fiscal UF, entrega, expected idDest, expected entrega/UF]
    ['SP → fiscal', 'SP', { tipo: 'enderecoFiscal' }, '1', null],
    ['RJ → fiscal', 'RJ', { tipo: 'enderecoFiscal' }, '2', null],
    ['SP → delivered RJ', 'SP', outroEndereco('RJ'), '2', 'RJ'],
    ['RJ → delivered SP', 'RJ', outroEndereco('SP'), '1', 'SP'],
    ['RJ → delivered RJ', 'RJ', outroEndereco('RJ'), '2', 'RJ'],
  ];

  it.each(CASES)('%s: idDest %s, entrega %s', (_label, fiscal, entrega, idDest, entregaUF) => {
    const input = buildGeneratorInput(completo(fiscal, entrega), ITEM_100, 7, 1, 'homologacao');
    const { nfeXml } = generateNFe({ ...input, cNF: '00000001' });
    expect(/<idDest>(\d)<\/idDest>/.exec(nfeXml)?.[1]).toBe(idDest);
    // 732/733: the CFOP's first digit agrees with idDest, by construction.
    const cfop = /<CFOP>(\d{4})<\/CFOP>/.exec(nfeXml)?.[1];
    expect(cfop?.[0]).toBe(idDest === '2' ? '6' : '5');
    // <entrega> present iff a separate delivery address decided — and its UF
    // is the one that decided.
    const uf = /<entrega>.*?<UF>([A-Z]{2})<\/UF>.*?<\/entrega>/.exec(nfeXml)?.[1] ?? null;
    expect(uf).toBe(entregaUF);
  });
});

// ---------------------------------------------------------------------------
// PIS/COFINS item ↔ ICMSTot (#509 — MOC 7.0 Anexo I rules 602/603: ICMSTot
// vPIS/vCOFINS must equal Σ of the item values). These go through the REAL
// buildGeneratorInput → aggregateTotals/buildTotalXml, never a hand-written
// golden, so they prove what the wire carries.
// ---------------------------------------------------------------------------

/** The item() default imposto (CSOSN 102) carrying the given PIS/COFINS configs. */
function impostoPisCofins(
  configuracaoPIS: Record<string, unknown> | null,
  configuracaoCOFINS: Record<string, unknown> | null,
): FiscalItem['imposto'] {
  return {
    origem: ORIGEM.nacional,
    unidade: 'UN',
    NCM: '61091000',
    cfop: '5102',
    configuracaoICMS: { crt: CRT.simplesNacional, csosn: CSOSN.tributadaSemCredito },
    configuracaoPIS,
    configuracaoCOFINS,
  } as never;
}

/**
 * Three items, one per PIS/COFINS shape:
 *  - A: 3 × 100 with a unit discount of 10 → net base 270 (gross 300);
 *    CST 49 by percent (PISOutr/COFINSOutr `vBC + p`).
 *  - B: 1 × 50; CST 01 (PISAliq/COFINSAliq). Its raw vPIS is 0.825, which the
 *    item rounds to 0.82 — so Σ of the ROUNDED item values (3.89) differs from
 *    the rounded raw Σ (3.8952 → 3.90), and the totals pin tells them apart.
 *  - C: 3 × 20; CST 99 per unit (PISOutr/COFINSOutr `qBCProd + vAliqProd`).
 */
const PIS_ITENS: FiscalItem[] = [
  item({
    produtoUid: 'a',
    itemIndex: 0,
    precoDeVenda: 100,
    quantidade: 3,
    descontoUnitario: 10,
    imposto: impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 1 },
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pCOFINS: 3 },
    ),
  }),
  item({
    produtoUid: 'b',
    itemIndex: 1,
    precoDeVenda: 50,
    quantidade: 1,
    imposto: impostoPisCofins(
      { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 1.65 },
      { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pCOFINS: 7.6 },
    ),
  }),
  item({
    produtoUid: 'c',
    itemIndex: 2,
    precoDeVenda: 20,
    quantidade: 3,
    imposto: impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.1234 },
      { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.5 },
    ),
  }),
];

/** The same items with the given PIS/COFINS configs on every one of them. */
function comPisCofins(
  configuracaoPIS: Record<string, unknown> | null,
  configuracaoCOFINS: Record<string, unknown> | null,
): FiscalItem[] {
  return PIS_ITENS.map((it) => ({
    ...it,
    imposto: impostoPisCofins(configuracaoPIS, configuracaoCOFINS),
  }));
}

/** Empty pagamentos → tPag 90, so the Σ vPag guard is skipped unless a test adds one. */
function buildPis(items: ReadonlyArray<FiscalItem>, pedido: Record<string, unknown> = {}) {
  return buildGeneratorInput(fullBundle({ pagamentos: [], pedido }), items, 7, 1, 'homologacao');
}

/** The ONE `<tag>` value in `xml`, as a number — fails when absent or repeated. */
function valorUnico(xml: string, tag: string): number {
  const valores = [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) =>
    Number(m[1]),
  );
  expect(valores, `exactly one <${tag}>`).toHaveLength(1);
  return valores[0]!;
}

describe('PIS/COFINS item ↔ ICMSTot (cStat 602/603)', () => {
  it('ICMSTot vPIS/vCOFINS equal Σ of the item values the dets carry', () => {
    const out = buildPis(PIS_ITENS);
    for (const tag of ['vPIS', 'vCOFINS']) {
      const somaItens = roundReais(
        out.itens.reduce((sum, gi) => sum + valorUnico(gi.impostoXml, tag), 0),
      );
      expect(valorUnico(out.totalXml, tag), tag).toBe(somaItens);
    }
    // Explicit, so the equality above cannot hold vacuously at 0 = 0. vPIS =
    // 2.70 + 0.82 + 0.37 (Σ of the ROUNDED item values — the raw Σ is 3.90);
    // vCOFINS = 8.10 + 3.80 + 1.50.
    expect(valorUnico(out.totalXml, 'vPIS')).toBe(3.89);
    expect(valorUnico(out.totalXml, 'vCOFINS')).toBe(13.4);
    // A: the percent base is the net-of-unit-discount 270, not the gross 300.
    expect(out.itens[0]!.impostoXml).toContain(
      '<PISOutr><CST>49</CST><vBC>270.00</vBC><pPIS>1.0000</pPIS><vPIS>2.70</vPIS></PISOutr>',
    );
    expect(out.itens[0]!.impostoXml).toContain(
      '<COFINSOutr><CST>49</CST><vBC>270.00</vBC><pCOFINS>3.0000</pCOFINS><vCOFINS>8.10</vCOFINS></COFINSOutr>',
    );
    // C: per unit — qBCProd is the item quantity, never a hardcoded 1.
    expect(out.itens[2]!.impostoXml).toContain(
      '<PISOutr><CST>99</CST><qBCProd>3.0000</qBCProd><vAliqProd>0.1234</vAliqProd><vPIS>0.37</vPIS></PISOutr>',
    );
  });

  it('the item base ignores the apportioned descontoTotal — A keeps vBC 270.00 (parity with PISAliq and RTC)', () => {
    const semDesconto = buildPis(PIS_ITENS);
    const comDesconto = buildPis(PIS_ITENS, { descontoTotal: 40 });
    // The order discount DID reach the det: A's vDesc is its unit discount (30)
    // plus its share of the 40 (28.42 of it, over the net 380).
    expect(comDesconto.itens[0]!.vDesc).toBe(58.42);
    expect(comDesconto.itens[0]!.impostoXml).toContain(
      '<PISOutr><CST>49</CST><vBC>270.00</vBC><pPIS>1.0000</pPIS><vPIS>2.70</vPIS></PISOutr>',
    );
    // ...and the total still sums the same item values, discount or not.
    expect(valorUnico(comDesconto.totalXml, 'vPIS')).toBe(valorUnico(semDesconto.totalXml, 'vPIS'));
    expect(valorUnico(comDesconto.totalXml, 'vCOFINS')).toBe(
      valorUnico(semDesconto.totalXml, 'vCOFINS'),
    );
  });

  it('vNF and the Σ vPag guard are unaffected: vNF has no PIS/COFINS term', () => {
    const comPis = buildPis(PIS_ITENS);
    const semPis = buildPis(comPisCofins(null, null));
    // Σ gross (300 + 50 + 60) − Σ vDesc (30) = 380, with or without PIS.
    expect(valorUnico(comPis.totalXml, 'vNF')).toBe(380);
    expect(valorUnico(semPis.totalXml, 'vNF')).toBe(380);
    // The contrast that makes the equality above meaningful.
    expect(valorUnico(comPis.totalXml, 'vPIS')).toBeGreaterThan(0);
    expect(valorUnico(semPis.totalXml, 'vPIS')).toBe(0);
    // A payment of exactly the goods total passes the guard with PIS non-zero.
    const pago = buildGeneratorInput(
      fullBundle({ pagamentos: [{ valor: 380, forma_de_pagamento: FORMA_PAGAMENTO.pix }] }),
      PIS_ITENS,
      7,
      1,
      'homologacao',
    );
    expect(pago.pagXml).toContain('<vPag>380.00</vPag>');
  });

  it('qBCProd equals the det quantity: genItems qTrib === quantidade, carried at 4 decimals', () => {
    const out = buildPis(PIS_ITENS);
    out.itens.forEach((gi, i) => {
      expect(gi.qTrib).toBe(PIS_ITENS[i]!.quantidade);
    });
    expect(out.itens[2]!.impostoXml).toContain('<PISOutr><CST>99</CST><qBCProd>3.0000</qBCProd>');
    expect(out.itens[2]!.impostoXml).toContain(
      '<COFINSOutr><CST>99</CST><qBCProd>3.0000</qBCProd><vAliqProd>0.5000</vAliqProd><vCOFINS>1.50</vCOFINS></COFINSOutr>',
    );
    // Near-miss: a fractional quantity is carried as-is, not rounded to a unit.
    const fracionado = buildPis([{ ...PIS_ITENS[2]!, quantidade: 2.5, vProd: 50, vProdBruto: 50 }]);
    expect(fracionado.itens[0]!.qTrib).toBe(2.5);
    expect(fracionado.itens[0]!.impostoXml).toContain(
      '<qBCProd>2.5000</qBCProd><vAliqProd>0.1234</vAliqProd><vPIS>0.31</vPIS>',
    );
    expect(valorUnico(fracionado.totalXml, 'vPIS')).toBe(0.31);
  });

  it('zero default: CST 49 with no rates gives a totalXml byte-equal to null PIS/COFINS', () => {
    const semAliquota = buildPis(
      comPisCofins(
        { CST: CST_PIS_COFINS.outrasOperacoesSaida },
        { CST: CST_PIS_COFINS.outrasOperacoesSaida },
      ),
    );
    const nulos = buildPis(comPisCofins(null, null));
    expect(semAliquota.totalXml).toBe(nulos.totalXml);
    expect(semAliquota.totalXml).toContain('<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS>');
    // The dets still carry the XSD-mandated zero PISOutr/COFINSOutr shape.
    expect(semAliquota.itens[0]!.impostoXml).toContain(
      '<PISOutr><CST>49</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr>',
    );
  });
});

describe('assertNotaBuildable — PIS/COFINS configs the engine refuses (#509)', () => {
  const CST_49 = CST_PIS_COFINS.outrasOperacoesSaida;

  function mensagem(
    configuracaoPIS: Record<string, unknown> | null,
    configuracaoCOFINS: Record<string, unknown> | null,
  ): string {
    const items = [item({ imposto: impostoPisCofins(configuracaoPIS, configuracaoCOFINS) })];
    const bundle = bundleWith(OP);
    const msg = orchestratorMessage(() => assertNotaBuildable(bundle, items, false));
    // The pre-flight IS generation's projection: same class, same message.
    expect(msg).toBe(orchestratorMessage(() => buildGenItems(items, bundle, false)));
    return msg;
  }

  it('PIS CST 49 with BOTH pPIS and vAliqProd → NFeOrchestratorError naming the item', () => {
    const msg = mensagem({ CST: CST_49, pPIS: 0.65, vAliqProd: 0.1 }, null);
    expect(msg.startsWith(`${ITEM_PREFIX} PIS CST=49 (PISOutr)`)).toBe(true);
    expect(msg).toMatch(/PIS CST=49/);
    expect(msg).toMatch(/not both/);
  });

  it('COFINS-only both-rates (PIS valid) names COFINS, not PIS', () => {
    const msg = mensagem({ CST: CST_49, pPIS: 0.65 }, { CST: CST_49, pCOFINS: 3, vAliqProd: 0.1 });
    expect(msg.startsWith(`${ITEM_PREFIX} COFINS CST=49 (COFINSOutr)`)).toBe(true);
    expect(msg).toMatch(/not both/);
  });

  it.each([
    {
      caso: 'CST 01 without pPIS',
      pis: { CST: CST_PIS_COFINS.tributavelAliquotaBasica },
      expected: `${ITEM_PREFIX} PIS CST=01 requires \`pPIS\``,
    },
    {
      caso: 'CST 03 without vAliqProd',
      pis: { CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade },
      expected: `${ITEM_PREFIX} PIS CST=03 requires \`vAliqProd\``,
    },
  ])('$caso → NFeOrchestratorError carrying the engine message', ({ pis, expected }) => {
    expect(mensagem(pis, null)).toBe(expected);
  });

  it('near-miss: one rate alone, or both at 0, builds', () => {
    const bundle = bundleWith(OP);
    for (const pis of [
      { CST: CST_49, pPIS: 0.65 },
      { CST: CST_49, vAliqProd: 0.1 },
      { CST: CST_49, pPIS: 0, vAliqProd: 0 },
      { CST: CST_49, pPIS: 0, vAliqProd: 0.1 },
    ]) {
      const items = [item({ imposto: impostoPisCofins(pis, null) })];
      expect(assertNotaBuildable(bundle, items, false), JSON.stringify(pis)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// #330 — nota de crédito / débito (finNFe 5/6): the item tax groups come from
// ONE mode (`modoGruposFor`), the document rules refuse before the items.
// ---------------------------------------------------------------------------

describe('nota de crédito / débito (finNFe 5/6, #330)', () => {
  const IMPOSTO_RTC = {
    ...item({}).imposto,
    configuracaoPIS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 1.65 },
    configuracaoCOFINS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pCOFINS: 7.6 },
    configuracaoIBSCBS: { CST: '000', cClassTrib: '000001', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 },
  } as FiscalItem['imposto'];
  const DEBITO_06 = { ...OP, tipo: 1, finNFe: 6, tpNFDebito: '06', tpNFCredito: null };
  const ITENS_RTC = [item({ imposto: IMPOSTO_RTC })];

  it('modoGruposFor reads the operação once: débito 06 is IBS/CBS only, crédito 04 is not', () => {
    expect(modoGruposFor(bundleWith(DEBITO_06))).toBe(MODO_GRUPOS_IMPOSTO.somenteIbsCbs);
    expect(
      modoGruposFor(bundleWith({ ...OP, tipo: 0, finNFe: 5, tpNFCredito: '04', tpNFDebito: null })),
    ).toBe(MODO_GRUPOS_IMPOSTO.completo);
    expect(modoGruposFor(bundleWith(OP))).toBe(MODO_GRUPOS_IMPOSTO.completo);
  });

  it('débito 06: the det and the total agree — IBS/CBS on the wire, no PIS/COFINS anywhere', () => {
    const bundle = { ...fullBundle({}), operacao: { ...fullBundle({}).operacao, ...DEBITO_06 } };
    const input = buildGeneratorInput(
      bundle as PedidoBundle,
      ITENS_RTC,
      7,
      1,
      'homologacao',
      1,
      undefined,
      null,
      true,
    );
    const det = input.itens[0]!.impostoXml;
    expect(det).toContain('<IBSCBS>');
    for (const grupo of ['<ICMS>', '<PIS>', '<COFINS>']) expect(det).not.toContain(grupo);
    expect(input.totalXml).toContain('<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS>');
    expect(input.totalXml).toContain('<vNFTot>101.00</vNFTot>');
    expect(input.operacao.tpNFDebito).toBe('06');
  });

  it('near-miss: the same items on a normal nota carry PIS/COFINS in the det AND the total', () => {
    const input = buildGeneratorInput(
      fullBundle({}),
      ITENS_RTC,
      7,
      1,
      'homologacao',
      1,
      undefined,
      null,
      true,
    );
    expect(input.itens[0]!.impostoXml).toContain('<PIS>');
    expect(input.totalXml).toContain('<vPIS>1.65</vPIS>');
  });

  it('refuses with the Reforma Tributária off — a document verdict, not a tribute error', () => {
    expect(
      orchestratorMessage(() => assertNotaBuildable(bundleWith(DEBITO_06), ITENS_RTC, false)),
    ).toBe(
      "pedido 'PED-TEST': Nota de crédito/débito só é emitida com a Reforma Tributária (IBS/CBS) ativa nesta filial.",
    );
  });

  it('the document rules run BEFORE the items: an unbuildable item does not mask them', () => {
    // No CFOP anywhere would be the first item error; the tipo speaks first.
    const semCfop = [item({ imposto: { ...IMPOSTO_RTC, cfop: null } as FiscalItem['imposto'] })];
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(
        // Crédito 05 is a tipo the ERP does not emit (contradictory in NT v1.40).
        bundleWith({ ...OP, tipo: 0, finNFe: 5, tpNFCredito: '05', tpNFDebito: null, cfop: null }),
        semCfop,
        true,
      ),
    );
    expect(msg).toContain('ainda não é emitido');
    expect(msg).not.toContain('cfop');
  });

  it('refuses an item without IBS/CBS, naming it', () => {
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(bundleWith(DEBITO_06), [...ITENS_RTC, item({ itemIndex: 1 })], true),
    );
    expect(msg).toBe(
      "pedido 'PED-TEST': Item 2: Todo item de nota de crédito/débito precisa da configuração de IBS/CBS (CST e cClassTrib).",
    );
  });

  it('passes a buildable débito 06', () => {
    expect(assertNotaBuildable(bundleWith(DEBITO_06), ITENS_RTC, true)).toBeUndefined();
  });

  it('judges the NFref of a crédito against the filial as emitente (269/678)', () => {
    const CHAVE_SP = '35260514200166000187550010000000071000000011';
    const credito04 = { ...OP, tipo: 0, finNFe: 5, tpNFCredito: '04', tpNFDebito: null };
    const bundle = (cnpj: string) =>
      ({
        ...bundleWith(credito04, { chNFeReferenciadas: [CHAVE_SP] }),
        filial: { cnpj, sede: { estado: 'SP' } },
      }) as unknown as PedidoBundle;
    expect(assertNotaBuildable(bundle('14200166000187'), ITENS_RTC, true)).toBeUndefined();
    expect(
      orchestratorMessage(() => assertNotaBuildable(bundle('11222333000181'), ITENS_RTC, true)),
    ).toContain('(SEFAZ 269)');
  });
});

// ---------------------------------------------------------------------------
// #330 part 3 — a nota de débito whose tipo binds a fixed cClassTrib: the tipo
// supplies CST + cClassTrib + group, the item its amounts (`itens[*].ajusteRtc`).
// ---------------------------------------------------------------------------

describe('lerAjusteRtc — best-effort read of the stored item field', () => {
  it('reads the stored shape and absence', () => {
    expect(lerAjusteRtc(null)).toBeNull();
    expect(lerAjusteRtc(undefined)).toBeNull();
    expect(lerAjusteRtc({ vIBS: 1, vCBS: 9, competApur: '2026-04' })).toEqual({
      vIBS: 1,
      vCBS: 9,
      competApur: '2026-04',
    });
  });

  it('keeps a malformed value as UNUSABLE amounts — refused by name, never dropped', () => {
    expect(lerAjusteRtc('x')).toEqual({ vIBS: Number.NaN, vCBS: Number.NaN, competApur: null });
    expect(lerAjusteRtc({ vIBS: '1', vCBS: 2, competApur: 202604 })).toEqual({
      vIBS: Number.NaN,
      vCBS: 2,
      competApur: null,
    });
  });
});

describe('nota de débito with an IBS/CBS adjustment (#330, part 3)', () => {
  /** The produto's OWN classification — which an adjustment item must not emit. */
  const IMPOSTO_RTC = {
    ...item({}).imposto,
    configuracaoIBSCBS: { CST: '000', cClassTrib: '000001', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 },
  } as FiscalItem['imposto'];
  const debito = (tpNFDebito: string) => ({
    ...OP,
    tipo: 1,
    finNFe: 6,
    tpNFDebito,
    tpNFCredito: null,
  });
  const comAjuste = (ajusteRtc: FiscalItem['ajusteRtc']) => [
    item({ imposto: IMPOSTO_RTC, ajusteRtc }),
  ];
  const gerar = (tpNFDebito: string, ajusteRtc: FiscalItem['ajusteRtc']) => {
    const base = fullBundle({});
    return buildGeneratorInput(
      { ...base, operacao: { ...base.operacao, ...debito(tpNFDebito) } } as PedidoBundle,
      comAjuste(ajusteRtc),
      7,
      1,
      'homologacao',
      1,
      undefined,
      null,
      true,
    );
  };

  it('ajusteDoItem: the tipo supplies classification + group, the item its amounts', () => {
    const it = comAjuste({ vIBS: 1, vCBS: 9, competApur: null })[0]!;
    expect(ajusteDoItem(bundleWith(debito('05')), it)).toEqual({
      cClassTrib: '800001',
      grupo: GRUPO_AJUSTE_RTC.transfCred,
      vIBS: 1,
      vCBS: 9,
      competApur: null,
    });
    // Near-misses: a tipo with no fixed cClassTrib, and an item without amounts.
    expect(ajusteDoItem(bundleWith(debito('06')), it)).toBeUndefined();
    expect(ajusteDoItem(bundleWith(debito('05')), { ...it, ajusteRtc: null })).toBeUndefined();
  });

  it('débito 05: the det carries 800001 + gTransfCred, not the produto classification', () => {
    const input = gerar('05', { vIBS: 10, vCBS: 90, competApur: null });
    const det = input.itens[0]!.impostoXml;
    expect(det).toBe(
      '<imposto><IBSCBS><CST>800</CST><cClassTrib>800001</cClassTrib>' +
        '<gTransfCred><vIBS>10.00</vIBS><vCBS>90.00</vCBS></gTransfCred></IBSCBS></imposto>',
    );
    // W47/W56: IBSCBSTot sums gIBSCBS only — the transfer never enters vIBS/vCBS.
    expect(input.totalXml).toContain('<vBCIBSCBS>0.00</vBCIBSCBS>');
    expect(input.totalXml).not.toContain('<gEstornoCred>');
  });

  it('débito 07: ICMS stays, gEstornoCred on the det AND in IBSCBSTot', () => {
    const input = gerar('07', { vIBS: 3, vCBS: 27, competApur: null });
    expect(input.itens[0]!.impostoXml).toContain('<ICMS>');
    expect(input.itens[0]!.impostoXml).toContain(
      '<gEstornoCred><vIBSEstCred>3.00</vIBSEstCred><vCBSEstCred>27.00</vCBSEstCred></gEstornoCred>',
    );
    expect(input.totalXml).toContain(
      '<gEstornoCred><vIBSEstCred>3.00</vIBSEstCred><vCBSEstCred>27.00</vCBSEstCred></gEstornoCred>',
    );
  });

  it('pre-flight: an adjustment item without its amounts is refused, naming it', () => {
    expect(
      orchestratorMessage(() =>
        assertNotaBuildable(bundleWith(debito('01')), comAjuste(null), true),
      ),
    ).toBe(
      "pedido 'PED-TEST': Item 1: Informe os valores de IBS e CBS do ajuste deste item (aba Fiscal).",
    );
  });

  it('pre-flight: 1129 on a zero transfer; a positive one passes', () => {
    expect(
      orchestratorMessage(() =>
        assertNotaBuildable(
          bundleWith(debito('01')),
          comAjuste({ vIBS: 0, vCBS: 0, competApur: null }),
          true,
        ),
      ),
    ).toContain('(SEFAZ 1129)');
    expect(
      assertNotaBuildable(
        bundleWith(debito('01')),
        comAjuste({ vIBS: 0, vCBS: 0.01, competApur: null }),
        true,
      ),
    ).toBeUndefined();
  });

  it('pre-flight: UB14-70 judges the cClassTrib the TIPO supplies, not the produto’s', () => {
    // The produto says 000001; débito 05 binds 800001 — and 800001 is emitted.
    expect(
      assertNotaBuildable(
        bundleWith(debito('05')),
        comAjuste({ vIBS: 1, vCBS: 1, competApur: null }),
        true,
      ),
    ).toBeUndefined();
  });

  it('pre-flight: a future competApur on gAjusteCompet is refused', () => {
    const msg = orchestratorMessage(() =>
      assertNotaBuildable(
        bundleWith(debito('02')),
        comAjuste({ vIBS: 1, vCBS: 1, competApur: '2999-01' }),
        true,
      ),
    );
    expect(msg).toContain('mês da emissão ou um mês anterior');
  });
});

// ---------------------------------------------------------------------------
// #331 — dPrevEntrega, gPagAntecipado and ISUFEmit, only with the RTC on.
// ---------------------------------------------------------------------------

describe('rtcDaNota — NT 2025.002 ide/emit fields (#331)', () => {
  const CHAVE = '35260514200166000187550010000000071000000011';
  /** 2026-09-29 12:00 in São Paulo. */
  const DH_EMI = new Date('2026-09-29T12:00:00-03:00');
  /** µs of a São Paulo wall-clock instant. */
  const us = (iso: string) => new Date(iso).getTime() * 1000;
  const bundle = (over: {
    previsao?: string | null;
    finNFe?: number;
    isuf?: string | null;
    pedido?: Record<string, unknown>;
  }) =>
    ({
      ...fullBundle({ pedido: over.pedido }),
      operacao: { ...OP, finNFe: over.finNFe ?? 1 },
      filial: { sede: { estado: 'SP' }, isuf: over.isuf ?? null },
      frete:
        over.previsao === undefined
          ? null
          : { dataPrevisaoEntrega: over.previsao == null ? null : us(over.previsao) },
    }) as unknown as PedidoBundle;

  it('emits the forecast as a São Paulo date, inside the B10a windows', () => {
    // 23:30 on 2026-10-14 in São Paulo is already the 15th in UTC — the date is SP's.
    expect(
      rtcDaNota(bundle({ previsao: '2026-10-14T23:30:00-03:00' }), DH_EMI, MODALIDADE_FRETE.cif),
    ).toEqual({ dPrevEntrega: '2026-10-14' });
  });

  it('omits the forecast SEFAZ would refuse — never refuses the nota', () => {
    const dentro = '2026-10-14T12:00:00-03:00';
    expect(rtcDaNota(bundle({ previsao: dentro }), DH_EMI, MODALIDADE_FRETE.fob)).toEqual({});
    expect(
      rtcDaNota(bundle({ previsao: dentro, finNFe: 2 }), DH_EMI, MODALIDADE_FRETE.cif),
    ).toEqual({});
    expect(
      rtcDaNota(bundle({ previsao: '2026-09-28T12:00:00-03:00' }), DH_EMI, MODALIDADE_FRETE.cif),
    ).toEqual({});
    expect(rtcDaNota(bundle({ previsao: null }), DH_EMI, MODALIDADE_FRETE.cif)).toEqual({});
  });

  it('carries the pedido’s pagamento-antecipado chaves and the filial’s ISUF', () => {
    expect(
      rtcDaNota(
        bundle({ pedido: { chNFePagamentoAntecipado: [CHAVE, ''] }, isuf: '200123456' }),
        DH_EMI,
        MODALIDADE_FRETE.semTransporte,
      ),
    ).toEqual({ pagAntecipado: [CHAVE], isufEmit: '200123456' });
  });

  it('buildGeneratorInput passes them only with the RTC on', () => {
    const b = { ...fullBundle({ pedido: { chNFePagamentoAntecipado: [CHAVE] } }) } as PedidoBundle;
    const on = buildGeneratorInput(b, ITEM_100, 7, 1, 'homologacao', 1, undefined, null, true);
    expect(on.rtc).toEqual({ pagAntecipado: [CHAVE] });
    // RTC off: a filial ISUF is simply not emitted (the pedido chaves above would
    // be REFUSED instead — the next test).
    const zfm = {
      ...fullBundle({}),
      filial: { isuf: '200123456', sede: { estado: 'AM', codigoMunicipio: '1302603' } },
    } as unknown as PedidoBundle;
    expect('rtc' in buildGeneratorInput(zfm, ITEM_100, 7, 1, 'homologacao')).toBe(false);
    expect(
      buildGeneratorInput(zfm, ITEM_100, 7, 1, 'homologacao', 1, undefined, null, true).rtc,
    ).toEqual({ isufEmit: '200123456' });
  });

  it('pre-flight: pagamento-antecipado chaves with the RTC off are refused (policy)', () => {
    const b = bundleWith(OP, { chNFePagamentoAntecipado: [CHAVE] });
    expect(orchestratorMessage(() => assertNotaBuildable(b, ITEM_100, false))).toBe(
      "pedido 'PED-TEST': As NF-e de pagamento antecipado só são referenciadas com a Reforma Tributária ativa nesta filial.",
    );
    expect(assertNotaBuildable(b, ITEM_100, true)).toBeUndefined();
  });

  it('pre-flight: 1185 — an ISUF on a filial outside the ZFM/ALC', () => {
    const b = (codigoMunicipio: string) =>
      ({
        ...bundleWith(OP),
        filial: { isuf: '200123456', sede: { estado: 'SP', codigoMunicipio } },
      }) as unknown as PedidoBundle;
    expect(orchestratorMessage(() => assertNotaBuildable(b('3550308'), ITEM_100, true))).toContain(
      '(SEFAZ 1185)',
    );
    // Near-miss: RTC off — ISUFEmit is not on the wire, nothing to judge.
    expect(assertNotaBuildable(b('3550308'), ITEM_100, false)).toBeUndefined();
  });
});
