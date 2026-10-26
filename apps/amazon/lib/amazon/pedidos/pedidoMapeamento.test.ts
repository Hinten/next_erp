import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { roundReais } from '@delfrance/core/money';
import { nextPedidoEstado } from '@delfrance/data/pedido';
import {
  ESTADO_PEDIDO,
  STATUS_PAGAMENTO,
  isPagamentoPagante,
  itemDoPedidoSchema,
  statusToEstadoPedido,
  type EstadoPedido,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import {
  ATUALIZADO_EM,
  ATUALIZADO_US,
  CRIADO_US,
  brl,
  depois,
  execucaoAmazon,
  linhaAmazon,
  pedidoAmazon,
  type OpcoesLinhaTeste,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import { EVENTO_PEDIDO_AMAZON } from './codigosPedidoAmazon';
import { PedidoAmazonIlegivelError } from './erros';
import { PREFIXO_ERRO_AMAZON } from './estadoPedidoAmazon';
import {
  mapearPedidoAmazon,
  montarEscritaPedidoAmazon,
  type EntradasPedidoAmazon,
  type EscritaPedidoAmazon,
} from './pedidoMapeamento';
import type { EscritaPagamentoPuraAmazon } from './pagamentoAmazon';

const AQUI = dirname(fileURLToPath(import.meta.url));
const NOW_US = ATUALIZADO_US + 3_600_000_000;

const ENTRADAS: EntradasPedidoAmazon = {
  integracaoPedidoOuterRef: 'documents/integracao/conta-teste',
  operacaoPedidoOuterRef: 'documents/operacao/op-teste',
  clientePedidoOuterRef: null,
  enderecoFreteOuterReference: null,
  integracaoFreteOuterRef: 'documents/int_frete/amz-conta-teste',
  modalidadeFreteImportacao: null,
  vinculos: new Map(),
};

type Doc = Record<string, unknown>;

function montar(
  armazenado: Doc | null,
  opcoes: OpcoesPedidoTeste = {},
  extras: { pagamento?: Doc | null; entradas?: Partial<EntradasPedidoAmazon> } = {},
): EscritaPedidoAmazon {
  const mapeado = mapearPedidoAmazon(pedidoAmazon(opcoes), { ...ENTRADAS, ...extras.entradas });
  return montarEscritaPedidoAmazon(armazenado, extras.pagamento ?? null, mapeado, {
    nowUs: NOW_US,
  });
}

/** The doc this importer CREATES from `opcoes`, with `over` on top (a stored snapshot). */
function criado(opcoes: OpcoesPedidoTeste = {}, over: Doc = {}): Doc {
  const r = montar(null, opcoes);
  if (r.tipo !== 'criar') throw new Error(`esperava criar, veio ${r.tipo}`);
  return { ...r.corpo, ...over };
}

/** Apply an `atualizar` patch to a doc, top-level keys (what an `update` does). */
function aplicar(doc: Doc, r: EscritaPedidoAmazon): Doc {
  if (r.tipo !== 'atualizar') throw new Error(`esperava atualizar, veio ${r.tipo}`);
  return { ...doc, ...r.patch };
}

function patchDe(r: EscritaPedidoAmazon): Readonly<Record<string, unknown>> {
  if (r.tipo !== 'atualizar') throw new Error(`esperava atualizar, veio ${r.tipo}`);
  return r.patch;
}

function decisao(r: EscritaPedidoAmazon) {
  if (r.tipo === 'nao-importado' || r.tipo === 'obsoleto')
    throw new Error(`sem decisão: ${r.tipo}`);
  return r.decisao;
}

const DUAS = [
  linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
  linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
];
const PAGO = (over: Doc = {}) => criado({ linhas: DUAS }, over);
const PENDENTE = (over: Doc = {}) => criado({ status: 'PENDING', linhas: DUAS }, over);

/** One line L1 (qty 2 at 10.00) whose proceeds carry a SHIPPING row of `frete`. */
const comFrete = (frete: string, extra: OpcoesLinhaTeste = {}) => [
  linhaAmazon('L1', {
    qtd: 2,
    preco: '10.00',
    quebras: [{ type: 'SHIPPING', subtotal: brl(frete) }],
    ...extra,
  }),
];

/** The freight money after a write (`guardado`, the stored one, when the block was not rewritten). */
function freteDepois(r: EscritaPedidoAmazon, guardado: number): unknown {
  const p = r.tipo === 'atualizar' ? r.patch : {};
  return Object.hasOwn(p, 'freteInicial') ? (p.freteInicial as Doc).valorCobrado : guardado;
}

function linhasDo(
  doc: Doc | Readonly<Record<string, unknown>>,
): { id: unknown; q: unknown; p: unknown }[] {
  const itens = (doc.itens ?? {}) as Record<string, Record<string, unknown>[]>;
  return Object.values(itens)
    .flat()
    .map((l) => ({ id: l.mktplaceId, q: l.quantidade, p: l.precoDeVenda }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/* -------------------------------------------------------------------------- */

describe('create', () => {
  it('writes the canonical body: estado, numero, refs, explicit produtoUid, the amz seed, the accepted watermark', () => {
    const r = montar(
      null,
      { linhas: DUAS },
      { entradas: { vinculos: new Map([['L1', 'prod-1']]) } },
    );
    expect(r.tipo).toBe('criar');
    const corpo = r.tipo === 'criar' ? r.corpo : {};
    expect(corpo).toMatchObject({
      ehSaida: true,
      estado: 'pago',
      error: null,
      numero: '171-9876543-2109876',
      integracaoPedidoOuterRef: 'documents/integracao/conta-teste',
      operacaoPedidoOuterRef: 'documents/operacao/op-teste',
      timestamp: CRIADO_US,
      lastMarketplaceUpdate: ATUALIZADO_US,
      ultimaModificacao: NOW_US,
      descontoTotal: 0,
      valorCobrado: 25,
      marketplace: {
        tipo: 'amazon',
        status: 'UNSHIPPED',
        statusEm: ATUALIZADO_US,
        fulfilledBy: 'MERCHANT',
        invoiceStatus: null,
        cancelBy: null,
        programs: ['PRIME'],
      },
      freteInicial: {
        externalOptionIntegracao: 'amz',
        estado: 'iniciado',
        integracaoFreteOuterRef: 'documents/int_frete/amz-conta-teste',
        ultimaModificacao: ATUALIZADO_US,
      },
    });
    const itens = corpo.itens as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(itens).sort()).toEqual(['NONE', 'prod-1']);
    expect(itens.NONE?.[0]).toMatchObject({
      produtoUid: null,
      mktplaceId: 'L2',
      ensureUniqueId: 'L2',
      ordem: 2,
    });
    expect(itens['prod-1']?.[0]).toMatchObject({
      produtoUid: 'prod-1',
      mktplaceId: 'L1',
      descontoUnitario: 0,
      timestamp: CRIADO_US,
    });
    expect(Object.hasOwn(itens.NONE?.[0] ?? {}, 'produtoUid')).toBe(true);
    expect(corpo.itensIds).toEqual(
      ['prod-1', 'NONE'].filter((k) => Object.keys(itens).includes(k)),
    );
  });

  it('never stores cancelReason, and valorCobrado is DERIVED — never proceeds.grandTotal', () => {
    const r = montar(null, {
      linhas: [
        {
          ...linhaAmazon('L1', {
            qtd: 1,
            preco: '100.00',
            quebras: [
              { type: 'SHIPPING', subtotal: brl('10.00') },
              { type: 'DISCOUNT', subtotal: brl('5.00') },
            ],
          }),
          cancellation: {
            cancellationExecution: { cancelledBy: 'SELLER', cancelReason: 'texto livre' },
          },
        },
      ],
      status: 'PENDING',
      extra: { proceeds: { grandTotal: brl('7777.77') } },
    });
    const corpo = r.tipo === 'criar' ? r.corpo : {};
    expect(corpo.valorCobrado).toBe(105);
    expect(corpo.descontoTotal).toBe(5);
    expect(corpo.marketplace).toMatchObject({ cancelBy: 'SELLER' });
    expect(Object.hasOwn(corpo.marketplace as object, 'cancelReason')).toBe(false);
    expect(JSON.stringify(corpo)).not.toContain('texto livre');
    expect(JSON.stringify(corpo)).not.toContain('7777');
  });

  it('a non-reversed approved order with a 0 or absent value files valor-zerado; a PENDING one does not', () => {
    expect(
      decisao(montar(null, { linhas: [linhaAmazon('L1', { qtd: 1, preco: '0.00' })] })).incidentes,
    ).toEqual(['valor-zerado']);
    expect(decisao(montar(null, { linhas: [linhaAmazon('L1', { qtd: 1 })] })).incidentes).toEqual([
      'valor-zerado',
    ]);
    expect(
      decisao(montar(null, { status: 'PENDING', linhas: [linhaAmazon('L1', { qtd: 1 })] }))
        .incidentes,
    ).toEqual([]);
  });
});

describe('the watermark', () => {
  it('a pedido this importer wrote, with a STRICTLY newer stored stamp ⇒ obsoleto (nothing computed)', () => {
    const r = montar(PAGO({ lastMarketplaceUpdate: ATUALIZADO_US + 1 }), {
      linhas: DUAS,
      status: 'PENDING',
    });
    expect(r).toEqual({ tipo: 'obsoleto', watermarkArmazenadoUs: ATUALIZADO_US + 1 });
  });

  it('EQUAL clock re-derives: an unchanged order is an empty patch, a changed status is written', () => {
    expect(montar(PAGO(), { linhas: DUAS }).tipo).toBe('sem-mudanca');
    const r = montar(PAGO(), { linhas: DUAS, status: 'PARTIALLY_SHIPPED' });
    expect(patchDe(r).marketplace).toMatchObject({ status: 'PARTIALLY_SHIPPED' });
  });

  it('the STORED side is read through the tolerant coercion: an ms int and an ISO string', () => {
    const ms = (ATUALIZADO_US + 5_000_000) / 1000;
    expect(montar(PAGO({ lastMarketplaceUpdate: ms }), { linhas: DUAS }).tipo).toBe('obsoleto');
    expect(montar(PAGO({ lastMarketplaceUpdate: depois(5) }), { linhas: DUAS }).tipo).toBe(
      'obsoleto',
    );
  });

  it('NEAR-MISS: the INCOMING side is never coerced — an ISO text without offset refuses the order', () => {
    expect(() => montar(PAGO(), { linhas: DUAS, atualizadoEm: '2026-10-01T12:00:00' })).toThrow(
      PedidoAmazonIlegivelError,
    );
  });

  it('a legacy pedido (no marketplace.tipo) with a NEWER ms stamp is accepted and re-derived; the patch writes the ACCEPTED value, never a maximum; the ladder still refuses pago → PENDING', () => {
    const legado = PAGO({
      marketplace: null,
      lastMarketplaceUpdate: (ATUALIZADO_US + 60_000_000) / 1000,
    });
    const r = montar(legado, { linhas: DUAS, status: 'PENDING' });
    expect(r.tipo).toBe('atualizar');
    expect(patchDe(r).lastMarketplaceUpdate).toBe(ATUALIZADO_US);
    expect(Object.hasOwn(patchDe(r), 'estado')).toBe(false);
    expect(decisao(r).motivoEstado).toBe('regressivo');
    // The SAME stamp on a pedido this importer wrote is obsoleto (NEAR-MISS).
    expect(
      montar(PAGO({ lastMarketplaceUpdate: (ATUALIZADO_US + 60_000_000) / 1000 }), {
        linhas: DUAS,
        status: 'PENDING',
      }).tipo,
    ).toBe('obsoleto');
  });

  it('ultimaModificacao is appended only to a NON-empty patch, monotonic', () => {
    const vazio = montar(PAGO({ ultimaModificacao: 1 }), { linhas: DUAS });
    expect(vazio).toEqual({
      tipo: 'sem-mudanca',
      decisao: expect.anything(),
      pagamento: expect.anything(),
    });
    const novo = montar(PAGO({ ultimaModificacao: NOW_US + 9 }), {
      linhas: DUAS,
      atualizadoEm: depois(60),
    });
    expect(patchDe(novo).ultimaModificacao).toBe(NOW_US + 9);
    expect(
      patchDe(montar(PAGO({ ultimaModificacao: 1 }), { linhas: DUAS, atualizadoEm: depois(60) }))
        .ultimaModificacao,
    ).toBe(NOW_US);
  });
});

describe('the comparators — one NEAR-MISS per group, each at an EQUAL order clock', () => {
  it('invoiceStatus, one programs element, the same elements reordered, prazoDespacho ⇒ a NON-empty patch', () => {
    const base = PAGO({});
    const comLista = criado({ linhas: DUAS, programs: ['PRIME', 'AMAZON_BUSINESS'] });
    expect(
      patchDe(montar(base, { linhas: DUAS, invoiceStatus: 'ACCEPTED' })).marketplace,
    ).toMatchObject({ invoiceStatus: 'ACCEPTED' });
    expect(
      patchDe(montar(base, { linhas: DUAS, programs: ['BUSINESS'] })).marketplace,
    ).toMatchObject({ programs: ['BUSINESS'] });
    expect(
      patchDe(montar(comLista, { linhas: DUAS, programs: ['AMAZON_BUSINESS', 'PRIME'] }))
        .marketplace,
    ).toMatchObject({
      programs: ['AMAZON_BUSINESS', 'PRIME'],
    });
    const prazo = montar(base, {
      linhas: DUAS,
      extra: {
        fulfillment: {
          fulfillmentStatus: 'UNSHIPPED',
          fulfilledBy: 'MERCHANT',
          shipByWindow: { latestDateTime: '2026-10-04T23:59:59Z' },
          deliverByWindow: { latestDateTime: '2026-10-08T23:59:59Z' },
        },
      },
    });
    expect(patchDe(prazo).freteInicial).toMatchObject({
      prazoDespacho: Date.parse('2026-10-04T23:59:59Z') * 1000,
    });
  });

  it('one pre-approval line price ⇒ a NON-empty patch; the unchanged order ⇒ the empty patch (EQUAL)', () => {
    const pendente = PENDENTE();
    expect(montar(pendente, { status: 'PENDING', linhas: DUAS }).tipo).toBe('sem-mudanca');
    const r = montar(pendente, {
      status: 'PENDING',
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.01' }), DUAS[1] ?? {}],
    });
    expect(linhasDo(patchDe(r))).toContainEqual({ id: 'L1', q: 2, p: 10.01 });
  });

  it('the order money in centavos at its three sites: one centavo of line price, of discount or of freight is written; a legacy float total equal in centavos is not (EQUAL)', () => {
    // NEAR-MISS: a one-centavo mirrored price re-derives the total to the centavo.
    const centavo = montar(PENDENTE(), {
      status: 'PENDING',
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.01' }), DUAS[1] ?? {}],
    });
    expect(patchDe(centavo).valorCobrado).toBe(25.02);
    // EQUAL: the lines change, their total does not; a stored float total is not rewritten.
    const mesmoTotal = montar(PENDENTE({ valorCobrado: 25.000000000000004 }), {
      status: 'PENDING',
      linhas: [linhaAmazon('L1', { qtd: 4, preco: '5.00' }), DUAS[1] ?? {}],
    });
    expect(linhasDo(patchDe(mesmoTotal))).toContainEqual({ id: 'L1', q: 4, p: 5 });
    expect(Object.hasOwn(patchDe(mesmoTotal), 'valorCobrado')).toBe(false);
    // NEAR-MISS: one centavo of discount on a mirror.
    const desconto = (valor: string) => [
      linhaAmazon('L1', {
        qtd: 2,
        preco: '10.00',
        quebras: [{ type: 'DISCOUNT', subtotal: brl(valor) }],
      }),
    ];
    const comDesconto = montar(criado({ status: 'PENDING', linhas: desconto('3.00') }), {
      status: 'PENDING',
      linhas: desconto('3.01'),
    });
    expect(patchDe(comDesconto)).toMatchObject({ descontoTotal: 3.01, valorCobrado: 16.99 });
    // NEAR-MISS: one centavo of freight on a mirror.
    const guardado = criado({ status: 'PENDING', linhas: comFrete('8.00') });
    const r = montar(guardado, { status: 'PENDING', linhas: comFrete('8.01') });
    expect(freteDepois(r, 8)).toBe(8.01);
    expect(patchDe(r).valorCobrado).toBe(28.01);
  });

  it('an absent ship-by or deliver-by deadline never erases a stored one (equal clock ⇒ the empty patch)', () => {
    const pago = PAGO();
    expect(pago.freteInicial).toMatchObject({
      prazoDespacho: Date.parse('2026-10-03T23:59:59Z') * 1000,
      dataPrevisaoEntrega: Date.parse('2026-10-08T23:59:59Z') * 1000,
    });
    for (const janela of ['shipByWindow', 'deliverByWindow']) {
      const fulfillment: Doc = {
        fulfillmentStatus: 'UNSHIPPED',
        fulfilledBy: 'MERCHANT',
        shipByWindow: { latestDateTime: '2026-10-03T23:59:59Z' },
        deliverByWindow: { latestDateTime: '2026-10-08T23:59:59Z' },
      };
      delete fulfillment[janela];
      expect(montar(pago, { linhas: DUAS, extra: { fulfillment } }).tipo, janela).toBe(
        'sem-mudanca',
      );
    }
  });

  it('absent ≢ null ≢ []: a stored pedido without programs + a derived [] is written once, then empty', () => {
    const semProgramas = PAGO();
    const marketplace = { ...(semProgramas.marketplace as Doc) };
    delete marketplace.programs;
    const r1 = montar({ ...semProgramas, marketplace }, { linhas: DUAS, programs: [] });
    expect(patchDe(r1).marketplace).toMatchObject({ programs: [] });
    expect(
      montar(aplicar({ ...semProgramas, marketplace }, r1), { linhas: DUAS, programs: [] }).tipo,
    ).toBe('sem-mudanca');
    // null on the wire is ≢ [] stored.
    expect(
      patchDe(
        montar(aplicar({ ...semProgramas, marketplace }, r1), { linhas: DUAS, programs: null }),
      ).marketplace,
    ).toMatchObject({ programs: null });
  });

  it('NEAR-MISS null ≢ absent, ONE key at a time: a stored block lacking only invoiceStatus, only cancelBy, or only programs, against a derived null, is written once, then empty', () => {
    const base = criado({ linhas: DUAS, programs: null });
    expect(montar(base, { linhas: DUAS, programs: null }).tipo).toBe('sem-mudanca');
    for (const chave of ['invoiceStatus', 'cancelBy', 'programs']) {
      const marketplace = { ...(base.marketplace as Doc) };
      expect(marketplace[chave], chave).toBeNull();
      delete marketplace[chave];
      const semChave = { ...base, marketplace };
      const r = montar(semChave, { linhas: DUAS, programs: null });
      expect(patchDe(r).marketplace, chave).toMatchObject({ [chave]: null });
      expect(montar(aplicar(semChave, r), { linhas: DUAS, programs: null }).tipo, chave).toBe(
        'sem-mudanca',
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                   D17                                      */
/* -------------------------------------------------------------------------- */

describe('D17 — reversed', () => {
  it('CANCELLED: every stored line kept (zeroed, absent, missing, emptied); estado and marketplace.status still move', () => {
    const variantes: OpcoesPedidoTeste['linhas'][] = [
      [linhaAmazon('L1', { qtd: 0, preco: '0.00' }), linhaAmazon('L2', { qtd: 1 })],
      [linhaAmazon('L1')],
      [],
      null,
    ];
    for (const linhas of variantes) {
      const r = montar(PAGO(), { status: 'CANCELLED', linhas, atualizadoEm: depois(60) });
      const p = patchDe(r);
      expect(Object.hasOwn(p, 'itens'), JSON.stringify(linhas)).toBe(false);
      expect(p.estado).toBe('cancelado');
      expect(p.marketplace).toMatchObject({ status: 'CANCELLED' });
      expect(decisao(r).itens).toBe('itens-preservados-reversao');
      expect(decisao(r).incidentes).toEqual([]);
    }
  });

  it('the order money is never written on itens-preservados-reversao (zeroed SHIPPING and DISCOUNT on CANCELLED)', () => {
    const com = (shipping: string, desconto: string) => [
      linhaAmazon('L1', {
        qtd: 2,
        preco: '10.00',
        quebras: [
          { type: 'SHIPPING', subtotal: brl(shipping) },
          { type: 'DISCOUNT', subtotal: brl(desconto) },
        ],
      }),
    ];
    const guardado = criado({ linhas: com('8.00', '3.00') });
    expect(guardado).toMatchObject({
      descontoTotal: 3,
      valorCobrado: 25,
      freteInicial: { valorCobrado: 8 },
    });
    const p = patchDe(
      montar(guardado, {
        status: 'CANCELLED',
        linhas: com('0.00', '0.00'),
        atualizadoEm: depois(60),
      }),
    );
    expect(Object.hasOwn(p, 'descontoTotal')).toBe(false);
    expect(Object.hasOwn(p, 'valorCobrado')).toBe(false);
    expect(Object.hasOwn(p, 'freteInicial') ? (p.freteInicial as Doc).valorCobrado : 8).toBe(8);
  });

  it('a reversal package or an executed cancellation after shipment ⇒ kept + possivel-reembolso', () => {
    const p = montar(PAGO(), {
      status: 'SHIPPED',
      pacotes: ['RETURNED_TO_SELLER'],
      linhas: [linhaAmazon('L1', { qtd: 0, preco: '0.00' })],
    });
    expect(decisao(p)).toMatchObject({
      itens: 'itens-preservados-reversao',
      incidentes: ['possivel-reembolso'],
    });
    const x = montar(PAGO(), {
      status: 'SHIPPED',
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', execucao: true }), DUAS[1] ?? {}],
    });
    expect(decisao(x)).toMatchObject({
      itens: 'itens-preservados-reversao',
      incidentes: ['possivel-reembolso'],
    });
  });

  it('first seen and reversed ⇒ NOT imported (zero writes); NEAR-MISS: the same SHIPPED order with intact lines is created', () => {
    expect(
      montar(null, { status: 'SHIPPED', pacotes: ['RETURNED_TO_SELLER'], linhas: DUAS }),
    ).toEqual({
      tipo: 'nao-importado',
      motivo: 'reversao-nao-importada',
    });
    expect(montar(null, { status: 'SHIPPED', linhas: [] })).toEqual({
      tipo: 'nao-importado',
      motivo: 'reversao-nao-importada',
    });
    expect(
      montar(null, {
        status: 'SHIPPED',
        linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', execucao: true })],
      }),
    ).toEqual({
      tipo: 'nao-importado',
      motivo: 'reversao-nao-importada',
    });
    const intacto = montar(null, { status: 'SHIPPED', linhas: DUAS });
    expect(intacto.tipo).toBe('criar');
    expect(intacto.tipo === 'criar' ? intacto.corpo.estado : null).toBe('pago');
    expect(montar(null, { status: 'CANCELLED', linhas: DUAS })).toEqual({
      tipo: 'nao-importado',
      motivo: 'cancelado-nao-importado',
    });
  });

  it('a pre-approval mirror then a zeroed or emptied SHIPPED ⇒ every stored line kept (row 4 before row 9)', () => {
    for (const linhas of [[], [linhaAmazon('L1', { qtd: 0, preco: '10.00' }), DUAS[1] ?? {}]]) {
      const r = montar(PENDENTE(), { status: 'SHIPPED', linhas, atualizadoEm: depois(60) });
      expect(decisao(r).itens).toBe('itens-preservados-reversao');
      expect(Object.hasOwn(patchDe(r), 'itens')).toBe(false);
    }
  });
});

describe('D17 — approved, still to ship (row 10)', () => {
  it('a line removed, added or zeroed, or qty 2 → 1 ⇒ divergence, nothing applied; an identical set ⇒ mantidas', () => {
    const casos = [
      [DUAS[0] ?? {}],
      [...DUAS, linhaAmazon('L3', { qtd: 1, preco: '1.00' })],
      [linhaAmazon('L1', { qtd: 0, preco: '10.00' }), DUAS[1] ?? {}],
      [linhaAmazon('L1', { qtd: 1, preco: '10.00' }), DUAS[1] ?? {}],
    ];
    for (const linhas of casos) {
      const r = montar(PAGO(), { linhas, atualizadoEm: depois(60) });
      const p = patchDe(r);
      expect(decisao(r).itens).toBe('divergencia-itens-aprovado');
      expect(decisao(r).avisos).toContain('divergencia-itens');
      expect(Object.hasOwn(p, 'itens')).toBe(false);
      expect(p.estado).toBe('error');
      expect(String(p.error)).toMatch(/^\[amazon\] itens divergentes do pedido na Amazon/);
    }
    expect(decisao(montar(PAGO(), { linhas: DUAS })).itens).toBe('mantidas');
  });

  it('across the boundary: the same zeroed line on CANCELLED ⇒ kept; on UNSHIPPED ⇒ divergence; SHIPPED unchanged ⇒ no motivo', () => {
    const zerada = [linhaAmazon('L1', { qtd: 0, preco: '10.00' }), DUAS[1] ?? {}];
    expect(decisao(montar(PAGO(), { status: 'CANCELLED', linhas: zerada })).itens).toBe(
      'itens-preservados-reversao',
    );
    expect(decisao(montar(PAGO(), { status: 'UNSHIPPED', linhas: zerada })).itens).toBe(
      'divergencia-itens-aprovado',
    );
    const enviado = decisao(montar(PAGO(), { status: 'SHIPPED', linhas: DUAS }));
    expect(enviado).toMatchObject({ itens: 'mantidas', avisos: [], incidentes: [], eventos: [] });
  });

  it('prices in centavos: 10.00 → 0.01 diverges; a stored 0 is FILLED (preco-preenchido); 0.01 → 10.00 diverges; a stored 0 QUANTITY is never filled', () => {
    expect(
      decisao(
        montar(PAGO(), { linhas: [linhaAmazon('L1', { qtd: 2, preco: '0.01' }), DUAS[1] ?? {}] }),
      ).itens,
    ).toBe('divergencia-itens-aprovado');
    const zero = PAGO();
    const itens = zero.itens as Record<string, Doc[]>;
    const comZero = {
      ...zero,
      itens: {
        NONE: (itens.NONE ?? []).map((l) =>
          l.mktplaceId === 'L1' ? { ...l, precoDeVenda: 0 } : l,
        ),
      },
    };
    const preenchido = montar(comZero, { linhas: DUAS });
    expect(decisao(preenchido)).toMatchObject({ itens: 'mantidas', eventos: ['preco-preenchido'] });
    expect(linhasDo(patchDe(preenchido))).toContainEqual({ id: 'L1', q: 2, p: 10 });
    const umCentavo = {
      ...zero,
      itens: {
        NONE: (itens.NONE ?? []).map((l) =>
          l.mktplaceId === 'L1' ? { ...l, precoDeVenda: 0.01 } : l,
        ),
      },
    };
    expect(decisao(montar(umCentavo, { linhas: DUAS })).itens).toBe('divergencia-itens-aprovado');
    const qtdZero = {
      ...zero,
      itens: {
        NONE: (itens.NONE ?? []).map((l) => (l.mktplaceId === 'L1' ? { ...l, quantidade: 0 } : l)),
      },
    };
    expect(decisao(montar(qtdZero, { linhas: DUAS })).itens).toBe('divergencia-itens-aprovado');
  });

  it('a changed discount on an approved, unshipped order ⇒ divergence', () => {
    const com = (desconto: string) => [
      linhaAmazon('L1', {
        qtd: 2,
        preco: '10.00',
        quebras: [{ type: 'DISCOUNT', subtotal: brl(desconto) }],
      }),
    ];
    const r = montar(criado({ linhas: com('3.00') }), { linhas: com('4.00') });
    expect(decisao(r).itens).toBe('divergencia-itens-aprovado');
    expect(decisao(montar(criado({ linhas: com('3.00') }), { linhas: com('3.00') })).itens).toBe(
      'mantidas',
    );
  });

  it('on mantidas a stored-null freight money is FILLED by a positive incoming one; an incoming 0 leaves it (NEAR-MISS)', () => {
    const com = (frete: string) => [
      linhaAmazon('L1', {
        qtd: 2,
        preco: '10.00',
        quebras: [{ type: 'SHIPPING', subtotal: brl(frete) }],
      }),
    ];
    const semFrete = criado({ linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00' })] });
    expect((semFrete.freteInicial as Doc).valorCobrado).toBeNull();
    const p = patchDe(montar(semFrete, { linhas: com('7.00') }));
    expect(p.freteInicial).toMatchObject({ valorCobrado: 7 });
    expect(p.valorCobrado).toBe(27);
    expect(montar(semFrete, { linhas: com('0.00') }).tipo).toBe('sem-mudanca');
  });

  it('a duplicate stored mktplaceId, or a stored line without one, makes the comparison divergent', () => {
    const base = PAGO();
    const itens = base.itens as Record<string, Doc[]>;
    const l1 = (itens.NONE ?? []).find((l) => l.mktplaceId === 'L1') ?? {};
    expect(
      decisao(montar({ ...base, itens: { NONE: [...(itens.NONE ?? []), l1] } }, { linhas: DUAS }))
        .itens,
    ).toBe('divergencia-itens-aprovado');
    expect(
      decisao(
        montar(
          { ...base, itens: { NONE: [...(itens.NONE ?? []), { ...l1, mktplaceId: null }] } },
          { linhas: DUAS },
        ),
      ).itens,
    ).toBe('divergencia-itens-aprovado');
  });

  it('a migrated pedido (produto-id key + NONE, no produtoUid, no ensureUniqueId, ordem 1, a float price) equals 33.30 by id; one id off by a digit diverges', () => {
    const linha = (id: string, preco: number) =>
      itemDoPedidoSchema.parse({
        mktplaceId: id,
        ordem: 1,
        precoDeVenda: preco,
        quantidade: 1,
        sku: `SKU-TESTE-${id}`,
        nomeDeVenda: `Produto teste ${id}`,
      });
    const semUid = (id: string, preco: number) => {
      const l: Doc = { ...linha(id, preco) };
      delete l.produtoUid;
      return l;
    };
    const migrado: Doc = {
      estado: 'pago',
      foiImpresso: false,
      lastMarketplaceUpdate: ATUALIZADO_US / 1000,
      itens: {
        'prod-1': [semUid('OI-0000001', 33.300000000000004)],
        NONE: [semUid('OI-0000002', 5)],
      },
      itensIds: ['prod-1', 'NONE'],
      freteInicial: null,
      descontoTotal: 0,
      valorCobrado: 38.3,
    };
    const incoming = (id1: string) => [
      linhaAmazon(id1, { qtd: 1, preco: '33.30' }),
      linhaAmazon('OI-0000002', { qtd: 1, preco: '5.00' }),
    ];
    const igual = montar(migrado, { linhas: incoming('OI-0000001') });
    expect(decisao(igual).itens).toBe('mantidas');
    expect(Object.hasOwn(patchDe(igual), 'itens')).toBe(false);
    expect(decisao(montar(migrado, { linhas: incoming('OI-0000003') })).itens).toBe(
      'divergencia-itens-aprovado',
    );
  });
});

describe('D17 — before approval, the approval moment, and the freeze', () => {
  it('PENDING mirrors, a removed line included; PENDING with [] or absent orderItems removes nothing', () => {
    const r = montar(PENDENTE(), {
      status: 'PENDING',
      linhas: [linhaAmazon('L1', { qtd: 3, preco: '9.00' })],
    });
    expect(decisao(r).itens).toBe('espelhadas');
    expect(linhasDo(patchDe(r))).toEqual([{ id: 'L1', q: 3, p: 9 }]);
    expect(patchDe(r).valorCobrado).toBe(27);
    for (const linhas of [[], null]) {
      const vazio = montar(PENDENTE(), { status: 'PENDING', linhas, atualizadoEm: depois(60) });
      expect(Object.hasOwn(patchDe(vazio), 'itens')).toBe(false);
    }
  });

  it('a mirror with an X or an R line: a 0 freight never overwrites a stored positive one (the whole group kept); NEAR-MISS: the same 0 on a plain mirror is written', () => {
    const guardado = criado({ status: 'PENDING', linhas: comFrete('8.00') });
    expect((guardado.freteInicial as Doc).valorCobrado).toBe(8);
    for (const extra of [{ execucao: true }, { solicitacao: true }]) {
      const r = montar(guardado, { status: 'PENDING', linhas: comFrete('0.00', extra) });
      expect(decisao(r).itens, JSON.stringify(extra)).toBe('espelhadas');
      expect(freteDepois(r, 8), JSON.stringify(extra)).toBe(8);
      expect(r.tipo === 'atualizar' && Object.hasOwn(r.patch, 'valorCobrado')).toBe(false);
    }
    const semProtecao = montar(guardado, { status: 'PENDING', linhas: comFrete('0.00') });
    expect(freteDepois(semProtecao, 8)).toBe(0);
    expect(patchDe(semProtecao).valorCobrado).toBe(20);
  });

  it('a mirror whose read carries no proceeds: an ABSENT money member never erases a stored one', () => {
    const guardado = criado({ status: 'PENDING', linhas: comFrete('8.00') });
    const r = montar(guardado, {
      status: 'PENDING',
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00' })],
    });
    expect(r.tipo).toBe('sem-mudanca');
  });

  it('the approval moment: a stored PENDING mirror + UNSHIPPED with a different price ⇒ mirrored, not divergent', () => {
    const r = montar(PENDENTE(), {
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '11.00' }), DUAS[1] ?? {}],
      atualizadoEm: depois(60),
    });
    expect(decisao(r)).toMatchObject({ itens: 'espelhadas', linhaD17: 9, bloqueio: null });
    expect(patchDe(r).estado).toBe('pago');
    expect(linhasDo(patchDe(r))).toContainEqual({ id: 'L1', q: 2, p: 11 });
  });

  it('NEAR-MISS pair — X at the approval moment BLOCKS; the same X on PENDING mirrors with the stored positive qty protected', () => {
    const comX = [linhaAmazon('L1', { qtd: 0, preco: '10.00', execucao: true }), DUAS[1] ?? {}];
    const bloqueado = montar(PENDENTE(), { linhas: comX, atualizadoEm: depois(60) });
    expect(decisao(bloqueado)).toMatchObject({
      itens: 'divergencia-itens-aprovado',
      eventos: ['cancelamento-parcial'],
      avisos: ['divergencia-itens'],
    });
    expect(patchDe(bloqueado).estado).toBe('error');
    expect(String(patchDe(bloqueado).error)).toBe(
      `${PREFIXO_ERRO_AMAZON}linha cancelada na Amazon em pedido a enviar: L1`,
    );
    const pendente = montar(PENDENTE(), {
      status: 'PENDING',
      linhas: comX,
      atualizadoEm: depois(60),
    });
    expect(decisao(pendente).itens).toBe('espelhadas');
    expect(Object.hasOwn(patchDe(pendente), 'itens')).toBe(false);
  });

  it('X on an approved UNSHIPPED order ⇒ BLOCK + cancelamento-parcial; a first-seen one is CREATED at our error', () => {
    const comX = [linhaAmazon('L1', { qtd: 0, preco: '10.00', execucao: true }), DUAS[1] ?? {}];
    const r = montar(PAGO(), { linhas: comX, atualizadoEm: depois(60) });
    expect(decisao(r)).toMatchObject({
      itens: 'divergencia-itens-aprovado',
      eventos: ['cancelamento-parcial'],
    });
    expect(patchDe(r)).toMatchObject({ estado: 'error' });
    const novo = montar(null, { linhas: comX });
    expect(novo.tipo).toBe('criar');
    expect(novo.tipo === 'criar' ? novo.corpo : {}).toMatchObject({
      estado: 'error',
      error: `${PREFIXO_ERRO_AMAZON}linha cancelada na Amazon em pedido a enviar: L1`,
    });
    expect(decisao(novo)).toMatchObject({
      itens: 'escritas',
      avisos: ['divergencia-itens'],
      eventos: ['cancelamento-parcial'],
    });
  });

  it('hasUserInteraction ⇒ congeladas: lines untouched, no divergence, the estado recovers from our error', () => {
    const r = montar(
      PAGO({
        hasUserInteraction: true,
        estado: 'error',
        error: `${PREFIXO_ERRO_AMAZON}itens divergentes do pedido na Amazon: L1`,
      }),
      {
        linhas: [linhaAmazon('L1', { qtd: 9, preco: '1.00' })],
      },
    );
    expect(decisao(r)).toMatchObject({ itens: 'congeladas', bloqueio: null, avisos: [] });
    expect(patchDe(r)).toMatchObject({ estado: 'pago', error: null });
    expect(Object.hasOwn(patchDe(r), 'itens')).toBe(false);
  });

  it('a divergence over a fora-da-escada estado (finalizado) keeps the estado and still raises the aviso', () => {
    const r = montar(PAGO({ estado: 'finalizado' }), {
      linhas: [linhaAmazon('L1', { qtd: 1, preco: '10.00' }), DUAS[1] ?? {}],
    });
    expect(decisao(r)).toMatchObject({
      itens: 'divergencia-itens-aprovado',
      avisos: ['divergencia-itens'],
      motivoEstado: 'fora-da-escada',
    });
    expect(r.tipo).toBe('sem-mudanca');
  });

  it('our own creation-time error is not "approved": status absent at create, then UNSHIPPED with a changed price ⇒ mirrored', () => {
    const criadoErro = criado({ status: null, linhas: DUAS });
    expect(criadoErro).toMatchObject({ estado: 'error', marketplace: { status: null } });
    const r = montar(criadoErro, {
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '12.00' }), DUAS[1] ?? {}],
      atualizadoEm: depois(60),
    });
    expect(decisao(r).itens).toBe('espelhadas');
    expect(patchDe(r)).toMatchObject({ estado: 'pago', error: null });
    // NEAR-MISS: OUR divergence error, with a stored UNSHIPPED status, stays divergent.
    const divergente = PAGO({
      estado: 'error',
      error: `${PREFIXO_ERRO_AMAZON}itens divergentes do pedido na Amazon: L1`,
    });
    expect(
      decisao(
        montar(divergente, {
          linhas: [linhaAmazon('L1', { qtd: 2, preco: '12.00' }), DUAS[1] ?? {}],
        }),
      ).itens,
    ).toBe('divergencia-itens-aprovado');
  });

  it('our error clears when the lines agree again; a FOREIGN error is never cleared', () => {
    const nosso = montar(
      PAGO({
        estado: 'error',
        error: `${PREFIXO_ERRO_AMAZON}itens divergentes do pedido na Amazon: L1`,
      }),
      { linhas: DUAS },
    );
    expect(patchDe(nosso)).toMatchObject({ estado: 'pago', error: null });
    const alheio = montar(PAGO({ estado: 'error', error: 'Rejeição 539 da SEFAZ' }), {
      linhas: DUAS,
    });
    expect(alheio.tipo).toBe('sem-mudanca');
    const pagoComNota = montar(PAGO({ error: 'nota de um operador' }), { linhas: DUAS });
    expect(pagoComNota.tipo).toBe('sem-mudanca');
  });

  it('an absent fulfilledBy on update never moves the estado to error', () => {
    const r = montar(PAGO(), { por: null, linhas: DUAS, atualizadoEm: depois(60) });
    expect(Object.hasOwn(patchDe(r), 'estado')).toBe(false);
    expect(decisao(r).avisos).toEqual(['logistica-desconhecida']);
  });
});

describe('the R modifier (a cancellation REQUEST alone) — plan §3 decision 7', () => {
  const comR = (qtd: number) => [
    linhaAmazon('L1', { qtd, preco: '10.00', solicitacao: true }),
    DUAS[1] ?? {},
  ];

  it('not printed: mantidas + cancelamento-solicitado, the estado unchanged', () => {
    const r = montar(PAGO(), { linhas: comR(2) });
    expect(decisao(r)).toMatchObject({
      itens: 'mantidas',
      avisos: ['cancelamento-solicitado'],
      estadoEscrito: null,
    });
    expect(r.tipo).toBe('sem-mudanca');
  });

  it('printed — dtImpressao alone, and separately foiImpresso alone — ⇒ cancelado + aceitar-cancelamento (NEAR-MISS pair)', () => {
    for (const impressao of [{ dtImpressao: NOW_US - 1 }, { foiImpresso: true }]) {
      const r = montar(PAGO(impressao), { linhas: comR(2) });
      expect(patchDe(r).estado, JSON.stringify(impressao)).toBe('cancelado');
      expect(decisao(r).avisos).toEqual(['aceitar-cancelamento']);
    }
  });

  it('printed takes the ONE CANCELLED predicate’s TARGET: a stored aprovado pagamento ⇒ estornadoIntegralmente; goods out ⇒ kept — and none of its incidentes, which an Amazon CANCELLED files (NEAR-MISS)', () => {
    const estornado = montar(
      PAGO({ foiImpresso: true }),
      { linhas: comR(2) },
      { pagamento: { status_pagamento: STATUS_PAGAMENTO.aprovado } },
    );
    expect(patchDe(estornado).estado).toBe('estornadoIntegralmente');
    const guardado = PAGO({ foiImpresso: true });
    const comFreteFora = {
      ...guardado,
      freteInicial: { ...(guardado.freteInicial as Doc), estado: 'postado' },
    };
    const fora = montar(comFreteFora, { linhas: comR(2) });
    expect(decisao(fora)).toMatchObject({
      estadoEscrito: null,
      motivoEstado: 'manter',
      incidentes: [],
      avisos: ['aceitar-cancelamento'],
    });
    expect(decisao(montar(comFreteFora, { status: 'CANCELLED', linhas: DUAS })).incidentes).toEqual(
      ['cancelado-apos-envio'],
    );
    // An operator's off-ladder pagamento: the request moves the estado and files nothing.
    const disputa = (opcoes: OpcoesPedidoTeste) =>
      montar(PAGO({ foiImpresso: true }), opcoes, {
        pagamento: { status_pagamento: STATUS_PAGAMENTO.em_disputa },
      });
    const pedido = disputa({ linhas: comR(2) });
    expect(patchDe(pedido).estado).toBe('cancelado');
    expect(decisao(pedido).incidentes).toEqual([]);
    expect(decisao(disputa({ status: 'CANCELLED', linhas: DUAS })).incidentes).toEqual([
      'pagamento-divergente',
    ]);
  });

  it('printed, but Amazon has SHIPPED the order or its status is unknown ⇒ no cancel and no aceitar-cancelamento, only cancelamento-solicitado; NEAR-MISS: UNSHIPPED and PENDING cancel', () => {
    for (const pagamento of [null, { status_pagamento: STATUS_PAGAMENTO.aprovado }]) {
      const enviado = montar(
        PAGO({ foiImpresso: true }),
        { status: 'SHIPPED', linhas: comR(2), atualizadoEm: depois(60) },
        { pagamento },
      );
      expect(Object.hasOwn(patchDe(enviado), 'estado'), JSON.stringify(pagamento)).toBe(false);
      expect(decisao(enviado)).toMatchObject({
        linhaD17: 11,
        avisos: ['cancelamento-solicitado'],
        incidentes: [],
      });
    }
    const desconhecido = montar(PAGO({ foiImpresso: true }), {
      status: null,
      linhas: comR(2),
      atualizadoEm: depois(60),
    });
    expect(Object.hasOwn(patchDe(desconhecido), 'estado')).toBe(false);
    expect(decisao(desconhecido).avisos).toEqual([
      'cancelamento-solicitado',
      'status-desconhecido',
    ]);
    const aEnviar = montar(PAGO({ foiImpresso: true }), {
      status: 'UNSHIPPED',
      linhas: comR(2),
      atualizadoEm: depois(60),
    });
    expect(patchDe(aEnviar).estado).toBe('cancelado');
    const pendente = montar(PENDENTE({ foiImpresso: true }), {
      status: 'PENDING',
      linhas: comR(2),
      atualizadoEm: depois(60),
    });
    expect(patchDe(pendente).estado).toBe('cancelado');
    expect(decisao(pendente).avisos).toEqual(['aceitar-cancelamento']);
  });

  it('a request protects a 0 or absent PRICE and a 0 freight on the approved comparison (mantidas); NEAR-MISS: without the request each is a divergence', () => {
    const comPreco = (preco: string | undefined, solicitacao: boolean) => [
      linhaAmazon('L1', { qtd: 2, ...(preco === undefined ? {} : { preco }), solicitacao }),
      DUAS[1] ?? {},
    ];
    for (const preco of ['0.00', undefined]) {
      expect(decisao(montar(PAGO(), { linhas: comPreco(preco, true) })).itens, preco).toBe(
        'mantidas',
      );
      expect(decisao(montar(PAGO(), { linhas: comPreco(preco, false) })).itens, preco).toBe(
        'divergencia-itens-aprovado',
      );
    }
    const guardado = criado({ linhas: comFrete('8.00') });
    expect(
      decisao(montar(guardado, { linhas: comFrete('0.00', { solicitacao: true }) })).itens,
    ).toBe('mantidas');
    expect(decisao(montar(guardado, { linhas: comFrete('0.00') })).itens).toBe(
      'divergencia-itens-aprovado',
    );
  });

  it('the request stays open: the cancel target holds on the next import (no flip back)', () => {
    const primeiro = montar(PAGO({ foiImpresso: true }), { linhas: comR(2) });
    const depoisDaPrimeira = aplicar(PAGO({ foiImpresso: true }), primeiro);
    const segundo = montar(depoisDaPrimeira, { linhas: comR(2), atualizadoEm: depois(60) });
    expect(Object.hasOwn(patchDe(segundo), 'estado')).toBe(false);
    expect(decisao(segundo).avisos).toEqual(['aceitar-cancelamento']);
  });

  it('a request protects values: qty 2 → 0 is kept; qty 2 → 1 is a divergence', () => {
    expect(decisao(montar(PAGO(), { linhas: comR(0) })).itens).toBe('mantidas');
    expect(decisao(montar(PAGO(), { linhas: comR(1) })).itens).toBe('divergencia-itens-aprovado');
  });

  it('a request and a divergence together raise BOTH avisos; on a printed pedido the cancel target wins over our error', () => {
    const naoImpresso = montar(PAGO(), { linhas: comR(1) });
    expect(decisao(naoImpresso).avisos).toEqual(['cancelamento-solicitado', 'divergencia-itens']);
    expect(patchDe(naoImpresso).estado).toBe('error');
    const impresso = montar(PAGO({ foiImpresso: true }), { linhas: comR(1) });
    expect(decisao(impresso).avisos).toEqual(['aceitar-cancelamento', 'divergencia-itens']);
    expect(patchDe(impresso).estado).toBe('cancelado');
  });
});

describe('cancelado-so-no-erp and the resurrection refinement (2026-10-22)', () => {
  it('stored cancelado, Amazon still to ship, no request ⇒ cancelado-so-no-erp, estado kept', () => {
    const r = montar(PAGO({ estado: 'cancelado' }), { linhas: DUAS, atualizadoEm: depois(60) });
    expect(decisao(r)).toMatchObject({ avisos: ['cancelado-so-no-erp'], motivoEstado: 'terminal' });
    expect(Object.hasOwn(patchDe(r), 'estado')).toBe(false);
  });

  it('NEAR-MISS: the same with a request open on a printed pedido ⇒ aceitar-cancelamento instead', () => {
    const r = montar(PAGO({ estado: 'cancelado', foiImpresso: true }), {
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true }), DUAS[1] ?? {}],
      atualizadoEm: depois(60),
    });
    expect(decisao(r).avisos).toEqual(['aceitar-cancelamento']);
  });

  it('NEAR-MISS: a request still open on L1 while L2 carries an execution ⇒ no cancelado-so-no-erp (R is off, the request is not)', () => {
    const r = montar(PAGO({ estado: 'cancelado', foiImpresso: true }), {
      linhas: [
        linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true }),
        linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
      ],
      atualizadoEm: depois(60),
    });
    expect(decisao(r)).toMatchObject({
      avisos: ['divergencia-itens'],
      eventos: ['cancelamento-parcial'],
      motivoEstado: 'terminal',
    });
  });

  it('stored cancelado + incoming CANCELLED ⇒ neither; stored pago + UNSHIPPED ⇒ neither', () => {
    expect(
      decisao(montar(PAGO({ estado: 'cancelado' }), { status: 'CANCELLED', linhas: DUAS })).avisos,
    ).toEqual([]);
    expect(decisao(montar(PAGO(), { linhas: DUAS, atualizadoEm: depois(60) })).avisos).toEqual([]);
  });

  it('NEAR-MISS pair: stored cancelado + stored status CANCELLED + strictly newer UNSHIPPED ⇒ ressuscitado; stored status UNSHIPPED ⇒ kept + cancelado-so-no-erp', () => {
    const amazonCancelou = PAGO({
      estado: 'cancelado',
      marketplace: { ...(PAGO().marketplace as Doc), status: 'CANCELLED' },
    });
    const vivo = montar(amazonCancelou, { linhas: DUAS, atualizadoEm: depois(60) });
    expect(patchDe(vivo).estado).toBe('pago');
    expect(decisao(vivo)).toMatchObject({ eventos: ['ressuscitado'], avisos: [] });
    const erpCancelou = montar(PAGO({ estado: 'cancelado' }), {
      linhas: DUAS,
      atualizadoEm: depois(60),
    });
    expect(Object.hasOwn(patchDe(erpCancelou), 'estado')).toBe(false);
    expect(decisao(erpCancelou).avisos).toEqual(['cancelado-so-no-erp']);
    // An EQUAL clock never resurrects, even when Amazon had cancelled — and the
    // cancel was Amazon's, so it is not cancelado-so-no-erp either.
    const igual = montar(amazonCancelou, { linhas: DUAS });
    expect(Object.hasOwn(patchDe(igual), 'estado')).toBe(false);
    expect(decisao(igual)).toMatchObject({ motivoEstado: 'terminal', avisos: [] });
  });
});

describe('unreadable stored data never drives the order total', () => {
  /** `doc` with line `id`'s price replaced by a value the item schema refuses. */
  const comLinhaIlegivel = (doc: Doc, id: string): Doc => {
    const itens = structuredClone(doc.itens) as Record<string, Doc[]>;
    for (const lista of Object.values(itens)) {
      for (const linha of lista) if (linha.mktplaceId === id) linha.precoDeVenda = 'ilegivel';
    }
    return { ...doc, itens };
  };
  /** `doc` with its `amz` freight block refused by the freight schema (an unknown estado). */
  const comFreteIlegivel = (doc: Doc): Doc => ({
    ...doc,
    freteInicial: { ...(doc.freteInicial as Doc), estado: 'estado-desconhecido' },
  });
  const comDuasEFrete = (frete: string) => [
    linhaAmazon('L1', {
      qtd: 2,
      preco: '10.00',
      quebras: [{ type: 'SHIPPING', subtotal: brl(frete) }],
    }),
    linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
  ];

  it('a stored line the schema refuses: the mirror writes no total, no discount and no freight money; NEAR-MISS: readable lines write all of it', () => {
    const guardado = criado({ status: 'PENDING', linhas: comDuasEFrete('8.00') });
    const legivel = patchDe(montar(guardado, { status: 'PENDING', linhas: comDuasEFrete('9.00') }));
    expect(legivel.valorCobrado).toBe(34);
    expect(legivel.freteInicial).toMatchObject({ valorCobrado: 9 });

    const r = montar(comLinhaIlegivel(guardado, 'L2'), {
      status: 'PENDING',
      linhas: comDuasEFrete('9.00'),
    });
    const p = r.tipo === 'atualizar' ? r.patch : {};
    expect(Object.hasOwn(p, 'valorCobrado')).toBe(false);
    expect(Object.hasOwn(p, 'descontoTotal')).toBe(false);
    expect(freteDepois(r, 8)).toBe(8);
    expect(decisao(r).eventos).toContain(EVENTO_PEDIDO_AMAZON.itensArmazenadosIlegiveis);
  });

  it('a stored line the schema refuses: an approved order whose stored-null freight would be filled writes no total either; NEAR-MISS: readable lines fill it', () => {
    const guardado = criado({ linhas: DUAS });
    const legivel = patchDe(montar(guardado, { linhas: comDuasEFrete('7.00') }));
    expect(legivel.valorCobrado).toBe(32);

    const r = montar(comLinhaIlegivel(guardado, 'L2'), { linhas: comDuasEFrete('7.00') });
    const p = r.tipo === 'atualizar' ? r.patch : {};
    expect(Object.hasOwn(p, 'valorCobrado')).toBe(false);
    expect(Object.hasOwn(p, 'descontoTotal')).toBe(false);
    expect((p.freteInicial as Doc | undefined)?.valorCobrado ?? null).toBeNull();
  });

  it('an amz freight block the schema refuses is not rewritten, and the total keeps the STORED freight; NEAR-MISS: a readable block takes the new freight in both places', () => {
    const guardado = criado({ status: 'PENDING', linhas: comDuasEFrete('8.00') });
    expect(guardado.valorCobrado).toBe(33);
    const legivel = patchDe(montar(guardado, { status: 'PENDING', linhas: comDuasEFrete('9.00') }));
    expect(legivel.freteInicial).toMatchObject({ valorCobrado: 9 });
    expect(legivel.valorCobrado).toBe(34);

    const r = montar(comFreteIlegivel(guardado), {
      status: 'PENDING',
      linhas: comDuasEFrete('9.00'),
    });
    const p = r.tipo === 'atualizar' ? r.patch : {};
    expect(Object.hasOwn(p, 'freteInicial')).toBe(false);
    expect(Object.hasOwn(p, 'valorCobrado')).toBe(false);
    expect(decisao(r).eventos).toContain(EVENTO_PEDIDO_AMAZON.freteArmazenadoIlegivel);
  });
});

describe('the CANCELLED estado through the predicate, end to end', () => {
  it('no pagamento ⇒ cancelado; an aprovado one ⇒ estornadoIntegralmente; an operator’s em_disputa ⇒ cancelado + pagamento-divergente', () => {
    expect(patchDe(montar(PAGO(), { status: 'CANCELLED', linhas: DUAS })).estado).toBe('cancelado');
    expect(
      patchDe(
        montar(
          PAGO(),
          { status: 'CANCELLED', linhas: DUAS },
          { pagamento: { status_pagamento: STATUS_PAGAMENTO.aprovado } },
        ),
      ).estado,
    ).toBe('estornadoIntegralmente');
    const disputa = montar(
      PAGO(),
      { status: 'CANCELLED', linhas: DUAS },
      { pagamento: { status_pagamento: STATUS_PAGAMENTO.em_disputa } },
    );
    expect(patchDe(disputa).estado).toBe('cancelado');
    expect(decisao(disputa).incidentes).toEqual(['pagamento-divergente']);
  });
});

describe('the lines’ identity', () => {
  it('ensureUniqueId is never added to a stored line; a stored NONE line is bound by a later link (equal-stamp redelivery)', () => {
    const guardado = PAGO();
    const itens = guardado.itens as Record<string, Doc[]>;
    const semId = {
      ...guardado,
      itens: { NONE: (itens.NONE ?? []).map((l) => ({ ...l, ensureUniqueId: null })) },
    };
    const r = montar(
      semId,
      { linhas: DUAS },
      { entradas: { vinculos: new Map([['L1', 'prod-9']]) } },
    );
    const p = patchDe(r);
    expect(decisao(r).itens).toBe('mantidas');
    const linhas = Object.values(p.itens as Record<string, Doc[]>).flat();
    expect(linhas.every((l) => l.ensureUniqueId === null)).toBe(true);
    expect((p.itens as Record<string, Doc[]>)['prod-9']?.[0]).toMatchObject({
      mktplaceId: 'L1',
      produtoUid: 'prod-9',
    });
    expect(Object.hasOwn(p, 'valorCobrado')).toBe(false);
  });

  it('a pre-approval mirror that REWRITES a stored line never backfills its ensureUniqueId either', () => {
    const guardado = PENDENTE();
    const itens = guardado.itens as Record<string, Doc[]>;
    const semId = {
      ...guardado,
      itens: Object.fromEntries(
        Object.entries(itens).map(([chave, lista]) => [
          chave,
          lista.map((l) => ({ ...l, ensureUniqueId: null })),
        ]),
      ),
    };
    const r = montar(semId, {
      status: 'PENDING',
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.01' }), DUAS[1] ?? {}],
    });
    expect(decisao(r).itens).toBe('espelhadas');
    const linhas = Object.values(patchDe(r).itens as Record<string, Doc[]>).flat();
    expect(linhasDo(patchDe(r))).toContainEqual({ id: 'L1', q: 2, p: 10.01 });
    expect(linhas).toHaveLength(2);
    expect(linhas.every((l) => l.ensureUniqueId === null)).toBe(true);
  });
});

describe('purity', () => {
  it('the mappers read no clock, no environment and no logger', () => {
    for (const arquivo of [
      'codigosPedidoAmazon.ts',
      'dinheiroAmazon.ts',
      'erros.ts',
      'estadoPedidoAmazon.ts',
      'freteAmazon.ts',
      'itensAmazon.ts',
      'pacotesAmazon.ts',
      'pagamentoAmazon.ts',
      'pedidoMapeamento.ts',
      'vendaAmazon.ts',
      'clienteAmazon.ts',
    ]) {
      const fonte = readFileSync(join(AQUI, arquivo), 'utf8');
      expect(fonte, arquivo).not.toMatch(
        /Date\.now|new Date\(|process\.env|console\.|registrarEventoAmazon|from 'firebase-admin/,
      );
    }
  });

  it('the base instant the suite uses is the one the helper declares', () => {
    expect(ATUALIZADO_EM).toBe('2026-10-01T12:00:00Z');
  });
});

/* -------------------------------------------------------------------------- */
/*                    PR 6: the pagamento beside the pedido                    */
/* -------------------------------------------------------------------------- */

/**
 * The FOB residue rows of the pair table, BY NAME (see that test): every one is
 * the FOB scenario, a paying pagamento beside `pago`, relabelled by the shared
 * reconcile only because the pedido's total carries the buyer-paid freight. An
 * owner decision flips this list to `[]`.
 */
const RESIDUO_FOB_ESPERADO: readonly string[] = [
  'fob-frete × ilegivel × estornado × SHIPPED × mais-novo',
  'fob-frete × nenhum × ausente × SHIPPED × mais-novo',
  'fob-frete × nenhum × ausente × UNSHIPPED × mais-novo',
  'fob-frete × pago × ausente × SHIPPED × igual',
  'fob-frete × pago × ausente × SHIPPED × mais-novo',
  'fob-frete × pago × ausente × UNSHIPPED × igual',
  'fob-frete × pago × ausente × UNSHIPPED × mais-novo',
  'fob-frete × pago × estornado × SHIPPED × mais-novo',
  'fob-frete × pago × estornado × UNSHIPPED × mais-novo',
  'fob-frete × pendente × aprovado × SHIPPED × igual',
  'fob-frete × pendente × aprovado × SHIPPED × mais-novo',
  'fob-frete × pendente × aprovado × UNSHIPPED × igual',
  'fob-frete × pendente × aprovado × UNSHIPPED × mais-novo',
  'fob-frete × pendente × ausente × SHIPPED × igual',
  'fob-frete × pendente × ausente × SHIPPED × mais-novo',
  'fob-frete × pendente × ausente × UNSHIPPED × igual',
  'fob-frete × pendente × ausente × UNSHIPPED × mais-novo',
  'fob-frete × pendente × em_disputa × SHIPPED × igual',
  'fob-frete × pendente × em_disputa × SHIPPED × mais-novo',
  'fob-frete × pendente × em_disputa × UNSHIPPED × igual',
  'fob-frete × pendente × em_disputa × UNSHIPPED × mais-novo',
  'fob-frete × pendente × estornado × SHIPPED × mais-novo',
  'fob-frete × pendente × estornado × UNSHIPPED × mais-novo',
  'fob-frete × reetiquetado × aprovado × SHIPPED × igual',
  'fob-frete × reetiquetado × aprovado × SHIPPED × mais-novo',
  'fob-frete × reetiquetado × aprovado × UNSHIPPED × igual',
  'fob-frete × reetiquetado × aprovado × UNSHIPPED × mais-novo',
  'fob-frete × reetiquetado × ausente × SHIPPED × igual',
  'fob-frete × reetiquetado × ausente × SHIPPED × mais-novo',
  'fob-frete × reetiquetado × ausente × UNSHIPPED × igual',
  'fob-frete × reetiquetado × ausente × UNSHIPPED × mais-novo',
  'fob-frete × reetiquetado × em_disputa × SHIPPED × igual',
  'fob-frete × reetiquetado × em_disputa × SHIPPED × mais-novo',
  'fob-frete × reetiquetado × em_disputa × UNSHIPPED × igual',
  'fob-frete × reetiquetado × em_disputa × UNSHIPPED × mais-novo',
  'fob-frete × reetiquetado × estornado × SHIPPED × mais-novo',
  'fob-frete × reetiquetado × estornado × UNSHIPPED × mais-novo',
];

/** The pagamento write a decision carries. */
function pagamentoDe(r: EscritaPedidoAmazon): EscritaPagamentoPuraAmazon {
  if (r.tipo === 'nao-importado' || r.tipo === 'obsoleto') {
    throw new Error(`sem pagamento: ${r.tipo}`);
  }
  return r.pagamento;
}

/** The pagamento this importer CREATES for `opcoes` (a stored snapshot), `over` on top. */
function pagamentoCriado(opcoes: OpcoesPedidoTeste = {}, over: Doc = {}): Doc {
  const p = pagamentoDe(montar(null, { linhas: DUAS, ...opcoes }));
  if (p.tipo !== 'criar') throw new Error(`esperava criar, veio ${p.tipo}`);
  return { ...p.corpo, ...over };
}

/** A stored line the item schema refuses: the pedido's total cannot be derived. */
function comLinhaIlegivel(doc: Doc): Doc {
  const copia = structuredClone(doc);
  const itens = copia.itens as Record<string, Doc[]>;
  const [primeira] = Object.values(itens).flat();
  if (primeira === undefined) throw new Error('sem linha');
  primeira.quantidade = 'x';
  return copia;
}

describe('★ PR 6 — the pair: the pagamento status ⇔ the pedido estado, on every row the import decides', () => {
  /** The off-ladder statuses: the operator's, never walked — the documented exception, BY NAME. */
  const FORA_DA_ESCADA = new Set<number>([
    STATUS_PAGAMENTO.em_disputa,
    STATUS_PAGAMENTO.recusado,
    STATUS_PAGAMENTO.devolvido,
    STATUS_PAGAMENTO.estornado_parcialmente,
  ]);
  /** The estados a pedido may hold with NO pagamento. */
  const SEM_PAGAMENTO = new Set<string>([
    ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    ESTADO_PEDIDO.cancelado,
    ESTADO_PEDIDO.error,
  ]);
  /** The buyer-paid shipping of the FOB scenario (reais). */
  const FRETE_FOB = 5;
  /**
   * The order a row reads: DUAS (no freight), and one line with a SHIPPING row
   * under the conta default (FOB), whose pagamento excludes the freight that the
   * pedido's own total still carries (the FOB residue below).
   */
  const CENARIOS: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
    'sem-frete': DUAS,
    'fob-frete': comFrete(String(FRETE_FOB)),
  };
  /** The two order clocks a row is read at: strictly newer than the stored one, and EQUAL to it. */
  const RELOGIOS: Readonly<Record<string, string>> = {
    'mais-novo': depois(60),
    igual: ATUALIZADO_EM,
  };

  function cenario(linhas: readonly Record<string, unknown>[]) {
    const pagamentoDo = (over: Doc = {}): Doc => {
      const p = pagamentoDe(montar(null, { linhas }));
      if (p.tipo !== 'criar') throw new Error(`esperava criar, veio ${p.tipo}`);
      return { ...p.corpo, ...over };
    };
    const comStatus = (status: number) => pagamentoDo({ status_pagamento: status });
    const pagamentos: Readonly<Record<string, Doc | null>> = {
      ausente: null,
      aprovado: pagamentoDo(),
      estornado: comStatus(STATUS_PAGAMENTO.estornado),
      em_disputa: comStatus(STATUS_PAGAMENTO.em_disputa),
      recusado: comStatus(STATUS_PAGAMENTO.recusado),
      devolvido: comStatus(STATUS_PAGAMENTO.devolvido),
      estornado_parcialmente: comStatus(STATUS_PAGAMENTO.estornado_parcialmente),
    };
    const pedidos: Readonly<Record<string, Doc | null>> = {
      nenhum: null,
      pendente: criado({ status: 'PENDING', linhas }),
      pago: criado({ linhas }),
      // The Pagamentos tab's reconcile relabelled a pago pedido (after an
      // operator's pagamento edit): an approved order, stored pre-approval.
      reetiquetado: criado({ linhas }, { estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento }),
      // The legacy approved-without-pagamento shape with a line the schema refuses.
      ilegivel: comLinhaIlegivel(criado({ linhas }, { marketplace: null })),
    };
    return { pagamentos, pedidos };
  }

  it('statusToEstadoPedido(status) names the estado (two residues excepted, each BY NAME), and nextPedidoEstado answers null with the row’s own money — at a newer AND an equal clock', () => {
    let decididas = 0;
    let iguais = 0;
    const residuosForaDaEscada: string[] = [];
    const residuosFob: string[] = [];
    const bloqueios: string[] = [];
    for (const [nomeCenario, linhas] of Object.entries(CENARIOS)) {
      const { pagamentos, pedidos } = cenario(linhas);
      for (const [nomePedido, pedido] of Object.entries(pedidos)) {
        for (const [nomePagamento, pagamento] of Object.entries(pagamentos)) {
          // A pagamento with no pedido above it is no row of this table (the
          // importer never writes one; only a deleted pedido could leave it).
          if (pedido === null && pagamento !== null) continue;
          for (const status of ['PENDING', 'UNSHIPPED', 'SHIPPED', 'CANCELLED']) {
            for (const [nomeRelogio, atualizadoEm] of Object.entries(RELOGIOS)) {
              // With nothing stored, the clock compares with nothing.
              if (pedido === null && nomeRelogio === 'igual') continue;
              const rotulo = `${nomeCenario} × ${nomePedido} × ${nomePagamento} × ${status} × ${nomeRelogio}`;
              const r = montar(pedido, { status, linhas, atualizadoEm }, { pagamento });
              if (r.tipo === 'nao-importado') {
                expect(pedido, rotulo).toBeNull();
                continue;
              }
              if (r.tipo === 'obsoleto') throw new Error(rotulo);
              const escrita = pagamentoDe(r);
              const estadoGuardado = (pedido?.estado ?? null) as string | null;
              const estadoFinal =
                r.decisao.estadoEscrito ?? (r.tipo === 'criar' ? r.corpo.estado : estadoGuardado);
              const statusGuardado = (pagamento?.status_pagamento ?? null) as number | null;
              const statusFinal = r.decisao.statusPagamento;
              // The pagamento never changes but where the decision says so.
              if (escrita.tipo === 'nada') expect(statusFinal, rotulo).toBe(statusGuardado);
              const decidiu =
                r.decisao.estadoEscrito !== null ||
                r.tipo === 'criar' ||
                escrita.tipo === 'criar' ||
                statusFinal !== statusGuardado;
              if (!decidiu) continue;
              decididas += 1;
              if (nomeRelogio === 'igual') iguais += 1;
              // A D17 block: our error, and the pagamento NOT written beside it
              // (the plan's status table); the reconcile never moves `error`.
              if (r.decisao.bloqueio !== null && estadoFinal === ESTADO_PEDIDO.error) {
                expect(escrita, rotulo).toEqual({ tipo: 'nada' });
                bloqueios.push(rotulo);
                continue;
              }
              // 1. The pair.
              if (statusFinal === null) {
                expect(SEM_PAGAMENTO.has(String(estadoFinal)), rotulo).toBe(true);
              } else if (!FORA_DA_ESCADA.has(statusFinal)) {
                expect(statusToEstadoPedido(statusFinal), rotulo).toBe(estadoFinal);
              }
              // 2. The reconcile leaves it where the import put it.
              const total =
                r.tipo === 'criar'
                  ? (r.corpo.valorCobrado as number)
                  : r.tipo === 'atualizar' && Object.hasOwn(r.patch, 'valorCobrado')
                    ? (r.patch.valorCobrado as number)
                    : (pedido?.valorCobrado as number);
              const valor =
                escrita.tipo === 'criar'
                  ? (escrita.corpo.valor as number)
                  : escrita.tipo === 'atualizar' && Object.hasOwn(escrita.patch, 'valor')
                    ? (escrita.patch.valor as number)
                    : ((pagamento?.valor ?? 0) as number);
              const quitado = statusFinal !== null && isPagamentoPagante(statusFinal) ? valor : 0;
              const proximo = nextPedidoEstado(
                estadoFinal as EstadoPedido,
                total,
                quitado,
                quitado,
              );
              // The FOB residue: the reconcile relabels ONLY because the pedido's
              // total carries the buyer-paid freight the note (and so the
              // pagamento) excludes — against the note's total it holds.
              if (
                proximo !== null &&
                nomeCenario === 'fob-frete' &&
                nextPedidoEstado(
                  estadoFinal as EstadoPedido,
                  roundReais(total - FRETE_FOB),
                  quitado,
                  quitado,
                ) === null
              ) {
                residuosFob.push(rotulo);
                continue;
              }
              if (proximo !== null && statusFinal !== null && FORA_DA_ESCADA.has(statusFinal)) {
                residuosForaDaEscada.push(rotulo);
                continue;
              }
              expect(proximo, rotulo).toBeNull();
            }
          }
        }
      }
    }
    // Anti-vacuity: most rows decide something, at both clocks.
    expect(decididas).toBeGreaterThanOrEqual(100);
    expect(iguais).toBeGreaterThanOrEqual(30);
    // Residue 1, BY NAME: an operator's NON-paying off-ladder status beside
    // Amazon's approval. The import moves a pre-approval pedido to pago (5-c's
    // table reads no pagamento there) and never walks the operator's status, so
    // the Pagamentos tab's reconcile would relabel it, and the next import
    // re-promote it. The operator owns that money; nothing else reaches this.
    expect(residuosForaDaEscada.sort()).toEqual(
      Object.keys(CENARIOS)
        .flatMap((c) => ['pendente', 'reetiquetado'].map((p) => `${c} × ${p}`))
        .flatMap((cp) =>
          ['devolvido', 'estornado_parcialmente', 'recusado'].map((s) => `${cp} × ${s}`),
        )
        .flatMap((cps) => ['SHIPPED', 'UNSHIPPED'].map((st) => `${cps} × ${st}`))
        .flatMap((linha) => Object.keys(RELOGIOS).map((rel) => `${linha} × ${rel}`))
        .sort(),
    );
    // Residue 2, BY NAME — the FOB rule (2026-10-21) against the shared reconcile,
    // an OWNER DECISION this PR does not take: under FOB with buyer-paid shipping
    // the pagamento states the note's total (freight excluded) while the pedido's
    // valorCobrado (the shared derive) still carries the freight, so a pagamento
    // edit on the Pagamentos tab relabels the pedido and the next import
    // re-promotes it. Only the FOB scenario, only a paying pagamento beside pago.
    expect(residuosFob.sort()).toEqual(RESIDUO_FOB_ESPERADO);
    // The D17 blocks the table meets, BY NAME: an approved pedido still to ship
    // whose stored line the schema refuses diverges (row 10), and a block writes
    // no pagamento — on every stored status, at both clocks.
    expect(bloqueios.sort()).toEqual(
      Object.keys(CENARIOS)
        .flatMap((c) =>
          [
            'aprovado',
            'ausente',
            'devolvido',
            'em_disputa',
            'estornado',
            'estornado_parcialmente',
            'recusado',
          ].map((pg) => `${c} × ilegivel × ${pg} × UNSHIPPED`),
        )
        .flatMap((linha) => Object.keys(RELOGIOS).map((rel) => `${linha} × ${rel}`))
        .sort(),
    );
  });

  it('★ CANCELLED: a stored aprovado ⇒ estornado + dataCancelamento beside estornadoIntegralmente; a PENDING pedido with none ⇒ cancelado and NO pagamento', () => {
    const r = montar(
      PAGO(),
      { status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(60) },
      { pagamento: pagamentoCriado() },
    );
    expect(patchDe(r).estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(pagamentoDe(r)).toMatchObject({
      tipo: 'atualizar',
      patch: {
        status_pagamento: STATUS_PAGAMENTO.estornado,
        dataCancelamento: ATUALIZADO_US + 60_000_000,
      },
    });
    const pendente = montar(PENDENTE(), {
      status: 'CANCELLED',
      linhas: DUAS,
      atualizadoEm: depois(60),
    });
    expect(patchDe(pendente).estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(pagamentoDe(pendente)).toEqual({ tipo: 'nada' });
  });

  it('★ CANCELLED on a stored pago WITHOUT a pagamento (the legacy shape) ⇒ cancelado, and none created', () => {
    const r = montar(PAGO(), { status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(60) });
    expect(patchDe(r).estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(pagamentoDe(r)).toEqual({ tipo: 'nada' });
  });

  it('★ an operator’s em_disputa + CANCELLED ⇒ cancelado + pagamento-divergente, the pagamento untouched; an operator’s recusado is never moved', () => {
    const disputa = montar(
      PAGO(),
      { status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(60) },
      { pagamento: pagamentoCriado({}, { status_pagamento: STATUS_PAGAMENTO.em_disputa }) },
    );
    expect(patchDe(disputa).estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(decisao(disputa).incidentes).toEqual(['pagamento-divergente']);
    expect(pagamentoDe(disputa)).toEqual({ tipo: 'nada' });
    for (const status of ['UNSHIPPED', 'SHIPPED', 'CANCELLED', 'PENDING']) {
      const recusado = montar(
        PAGO(),
        { status, linhas: DUAS, atualizadoEm: depois(60) },
        { pagamento: pagamentoCriado({}, { status_pagamento: STATUS_PAGAMENTO.recusado }) },
      );
      expect(pagamentoDe(recusado), status).toEqual({ tipo: 'nada' });
      expect(decisao(recusado).statusPagamento, status).toBe(STATUS_PAGAMENTO.recusado);
    }
  });

  it('★ an ERP-side cancel is never reopened, and its pagamento is not walked back: stored cancelado + estornado + a newer UNSHIPPED ⇒ both kept', () => {
    const r = montar(
      PAGO({ estado: ESTADO_PEDIDO.cancelado }),
      { status: 'UNSHIPPED', linhas: DUAS, atualizadoEm: depois(60) },
      { pagamento: pagamentoCriado({}, { status_pagamento: STATUS_PAGAMENTO.estornado }) },
    );
    expect(decisao(r).estadoEscrito).toBeNull();
    expect(pagamentoDe(r)).toEqual({ tipo: 'nada' });
  });

  it('★ an Amazon-side cancel resurrected by a newer read: estornadoIntegralmente → pago AND estornado → aprovado together (logged); an equal clock moves neither', () => {
    const cancelado = PAGO({
      estado: ESTADO_PEDIDO.estornadoIntegralmente,
      marketplace: { tipo: 'amazon', status: 'CANCELLED' },
    });
    const estornado = pagamentoCriado({}, { status_pagamento: STATUS_PAGAMENTO.estornado });
    const novo = montar(
      cancelado,
      { status: 'UNSHIPPED', linhas: DUAS, atualizadoEm: depois(60) },
      { pagamento: estornado },
    );
    expect(patchDe(novo).estado).toBe(ESTADO_PEDIDO.pago);
    expect(pagamentoDe(novo)).toMatchObject({
      patch: { status_pagamento: STATUS_PAGAMENTO.aprovado },
    });
    expect(decisao(novo).eventos).toEqual(
      expect.arrayContaining(['ressuscitado', 'pagamento-ressuscitado']),
    );
    const igual = montar(
      cancelado,
      { status: 'UNSHIPPED', linhas: DUAS },
      { pagamento: estornado },
    );
    expect(decisao(igual).estadoEscrito).toBeNull();
    expect(pagamentoDe(igual)).toEqual({ tipo: 'nada' });
  });

  it('★ the pair at an EQUAL clock: an operator’s refund the reconcile relabelled (aguardando + estornado), met by the same read ⇒ BOTH kept (motivo terminal); a strictly newer read moves both (NEAR-MISS)', () => {
    const reetiquetado = PAGO({ estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento });
    const estornado = pagamentoCriado({}, { status_pagamento: STATUS_PAGAMENTO.estornado });
    const igual = montar(
      reetiquetado,
      { status: 'UNSHIPPED', linhas: DUAS },
      { pagamento: estornado },
    );
    expect(decisao(igual)).toMatchObject({
      estadoEscrito: null,
      motivoEstado: 'terminal',
      statusPagamento: STATUS_PAGAMENTO.estornado,
    });
    expect(pagamentoDe(igual)).toEqual({ tipo: 'nada' });
    // A stored pago beside it (the reconcile has not run): not resurrected either.
    const pago = montar(PAGO(), { status: 'UNSHIPPED', linhas: DUAS }, { pagamento: estornado });
    expect(pagamentoDe(pago)).toEqual({ tipo: 'nada' });
    expect(decisao(pago).statusPagamento).toBe(STATUS_PAGAMENTO.estornado);
    // NEAR-MISS: a strictly newer read resurrects the pagamento, and the pedido moves with it.
    for (const pedido of [reetiquetado, PAGO()]) {
      const novo = montar(
        pedido,
        { status: 'UNSHIPPED', linhas: DUAS, atualizadoEm: depois(60) },
        { pagamento: estornado },
      );
      expect(pagamentoDe(novo)).toMatchObject({
        patch: { status_pagamento: STATUS_PAGAMENTO.aprovado },
      });
      expect(decisao(novo).statusPagamento).toBe(STATUS_PAGAMENTO.aprovado);
    }
    expect(
      decisao(
        montar(
          reetiquetado,
          { status: 'UNSHIPPED', linhas: DUAS, atualizadoEm: depois(60) },
          { pagamento: estornado },
        ),
      ).estadoEscrito,
    ).toBe(ESTADO_PEDIDO.pago);
  });

  it('★ a reversal never writes pago beside a pagamento that stays estornado: relabelled aguardando + estornado + a newer SHIPPED with a returned package ⇒ the estado kept; NEAR-MISS: an aprovado pagamento moves it to pago', () => {
    const reetiquetado = PAGO({ estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento });
    const leitura = {
      status: 'SHIPPED',
      pacotes: ['RETURNED_TO_SELLER'],
      linhas: DUAS,
      atualizadoEm: depois(60),
    };
    const estornado = montar(reetiquetado, leitura, {
      pagamento: pagamentoCriado({}, { status_pagamento: STATUS_PAGAMENTO.estornado }),
    });
    expect(decisao(estornado)).toMatchObject({
      itens: 'itens-preservados-reversao',
      estadoEscrito: null,
      motivoEstado: 'terminal',
      statusPagamento: STATUS_PAGAMENTO.estornado,
    });
    const aprovado = montar(reetiquetado, leitura, { pagamento: pagamentoCriado() });
    expect(decisao(aprovado)).toMatchObject({
      estadoEscrito: ESTADO_PEDIDO.pago,
      statusPagamento: STATUS_PAGAMENTO.aprovado,
    });
  });

  it('★ the printed-request cancel moves the pagamento with the estado (estornado beside estornadoIntegralmente), even when a line divergence blocks', () => {
    const impresso = PAGO({ foiImpresso: true });
    const comR = [
      linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true }),
      linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
    ];
    const r = montar(
      impresso,
      { status: 'UNSHIPPED', linhas: comR, atualizadoEm: depois(60) },
      { pagamento: pagamentoCriado() },
    );
    expect(patchDe(r).estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(pagamentoDe(r)).toMatchObject({
      patch: { status_pagamento: STATUS_PAGAMENTO.estornado },
    });
    const divergente = [
      linhaAmazon('L1', { qtd: 3, preco: '10.00', solicitacao: true }),
      linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
    ];
    const bloqueado = montar(
      impresso,
      { status: 'UNSHIPPED', linhas: divergente, atualizadoEm: depois(60) },
      { pagamento: pagamentoCriado() },
    );
    expect(decisao(bloqueado).bloqueio).not.toBeNull();
    expect(pagamentoDe(bloqueado)).toMatchObject({
      patch: { status_pagamento: STATUS_PAGAMENTO.estornado },
    });
  });
});

describe('★ PR 6 — the pagamento terms of D17', () => {
  /** A stored pagamento THIS importer wrote, `valor` 25 (= DUAS). */
  const NOSSO = () => pagamentoCriado();

  it('★ PENDING ⇒ no pagamento, whatever the executions say', () => {
    expect(pagamentoDe(montar(null, { status: 'PENDING', linhas: DUAS }))).toEqual({
      tipo: 'nada',
    });
    expect(
      pagamentoDe(
        montar(PENDENTE(), { status: 'PENDING', linhas: DUAS, atualizadoEm: depois(60) }),
      ),
    ).toEqual({ tipo: 'nada' });
  });

  it('★ PENDING never creates a pagamento — not even beside a stored pago that has none (the legacy shape), where the estado ladder keeps pago; NEAR-MISS: UNSHIPPED creates it at aprovado', () => {
    for (const status of ['PENDING', 'PENDING_AVAILABILITY']) {
      const leitura = { status, linhas: DUAS, atualizadoEm: depois(60) };
      const r = montar(PAGO(), leitura);
      expect(decisao(r).motivoEstado, status).toBe('regressivo');
      expect(pagamentoDe(r), status).toEqual({ tipo: 'nada' });
      expect(decisao(r).statusPagamento, status).toBeNull();
      // A stored aprovado one is left exactly as it is.
      expect(
        pagamentoDe(montar(PAGO(), leitura, { pagamento: pagamentoCriado() })),
        status,
      ).toEqual({ tipo: 'nada' });
    }
    const aprovado = montar(PAGO(), {
      status: 'UNSHIPPED',
      linhas: DUAS,
      atualizadoEm: depois(60),
    });
    expect(pagamentoDe(aprovado)).toMatchObject({
      tipo: 'criar',
      corpo: { status_pagamento: STATUS_PAGAMENTO.aprovado, valor: 25 },
    });
  });

  it('★ an approved pedido WITHOUT a pagamento whose stored line the schema refuses: no total to state ⇒ none created, no status claimed, and pagamento-divergente; NEAR-MISS: readable lines create it', () => {
    const leitura = { status: 'SHIPPED', linhas: DUAS, atualizadoEm: depois(60) };
    const ilegivel = montar(comLinhaIlegivel(PAGO({ marketplace: null })), leitura);
    expect(pagamentoDe(ilegivel)).toEqual({ tipo: 'nada' });
    expect(decisao(ilegivel).statusPagamento).toBeNull();
    expect(decisao(ilegivel).incidentes).toContain('pagamento-divergente');
    const legivel = montar(PAGO({ marketplace: null }), leitura);
    expect(pagamentoDe(legivel)).toMatchObject({ tipo: 'criar', corpo: { valor: 25 } });
    expect(decisao(legivel).statusPagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(decisao(legivel).incidentes).not.toContain('pagamento-divergente');
  });

  it('★ an approved create: Σ = the total ⇒ Σ, nothing filed (EQUAL); one centavo SHORT ⇒ the total + pagamento-divergente, and the reconcile stays put (NEAR-MISS); ABOVE ⇒ Σ + the incidente', () => {
    const com = (valor: string) =>
      montar(null, { linhas: DUAS, pagamento: [execucaoAmazon('CreditCard', valor)] });
    const igual = com('25.00');
    expect(pagamentoDe(igual)).toMatchObject({ tipo: 'criar', corpo: { valor: 25 } });
    expect(decisao(igual).incidentes).toEqual([]);
    const curto = com('24.99');
    expect(pagamentoDe(curto)).toMatchObject({ corpo: { valor: 25 } });
    expect(decisao(curto).incidentes).toEqual(['pagamento-divergente']);
    expect(nextPedidoEstado(ESTADO_PEDIDO.pago, 25, 25, 25)).toBeNull();
    // What the short sum would have done: relabel the pedido.
    expect(nextPedidoEstado(ESTADO_PEDIDO.pago, 25, 24.99, 24.99)).not.toBeNull();
    const acima = com('25.01');
    expect(pagamentoDe(acima)).toMatchObject({ corpo: { valor: 25.01 } });
    expect(decisao(acima).incidentes).toEqual(['pagamento-divergente']);
  });

  it('★ reversed (CANCELLED) with the amount zeroed ⇒ the status moves, the valor is KEPT — even one the derive would now state differently', () => {
    for (const valor of [25, 30]) {
      const r = montar(
        PAGO(),
        {
          status: 'CANCELLED',
          linhas: DUAS,
          atualizadoEm: depois(60),
          pagamento: [execucaoAmazon('CreditCard', '0.00')],
        },
        { pagamento: { ...NOSSO(), valor } },
      );
      const p = pagamentoDe(r);
      expect(p, String(valor)).toMatchObject({
        patch: { status_pagamento: STATUS_PAGAMENTO.estornado },
      });
      expect(p.tipo === 'atualizar' && Object.hasOwn(p.patch, 'valor'), String(valor)).toBe(false);
    }
  });

  it('★ Z by the payment: SHIPPED with intact lines but the executions zeroed while the stored valor is positive ⇒ a reversal (row 4): lines, money, status and valor kept', () => {
    const r = montar(
      PAGO(),
      {
        status: 'SHIPPED',
        linhas: DUAS,
        atualizadoEm: depois(60),
        pagamento: [execucaoAmazon('CreditCard', '0.00')],
      },
      { pagamento: NOSSO() },
    );
    expect(decisao(r)).toMatchObject({
      itens: 'itens-preservados-reversao',
      incidentes: ['possivel-reembolso'],
    });
    expect(pagamentoDe(r)).toEqual({ tipo: 'nada' });
    // NEAR-MISS: the same SHIPPED read paying the stored valor is no reversal.
    const pago = montar(
      PAGO(),
      { status: 'SHIPPED', linhas: DUAS, atualizadoEm: depois(60) },
      { pagamento: NOSSO() },
    );
    expect(decisao(pago).itens).toBe('mantidas');
  });

  it('★ approved, still to ship: a changed DERIVED valor ⇒ the blocking divergence, our error, NO pagamento write; unchanged ⇒ no write at all', () => {
    const mudou = montar(
      PAGO(),
      {
        status: 'UNSHIPPED',
        linhas: DUAS,
        atualizadoEm: depois(60),
        pagamento: [execucaoAmazon('CreditCard', '30.00')],
      },
      { pagamento: NOSSO() },
    );
    expect(decisao(mudou)).toMatchObject({
      itens: 'divergencia-itens-aprovado',
      bloqueio: { causa: 'pagamento', linhas: [] },
      avisos: ['divergencia-itens'],
    });
    expect(patchDe(mudou)).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: `${PREFIXO_ERRO_AMAZON}valor do pagamento divergente do pedido na Amazon`,
    });
    expect(pagamentoDe(mudou)).toEqual({ tipo: 'nada' });
    const igual = montar(PAGO(), { status: 'UNSHIPPED', linhas: DUAS }, { pagamento: NOSSO() });
    expect(igual.tipo).toBe('sem-mudanca');
    expect(pagamentoDe(igual)).toEqual({ tipo: 'nada' });
  });

  it('★ derived against derived: a SHORT sum covered by the total never reads as a change (NEAR-MISS to the raw sum)', () => {
    const curto = montar(
      PAGO(),
      {
        status: 'UNSHIPPED',
        linhas: DUAS,
        atualizadoEm: depois(60),
        pagamento: [execucaoAmazon('CreditCard', '20.00')],
      },
      { pagamento: NOSSO() },
    );
    expect(decisao(curto).bloqueio).toBeNull();
    expect(decisao(curto).itens).toBe('mantidas');
  });

  it('★ a line divergence writes no pagamento — not even the create a pedido without one would get', () => {
    const r = montar(PAGO(), {
      status: 'UNSHIPPED',
      linhas: [
        linhaAmazon('L1', { qtd: 3, preco: '10.00' }),
        linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
      ],
      atualizadoEm: depois(60),
    });
    expect(decisao(r).itens).toBe('divergencia-itens-aprovado');
    expect(pagamentoDe(r)).toEqual({ tipo: 'nada' });
  });

  it('★ a pagamento this importer never wrote (the legacy’s, no lastProviderUpdate) is ADOPTED once — never compared, never blocking', () => {
    const legado = {
      id: '171-9876543-2109876',
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      forma_de_pagamento: 99,
      descricaoPagamento: 'texto antigo',
      cartao: null,
      // The legacy's own total (a different freight rule).
      valor: 33,
    };
    const r = montar(
      PAGO(),
      { status: 'UNSHIPPED', linhas: DUAS, atualizadoEm: depois(60) },
      { pagamento: legado },
    );
    expect(decisao(r).bloqueio).toBeNull();
    expect(pagamentoDe(r)).toMatchObject({
      tipo: 'atualizar',
      patch: { valor: 25, forma_de_pagamento: 3, lastProviderUpdate: ATUALIZADO_US + 60_000_000 },
    });
    // NEAR-MISS: the same stored valor on a pagamento WE wrote is a divergence.
    const nosso = montar(
      PAGO(),
      { status: 'UNSHIPPED', linhas: DUAS, atualizadoEm: depois(60) },
      { pagamento: { ...NOSSO(), valor: 33 } },
    );
    expect(decisao(nosso).bloqueio).toMatchObject({ causa: 'pagamento' });
  });

  it('split legs, an unknown forma and a refused acquirer reach the pedido’s incidentes and events', () => {
    const r = montar(null, {
      linhas: DUAS,
      pagamento: [
        execucaoAmazon('GC', '20.00', { acquirerId: '12345678' }),
        execucaoAmazon('CreditCard', '5.00', { acquirerId: '12345678' }),
      ],
    });
    expect(decisao(r).incidentes).toEqual(['forma-pagamento-desconhecida', 'pagamento-dividido']);
    const comCartao = montar(null, {
      linhas: DUAS,
      pagamento: [execucaoAmazon('CreditCard', '25.00', { acquirerId: '12345678' })],
    });
    expect(decisao(comCartao).eventos).toContain('cnpj-instituicao-recusado');
  });
});
