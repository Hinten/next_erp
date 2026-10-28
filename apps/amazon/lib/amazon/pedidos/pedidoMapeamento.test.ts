import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { roundReais } from '@delfrance/core/money';
import { nextPedidoEstado } from '@delfrance/data/pedido';
import {
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  freteDoPedidoSchema,
  STATUS_PAGAMENTO,
  isPagamentoPagante,
  itemDoPedidoSchema,
  motivoPedidoAmazonSchema,
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
  pacoteAmazon,
  pedidoAmazon,
  type OpcoesLinhaTeste,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import { EVENTO_PEDIDO_AMAZON } from './codigosPedidoAmazon';
import { PedidoAmazonIlegivelError } from './erros';
import { PREFIXO_ERRO_AMAZON, TEXTO_ERRO_AMAZON } from './estadoPedidoAmazon';
import { motivosDoPedidoAmazon } from './importarPedido';
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

/**
 * PR 7: an order still to ship whose read carries no package and no invoice
 * status counts one `nota-fiscal-nao-informada` line (no freight change, never
 * a guess) — the default test order is exactly that.
 */
const SEM_NOTA = 'nota-fiscal-nao-informada';

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
    // An approved pedido WITH its pagamento (the ordinary shape; PR 5-f pins the
    // one without a pagamento in its own suite at the end of this file).
    const pagamento = pagamentoCriado();
    const p = montar(
      PAGO(),
      {
        status: 'SHIPPED',
        pacotes: ['RETURNED_TO_SELLER'],
        linhas: [linhaAmazon('L1', { qtd: 0, preco: '0.00' })],
      },
      { pagamento },
    );
    expect(decisao(p)).toMatchObject({
      itens: 'itens-preservados-reversao',
      incidentes: ['possivel-reembolso'],
    });
    const x = montar(
      PAGO(),
      {
        status: 'SHIPPED',
        linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', execucao: true }), DUAS[1] ?? {}],
      },
      { pagamento },
    );
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
    expect(decisao(preenchido)).toMatchObject({
      itens: 'mantidas',
      eventos: [SEM_NOTA, 'preco-preenchido'],
    });
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
      eventos: ['cancelamento-parcial', SEM_NOTA],
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
      eventos: ['cancelamento-parcial', SEM_NOTA],
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
      eventos: ['cancelamento-parcial', SEM_NOTA],
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
      eventos: ['cancelamento-parcial', SEM_NOTA],
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
    expect(decisao(vivo)).toMatchObject({ eventos: [SEM_NOTA, 'ressuscitado'], avisos: [] });
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

describe('★ PR 5-f — a status this code does not know never replaces a stored KNOWN one (the D17 lock and the resurrection discriminator survive it)', () => {
  /** The divergent read of the C1 probe: L1 qty 2 → 1, L2 unchanged. */
  const DIVERGENTES = [linhaAmazon('L1', { qtd: 1, preco: '10.00' }), DUAS[1] ?? {}];
  const JANELAS = {
    shipByWindow: { latestDateTime: '2026-10-03T23:59:59Z' },
    deliverByWindow: { latestDateTime: '2026-10-08T23:59:59Z' },
  };
  /**
   * Every read whose `fulfillmentStatus` this code does not know: the token the
   * migration guide maps from v0 (absent from the v2026 enum), any other token
   * (a known one in another case included — membership is exact), an explicit
   * `null`, a blank, the key absent, and no `fulfillment` object at all.
   */
  const DESCONHECIDAS: readonly (readonly [string, OpcoesPedidoTeste])[] = [
    ['INVOICE_UNCONFIRMED', { status: 'INVOICE_UNCONFIRMED' }],
    ['another token', { status: 'SOMETHING_NEW' }],
    ['a known token in lower case', { status: 'unshipped' }],
    [
      'null',
      {
        extra: { fulfillment: { fulfillmentStatus: null, fulfilledBy: 'MERCHANT', ...JANELAS } },
      },
    ],
    ['blank', { status: '   ' }],
    ['the key absent', { status: null }],
    ['no fulfillment object', { semFulfillment: true }],
  ];

  /** `doc` once `r` lands (a `sem-mudanca` leaves it as it is). */
  const depoisDe = (doc: Doc, r: EscritaPedidoAmazon): Doc =>
    r.tipo === 'atualizar' ? { ...doc, ...r.patch } : doc;

  /** A pago pedido, then the divergent UNSHIPPED read: row 10's BLOCK, status UNSHIPPED stored. */
  function bloqueado(): Doc {
    const r = montar(PAGO(), { linhas: DIVERGENTES, atualizadoEm: depois(60) });
    expect(decisao(r)).toMatchObject({ linhaD17: 10, itens: 'divergencia-itens-aprovado' });
    const doc = aplicar(PAGO(), r);
    expect(doc).toMatchObject({ estado: 'error', marketplace: { status: 'UNSHIPPED' } });
    return doc;
  }

  for (const [nome, leitura] of DESCONHECIDAS) {
    it(`★ ${nome} between the block and the next read keeps the block: UNSHIPPED ⇒ row 10 again, SHIPPED ⇒ row 11 — never row 9's mirror`, () => {
      const bloco = bloqueado();
      const meio = montar(bloco, { ...leitura, linhas: DIVERGENTES, atualizadoEm: depois(120) });
      expect(decisao(meio)).toMatchObject({
        linhaD17: 13,
        itens: 'mantidas',
        motivoEstado: 'manter',
      });
      // The aviso still comes from the read.
      expect(decisao(meio).avisos).toContain('status-desconhecido');
      const guardado = depoisDe(bloco, meio);
      expect(guardado).toMatchObject({
        estado: 'error',
        error: bloco.error,
        marketplace: { status: 'UNSHIPPED' },
      });

      // UNSHIPPED with the same lines: still the approved comparison (row 10), still blocked.
      const aEnviar = montar(guardado, { linhas: DIVERGENTES, atualizadoEm: depois(180) });
      expect(decisao(aEnviar)).toMatchObject({
        linhaD17: 10,
        itens: 'divergencia-itens-aprovado',
        avisos: ['divergencia-itens'],
        bloqueio: { causa: 'itens', linhas: ['L1'] },
        estadoEscrito: null,
      });
      const depoisAEnviar = depoisDe(guardado, aEnviar);
      // The probe's outcome is gone: no mirror, no pago, the block text and the money intact.
      expect(depoisAEnviar).toMatchObject({
        estado: 'error',
        error: bloco.error,
        valorCobrado: 25,
      });
      expect(linhasDo(depoisAEnviar)).toEqual(linhasDo(PAGO()));
      // Exactly what the same read decides straight over the block (the control).
      expect(decisao(aEnviar)).toEqual(
        decisao(montar(bloco, { linhas: DIVERGENTES, atualizadoEm: depois(180) })),
      );

      // SHIPPED with the same lines: row 11 keeps the stored lines, as over the block.
      const enviado = montar(guardado, {
        status: 'SHIPPED',
        linhas: DIVERGENTES,
        atualizadoEm: depois(180),
      });
      expect(decisao(enviado)).toMatchObject({ linhaD17: 11, itens: 'mantidas' });
      expect(Object.hasOwn(patchDe(enviado), 'itens')).toBe(false);
      expect(Object.hasOwn(patchDe(enviado), 'valorCobrado')).toBe(false);
      expect(decisao(enviado)).toEqual(
        decisao(
          montar(bloco, { status: 'SHIPPED', linhas: DIVERGENTES, atualizadoEm: depois(180) }),
        ),
      );
    });
  }

  it('★ the PAGAMENTO block too (row 10’s valor term): INVOICE_UNCONFIRMED or no fulfillment in between ⇒ still blocked, no pagamento written', () => {
    const pagamento = [execucaoAmazon('CreditCard', '30.00')];
    const nosso = pagamentoCriado();
    const r = montar(
      PAGO(),
      { linhas: DUAS, atualizadoEm: depois(60), pagamento },
      { pagamento: nosso },
    );
    expect(decisao(r).bloqueio).toEqual({ causa: 'pagamento', linhas: [] });
    const bloco = aplicar(PAGO(), r);
    for (const leitura of [{ status: 'INVOICE_UNCONFIRMED' }, { semFulfillment: true }]) {
      const rotulo = JSON.stringify(leitura);
      const meio = montar(
        bloco,
        { ...leitura, linhas: DUAS, atualizadoEm: depois(120), pagamento },
        { pagamento: nosso },
      );
      expect(pagamentoDe(meio), rotulo).toEqual({ tipo: 'nada' });
      const final = montar(
        depoisDe(bloco, meio),
        { linhas: DUAS, atualizadoEm: depois(180), pagamento },
        { pagamento: nosso },
      );
      expect(decisao(final), rotulo).toMatchObject({
        linhaD17: 10,
        bloqueio: { causa: 'pagamento', linhas: [] },
        estadoEscrito: null,
        motivoEstado: 'sem-mudanca',
      });
      expect(pagamentoDe(final), rotulo).toEqual({ tipo: 'nada' });
    }
  });

  it('★ the keep is the STATUS alone: the same unknown read still writes the clock and every other marketplace field (NEAR-MISS on scope)', () => {
    const r = montar(PAGO(), {
      status: 'INVOICE_UNCONFIRMED',
      linhas: DUAS,
      invoiceStatus: 'ACCEPTED',
      programs: ['BUSINESS'],
      atualizadoEm: depois(60),
    });
    expect(patchDe(r)).toMatchObject({
      lastMarketplaceUpdate: ATUALIZADO_US + 60_000_000,
      marketplace: {
        tipo: 'amazon',
        status: 'UNSHIPPED',
        statusEm: ATUALIZADO_US + 60_000_000,
        invoiceStatus: 'ACCEPTED',
        programs: ['BUSINESS'],
        fulfilledBy: 'MERCHANT',
      },
    });
    const semFulfillment = montar(PAGO(), {
      semFulfillment: true,
      linhas: DUAS,
      atualizadoEm: depois(60),
    });
    expect(patchDe(semFulfillment).marketplace).toMatchObject({
      status: 'UNSHIPPED',
      fulfilledBy: null,
    });
  });

  it('★ an EQUAL redelivery of that unknown read once it landed ⇒ sem-mudanca (the comparator reads the block as it will be stored, never the raw read)', () => {
    for (const [nome, leitura] of DESCONHECIDAS) {
      const r = montar(PAGO(), { ...leitura, linhas: DUAS, atualizadoEm: depois(60) });
      const doc = depoisDe(PAGO(), r);
      expect(doc.marketplace, nome).toMatchObject({ status: 'UNSHIPPED' });
      expect(montar(doc, { ...leitura, linhas: DUAS, atualizadoEm: depois(60) }).tipo, nome).toBe(
        'sem-mudanca',
      );
    }
  });

  it('NEAR-MISS — a KNOWN status still replaces a known one', () => {
    for (const status of ['SHIPPED', 'PARTIALLY_SHIPPED', 'CANCELLED', 'PENDING']) {
      const r = montar(PAGO(), { status, linhas: DUAS, atualizadoEm: depois(60) });
      expect(patchDe(r).marketplace, status).toMatchObject({ status });
    }
    const aprovado = montar(PENDENTE(), { linhas: DUAS, atualizadoEm: depois(60) });
    expect(patchDe(aprovado).marketplace).toMatchObject({ status: 'UNSHIPPED' });
    // …and over the block: SHIPPED is written (row 11 reads it next time).
    const enviado = montar(bloqueado(), {
      status: 'SHIPPED',
      linhas: DIVERGENTES,
      atualizadoEm: depois(120),
    });
    expect(patchDe(enviado).marketplace).toMatchObject({ status: 'SHIPPED' });
  });

  it('NEAR-MISS — a create records an unknown status as it arrives (there is no known one to keep)', () => {
    expect(criado({ status: 'INVOICE_UNCONFIRMED', linhas: DUAS })).toMatchObject({
      estado: 'error',
      marketplace: { status: 'INVOICE_UNCONFIRMED' },
    });
    expect(criado({ status: null, linhas: DUAS })).toMatchObject({ marketplace: { status: null } });
    expect(criado({ semFulfillment: true, linhas: DUAS })).toMatchObject({
      marketplace: { status: null },
    });
  });

  it('NEAR-MISS — an unknown or absent status still replaces a stored unknown or absent one, as before', () => {
    const desconhecido = criado({ status: 'INVOICE_UNCONFIRMED', linhas: DUAS });
    for (const status of ['SOMETHING_NEW', null]) {
      const r = montar(desconhecido, { status, linhas: DUAS, atualizadoEm: depois(60) });
      expect(patchDe(r).marketplace, String(status)).toMatchObject({ status });
    }
    const semStatus = criado({ status: null, linhas: DUAS });
    expect(
      patchDe(
        montar(semStatus, {
          status: 'INVOICE_UNCONFIRMED',
          linhas: DUAS,
          atualizadoEm: depois(60),
        }),
      ).marketplace,
    ).toMatchObject({ status: 'INVOICE_UNCONFIRMED' });
    // A stored status in another case is no KNOWN one either (exact membership, no fold).
    const minusculo = PAGO({
      marketplace: { ...(PAGO().marketplace as Doc), status: 'unshipped' },
    });
    expect(
      patchDe(
        montar(minusculo, {
          status: 'INVOICE_UNCONFIRMED',
          linhas: DUAS,
          atualizadoEm: depois(60),
        }),
      ).marketplace,
    ).toMatchObject({ status: 'INVOICE_UNCONFIRMED' });
    // A stored block without a status key holds no known one.
    const semChave = { ...(PAGO().marketplace as Doc) };
    delete semChave.status;
    expect(
      patchDe(
        montar(
          { ...PAGO(), marketplace: semChave },
          { status: 'INVOICE_UNCONFIRMED', linhas: DUAS, atualizadoEm: depois(60) },
        ),
      ).marketplace,
    ).toMatchObject({ status: 'INVOICE_UNCONFIRMED' });
  });

  it('★ the resurrection discriminator survives too: Amazon’s CANCELLED, an unknown read, then a strictly newer UNSHIPPED ⇒ ressuscitado, never cancelado-so-no-erp; NEAR-MISS: an ERP-side cancel stays kept + cancelado-so-no-erp', () => {
    const amazonCancelou = PAGO({
      estado: 'cancelado',
      marketplace: { ...(PAGO().marketplace as Doc), status: 'CANCELLED' },
    });
    for (const [nome, leitura] of DESCONHECIDAS) {
      const meio = montar(amazonCancelou, { ...leitura, linhas: DUAS, atualizadoEm: depois(60) });
      const guardado = depoisDe(amazonCancelou, meio);
      expect(guardado, nome).toMatchObject({
        estado: 'cancelado',
        marketplace: { status: 'CANCELLED' },
      });
      const vivo = montar(guardado, { linhas: DUAS, atualizadoEm: depois(120) });
      expect(patchDe(vivo).estado, nome).toBe('pago');
      expect(decisao(vivo).avisos, nome).toEqual([]);
      expect(decisao(vivo).eventos, nome).toContain('ressuscitado');
    }
    const erpCancelou = PAGO({ estado: 'cancelado' });
    const meio = montar(erpCancelou, {
      status: 'INVOICE_UNCONFIRMED',
      linhas: DUAS,
      atualizadoEm: depois(60),
    });
    const r = montar(depoisDe(erpCancelou, meio), { linhas: DUAS, atualizadoEm: depois(120) });
    expect(Object.hasOwn(patchDe(r), 'estado')).toBe(false);
    expect(decisao(r).avisos).toEqual(['cancelado-so-no-erp']);
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

/* -------------------------------------------------------------------------- */
/*                     ★ PR 7 — Easy Ship packages → freteInicial              */
/* -------------------------------------------------------------------------- */

describe('★ PR 7 — the freight group: packages → freteInicial, inside the same decision', () => {
  /** A stored PAGO pedido (UNSHIPPED, invoice ACCEPTED) whose freight block holds `over`. */
  const comFreteGuardado = (over: Doc, opcoes: OpcoesPedidoTeste = {}): Doc => {
    const doc = criado({ linhas: DUAS, invoiceStatus: 'ACCEPTED', ...opcoes });
    return { ...doc, freteInicial: { ...(doc.freteInicial as Doc), ...over } };
  };
  const freteDo = (r: EscritaPedidoAmazon): Doc | null => {
    if (r.tipo === 'criar') return r.corpo.freteInicial as Doc;
    if (r.tipo === 'atualizar' && Object.hasOwn(r.patch, 'freteInicial')) {
      return r.patch.freteInicial as Doc;
    }
    return null;
  };

  it('create: a first-seen SHIPPED order with picked-up packages is created at postado, with its diary and codRastreio', () => {
    const r = montar(null, {
      status: 'SHIPPED',
      linhas: DUAS,
      pacotesBrutos: [
        pacoteAmazon('PKG-B', 'PICKED_UP', { rastreio: 'TRK-B' }),
        pacoteAmazon('PKG-A', 'DROPPED_OFF', { rastreio: 'TRK-A' }),
      ],
    });
    expect(freteDo(r)).toMatchObject({
      estado: 'postado',
      codRastreio: 'TRK-A, TRK-B',
      externalOptionIntegracao: 'amz',
    });
    expect((freteDo(r)?.pacotes as Doc[]).map((l) => [l.numero, l.estado, l.atualizadoEm])).toEqual(
      [
        ['PKG-A', 'postado', ATUALIZADO_US],
        ['PKG-B', 'postado', ATUALIZADO_US],
      ],
    );
  });

  it('create without packages: the invoice status decides (UNSHIPPED + NOT_FOUND ⇒ aguardandoNFe); none at all ⇒ iniciado + one count line', () => {
    expect(freteDo(montar(null, { linhas: DUAS, invoiceStatus: 'NOT_FOUND' }))).toMatchObject({
      estado: 'aguardandoNFe',
    });
    const semNota = montar(null, { linhas: DUAS });
    expect(freteDo(semNota)).toMatchObject({ estado: 'iniciado' });
    expect(Object.hasOwn(freteDo(semNota) ?? {}, 'pacotes')).toBe(false);
    expect(decisao(semNota).eventos).toEqual([SEM_NOTA]);
    expect(decisao(montar(null, { linhas: DUAS, invoiceStatus: 'NOT_REQUIRED' })).eventos).toEqual([
      'nota-fiscal-nao-exigida',
    ]);
  });

  it('★ an EQUAL-clock delivery carrying a newer package state is APPLIED (the package-only change survives a clock that did not move)', () => {
    const guardado = criado({ linhas: DUAS, invoiceStatus: 'ACCEPTED' });
    expect((guardado.freteInicial as Doc).estado).toBe('aguardandoAgendamento');
    const r = montar(guardado, {
      linhas: DUAS,
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP', { status: 'PENDING' })],
    });
    expect(r.tipo).toBe('atualizar');
    expect(r.tipo === 'atualizar' ? r.grupos : []).toEqual(['frete']);
    expect(freteDo(r)).toMatchObject({ estado: 'aguardandoPostagem' });
    expect((freteDo(r)?.pacotes as Doc[])[0]).toMatchObject({
      numero: 'PKG-1',
      estadoMarketplace: 'PENDING_PICK_UP',
      statusMarketplace: 'PENDING',
      fonte: 'getOrder',
    });
  });

  it('★ an unchanged redelivery ⇒ sem-mudanca (zero writes); ★ one diary field changed at an EQUAL clock ⇒ a non-empty patch (NEAR-MISS)', () => {
    const opcoes: OpcoesPedidoTeste = {
      status: 'SHIPPED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'AT_ORIGIN_FC', { rastreio: 'TRK-1' })],
    };
    const guardado = criado(opcoes);
    expect(montar(guardado, opcoes).tipo).toBe('sem-mudanca');
    const r = montar(guardado, {
      ...opcoes,
      pacotesBrutos: [
        pacoteAmazon('PKG-1', 'AT_ORIGIN_FC', { rastreio: 'TRK-1', status: 'SHIPPED' }),
      ],
    });
    expect(r.tipo).toBe('atualizar');
    expect(Object.keys(freteDo(r) ?? {})).toContain('pacotes');
    expect((freteDo(r)?.pacotes as Doc[])[0]).toMatchObject({ statusMarketplace: 'SHIPPED' });
    expect(freteDo(r)).toMatchObject({ estado: 'recebidoPelaTransportadora' });
  });

  it('★ CANCELLED + stored aguardandoPostagem + an incoming PICKED_UP ⇒ the pedido estado KEPT, freight postado, cancelado-apos-envio (the fold read BEFORE the decision)', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    const r = montar(guardado, {
      status: 'CANCELLED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(Object.hasOwn(patchDe(r), 'estado')).toBe(false);
    expect(decisao(r)).toMatchObject({ motivoEstado: 'manter' });
    expect(decisao(r).incidentes).toContain('cancelado-apos-envio');
    expect(freteDo(r)).toMatchObject({ estado: 'postado' });
  });

  it('★ NEAR-MISS: CANCELLED + stored aguardandoPostagem + PENDING_PICK_UP ⇒ released: cancelado, freight cancelado, no cancelado-apos-envio', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    const r = montar(guardado, {
      status: 'CANCELLED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
    });
    expect(patchDe(r).estado).toBe('cancelado');
    expect(decisao(r).incidentes).not.toContain('cancelado-apos-envio');
    expect(freteDo(r)).toMatchObject({ estado: 'cancelado' });
  });

  it('★ CANCELLED after postado, after objetoExtraviado and after aguardandoRetirada ⇒ KEPT (never cancelado), even with no package in the read', () => {
    for (const estado of ['postado', 'objetoExtraviado', 'aguardandoRetirada'] as const) {
      const r = montar(comFreteGuardado({ estado }), { status: 'CANCELLED', linhas: DUAS });
      expect(Object.hasOwn(patchDe(r), 'estado'), estado).toBe(false);
      expect(decisao(r).incidentes, estado).toContain('cancelado-apos-envio');
      expect(freteDo(r)?.estado ?? estado, estado).toBe(estado);
    }
  });

  it('★ the pair still holds through the fold: CANCELLED + an aprovado pagamento — goods out by the fold ⇒ pago/aprovado kept; goods in ⇒ estornadoIntegralmente/estornado', () => {
    const pagamento = pagamentoCriado({ invoiceStatus: 'ACCEPTED' });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    const fora = montar(
      guardado,
      { status: 'CANCELLED', linhas: DUAS, pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')] },
      { pagamento },
    );
    expect(decisao(fora)).toMatchObject({
      estadoEscrito: null,
      statusPagamento: STATUS_PAGAMENTO.aprovado,
    });
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.aprovado)).toBe(ESTADO_PEDIDO.pago);
    expect(pagamentoDe(fora).tipo).not.toBe('criar');
    const dentro = montar(
      guardado,
      {
        status: 'CANCELLED',
        linhas: DUAS,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
      },
      { pagamento },
    );
    expect(decisao(dentro)).toMatchObject({
      estadoEscrito: ESTADO_PEDIDO.estornadoIntegralmente,
      statusPagamento: STATUS_PAGAMENTO.estornado,
    });
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.estornado)).toBe(
      ESTADO_PEDIDO.estornadoIntegralmente,
    );
  });

  it('★ a migrated fulfillment block on an MFN order: PICKED_UP refused as regressive (rung 11 > 10), AT_DESTINATION_FC written', () => {
    const guardado = comFreteGuardado({ estado: 'fulfillment' });
    const recuo = montar(guardado, {
      status: 'SHIPPED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(freteDo(recuo)?.estado).toBe('fulfillment');
    const avanca = montar(guardado, {
      status: 'SHIPPED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'AT_DESTINATION_FC')],
    });
    expect(freteDo(avanca)?.estado).toBe('aCaminho');
  });

  it('★ a block another modality owns (Melhor Envio) is UNTOUCHED — but the freight motivos are still derived from the order', () => {
    const guardado = comFreteGuardado({
      externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios,
      estado: 'iniciado',
    });
    // The stored block READS (a parseable foreign block, so only the guard can stop a write).
    expect(freteDoPedidoSchema.safeParse(guardado.freteInicial).success).toBe(true);
    const r = montar(guardado, {
      status: 'SHIPPED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP'), pacoteAmazon('PKG-2', 'NEW_TOKEN')],
    });
    expect(freteDo(r)).toBeNull();
    expect(decisao(r).avisos).toContain('pacote-status-desconhecido');
    // NEAR-MISS: a newer read with a moved ship-by deadline still writes nothing there.
    const movido = montar(guardado, {
      status: 'SHIPPED',
      linhas: DUAS,
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP', { rastreio: 'TRK-1' })],
      extra: {
        fulfillment: {
          fulfillmentStatus: 'SHIPPED',
          fulfilledBy: 'MERCHANT',
          shipByWindow: { latestDateTime: '2026-10-05T23:59:59Z' },
        },
      },
    });
    expect(movido.tipo).toBe('atualizar');
    expect(freteDo(movido)).toBeNull();
  });

  it('an AFN order keeps its fulfillment block whatever the packages say', () => {
    const r = montar(null, {
      por: 'AMAZON',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(freteDo(r)?.estado).toBe('fulfillment');
  });

  it('★ LABEL_CANCELLED ⇒ despachoNegado + coleta-cancelada; the reschedule on an EQUAL clock is refused, on a strictly newer one written (frete-ressuscitado), and the motivo is no longer derived', () => {
    const cancelada: OpcoesPedidoTeste = {
      linhas: DUAS,
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'LABEL_CANCELLED')],
    };
    const guardado = criado(cancelada);
    expect((guardado.freteInicial as Doc).estado).toBe('despachoNegado');
    expect(decisao(montar(guardado, cancelada)).avisos).toEqual(['coleta-cancelada']);
    const reagendada: OpcoesPedidoTeste = {
      ...cancelada,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
    };
    const igual = montar(guardado, reagendada);
    expect(freteDo(igual)?.estado).toBe('despachoNegado');
    expect(decisao(igual).avisos).toEqual([]);
    expect(decisao(igual).eventos).not.toContain('frete-ressuscitado');
    const novo = montar(guardado, { ...reagendada, atualizadoEm: depois(60) });
    expect(freteDo(novo)?.estado).toBe('aguardandoPostagem');
    expect(decisao(novo).eventos).toContain('frete-ressuscitado');
  });

  it('★ a LABEL_CANCELLED read AFTER the pickup (stored postado, equal or newer clock) keeps postado — the diary row and coleta-cancelada still land — so a later CANCELLED read with no package never restocks', () => {
    for (const atualizadoEm of [undefined, depois(60)]) {
      const r = montar(comFreteGuardado({ estado: 'postado' }), {
        status: 'SHIPPED',
        linhas: DUAS,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'LABEL_CANCELLED')],
        ...(atualizadoEm === undefined ? {} : { atualizadoEm }),
      });
      expect(freteDo(r)?.estado, String(atualizadoEm)).toBe('postado');
      expect((freteDo(r)?.pacotes as Doc[])[0]).toMatchObject({
        numero: 'PKG-1',
        estado: 'despachoNegado',
        estadoMarketplace: 'LABEL_CANCELLED',
      });
      expect(decisao(r).avisos).toEqual(['coleta-cancelada']);
      const cancelada = montar(comFreteGuardado(freteDo(r) ?? {}), {
        status: 'CANCELLED',
        linhas: DUAS,
      });
      expect(Object.hasOwn(patchDe(cancelada), 'estado')).toBe(false);
      expect(decisao(cancelada).incidentes).toContain('cancelado-apos-envio');
      expect(freteDo(cancelada)?.estado ?? 'postado').toBe('postado');
    }
  });

  /** The stored doc once `r` lands (an empty decision leaves it as it was). */
  const seguir = (doc: Doc, r: EscritaPedidoAmazon): Doc =>
    r.tipo === 'sem-mudanca' ? doc : aplicar(doc, r);
  /** The pedido estado a CANCELLED read KEPT (nothing written, the incidente filed). */
  const mantido = (r: EscritaPedidoAmazon, nome: string) => {
    expect(r.tipo === 'atualizar' ? Object.hasOwn(r.patch, 'estado') : false, nome).toBe(false);
    expect(decisao(r), nome).toMatchObject({ estadoEscrito: null });
    expect(decisao(r).incidentes, nome).toContain('cancelado-apos-envio');
    expect(decisao(r).statusPagamento ?? STATUS_PAGAMENTO.aprovado, nome).toBe(
      STATUS_PAGAMENTO.aprovado,
    );
  };
  /** The CANCELLED predicate RELEASED the goods: the refund, the pagamento, the freight. */
  const liberado = (r: EscritaPedidoAmazon, nome: string) => {
    expect(patchDe(r).estado, nome).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(decisao(r).statusPagamento, nome).toBe(STATUS_PAGAMENTO.estornado);
    expect(decisao(r).incidentes, nome).not.toContain('cancelado-apos-envio');
  };

  it('★ PATH A — a goods-OUT failure never resurrects into a goods-IN rung: picked up → LOST → a sibling still waiting (strictly newer) keeps objetoExtraviado (no frete-ressuscitado), and the CANCELLED read without packages keeps the pedido; NEAR-MISS: the same walk with the pickup CANCELLED (goods in) is rescheduled and then released', () => {
    const pagamento = pagamentoCriado({ status: 'SHIPPED' });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    const passo = (doc: Doc, opcoes: OpcoesPedidoTeste) =>
      montar(doc, { linhas: DUAS, ...opcoes }, { pagamento });

    const coletado = criado({
      status: 'SHIPPED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect((coletado.freteInicial as Doc).estado).toBe('postado');
    const r30 = passo(coletado, {
      status: 'SHIPPED',
      atualizadoEm: depois(30),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'LOST')],
    });
    expect(freteDo(r30)?.estado).toBe('objetoExtraviado');
    const perdido = seguir(coletado, r30);
    const r60 = passo(perdido, {
      status: 'SHIPPED',
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'LOST'), pacoteAmazon('PKG-2', 'PENDING_PICK_UP')],
    });
    expect(freteDo(r60)?.estado ?? 'objetoExtraviado').toBe('objetoExtraviado');
    expect(decisao(r60).eventos).not.toContain('frete-ressuscitado');
    const r120 = passo(seguir(perdido, r60), {
      status: 'CANCELLED',
      atualizadoEm: depois(120),
    });
    mantido(r120, 'LOST');
    expect(freteDo(r120)?.estado ?? 'objetoExtraviado').toBe('objetoExtraviado');

    // NEAR-MISS: the pickup cancelled while the goods were still in.
    const agendado = criado({
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
    });
    expect((agendado.freteInicial as Doc).estado).toBe('aguardandoPostagem');
    const n30 = passo(agendado, {
      atualizadoEm: depois(30),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'LABEL_CANCELLED')],
    });
    expect(freteDo(n30)?.estado).toBe('despachoNegado');
    const negado = seguir(agendado, n30);
    const n60 = passo(negado, {
      atualizadoEm: depois(60),
      pacotesBrutos: [
        pacoteAmazon('PKG-1', 'LABEL_CANCELLED'),
        pacoteAmazon('PKG-2', 'PENDING_PICK_UP'),
      ],
    });
    expect(freteDo(n60)?.estado).toBe('aguardandoPostagem');
    expect(decisao(n60).eventos).toContain('frete-ressuscitado');
    const n120 = passo(seguir(negado, n60), { status: 'CANCELLED', atualizadoEm: depois(120) });
    liberado(n120, 'LABEL_CANCELLED');
    expect(freteDo(n120)?.estado).toBe('cancelado');
  });

  it('★ PATH A, the no-packages route: a stored falhaNaEntrega + a strictly newer PARTIALLY_SHIPPED read without packages (invoice ACCEPTED) keeps falhaNaEntrega, and the CANCELLED read after it keeps the pedido; NEAR-MISS: a stored despachoNegado (goods in) is rescheduled to aguardandoAgendamento and then released', () => {
    const pagamento = pagamentoCriado({ invoiceStatus: 'ACCEPTED' });
    for (const [falha, fica] of [
      ['falhaNaEntrega', true],
      ['despachoNegado', false],
    ] as const) {
      const guardado = comFreteGuardado({ estado: falha });
      const r60 = montar(
        guardado,
        {
          status: 'PARTIALLY_SHIPPED',
          linhas: DUAS,
          invoiceStatus: 'ACCEPTED',
          atualizadoEm: depois(60),
        },
        { pagamento },
      );
      expect(freteDo(r60)?.estado ?? falha, falha).toBe(fica ? falha : 'aguardandoAgendamento');
      expect(decisao(r60).eventos.includes('frete-ressuscitado'), falha).toBe(!fica);
      const r120 = montar(
        seguir(guardado, r60),
        { status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(120) },
        { pagamento },
      );
      if (fica) {
        mantido(r120, falha);
        expect(freteDo(r120)?.estado ?? falha).toBe(falha);
      } else {
        liberado(r120, falha);
        expect(freteDo(r120)?.estado).toBe('cancelado');
      }
    }
  });

  describe('★ PATH B — a package that left beside a sibling still waiting: its diary row is the durable evidence', () => {
    const pagamento = pagamentoCriado();
    /** Stored pago, freight iniciado (no invoice yet). */
    const inicial = (): Doc => criado({ linhas: DUAS });
    /** The read at depois(60), carrying `pacotesBrutos`. */
    const aos60Com = (
      pacotesBrutos: OpcoesPedidoTeste['pacotesBrutos'],
      status = 'PARTIALLY_SHIPPED',
    ) => {
      const guardado = inicial();
      expect((guardado.freteInicial as Doc).estado).toBe('iniciado');
      const r = montar(
        guardado,
        { status, linhas: DUAS, atualizadoEm: depois(60), pacotesBrutos },
        { pagamento },
      );
      return seguir(guardado, r);
    };
    /** The read at depois(60): `tokens[0]` for PKG-1, `tokens[1]` for PKG-2. */
    const aos60 = (tokens: readonly [string, string], status = 'PARTIALLY_SHIPPED') =>
      aos60Com([pacoteAmazon('PKG-1', tokens[0]), pacoteAmazon('PKG-2', tokens[1])], status);
    /** The three CANCELLED reads at depois(120). */
    const CANCELADAS: Readonly<Record<string, OpcoesPedidoTeste>> = {
      '(a) no packages': { status: 'CANCELLED', atualizadoEm: depois(120) },
      '(b) both LABEL_CANCELLED': {
        status: 'CANCELLED',
        atualizadoEm: depois(120),
        pacotesBrutos: [
          pacoteAmazon('PKG-1', 'LABEL_CANCELLED'),
          pacoteAmazon('PKG-2', 'LABEL_CANCELLED'),
        ],
      },
      '(c) PKG-2 LABEL_CANCELLED only': {
        status: 'CANCELLED',
        atualizadoEm: depois(120),
        pacotesBrutos: [pacoteAmazon('PKG-2', 'LABEL_CANCELLED')],
      },
    };
    const cancelar = (doc: Doc, opcoes: OpcoesPedidoTeste) =>
      montar(doc, { linhas: DUAS, ...opcoes }, { pagamento });

    it('the setup: PKG-1 picked up, PKG-2 waiting ⇒ the block at the least-advanced rung (goods IN), the diary row of PKG-1 at postado', () => {
      const guardado = aos60(['PICKED_UP', 'PENDING_PICK_UP']);
      const frete = guardado.freteInicial as Doc;
      expect(frete.estado).toBe('aguardandoPostagem');
      expect((frete.pacotes as Doc[]).map((l) => [l.numero, l.estado])).toEqual([
        ['PKG-1', 'postado'],
        ['PKG-2', 'aguardandoPostagem'],
      ]);
    });

    it('★ (a), (b) and (c) KEEP the pedido (cancelado-apos-envio, the pagamento aprovado) — the freight never cancelado; NEAR-MISS: the same walk where PKG-1 never left is RELEASED by each', () => {
      for (const [nome, opcoes] of Object.entries(CANCELADAS)) {
        const r = cancelar(aos60(['PICKED_UP', 'PENDING_PICK_UP']), opcoes);
        mantido(r, nome);
        expect(freteDo(r)?.estado ?? 'aguardandoPostagem', nome).not.toBe('cancelado');
        // NEAR-MISS: every stored row says the goods are IN.
        const dentro = cancelar(aos60(['PENDING_PICK_UP', 'PENDING_PICK_UP'], 'UNSHIPPED'), opcoes);
        liberado(dentro, `${nome} / never left`);
        expect(freteDo(dentro)?.estado, nome).toBe('cancelado');
      }
    });

    it('★ (b)’s EQUAL-clock redelivery stays KEPT (and so does a later CANCELLED read without packages), because (b) kept the diary row of PKG-1 at postado — its wire fields take the LABEL_CANCELLED', () => {
      const opcoes = CANCELADAS['(b) both LABEL_CANCELLED'] ?? {};
      const guardado = aos60(['PICKED_UP', 'PENDING_PICK_UP']);
      const r = cancelar(guardado, opcoes);
      mantido(r, '(b)');
      // The behaviour first: the redelivery reads ONLY what (b) left behind.
      const depoisDeB = seguir(guardado, r);
      const deNovo = cancelar(depoisDeB, opcoes);
      mantido(deNovo, '(b) redelivered');
      expect(deNovo.tipo).toBe('sem-mudanca');
      mantido(cancelar(depoisDeB, CANCELADAS['(a) no packages'] ?? {}), '(b)→(a)');
      // The mechanism: the row gate.
      expect(
        (freteDo(r)?.pacotes as Doc[]).map((l) => [l.numero, l.estado, l.estadoMarketplace]),
      ).toEqual([
        ['PKG-1', 'postado', 'LABEL_CANCELLED'],
        ['PKG-2', 'despachoNegado', 'LABEL_CANCELLED'],
      ]);
      expect(freteDo(r)?.estado).toBe('despachoNegado');
    });

    it('★ NEAR-MISS (the reading’s SCOPE): a malformed stored row contributes nothing, and the rows of a block another modality owns are never read — both RELEASED; the same rows on our block KEEP', () => {
      const guardado = aos60(['PICKED_UP', 'PENDING_PICK_UP']);
      const frete = guardado.freteInicial as Doc;
      const comPacotes = (pacotes: Doc[], over: Doc = {}): Doc => ({
        ...guardado,
        freteInicial: { ...frete, ...over, pacotes },
      });
      const linhas = frete.pacotes as Doc[];
      const pkg1 = linhas[0] ?? {};
      const pkg2 = linhas[1] ?? {};
      const opcoes = CANCELADAS['(a) no packages'] ?? {};
      // Inherited property names included: an `in`-style lookup would read them as goods out.
      for (const malformado of [
        'POSTADO',
        ' postado',
        'postado ',
        7,
        null,
        'toString',
        'constructor',
        '__proto__',
      ]) {
        const r = cancelar(comPacotes([{ ...pkg1, estado: malformado }, pkg2]), opcoes);
        liberado(r, `malformed ${String(malformado)}`);
      }
      const doMelhorEnvio = comPacotes(linhas, {
        externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios,
      });
      liberado(cancelar(doMelhorEnvio, opcoes), 'Melhor Envio block');
      // The control: the very same rows on OUR block keep the pedido.
      mantido(cancelar(comPacotes(linhas), opcoes), 'amz block');
    });

    it('★ RESIDUAL, pinned as it is today: a package the fold cannot key (no packageReferenceId, or one key twice in one read) leaves NO diary row and blocks the block, so its pickup is read only from the read that carries it — a later CANCELLED read without packages RELEASES; the CANCELLED read that still carries it KEEPS; NEAR-MISS: the same pickup KEYED keeps through its row', () => {
      const semNumero = [
        pacoteAmazon(undefined, 'PICKED_UP'),
        pacoteAmazon('PKG-2', 'PENDING_PICK_UP'),
      ];
      const chaveDupla = [
        pacoteAmazon('PKG-1', 'PICKED_UP'),
        pacoteAmazon('PKG-1', 'PENDING_PICK_UP'),
      ];
      for (const [nome, brutos, linhasEsperadas] of [
        ['no packageReferenceId', semNumero, [['PKG-2', 'aguardandoPostagem']]],
        ['the same key twice', chaveDupla, []],
      ] as const) {
        const guardado = aos60Com([...brutos]);
        const frete = guardado.freteInicial as Doc;
        // The fold is blocked: the block does not move, and no row records the pickup.
        expect(frete.estado, nome).toBe('iniciado');
        expect(
          ((frete.pacotes as Doc[] | undefined) ?? []).map((l) => [l.numero, l.estado]),
          nome,
        ).toEqual(linhasEsperadas);
        // The residual: nothing stored says the goods left.
        liberado(cancelar(guardado, CANCELADAS['(a) no packages'] ?? {}), nome);
        // The read that carries the package still says so (the second reading).
        mantido(
          cancelar(guardado, {
            status: 'CANCELLED',
            atualizadoEm: depois(120),
            pacotesBrutos: [...brutos],
          }),
          `${nome}, carried by the CANCELLED read`,
        );
      }
      // NEAR-MISS: keyed, the diary row is the durable evidence.
      mantido(
        cancelar(aos60(['PICKED_UP', 'PENDING_PICK_UP']), CANCELADAS['(a) no packages'] ?? {}),
        'keyed',
      );
    });
  });

  it('★ the third reading’s LOGISTICS scope: the rows on a block the stored-block reading reads as fulfillment (an AFN seed, under an AFN read or one without fulfilledBy) are never this ERP’s goods out — the CANCELLED read RELEASES, exactly like the same block without rows; NEAR-MISS: the same rows under a MERCHANT read (the residue, rung 11) and on a block that is NOT fulfillment KEEP', () => {
    const coletadoPor = (seed: Doc, por: string | null): Doc => {
      const r = montar(seed, {
        por,
        status: 'SHIPPED',
        linhas: DUAS,
        atualizadoEm: depois(30),
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
      });
      return seguir(seed, r);
    };
    const cancelada = (doc: Doc, por: string | null) =>
      montar(doc, { por, status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(60) });

    const afn = criado({ por: 'AMAZON', status: 'UNSHIPPED', linhas: DUAS });
    expect((afn.freteInicial as Doc).estado).toBe('fulfillment');
    for (const por of ['AMAZON', null]) {
      // An AFN read (or one without fulfilledBy) writes Amazon's packages to the
      // diary of the AFN block — never its estado.
      const comLinhas = coletadoPor(afn, por);
      const frete = comLinhas.freteInicial as Doc;
      expect(frete.estado, String(por)).toBe('fulfillment');
      expect(
        (frete.pacotes as Doc[]).map((l) => [l.numero, l.estado]),
        String(por),
      ).toEqual([['PKG-1', 'postado']]);
      for (const porCancelada of ['AMAZON', null]) {
        const nome = `${String(por)}→${String(porCancelada)}`;
        const r = cancelada(comLinhas, porCancelada);
        expect(patchDe(r).estado, nome).toBe(ESTADO_PEDIDO.cancelado);
        expect(decisao(r).incidentes, nome).not.toContain('cancelado-apos-envio');
        expect(freteDo(r)?.estado ?? 'fulfillment', nome).toBe('fulfillment');
        // The control: the same AFN block WITHOUT rows answers the same.
        const semLinhas = cancelada(afn, porCancelada);
        expect(patchDe(semLinhas).estado, nome).toBe(ESTADO_PEDIDO.cancelado);
      }
      // NEAR-MISS: under a MERCHANT read the stored fulfillment is the legacy
      // residue (rung 11, goods out) — the stored-block reading keeps it already.
      const mfn = cancelada(comLinhas, 'MERCHANT');
      expect(Object.hasOwn(patchDe(mfn), 'estado'), String(por)).toBe(false);
      expect(decisao(mfn).incidentes, String(por)).toContain('cancelado-apos-envio');
    }
    // NEAR-MISS (the scope is the BLOCK, never the read): a block seeded at
    // iniciado by a read without fulfilledBy holds rows an AFN read wrote — its
    // rows count, so an AFN CANCELLED read KEEPS (wrongly keeping costs an
    // incidente; wrongly releasing would restock goods that left).
    const semPor = criado({ por: null, status: 'UNSHIPPED', linhas: DUAS });
    expect((semPor.freteInicial as Doc).estado).toBe('iniciado');
    const comLinhasDoNosso = coletadoPor(semPor, 'AMAZON');
    expect((comLinhasDoNosso.freteInicial as Doc).estado).toBe('iniciado');
    const r = cancelada(comLinhasDoNosso, 'AMAZON');
    expect(Object.hasOwn(patchDe(r), 'estado')).toBe(false);
    expect(decisao(r).incidentes).toContain('cancelado-apos-envio');
    // …and the same block without the rows is released.
    expect(patchDe(cancelada(semPor, 'AMAZON')).estado).toBe(ESTADO_PEDIDO.cancelado);
  });

  it('a LABEL_CANCELLED package on a CANCELLED order derives no coleta-cancelada (the order resolves it)', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    const r = montar(guardado, {
      status: 'CANCELLED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'LABEL_CANCELLED')],
    });
    expect(decisao(r).avisos).not.toContain('coleta-cancelada');
  });

  it('★ a package without a reference blocks the freight (no change) + pacote-status-desconhecido + the count line, while the keyed package’s row is still written', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoAgendamento' });
    const r = montar(guardado, {
      linhas: DUAS,
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP'), pacoteAmazon(undefined, 'PICKED_UP')],
    });
    expect(freteDo(r)?.estado).toBe('aguardandoAgendamento');
    expect((freteDo(r)?.pacotes as Doc[]).map((l) => l.numero)).toEqual(['PKG-1']);
    expect(decisao(r).avisos).toEqual(['pacote-status-desconhecido']);
    expect(decisao(r).eventos).toContain('pacote-nao-mapeado');
    expect(decisao(r).pacotes).toEqual({
      pacotes: 2,
      naoMapeados: 0,
      semChave: 1,
      statusPacotes: 'IN_TRANSIT',
    });
  });

  it('★ codRastreio: a stored value is REPLACED by Amazon’s (codRastreio-divergente, never the value); an empty fold keeps it', () => {
    const guardado = comFreteGuardado(
      { estado: 'postado', codRastreio: 'TRK-VELHO' },
      { status: 'SHIPPED' },
    );
    const troca = montar(guardado, {
      status: 'SHIPPED',
      linhas: DUAS,
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP', { rastreio: 'TRK-NOVO' })],
    });
    expect(freteDo(troca)?.codRastreio).toBe('TRK-NOVO');
    expect(decisao(troca).eventos).toContain('codRastreio-divergente');
    const vazio = montar(guardado, {
      status: 'SHIPPED',
      linhas: DUAS,
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(freteDo(vazio)?.codRastreio ?? 'TRK-VELHO').toBe('TRK-VELHO');
    expect(decisao(vazio).eventos).not.toContain('codRastreio-divergente');
  });

  it('★ a stored freight error (step 14’s stamp): ACCEPTED (aguardandoAgendamento) leaves it, a picked-up package clears it', () => {
    const guardado = comFreteGuardado({ estado: 'error' });
    const aceita = montar(guardado, { linhas: DUAS, invoiceStatus: 'ACCEPTED' });
    expect(freteDo(aceita)?.estado ?? 'error').toBe('error');
    const coletada = montar(guardado, {
      status: 'SHIPPED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(freteDo(coletada)?.estado).toBe('postado');
  });

  it('a D17 block still writes the freight (non-money, Amazon-owned)', () => {
    const r = montar(PAGO(), {
      linhas: [linhaAmazon('L1', { qtd: 1, preco: '10.00' }), DUAS[1] ?? {}],
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
    });
    expect(decisao(r).itens).toBe('divergencia-itens-aprovado');
    expect(freteDo(r)?.estado).toBe('aguardandoPostagem');
  });

  it('an unreadable stored freight block writes nothing of the group (and claims no freight event)', () => {
    const guardado = comFreteGuardado({
      estado: 'despachoNegado',
      modalidade: 'nao-e-modalidade',
    });
    const r = montar(guardado, {
      linhas: DUAS,
      invoiceStatus: 'ACCEPTED',
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
    });
    expect(freteDo(r)).toBeNull();
    expect(decisao(r).eventos).toContain('frete-armazenado-ilegivel');
    expect(decisao(r).eventos).not.toContain('frete-ressuscitado');
  });

  it('★ E3: PENDING_DROP_OFF moves aguardandoAgendamento to aguardandoPostagem — a removal estado (the stock leaves at scheduling)', () => {
    const r = montar(comFreteGuardado({ estado: 'aguardandoAgendamento' }), {
      linhas: DUAS,
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_DROP_OFF')],
    });
    expect(freteDo(r)?.estado).toBe('aguardandoPostagem');
    expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(ESTADO_FRETE.aguardandoPostagem)).toBe(true);
  });

  it('★ an AFN-seeded block is never walked by a read WITHOUT fulfilledBy: AT_DESTINATION_FC (a removal estado) and CANCELLED both leave fulfillment', () => {
    const afn = criado({ por: 'AMAZON', status: 'UNSHIPPED', linhas: DUAS });
    expect((afn.freteInicial as Doc).estado).toBe('fulfillment');
    const semPor = montar(afn, {
      por: null,
      status: 'SHIPPED',
      linhas: DUAS,
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'AT_DESTINATION_FC')],
    });
    expect(decisao(semPor).avisos).toContain('logistica-desconhecida');
    expect(freteDo(semPor)?.estado ?? 'fulfillment').toBe('fulfillment');
    for (const por of [null, 'AMAZON']) {
      const cancelado = montar(afn, {
        por,
        status: 'CANCELLED',
        linhas: DUAS,
        atualizadoEm: depois(60),
      });
      expect(freteDo(cancelado)?.estado ?? 'fulfillment', String(por)).toBe('fulfillment');
    }
    // NEAR-MISS: the SAME stored value under a MERCHANT read is the legacy residue (rung 11).
    const mfn = montar(afn, {
      status: 'SHIPPED',
      linhas: DUAS,
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'AT_DESTINATION_FC')],
    });
    expect(freteDo(mfn)?.estado).toBe('aCaminho');
  });

  it('★ an AFN read moves NO block: a stored iniciado (seeded by a read without fulfilledBy) stays put through a PICKED_UP', () => {
    const semPor = criado({ por: null, status: 'UNSHIPPED', linhas: DUAS });
    expect((semPor.freteInicial as Doc).estado).toBe('iniciado');
    const afn = montar(semPor, {
      por: 'AMAZON',
      status: 'SHIPPED',
      linhas: DUAS,
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(freteDo(afn)?.estado ?? 'iniciado').toBe('iniciado');
    // NEAR-MISS: the same stored block under a MERCHANT read follows the package.
    const mfn = montar(semPor, {
      status: 'SHIPPED',
      linhas: DUAS,
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(freteDo(mfn)?.estado).toBe('postado');
  });

  it('★ CANCELLED: a package with the carrier is goods out WHATEVER its siblings say (waiting, unknown) and keyed or not — estado kept, cancelado-apos-envio, freight never cancelado', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    // The unknown sibling's closed status is PENDING, so the picked-up package alone says it.
    const desconhecidoPendente = pacoteAmazon('PKG-2', 'NEW_TOKEN', { status: 'PENDING' });
    for (const pacotesBrutos of [
      [pacoteAmazon('PKG-1', 'PICKED_UP'), pacoteAmazon('PKG-2', 'PENDING_PICK_UP')],
      [pacoteAmazon('PKG-1', 'PICKED_UP'), desconhecidoPendente],
      [pacoteAmazon(undefined, 'PICKED_UP')],
    ]) {
      const nome = pacotesBrutos.map((p) => JSON.stringify(p.packageStatus)).join();
      const r = montar(guardado, { status: 'CANCELLED', linhas: DUAS, pacotesBrutos });
      expect(Object.hasOwn(patchDe(r), 'estado'), nome).toBe(false);
      expect(decisao(r).incidentes, nome).toContain('cancelado-apos-envio');
      // The fold's own answer (the least-advanced rung, or none when blocked): never cancelado.
      expect(freteDo(r)?.estado ?? 'aguardandoPostagem', nome).toBe('aguardandoPostagem');
    }
    // The blocked read still raises its aviso (and the freight was not moved by it).
    const bloqueado = montar(guardado, {
      status: 'CANCELLED',
      linhas: DUAS,
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP'), desconhecidoPendente],
    });
    expect(decisao(bloqueado).avisos).toContain('pacote-status-desconhecido');
    // NEAR-MISS: every package still waiting (or unknown alone, its closed status
    // still PENDING: PR 5-f's fallback reads the status of an unknown token) ⇒ released.
    for (const pacotesBrutos of [
      [pacoteAmazon('PKG-1', 'PENDING_PICK_UP'), pacoteAmazon('PKG-2', 'PENDING_PICK_UP')],
      [pacoteAmazon('PKG-1', 'NEW_TOKEN', { status: 'PENDING' })],
    ]) {
      const r = montar(guardado, { status: 'CANCELLED', linhas: DUAS, pacotesBrutos });
      expect(patchDe(r).estado).toBe('cancelado');
      expect(freteDo(r)?.estado).toBe('cancelado');
    }
  });

  it('★ the migrated residue is goods out for the CANCELLED check too: a stored fulfillment without marketplace under a MERCHANT CANCELLED — and since PR 5-f under one WITHOUT fulfilledBy — ⇒ estado kept, cancelado-apos-envio, freight never cancelado; NEAR-MISS: under an AFN read it is released (Amazon says the order is its own)', () => {
    const migrado: Doc = { ...comFreteGuardado({ estado: 'fulfillment' }) };
    delete migrado.marketplace;
    for (const por of ['MERCHANT', null]) {
      const r = montar(migrado, { por, status: 'CANCELLED', linhas: DUAS });
      expect(Object.hasOwn(patchDe(r), 'estado'), String(por)).toBe(false);
      expect(decisao(r).incidentes, String(por)).toContain('cancelado-apos-envio');
      expect(freteDo(r)?.estado ?? 'fulfillment', String(por)).toBe('fulfillment');
    }
    // The residue's SCOPE: an AFN read never reads the stored value as goods out,
    // and the block is fora-do-canal (untouched).
    const afn = montar(migrado, { por: 'AMAZON', status: 'CANCELLED', linhas: DUAS });
    expect(patchDe(afn).estado).toBe('cancelado');
    expect(decisao(afn).incidentes).not.toContain('cancelado-apos-envio');
    expect(freteDo(afn)?.estado ?? 'fulfillment').toBe('fulfillment');
  });

  it('★ CANCELLED over an estado the operator owns (finalizado) with the goods IN: estado kept + cancelado-apos-envio, and the freight KEPT too (the predicate’s outcome, not a copy)', () => {
    const guardado: Doc = {
      ...comFreteGuardado({ estado: 'checkFinalizado' }),
      estado: ESTADO_PEDIDO.finalizado,
    };
    const r = montar(guardado, { status: 'CANCELLED', linhas: DUAS });
    expect(decisao(r)).toMatchObject({ motivoEstado: 'manter' });
    expect(decisao(r).incidentes).toContain('cancelado-apos-envio');
    expect(freteDo(r)?.estado ?? 'checkFinalizado').toBe('checkFinalizado');
    // NEAR-MISS: the same freight under a governed pago ⇒ released, freight cancelado.
    const governado = montar(comFreteGuardado({ estado: 'checkFinalizado' }), {
      status: 'CANCELLED',
      linhas: DUAS,
    });
    expect(patchDe(governado).estado).toBe('cancelado');
    expect(freteDo(governado)?.estado).toBe('cancelado');
  });
});

describe('★ PR 5-f — an unreadable package whose closed status says it left is goods out for the CANCELLED predicate (the restock side), never for the target', () => {
  const pagamento = pagamentoCriado({ invoiceStatus: 'ACCEPTED' });
  const FORA = ['IN_TRANSIT', 'SHIPPED', 'DELIVERED', 'UNDELIVERABLE'] as const;
  /** A stored PAGO pedido (UNSHIPPED, invoice ACCEPTED) whose `amz` freight block holds `over`. */
  const comFreteGuardado = (over: Doc): Doc => {
    const doc = criado({ linhas: DUAS, invoiceStatus: 'ACCEPTED' });
    return { ...doc, freteInicial: { ...(doc.freteInicial as Doc), ...over } };
  };
  const freteDo = (r: EscritaPedidoAmazon): Doc | null =>
    r.tipo === 'atualizar' && Object.hasOwn(r.patch, 'freteInicial')
      ? (r.patch.freteInicial as Doc)
      : null;
  const seguir = (doc: Doc, r: EscritaPedidoAmazon): Doc =>
    r.tipo === 'sem-mudanca' ? doc : aplicar(doc, r);
  const cancelar = (doc: Doc, opcoes: OpcoesPedidoTeste = {}) =>
    montar(
      doc,
      { status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(120), ...opcoes },
      { pagamento },
    );
  /** KEPT: no estado written, cancelado-apos-envio, the pagamento still aprovado. */
  const mantido = (r: EscritaPedidoAmazon, nome: string) => {
    expect(r.tipo === 'atualizar' ? Object.hasOwn(r.patch, 'estado') : false, nome).toBe(false);
    expect(decisao(r), nome).toMatchObject({ estadoEscrito: null });
    expect(decisao(r).incidentes, nome).toContain('cancelado-apos-envio');
    expect(decisao(r).statusPagamento ?? STATUS_PAGAMENTO.aprovado, nome).toBe(
      STATUS_PAGAMENTO.aprovado,
    );
  };
  /** RELEASED: the refund, the pagamento estornado, the freight cancelado. */
  const liberado = (r: EscritaPedidoAmazon, nome: string) => {
    expect(patchDe(r).estado, nome).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(decisao(r).statusPagamento, nome).toBe(STATUS_PAGAMENTO.estornado);
    expect(decisao(r).incidentes, nome).not.toContain('cancelado-apos-envio');
    expect(freteDo(r)?.estado, nome).toBe('cancelado');
  };

  it('★ the probe: CANCELLED over a governed pago (aprovado pagamento) whose freight is still before postado, with a package Amazon reports IN_TRANSIT/SHIPPED/DELIVERED/UNDELIVERABLE but whose detailedStatus is absent or undocumented — keyed or not ⇒ KEPT, cancelado-apos-envio, the freight never cancelado, the aviso still raised', () => {
    for (const estadoFrete of ['aguardandoPostagem', 'checkFinalizado', 'aguardandoAgendamento']) {
      const guardado = comFreteGuardado({ estado: estadoFrete });
      for (const status of FORA) {
        for (const [forma, bruto] of [
          ['sem detailedStatus', pacoteAmazon('PKG-1', undefined, { status })],
          ['token novo', pacoteAmazon('PKG-1', 'TOKEN_NOVO_X', { status })],
          ['sem chave', pacoteAmazon(undefined, undefined, { status })],
        ] as const) {
          const nome = `${estadoFrete} / ${status} / ${forma}`;
          const r = cancelar(guardado, { pacotesBrutos: [bruto] });
          mantido(r, nome);
          // The target is the blocked fold's: the stored freight estado does not move.
          expect(freteDo(r)?.estado ?? estadoFrete, nome).toBe(estadoFrete);
          expect(decisao(r).avisos, nome).toContain('pacote-status-desconhecido');
        }
      }
    }
  });

  it('★ NEAR-MISS: the same reads whose closed status does NOT say the package left (PENDING, CANCELLED, absent, an undocumented status) ⇒ released, exactly as before', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    for (const status of ['PENDING', 'CANCELLED', null, 'NEW_STATUS']) {
      for (const bruto of [
        pacoteAmazon('PKG-1', undefined, { status }),
        pacoteAmazon('PKG-1', 'TOKEN_NOVO_X', { status }),
      ]) {
        const nome = `${String(status)} / ${JSON.stringify(bruto.packageStatus)}`;
        liberado(cancelar(guardado, { pacotesBrutos: [bruto] }), nome);
      }
    }
  });

  it('★ NEAR-MISS (the token decides): a KNOWN goods-in detailedStatus beside a goods-out status is released; a known goods-out one beside PENDING is kept', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    liberado(
      cancelar(guardado, {
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP', { status: 'SHIPPED' })],
      }),
      'PENDING_PICK_UP + SHIPPED',
    );
    liberado(
      cancelar(guardado, {
        pacotesBrutos: [pacoteAmazon('PKG-1', 'LABEL_CANCELLED', { status: 'DELIVERED' })],
      }),
      'LABEL_CANCELLED + DELIVERED',
    );
    mantido(
      cancelar(guardado, {
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP', { status: 'PENDING' })],
      }),
      'PICKED_UP + PENDING',
    );
  });

  it('★ the TARGET is unchanged (no status-only floor): a SHIPPED read with the same package over a stored aguardandoAgendamento keeps the freight estado, writes the row with estado null and the status verbatim, raises the aviso, and the pedido stays pago', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoAgendamento' });
    for (const status of FORA) {
      const r = montar(
        guardado,
        {
          status: 'SHIPPED',
          linhas: DUAS,
          atualizadoEm: depois(60),
          pacotesBrutos: [pacoteAmazon('PKG-1', undefined, { status })],
        },
        { pagamento },
      );
      expect(freteDo(r)?.estado ?? 'aguardandoAgendamento', status).toBe('aguardandoAgendamento');
      expect((freteDo(r)?.pacotes as Doc[] | undefined)?.[0], status).toMatchObject({
        numero: 'PKG-1',
        estado: null,
        estadoMarketplace: null,
        statusMarketplace: status,
      });
      expect(decisao(r).avisos, status).toContain('pacote-status-desconhecido');
      expect(Object.hasOwn(patchDe(r), 'estado'), status).toBe(false);
    }
  });

  it('★ durable: the diary row a read left keeps a LATER CANCELLED read without packages from restocking; NEAR-MISS: the same walk at status PENDING is released, and so is an unkeyed package (no row — the module’s residual)', () => {
    const passo = (doc: Doc, opcoes: OpcoesPedidoTeste) =>
      seguir(
        doc,
        montar(
          doc,
          { status: 'SHIPPED', linhas: DUAS, atualizadoEm: depois(60), ...opcoes },
          { pagamento },
        ),
      );
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    for (const status of FORA) {
      const lido = passo(guardado, {
        pacotesBrutos: [pacoteAmazon('PKG-1', undefined, { status })],
      });
      expect((lido.freteInicial as Doc).estado, status).toBe('aguardandoPostagem');
      const r = cancelar(lido);
      mantido(r, status);
      expect(freteDo(r)?.estado ?? 'aguardandoPostagem', status).toBe('aguardandoPostagem');
    }
    const pendente = passo(guardado, {
      pacotesBrutos: [pacoteAmazon('PKG-1', undefined, { status: 'PENDING' })],
    });
    liberado(cancelar(pendente), 'PENDING');
    const semChave = passo(guardado, {
      pacotesBrutos: [pacoteAmazon(undefined, undefined, { status: 'IN_TRANSIT' })],
    });
    liberado(cancelar(semChave), 'unkeyed');
    // …while the CANCELLED read that still carries the unkeyed package keeps (this read's own).
    mantido(
      cancelar(semChave, {
        pacotesBrutos: [pacoteAmazon(undefined, undefined, { status: 'IN_TRANSIT' })],
      }),
      'unkeyed, carried',
    );
  });

  it('★ the stored reading’s SCOPE is the third reading’s: such rows on a block another modality owns, or on an AFN-seeded fulfillment block under a read that does not say MERCHANT, never keep the pedido; the same rows on our block do', () => {
    const lido = seguir(
      comFreteGuardado({ estado: 'aguardandoPostagem' }),
      montar(
        comFreteGuardado({ estado: 'aguardandoPostagem' }),
        {
          status: 'SHIPPED',
          linhas: DUAS,
          atualizadoEm: depois(60),
          pacotesBrutos: [pacoteAmazon('PKG-1', undefined, { status: 'DELIVERED' })],
        },
        { pagamento },
      ),
    );
    mantido(cancelar(lido), 'amz block');
    const doMelhorEnvio: Doc = {
      ...lido,
      freteInicial: {
        ...(lido.freteInicial as Doc),
        externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios,
      },
    };
    const r = cancelar(doMelhorEnvio);
    expect(patchDe(r).estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(decisao(r).incidentes).not.toContain('cancelado-apos-envio');

    const afn = criado({ por: 'AMAZON', status: 'UNSHIPPED', linhas: DUAS });
    expect((afn.freteInicial as Doc).estado).toBe('fulfillment');
    for (const por of ['AMAZON', null]) {
      const comLinhas = seguir(
        afn,
        montar(afn, {
          por,
          status: 'SHIPPED',
          linhas: DUAS,
          atualizadoEm: depois(30),
          pacotesBrutos: [pacoteAmazon('PKG-1', undefined, { status: 'DELIVERED' })],
        }),
      );
      expect(
        ((comLinhas.freteInicial as Doc).pacotes as Doc[]).map((l) => l.statusMarketplace),
        String(por),
      ).toEqual(['DELIVERED']);
      const cancelada = montar(comLinhas, {
        por,
        status: 'CANCELLED',
        linhas: DUAS,
        atualizadoEm: depois(60),
      });
      expect(patchDe(cancelada).estado, String(por)).toBe(ESTADO_PEDIDO.cancelado);
      expect(decisao(cancelada).incidentes, String(por)).not.toContain('cancelado-apos-envio');
    }
  });

  it('★ RESIDUAL, pinned as it is today: a later read that names the same package with a goods-IN reading (PENDING_PICK_UP at PENDING) rewrites the row’s wire fields — on an EQUAL order clock too (a stale re-derive) — and the CANCELLED read without packages after it RELEASES; NEAR-MISS: the same walk from a PICKED_UP row keeps (the row gate keeps its estado)', () => {
    const guardado = comFreteGuardado({ estado: 'aguardandoPostagem' });
    const ler = (doc: Doc, pacotesBrutos: OpcoesPedidoTeste['pacotesBrutos'], s: number) =>
      seguir(
        doc,
        montar(
          doc,
          { status: 'SHIPPED', linhas: DUAS, atualizadoEm: depois(s), pacotesBrutos },
          { pagamento },
        ),
      );
    const deVolta = [pacoteAmazon('PKG-1', 'PENDING_PICK_UP', { status: 'PENDING' })];
    const doStatus = ler(
      ler(guardado, [pacoteAmazon('PKG-1', undefined, { status: 'IN_TRANSIT' })], 30),
      deVolta,
      60,
    );
    expect(((doStatus.freteInicial as Doc).pacotes as Doc[])[0]).toMatchObject({
      estado: 'aguardandoPostagem',
      estadoMarketplace: 'PENDING_PICK_UP',
      statusMarketplace: 'PENDING',
    });
    liberado(cancelar(doStatus), 'status evidence, then goods in');
    const doEstado = ler(ler(guardado, [pacoteAmazon('PKG-1', 'PICKED_UP')], 30), deVolta, 60);
    mantido(cancelar(doEstado), 'estado evidence, then goods in');

    // The same rewrite on an EQUAL order clock: an importer whose precondition
    // was lost re-derives from a fresh snapshot with its older fetch, and an
    // equal clock applies. The status-only evidence goes with the wire fields.
    const comStatus = ler(
      guardado,
      [pacoteAmazon('PKG-1', undefined, { status: 'IN_TRANSIT' })],
      30,
    );
    mantido(cancelar(comStatus), 'status evidence alone');
    const igual = ler(comStatus, [pacoteAmazon('PKG-1', undefined, { status: 'PENDING' })], 30);
    expect(((igual.freteInicial as Doc).pacotes as Doc[])[0]).toMatchObject({
      estado: null,
      estadoMarketplace: null,
      statusMarketplace: 'PENDING',
    });
    liberado(cancelar(igual), 'status evidence, then an equal-clock stale read');
  });
});

describe('★ PR 5-f — a stored fulfillment under a CANCELLED read WITHOUT fulfilledBy is the legacy residue (goods out), unless the pedido is held at our own AFN error', () => {
  const pagamento = pagamentoCriado({ invoiceStatus: 'ACCEPTED' });
  /** The logistics-less spellings of a read: absent, blank, another case, a stray space. */
  const SEM_LOGISTICA = [null, '', 'merchant', 'MERCHANT '] as const;
  /**
   * A migrated MFN pedido, by shape: a stored governed `pago`, no marketplace
   * block of this importer's, its freight block at `fulfillment` (the residue).
   */
  const migrado = (): Doc => {
    const doc = criado({ linhas: DUAS, invoiceStatus: 'ACCEPTED' });
    const r: Doc = {
      ...doc,
      freteInicial: { ...(doc.freteInicial as Doc), estado: ESTADO_FRETE.fulfillment },
    };
    delete r.marketplace;
    return r;
  };
  /** What an AFN create leaves: our AFN error, the freight seeded `fulfillment`, no pagamento. */
  const semeadoAfn = (): Doc => criado({ por: 'AMAZON', status: 'UNSHIPPED', linhas: DUAS });
  const cancelar = (doc: Doc, por: string | null, pg: Doc | null) =>
    montar(
      doc,
      { por, status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(120) },
      { pagamento: pg },
    );
  /** The freight estado a write leaves on the block (`undefined`: the block not rewritten). */
  const freteDo = (r: EscritaPedidoAmazon): unknown =>
    r.tipo === 'atualizar' && Object.hasOwn(r.patch, 'freteInicial')
      ? (r.patch.freteInicial as Doc).estado
      : undefined;
  /** KEPT: no estado written, cancelado-apos-envio, the freight block never moved. */
  const mantido = (r: EscritaPedidoAmazon, nome: string) => {
    expect(r.tipo === 'atualizar' ? Object.hasOwn(r.patch, 'estado') : false, nome).toBe(false);
    expect(decisao(r), nome).toMatchObject({ estadoEscrito: null, motivoEstado: 'manter' });
    expect(decisao(r).incidentes, nome).toContain('cancelado-apos-envio');
    expect(freteDo(r) ?? ESTADO_FRETE.fulfillment, nome).toBe(ESTADO_FRETE.fulfillment);
  };
  /** RELEASED to `estado`: no cancelado-apos-envio, the freight block never moved (fora-do-canal). */
  const liberado = (r: EscritaPedidoAmazon, estado: EstadoPedido, nome: string) => {
    expect(patchDe(r).estado, nome).toBe(estado);
    expect(decisao(r).incidentes, nome).not.toContain('cancelado-apos-envio');
    expect(freteDo(r) ?? ESTADO_FRETE.fulfillment, nome).toBe(ESTADO_FRETE.fulfillment);
  };

  it('★ the probe: stored pago + aprovado pagamento + freight fulfillment, then CANCELLED WITHOUT fulfilledBy (absent, blank, another spelling) ⇒ KEPT, cancelado-apos-envio, the pagamento still aprovado — exactly what the same read with MERCHANT answers', () => {
    const guardado = migrado();
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    const comMerchant = cancelar(guardado, 'MERCHANT', pagamento);
    mantido(comMerchant, 'MERCHANT');
    for (const por of SEM_LOGISTICA) {
      const nome = JSON.stringify(por);
      const r = cancelar(guardado, por, pagamento);
      mantido(r, nome);
      expect(decisao(r).statusPagamento ?? STATUS_PAGAMENTO.aprovado, nome).toBe(
        STATUS_PAGAMENTO.aprovado,
      );
      expect(decisao(r).incidentes, nome).toEqual(decisao(comMerchant).incidentes);
      expect(pagamentoDe(r), nome).toEqual(pagamentoDe(comMerchant));
    }
  });

  it('★ the C1 flip: the SAME stored doc under an AFN CANCELLED read ⇒ released as today (estornadoIntegralmente, the pagamento estornado, no incidente), the block fora-do-canal — never cancelado', () => {
    const r = cancelar(migrado(), 'AMAZON', pagamento);
    liberado(r, ESTADO_PEDIDO.estornadoIntegralmente, 'AMAZON');
    expect(decisao(r).statusPagamento).toBe(STATUS_PAGAMENTO.estornado);
  });

  it('★ NEAR-MISS, the old behaviour kept: our AFN seed (error + the AFN text, freight fulfillment) under a CANCELLED read without fulfilledBy, or an AFN one, is RELEASED — even after an AFN read wrote a goods-out row to its diary (PR 7: those rows are Amazon’s packages); a MERCHANT read still reads it as the residue (unchanged)', () => {
    const afn = semeadoAfn();
    expect(afn).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_ERRO_AMAZON.afn });
    expect((afn.freteInicial as Doc).estado).toBe(ESTADO_FRETE.fulfillment);
    const coleta = montar(afn, {
      por: 'AMAZON',
      status: 'SHIPPED',
      linhas: DUAS,
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    const comLinhas = aplicar(afn, coleta);
    expect(comLinhas).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_ERRO_AMAZON.afn });
    expect(((comLinhas.freteInicial as Doc).pacotes as Doc[]).map((l) => l.estado)).toEqual([
      'postado',
    ]);
    for (const [doc, comQue] of [
      [afn, 'seed'],
      [comLinhas, 'seed + row'],
    ] as const) {
      for (const por of [...SEM_LOGISTICA, 'AMAZON']) {
        liberado(
          cancelar(doc, por, null),
          ESTADO_PEDIDO.cancelado,
          `${comQue} / ${JSON.stringify(por)}`,
        );
      }
      mantido(cancelar(doc, 'MERCHANT', null), `${comQue} / MERCHANT`);
    }
  });

  it('★ the AFN error’s SCOPE is exact: the same seeded block whose pedido is NOT held at exactly our AFN error (another text of ours, the AFN text with a stray space, the AFN text beside another estado) reads as the residue ⇒ KEPT + cancelado-apos-envio; NEAR-MISS: exactly our AFN error ⇒ released', () => {
    const afn = semeadoAfn();
    liberado(cancelar(afn, null, null), ESTADO_PEDIDO.cancelado, 'exactly ours');
    for (const [nome, over] of [
      ['another text of ours', { error: TEXTO_ERRO_AMAZON.naoAtendivel }],
      ['a stray space', { error: `${TEXTO_ERRO_AMAZON.afn} ` }],
      ['another estado', { estado: ESTADO_PEDIDO.pago }],
    ] as const) {
      mantido(cancelar({ ...afn, ...over }, null, null), nome);
    }
  });

  it('★ the goods-out reading ONLY: under a read without fulfilledBy the residue’s block is never WALKED (AT_DESTINATION_FC, a removal estado, leaves fulfillment); NEAR-MISS: the same read with MERCHANT walks it (rung 11 → aCaminho)', () => {
    const guardado = migrado();
    const leitura = (por: string | null) =>
      montar(
        guardado,
        {
          por,
          status: 'SHIPPED',
          linhas: DUAS,
          invoiceStatus: 'ACCEPTED',
          atualizadoEm: depois(60),
          pacotesBrutos: [pacoteAmazon('PKG-1', 'AT_DESTINATION_FC')],
        },
        { pagamento },
      );
    for (const por of SEM_LOGISTICA) {
      expect(freteDo(leitura(por)) ?? ESTADO_FRETE.fulfillment, JSON.stringify(por)).toBe(
        ESTADO_FRETE.fulfillment,
      );
    }
    expect(freteDo(leitura('MERCHANT'))).toBe(ESTADO_FRETE.aCaminho);
  });

  it('★ (consequence, through the block rule of PR 5-f) a D17 block under a read without fulfilledBy over the residue keeps pago — the removal stands, never our error; NEAR-MISS: the same block under an AFN read goes to our error, as today', () => {
    const guardado = migrado();
    const L2_CANCELADA = [
      DUAS[0] ?? {},
      linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
    ];
    const bloquear = (por: string | null) =>
      montar(
        guardado,
        {
          por,
          status: 'PARTIALLY_SHIPPED',
          linhas: L2_CANCELADA,
          invoiceStatus: 'ACCEPTED',
          atualizadoEm: depois(60),
        },
        { pagamento },
      );
    for (const por of [...SEM_LOGISTICA, 'MERCHANT']) {
      const nome = JSON.stringify(por);
      const r = bloquear(por);
      expect(decisao(r).itens, nome).toBe('divergencia-itens-aprovado');
      expect(decisao(r).avisos, nome).toContain('divergencia-itens');
      expect(r.tipo === 'atualizar' ? Object.hasOwn(r.patch, 'estado') : false, nome).toBe(false);
      expect(r.tipo === 'atualizar' ? Object.hasOwn(r.patch, 'error') : false, nome).toBe(false);
      expect(pagamentoDe(r), nome).toEqual({ tipo: 'nada' });
    }
    const afn = bloquear('AMAZON');
    expect(decisao(afn).itens).toBe('divergencia-itens-aprovado');
    expect(patchDe(afn)).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: `${PREFIXO_ERRO_AMAZON}linha cancelada na Amazon em pedido a enviar: L2`,
    });
  });
});

describe('★ PR 5-f — a D17 block never puts goods that left back on sale: the table’s target stays while the goods are out or the freight removes stock', () => {
  const pagamento = pagamentoCriado();
  /** L1 intact, L2 cancelled on Amazon (an executed line cancellation): D17 rows 5/6. */
  const L2_CANCELADA = [
    DUAS[0] ?? {},
    linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
  ];
  const TEXTO_BLOQUEIO = `${PREFIXO_ERRO_AMAZON}linha cancelada na Amazon em pedido a enviar: L2`;
  /** A stored PAGO pedido (UNSHIPPED, invoice ACCEPTED) whose `amz` freight block holds `over`. */
  const comFreteGuardado = (over: Doc): Doc => {
    const doc = criado({ linhas: DUAS, invoiceStatus: 'ACCEPTED' });
    return { ...doc, freteInicial: { ...(doc.freteInicial as Doc), ...over } };
  };
  /** The blocking read (PARTIALLY_SHIPPED, L2 cancelled) over `guardado`, `opcoes` on top. */
  const bloquear = (guardado: Doc, opcoes: OpcoesPedidoTeste = {}) =>
    montar(
      guardado,
      {
        status: 'PARTIALLY_SHIPPED',
        linhas: L2_CANCELADA,
        invoiceStatus: 'ACCEPTED',
        atualizadoEm: depois(60),
        ...opcoes,
      },
      { pagamento },
    );
  /** `doc` once `r` lands (a `sem-mudanca` leaves it as it is). */
  const depoisDe = (doc: Doc, r: EscritaPedidoAmazon): Doc =>
    r.tipo === 'atualizar' ? { ...doc, ...r.patch } : doc;
  const freteDepoisDe = (doc: Doc, r: EscritaPedidoAmazon): unknown =>
    (depoisDe(doc, r).freteInicial as Doc).estado;
  const patchOuVazio = (r: EscritaPedidoAmazon): Readonly<Record<string, unknown>> =>
    r.tipo === 'atualizar' ? r.patch : {};
  /** The block's own signals, whatever the estado: the aviso, the event, the lines kept, no pagamento. */
  function bloqueioSinalizado(r: EscritaPedidoAmazon, nome: string): void {
    expect(decisao(r), nome).toMatchObject({
      itens: 'divergencia-itens-aprovado',
      bloqueio: { causa: 'cancelamento-parcial', linhas: ['L2'] },
    });
    expect(decisao(r).avisos, nome).toContain('divergencia-itens');
    expect(decisao(r).eventos, nome).toContain(EVENTO_PEDIDO_AMAZON.cancelamentoParcial);
    expect(Object.hasOwn(patchOuVazio(r), 'itens'), nome).toBe(false);
    expect(pagamentoDe(r), nome).toEqual({ tipo: 'nada' });
  }
  /** The table's target stayed: pago, no error text, the stored lines. */
  function mantemPago(guardado: Doc, r: EscritaPedidoAmazon, nome: string): Doc {
    bloqueioSinalizado(r, nome);
    const doc = depoisDe(guardado, r);
    expect(doc.estado, nome).toBe(ESTADO_PEDIDO.pago);
    expect(doc.error ?? null, nome).toBeNull();
    expect(linhasDo(doc), nome).toEqual(linhasDo(guardado));
    return doc;
  }
  /** The block's error: estado error + our text (the reservation released), the stored lines. */
  function vaiParaErro(guardado: Doc, r: EscritaPedidoAmazon, nome: string): Doc {
    bloqueioSinalizado(r, nome);
    const doc = depoisDe(guardado, r);
    expect(doc, nome).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_BLOQUEIO });
    expect(linhasDo(doc), nome).toEqual(linhasDo(guardado));
    return doc;
  }

  it('★ the probe: stored pago + freight postado, then PARTIALLY_SHIPPED with L2 cancelled and PKG-1 PICKED_UP ⇒ pago KEPT (never error), divergencia-itens + cancelamento-parcial still raised; the next reads stay pago and stay blocked (row 6, then row 10)', () => {
    const guardado = comFreteGuardado({ estado: ESTADO_FRETE.postado });
    const r = bloquear(guardado, { pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')] });
    expect(decisao(r)).toMatchObject({
      linhaD17: 6,
      estadoEscrito: null,
      motivoEstado: 'sem-mudanca',
    });
    const doc = mantemPago(guardado, r, 'the probe');
    expect(Object.hasOwn(patchOuVazio(r), 'estado')).toBe(false);
    expect(Object.hasOwn(patchOuVazio(r), 'error')).toBe(false);

    // The next read, the same order, strictly newer: still row 6, still pago.
    const deNovo = bloquear(doc, {
      atualizadoEm: depois(120),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(decisao(deNovo).linhaD17).toBe(6);
    const doc2 = mantemPago(doc, deNovo, 'the next read');

    // Amazon drops the execution but L2 still says 0: the APPROVED comparison
    // (row 10 — `pago` is approved), still blocked, the lines never mirrored.
    const semExecucao = montar(
      doc2,
      {
        status: 'PARTIALLY_SHIPPED',
        linhas: [DUAS[0] ?? {}, linhaAmazon('L2', { qtd: 0, preco: '5.00' })],
        invoiceStatus: 'ACCEPTED',
        atualizadoEm: depois(180),
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
      },
      { pagamento },
    );
    expect(decisao(semExecucao)).toMatchObject({
      linhaD17: 10,
      itens: 'divergencia-itens-aprovado',
      bloqueio: { causa: 'itens', linhas: ['L2'] },
      estadoEscrito: null,
    });
    expect(decisao(semExecucao).avisos).toContain('divergencia-itens');
    expect(pagamentoDe(semExecucao)).toEqual({ tipo: 'nada' });
    const doc3 = depoisDe(doc2, semExecucao);
    expect(doc3.estado).toBe(ESTADO_PEDIDO.pago);
    expect(linhasDo(doc3)).toEqual(linhasDo(guardado));
  });

  it('★ the goods out from THIS read alone (stored aguardandoAgendamento, PKG-1 PICKED_UP) ⇒ pago kept, the freight written postado; NEAR-MISS: the same read with PKG-1 still waiting for its invoice ⇒ our error', () => {
    const guardado = comFreteGuardado({ estado: ESTADO_FRETE.aguardandoAgendamento });
    const fora = bloquear(guardado, { pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')] });
    mantemPago(guardado, fora, 'picked up');
    expect(freteDepoisDe(guardado, fora)).toBe(ESTADO_FRETE.postado);

    const dentro = bloquear(guardado, {
      invoiceStatus: 'NOT_FOUND',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_SCHEDULE')],
    });
    vaiParaErro(guardado, dentro, 'still waiting');
    expect(freteDepoisDe(guardado, dentro)).toBe(ESTADO_FRETE.aguardandoAgendamento);
  });

  it('★ the goods-out reading ALONE, the freight estado outside the removal set ⇒ pago kept: PKG-1 PICKED_UP beside a sibling whose token blocks the fold (the block does not move), and a migrated fulfillment residue under a MERCHANT read', () => {
    const aguardando = comFreteGuardado({ estado: ESTADO_FRETE.aguardandoAgendamento });
    // The unknown sibling's closed status is PENDING, so the picked-up package alone says it.
    const r = bloquear(aguardando, {
      pacotesBrutos: [
        pacoteAmazon('PKG-1', 'PICKED_UP'),
        pacoteAmazon('PKG-2', 'TOKEN_NOVO_X', { status: 'PENDING' }),
      ],
    });
    expect(decisao(r).eventos).toContain(EVENTO_PEDIDO_AMAZON.pacoteNaoMapeado);
    expect(freteDepoisDe(aguardando, r)).toBe(ESTADO_FRETE.aguardandoAgendamento);
    mantemPago(aguardando, r, 'blocked fold');

    const residuo = comFreteGuardado({ estado: ESTADO_FRETE.fulfillment });
    expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(ESTADO_FRETE.fulfillment)).toBe(false);
    const doResiduo = bloquear(residuo);
    mantemPago(residuo, doResiduo, 'residue');
    expect(freteDepoisDe(residuo, doResiduo)).toBe(ESTADO_FRETE.fulfillment);
  });

  it('★ (PR 5-f, item 3) the goods-out reading includes the closed-status fallback: PKG-1 with no detailedStatus that Amazon reports IN_TRANSIT, over a stored iniciado (outside the removal set) ⇒ pago kept, the freight not moved; NEAR-MISS: the same package at PENDING ⇒ our error', () => {
    const iniciado = comFreteGuardado({ estado: ESTADO_FRETE.iniciado });
    const emTransito = bloquear(iniciado, {
      pacotesBrutos: [pacoteAmazon('PKG-1', undefined, { status: 'IN_TRANSIT' })],
    });
    expect(freteDepoisDe(iniciado, emTransito)).toBe(ESTADO_FRETE.iniciado);
    const doc = mantemPago(iniciado, emTransito, 'status fallback');
    // The row it left keeps the next read (without packages) at pago too.
    mantemPago(doc, bloquear(doc, { atualizadoEm: depois(120) }), 'status fallback / next read');
    const pendente = bloquear(iniciado, {
      pacotesBrutos: [pacoteAmazon('PKG-1', undefined, { status: 'PENDING' })],
    });
    vaiParaErro(iniciado, pendente, 'status PENDING');
  });

  it('★ the removal applied with the goods still IN the warehouse (stored empacotado, aguardandoPostagem, checkFinalizado) ⇒ pago kept, and the next read keeps it', () => {
    for (const estadoFrete of [
      ESTADO_FRETE.empacotado,
      ESTADO_FRETE.aguardandoPostagem,
      ESTADO_FRETE.checkFinalizado,
    ]) {
      expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(estadoFrete), estadoFrete).toBe(true);
      const guardado = comFreteGuardado({ estado: estadoFrete });
      const r = bloquear(guardado);
      const doc = mantemPago(guardado, r, estadoFrete);
      expect(freteDepoisDe(guardado, r), estadoFrete).toBe(estadoFrete);
      const deNovo = bloquear(doc, { atualizadoEm: depois(120) });
      mantemPago(doc, deNovo, `${estadoFrete} / next read`);
    }
  });

  it('★ a removal THIS read starts (stored aguardandoAgendamento, PKG-1 PENDING_PICK_UP ⇒ aguardandoPostagem) ⇒ pago kept, and the next read agrees; NEAR-MISS: the same verdict on an amz block the schema refuses is never written ⇒ our error', () => {
    const guardado = comFreteGuardado({ estado: ESTADO_FRETE.aguardandoAgendamento });
    const agendado = [pacoteAmazon('PKG-1', 'PENDING_PICK_UP', { status: 'PENDING' })];
    const r = bloquear(guardado, { pacotesBrutos: agendado });
    const doc = mantemPago(guardado, r, 'scheduled now');
    expect(freteDepoisDe(guardado, r)).toBe(ESTADO_FRETE.aguardandoPostagem);
    mantemPago(
      doc,
      bloquear(doc, { atualizadoEm: depois(120), pacotesBrutos: agendado }),
      'scheduled now / next read',
    );

    // The estado reads, the block does not (a field the freight schema refuses).
    const ilegivel: Doc = {
      ...guardado,
      freteInicial: { ...(guardado.freteInicial as Doc), prazoDespacho: 'ilegivel' },
    };
    expect(freteDoPedidoSchema.safeParse(ilegivel.freteInicial).success).toBe(false);
    const naoGravado = bloquear(ilegivel, { pacotesBrutos: agendado });
    expect(decisao(naoGravado).eventos).toContain(EVENTO_PEDIDO_AMAZON.freteArmazenadoIlegivel);
    expect(freteDepoisDe(ilegivel, naoGravado)).toBe(ESTADO_FRETE.aguardandoAgendamento);
    vaiParaErro(ilegivel, naoGravado, 'unreadable block');
  });

  it('★ NEAR-MISS (the reservation rule stands): stored freight iniciado or aguardandoNFe, the goods in ⇒ our error, the reservation released; the next read keeps the error and the block', () => {
    for (const estadoFrete of [ESTADO_FRETE.iniciado, ESTADO_FRETE.aguardandoNFe]) {
      const guardado = comFreteGuardado({ estado: estadoFrete });
      const r = bloquear(guardado, { invoiceStatus: 'NOT_FOUND' });
      expect(decisao(r), estadoFrete).toMatchObject({ estadoEscrito: ESTADO_PEDIDO.error });
      const doc = vaiParaErro(guardado, r, estadoFrete);
      const deNovo = bloquear(doc, { invoiceStatus: 'NOT_FOUND', atualizadoEm: depois(120) });
      expect(decisao(deNovo), estadoFrete).toMatchObject({
        linhaD17: 6,
        motivoEstado: 'sem-mudanca',
      });
      vaiParaErro(doc, deNovo, `${estadoFrete} / next read`);
    }
  });

  it('★ NEAR-MISS (the freight AFTER this read, not the stored one): stored aguardandoPostagem + PKG-1 LABEL_CANCELLED ⇒ despachoNegado, the goods on the shelf ⇒ our error; the next read agrees', () => {
    const guardado = comFreteGuardado({ estado: ESTADO_FRETE.aguardandoPostagem });
    const cancelada = [pacoteAmazon('PKG-1', 'LABEL_CANCELLED')];
    const r = bloquear(guardado, { pacotesBrutos: cancelada });
    expect(freteDepoisDe(guardado, r)).toBe(ESTADO_FRETE.despachoNegado);
    const doc = vaiParaErro(guardado, r, 'pickup cancelled');
    vaiParaErro(
      doc,
      bloquear(doc, { atualizadoEm: depois(120), pacotesBrutos: cancelada }),
      'pickup cancelled / next read',
    );
  });

  it('★ a first-seen blocked order whose PKG-1 Amazon already reports PICKED_UP is CREATED at pago (no pagamento while blocked), and the next read keeps it; NEAR-MISS: the same order without packages is created at our error', () => {
    const leitura: OpcoesPedidoTeste = {
      status: 'PARTIALLY_SHIPPED',
      linhas: L2_CANCELADA,
      invoiceStatus: 'ACCEPTED',
    };
    const fora = montar(null, { ...leitura, pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')] });
    expect(fora.tipo).toBe('criar');
    const corpo = fora.tipo === 'criar' ? fora.corpo : {};
    expect(corpo).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      error: null,
      freteInicial: { estado: ESTADO_FRETE.postado },
    });
    expect(decisao(fora)).toMatchObject({
      linhaD17: 5,
      itens: 'escritas',
      bloqueio: { causa: 'cancelamento-parcial', linhas: ['L2'] },
    });
    expect(decisao(fora).avisos).toContain('divergencia-itens');
    expect(decisao(fora).eventos).toContain(EVENTO_PEDIDO_AMAZON.cancelamentoParcial);
    expect(pagamentoDe(fora)).toEqual({ tipo: 'nada' });
    // No pagamento while the block stands, and no pagamento-divergente for it:
    // the crítico aviso is the signal, and the pagamento is created once the
    // block ends (here: an operator's edit, D17 row 1).
    expect(decisao(fora).incidentes).not.toContain('pagamento-divergente');
    const editado = montar(
      { ...(fora.tipo === 'criar' ? fora.corpo : {}), hasUserInteraction: true },
      { ...leitura, atualizadoEm: depois(30), pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')] },
    );
    expect(decisao(editado)).toMatchObject({ linhaD17: 1, bloqueio: null });
    expect(pagamentoDe(editado).tipo).toBe('criar');

    const guardado: Doc = { ...corpo };
    const deNovo = montar(guardado, {
      ...leitura,
      atualizadoEm: depois(60),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
    });
    expect(decisao(deNovo).linhaD17).toBe(6);
    mantemPago(guardado, deNovo, 'created / next read');

    const dentro = montar(null, leitura);
    expect(dentro.tipo === 'criar' ? dentro.corpo : {}).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: TEXTO_BLOQUEIO,
    });

    // The goods-out reading ALONE on a create: PKG-1 picked up beside a sibling
    // whose token blocks the fold, so the seed's freight stays iniciado (outside
    // the removal set) — still created at pago, and the next read agrees.
    const dobraBloqueada = {
      ...leitura,
      pacotesBrutos: [
        pacoteAmazon('PKG-1', 'PICKED_UP'),
        pacoteAmazon('PKG-2', 'TOKEN_NOVO_X', { status: 'PENDING' }),
      ],
    };
    const soMercadoria = montar(null, dobraBloqueada);
    const corpoMercadoria = soMercadoria.tipo === 'criar' ? soMercadoria.corpo : {};
    expect(corpoMercadoria).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      error: null,
      freteInicial: { estado: ESTADO_FRETE.iniciado },
    });
    expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(ESTADO_FRETE.iniciado)).toBe(false);
    expect(pagamentoDe(soMercadoria)).toEqual({ tipo: 'nada' });
    const guardadoMercadoria: Doc = { ...corpoMercadoria };
    mantemPago(
      guardadoMercadoria,
      montar(guardadoMercadoria, { ...dobraBloqueada, atualizadoEm: depois(60) }),
      'blocked fold, created / next read',
    );
  });

  it('★ a block held at our error LEAVES it once a removal stands (stored error + aguardandoAgendamento, then PKG-1 PENDING_PICK_UP) ⇒ pago, our text cleared, the block and its aviso kept', () => {
    const guardado = comFreteGuardado({ estado: ESTADO_FRETE.aguardandoAgendamento });
    const noErro = depoisDe(guardado, bloquear(guardado));
    expect(noErro).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_BLOQUEIO });
    const r = bloquear(noErro, {
      atualizadoEm: depois(120),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
    });
    expect(decisao(r)).toMatchObject({ estadoEscrito: ESTADO_PEDIDO.pago, linhaD17: 6 });
    expect(patchDe(r)).toMatchObject({ estado: ESTADO_PEDIDO.pago, error: null });
    mantemPago(noErro, r, 'removal starts over our error');
  });
});

describe('★ PR 5-f — a pedido ALREADY held at our block error: it leaves for pago once the goods are out or the freight removes stock, whatever the read’s status or logistics; and a known PENDING never drops the lock', () => {
  const pagamento = pagamentoCriado({ invoiceStatus: 'ACCEPTED' });
  /** L1 2 → 1: a row-10 block ("itens"). */
  const DIVERGENTES = [linhaAmazon('L1', { qtd: 1, preco: '10.00' }), DUAS[1] ?? {}];
  const TEXTO_BLOQUEIO = `${PREFIXO_ERRO_AMAZON}itens divergentes do pedido na Amazon: L1`;
  const depoisDe = (doc: Doc, r: EscritaPedidoAmazon): Doc =>
    r.tipo === 'atualizar' ? { ...doc, ...r.patch } : doc;
  const freteDe = (doc: Doc): unknown => (doc.freteInicial as Doc).estado;
  /**
   * A stored pago (UNSHIPPED, invoice ACCEPTED: freight aguardandoAgendamento,
   * outside the removal set), then the row-10 block with no package: our
   * error, the reservation released, the lines kept.
   */
  function noErroDeBloqueio(): Doc {
    const guardado = criado({ linhas: DUAS, invoiceStatus: 'ACCEPTED' });
    const r = montar(
      guardado,
      { linhas: DIVERGENTES, invoiceStatus: 'ACCEPTED', atualizadoEm: depois(60) },
      { pagamento },
    );
    expect(decisao(r)).toMatchObject({ linhaD17: 10, bloqueio: { causa: 'itens' } });
    const doc = depoisDe(guardado, r);
    expect(doc).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_BLOQUEIO });
    expect(freteDe(doc)).toBe(ESTADO_FRETE.aguardandoAgendamento);
    return doc;
  }
  /** A later read over `doc` with the divergent lines, `opcoes` on top. */
  const ler = (doc: Doc, opcoes: OpcoesPedidoTeste, segundos = 120) =>
    montar(
      doc,
      {
        linhas: DIVERGENTES,
        invoiceStatus: 'ACCEPTED',
        atualizadoEm: depois(segundos),
        ...opcoes,
      },
      { pagamento },
    );
  /** The importer's resolver never closes divergencia-itens on `r`. */
  function avisoAberto(r: EscritaPedidoAmazon, estadoFinal: EstadoPedido, nome: string): void {
    expect(decisao(r).itensConferem, nome).toBe(false);
    const { resolver } = motivosDoPedidoAmazon({
      decisao: decisao(r),
      fase: 'desconhecida',
      estadoFinal,
    });
    expect(resolver, nome).not.toContain('divergencia-itens');
  }

  it('★ the probe: our block error, then a read whose status or logistics is unknown (INVOICE_UNCONFIRMED, a new token, no fulfillment object, UNSHIPPED without fulfilledBy) or a MERCHANT PENDING, while Amazon reports the package picked up or its pickup scheduled ⇒ pago, our text cleared, the lines kept, no pagamento, the aviso open; the next MERCHANT read re-derives the block and keeps pago', () => {
    const casos: readonly [string, OpcoesPedidoTeste, string, number][] = [
      [
        'INVOICE_UNCONFIRMED',
        { status: 'INVOICE_UNCONFIRMED', pacotes: ['PICKED_UP'] },
        ESTADO_FRETE.postado,
        13,
      ],
      [
        'a new token',
        { status: 'SOMETHING_NEW', pacotes: ['PENDING_PICK_UP'] },
        ESTADO_FRETE.aguardandoPostagem,
        13,
      ],
      [
        'no fulfillment',
        { semFulfillment: true, pacotes: ['PICKED_UP'] },
        ESTADO_FRETE.postado,
        13,
      ],
      [
        'UNSHIPPED without fulfilledBy',
        { por: null, pacotes: ['PICKED_UP'] },
        ESTADO_FRETE.postado,
        10,
      ],
      ['MERCHANT PENDING', { status: 'PENDING', pacotes: ['PICKED_UP'] }, ESTADO_FRETE.postado, 12],
    ];
    for (const [nome, opcoes, freteEsperado, linha] of casos) {
      const noErro = noErroDeBloqueio();
      const r = ler(noErro, opcoes);
      expect(decisao(r), nome).toMatchObject({
        linhaD17: linha,
        estadoEscrito: ESTADO_PEDIDO.pago,
      });
      expect(patchDe(r), nome).toMatchObject({ estado: ESTADO_PEDIDO.pago, error: null });
      expect(Object.hasOwn(patchDe(r), 'itens'), nome).toBe(false);
      expect(pagamentoDe(r), nome).toEqual({ tipo: 'nada' });
      avisoAberto(r, ESTADO_PEDIDO.pago, nome);
      const doc = depoisDe(noErro, r);
      expect(freteDe(doc), nome).toBe(freteEsperado);
      expect(linhasDo(doc), nome).toEqual(linhasDo(noErro));

      // The lock holds: a MERCHANT UNSHIPPED with the same lines is row 10 again, pago kept.
      const seguinte = ler(doc, { pacotes: ['PICKED_UP'] }, 180);
      expect(decisao(seguinte), nome).toMatchObject({
        linhaD17: 10,
        bloqueio: { causa: 'itens' },
        estadoEscrito: null,
      });
      expect(linhasDo(depoisDe(doc, seguinte)), nome).toEqual(linhasDo(noErro));
      expect(depoisDe(doc, seguinte).estado, nome).toBe(ESTADO_PEDIDO.pago);
    }
  });

  it('★ NEAR-MISS: the same reads with the goods in and no removal (no package, the freight still aguardandoAgendamento) keep our error and its text — the reservation stays released', () => {
    const casos: readonly [string, OpcoesPedidoTeste, string][] = [
      ['INVOICE_UNCONFIRMED', { status: 'INVOICE_UNCONFIRMED' }, 'manter'],
      ['no fulfillment', { semFulfillment: true }, 'manter'],
      [
        'UNSHIPPED without fulfilledBy (row 10: the block re-derived)',
        { por: null },
        'sem-mudanca',
      ],
      ['MERCHANT PENDING', { status: 'PENDING' }, 'regressivo'],
    ];
    for (const [nome, opcoes, motivo] of casos) {
      const noErro = noErroDeBloqueio();
      const r = ler(noErro, opcoes);
      expect(decisao(r), nome).toMatchObject({ estadoEscrito: null, motivoEstado: motivo });
      const doc = depoisDe(noErro, r);
      expect(doc, nome).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_BLOQUEIO });
      expect(freteDe(doc), nome).toBe(ESTADO_FRETE.aguardandoAgendamento);
    }
  });

  it('★ NEAR-MISS (scope): a CANCELLED read with the goods out keeps our error (the predicate decides: cancelado-apos-envio); an AFN read over a removal takes the table’s own error; our NON-block errors (logistics, AFN, unknown status) stay where they are', () => {
    const noErro = noErroDeBloqueio();
    const cancelado = ler(noErro, { status: 'CANCELLED', pacotes: ['PICKED_UP'] });
    expect(decisao(cancelado)).toMatchObject({ estadoEscrito: null, motivoEstado: 'manter' });
    expect(decisao(cancelado).incidentes).toContain('cancelado-apos-envio');
    expect(depoisDe(noErro, cancelado).estado).toBe(ESTADO_PEDIDO.error);

    const comRemocao: Doc = {
      ...noErro,
      freteInicial: { ...(noErro.freteInicial as Doc), estado: ESTADO_FRETE.aguardandoPostagem },
    };
    const afn = ler(comRemocao, { por: 'AMAZON' });
    expect(depoisDe(comRemocao, afn)).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: TEXTO_ERRO_AMAZON.afn,
    });

    for (const error of [
      TEXTO_ERRO_AMAZON.logisticaDesconhecida,
      TEXTO_ERRO_AMAZON.afn,
      TEXTO_ERRO_AMAZON.statusDesconhecido,
    ]) {
      const guardado: Doc = { ...comRemocao, error };
      const r = ler(guardado, { status: 'INVOICE_UNCONFIRMED', pacotes: ['PICKED_UP'] });
      expect(decisao(r), error).toMatchObject({ estadoEscrito: null, motivoEstado: 'manter' });
      expect(depoisDe(guardado, r), error).toMatchObject({ estado: ESTADO_PEDIDO.error, error });
    }
  });

  it('★ the lock survives a KNOWN pre-approval status: block, then MERCHANT PENDING (row 12: our error KEPT as a regression, with its text and the stored lines), then UNSHIPPED with the same divergent lines ⇒ row 10 blocks again — never the row-9 mirror, the pagamento valor untouched', () => {
    const noErro = noErroDeBloqueio();
    const pendente = ler(noErro, { status: 'PENDING' });
    expect(decisao(pendente)).toMatchObject({
      linhaD17: 12,
      estadoEscrito: null,
      motivoEstado: 'regressivo',
      itensConferem: false,
    });
    const doc = depoisDe(noErro, pendente);
    expect(doc).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_BLOQUEIO });
    expect((doc.marketplace as Doc).status).toBe('PENDING');

    const aprovado = ler(doc, {}, 180);
    expect(decisao(aprovado)).toMatchObject({
      linhaD17: 10,
      itens: 'divergencia-itens-aprovado',
      bloqueio: { causa: 'itens', linhas: ['L1'] },
    });
    expect(decisao(aprovado).avisos).toContain('divergencia-itens');
    expect(pagamentoDe(aprovado)).toEqual({ tipo: 'nada' });
    const final = depoisDe(doc, aprovado);
    expect(final).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_BLOQUEIO });
    expect(linhasDo(final)).toEqual(linhasDo(noErro));
  });

  it('★ NEAR-MISS: our error that was never approved (a PENDING create without fulfilledBy) still moves to aguardandoConfirmacaoDePagamento on MERCHANT PENDING, and its first UNSHIPPED mirrors the lines (row 9), as before', () => {
    const r0 = montar(null, { status: 'PENDING', por: null, linhas: DUAS });
    const criadoSemPor: Doc = r0.tipo === 'criar' ? { ...r0.corpo } : {};
    expect(criadoSemPor).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
    });
    const pendente = montar(criadoSemPor, {
      status: 'PENDING',
      linhas: DUAS,
      atualizadoEm: depois(60),
    });
    expect(decisao(pendente)).toMatchObject({
      estadoEscrito: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    });
    const doc = depoisDe(criadoSemPor, pendente);
    const aprovado = montar(doc, { linhas: DIVERGENTES, atualizadoEm: depois(120) });
    expect(decisao(aprovado)).toMatchObject({ linhaD17: 9, itens: 'espelhadas' });
    expect(linhasDo(depoisDe(doc, aprovado))).toEqual([
      { id: 'L1', q: 1, p: 10 },
      { id: 'L2', q: 1, p: 5 },
    ]);
  });
});

describe('★ PR 5-f — an approved pedido never sits without a pagamento in silence, and divergencia-itens resolves only on lines that agree', () => {
  /** L1 intact, L2 cancelled on Amazon (an executed line cancellation that stays on the line). */
  const L2_CANCELADA = [
    DUAS[0] ?? {},
    linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
  ];
  const TEXTO_BLOQUEIO = `${PREFIXO_ERRO_AMAZON}linha cancelada na Amazon em pedido a enviar: L2`;
  const depoisDe = (doc: Doc, r: EscritaPedidoAmazon): Doc =>
    r.tipo === 'atualizar' ? { ...doc, ...r.patch } : doc;
  /** An operator's fix on the pedido form: L2 dropped, the edit latch stamped. */
  const corrigido = (doc: Doc): Doc => {
    const itens = doc.itens as Record<string, Doc[]>;
    return {
      ...doc,
      hasUserInteraction: true,
      itens: Object.fromEntries(
        Object.entries(itens).map(([chave, linhas]) => [
          chave,
          linhas.filter((l) => l.mktplaceId !== 'L2'),
        ]),
      ),
    };
  };
  /** The block of a line cancellation (row 6) over `guardado`: our error, the lines kept. */
  function bloqueado(guardado: Doc, pagamento: Doc | null): Doc {
    const r = montar(
      guardado,
      { status: 'UNSHIPPED', linhas: L2_CANCELADA, atualizadoEm: depois(60) },
      { pagamento },
    );
    expect(decisao(r)).toMatchObject({
      linhaD17: 6,
      bloqueio: { causa: 'cancelamento-parcial', linhas: ['L2'] },
      itensConferem: false,
    });
    expect(pagamentoDe(r)).toEqual({ tipo: 'nada' });
    const doc = depoisDe(guardado, r);
    expect(doc).toMatchObject({ estado: ESTADO_PEDIDO.error, error: TEXTO_BLOQUEIO });
    return doc;
  }
  /** Amazon ships the order while L2 still carries its execution (X with SHIPPED: a reversal). */
  const enviadoComX = (doc: Doc, segundos: number, pagamento: Doc | null = null) =>
    montar(
      doc,
      { status: 'SHIPPED', linhas: L2_CANCELADA, atualizadoEm: depois(segundos) },
      { pagamento },
    );

  describe('(a) no pagamento + a possible reversal on an approved read ⇒ pagamento-divergente, never silence', () => {
    it('★ the likeliest path: PENDING first (no pagamento), the line cancellation blocks it, an operator fixes the lines, and the first read after the fix is already SHIPPED with the execution still on L2 ⇒ pago, NOTHING created, no status claimed, and pagamento-divergente — on the next SHIPPED read too', () => {
      const fixado = corrigido(bloqueado(PENDENTE(), null));
      const r = enviadoComX(fixado, 120);
      expect(decisao(r)).toMatchObject({
        linhaD17: 1,
        itens: 'congeladas',
        estadoEscrito: ESTADO_PEDIDO.pago,
        statusPagamento: null,
        incidentes: ['pagamento-divergente'],
      });
      expect(pagamentoDe(r)).toEqual({ tipo: 'nada' });
      const doc = depoisDe(fixado, r);
      expect(doc).toMatchObject({ estado: ESTADO_PEDIDO.pago, error: null });
      // The execution never leaves the line, so no later read creates one: each says so.
      const deNovo = enviadoComX(doc, 180);
      expect(pagamentoDe(deNovo)).toEqual({ tipo: 'nada' });
      expect(decisao(deNovo).incidentes).toEqual(['pagamento-divergente']);
    });

    it('★ NEAR-MISS: the same fix, but the first read after it is UNSHIPPED (the execution still on L2, not a reversal) ⇒ the pagamento is CREATED at aprovado for the operator’s lines, nothing filed', () => {
      const fixado = corrigido(bloqueado(PENDENTE(), null));
      const r = montar(fixado, {
        status: 'UNSHIPPED',
        linhas: L2_CANCELADA,
        atualizadoEm: depois(120),
      });
      expect(decisao(r)).toMatchObject({
        linhaD17: 1,
        estadoEscrito: ESTADO_PEDIDO.pago,
        statusPagamento: STATUS_PAGAMENTO.aprovado,
      });
      expect(pagamentoDe(r)).toMatchObject({
        tipo: 'criar',
        corpo: { status_pagamento: STATUS_PAGAMENTO.aprovado, valor: 20 },
      });
      expect(decisao(r).incidentes).not.toContain('pagamento-divergente');
    });

    it('★ without the fix: the blocked pedido read SHIPPED with the execution ⇒ row 4, pago, nothing created, pagamento-divergente beside possivel-reembolso', () => {
      const r = enviadoComX(bloqueado(PENDENTE(), null), 120);
      expect(decisao(r)).toMatchObject({
        linhaD17: 4,
        itens: 'itens-preservados-reversao',
        estadoEscrito: ESTADO_PEDIDO.pago,
        statusPagamento: null,
        incidentes: ['pagamento-divergente', 'possivel-reembolso'],
      });
      expect(pagamentoDe(r)).toEqual({ tipo: 'nada' });
    });

    it('★ NEAR-MISS: a pedido WITH its pagamento keeps today’s path — the same reads leave it untouched (aprovado) and file only possivel-reembolso, or nothing when frozen', () => {
      const pagamento = pagamentoCriado();
      const r = enviadoComX(bloqueado(PAGO(), pagamento), 120, pagamento);
      expect(decisao(r)).toMatchObject({
        linhaD17: 4,
        estadoEscrito: ESTADO_PEDIDO.pago,
        statusPagamento: STATUS_PAGAMENTO.aprovado,
        incidentes: ['possivel-reembolso'],
      });
      expect(pagamentoDe(r)).toEqual({ tipo: 'nada' });
      const congelado = enviadoComX(corrigido(bloqueado(PAGO(), pagamento)), 120, pagamento);
      expect(decisao(congelado)).toMatchObject({
        linhaD17: 1,
        statusPagamento: STATUS_PAGAMENTO.aprovado,
        incidentes: [],
      });
    });

    it('★ the arm is the reversal, not X alone: a returned package on a stored pago without a pagamento files it too; NEAR-MISS (scope): a reversal over an estado the operator owns, a CANCELLED with none stored, and a plain SHIPPED file nothing of the kind', () => {
      const enviado = { status: 'SHIPPED', linhas: DUAS, atualizadoEm: depois(60) } as const;
      const p = montar(PAGO(), { ...enviado, pacotes: ['RETURNED_TO_SELLER'] });
      expect(decisao(p)).toMatchObject({
        linhaD17: 4,
        statusPagamento: null,
        incidentes: ['pagamento-divergente', 'possivel-reembolso'],
      });
      expect(pagamentoDe(p)).toEqual({ tipo: 'nada' });
      const doOperador = montar(PAGO({ estado: ESTADO_PEDIDO.finalizado }), {
        ...enviado,
        pacotes: ['RETURNED_TO_SELLER'],
      });
      expect(decisao(doOperador).motivoEstado).toBe('fora-da-escada');
      expect(decisao(doOperador).incidentes).toEqual(['possivel-reembolso']);
      const cancelado = montar(PAGO(), { ...enviado, status: 'CANCELLED' });
      expect(decisao(cancelado).estadoEscrito).toBe(ESTADO_PEDIDO.cancelado);
      expect(decisao(cancelado).incidentes).not.toContain('pagamento-divergente');
      const simples = montar(PAGO(), enviado);
      expect(pagamentoDe(simples)).toMatchObject({ tipo: 'criar' });
      expect(decisao(simples).incidentes).not.toContain('pagamento-divergente');
    });
  });

  describe('(b) the lines’ verdict (itensConferem), the one fact divergencia-itens resolves on', () => {
    it('★ a row-6 block then SHIPPED with the execution still on L2 ⇒ the estado leaves our error for pago (the goods are out) but the lines were NOT judged: itensConferem false; NEAR-MISS: frozen ⇒ true; Amazon’s lines agreeing again (UNSHIPPED, row 10) ⇒ true', () => {
      const pagamento = pagamentoCriado();
      const noErro = bloqueado(PAGO(), pagamento);
      const r = enviadoComX(noErro, 120, pagamento);
      expect(decisao(r)).toMatchObject({
        linhaD17: 4,
        estadoEscrito: ESTADO_PEDIDO.pago,
        itensConferem: false,
      });
      expect(patchDe(r)).toMatchObject({ estado: ESTADO_PEDIDO.pago, error: null });
      expect(linhasDo(depoisDe(noErro, r))).toEqual(linhasDo(noErro));
      expect(decisao(enviadoComX(corrigido(noErro), 120, pagamento))).toMatchObject({
        linhaD17: 1,
        itensConferem: true,
      });
      const deAcordo = montar(
        noErro,
        { status: 'UNSHIPPED', linhas: DUAS, atualizadoEm: depois(120) },
        { pagamento },
      );
      expect(decisao(deAcordo)).toMatchObject({
        linhaD17: 10,
        itens: 'mantidas',
        estadoEscrito: ESTADO_PEDIDO.pago,
        itensConferem: true,
      });
    });

    it('★ row 11 is JUDGED by row 10’s comparison: a row-10 block (L1 2 → 3) then SHIPPED with L1 still 3 ⇒ pago, divergencia-pos-envio, itensConferem false; NEAR-MISS: SHIPPED with the stored lines ⇒ true', () => {
      const pagamento = pagamentoCriado();
      const trocada = [linhaAmazon('L1', { qtd: 3, preco: '10.00' }), DUAS[1] ?? {}];
      const b = montar(
        PAGO(),
        { status: 'UNSHIPPED', linhas: trocada, atualizadoEm: depois(60) },
        { pagamento },
      );
      expect(decisao(b)).toMatchObject({ linhaD17: 10, bloqueio: { causa: 'itens' } });
      const noErro = depoisDe(PAGO(), b);
      const enviado = montar(
        noErro,
        { status: 'SHIPPED', linhas: trocada, atualizadoEm: depois(120) },
        { pagamento },
      );
      expect(decisao(enviado)).toMatchObject({
        linhaD17: 11,
        itens: 'mantidas',
        estadoEscrito: ESTADO_PEDIDO.pago,
        itensConferem: false,
      });
      expect(decisao(enviado).eventos).toContain(EVENTO_PEDIDO_AMAZON.divergenciaPosEnvio);
      const igual = montar(
        noErro,
        { status: 'SHIPPED', linhas: DUAS, atualizadoEm: depois(120) },
        { pagamento },
      );
      expect(decisao(igual)).toMatchObject({ linhaD17: 11, itensConferem: true });
      expect(decisao(igual).eventos).not.toContain(EVENTO_PEDIDO_AMAZON.divergenciaPosEnvio);
    });

    it('★ with the goods-out rule in the tree: a block over goods already out keeps pago (sem-mudanca), and the next SHIPPED read with the execution is row 4, not judged (itensConferem false) — so a KEPT estado no longer resolves the aviso; NEAR-MISS: frozen ⇒ true', () => {
      const pagamento = pagamentoCriado();
      const base = criado({ linhas: DUAS, invoiceStatus: 'ACCEPTED' });
      const guardado = {
        ...base,
        freteInicial: { ...(base.freteInicial as Doc), estado: ESTADO_FRETE.postado },
      };
      const leitura = (status: string, segundos: number): OpcoesPedidoTeste => ({
        status,
        linhas: L2_CANCELADA,
        invoiceStatus: 'ACCEPTED',
        atualizadoEm: depois(segundos),
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
      });
      const b = montar(guardado, leitura('PARTIALLY_SHIPPED', 60), { pagamento });
      expect(decisao(b)).toMatchObject({ linhaD17: 6, motivoEstado: 'sem-mudanca' });
      const doc = depoisDe(guardado, b);
      expect(doc.estado).toBe(ESTADO_PEDIDO.pago);
      const r = montar(doc, leitura('SHIPPED', 120), { pagamento });
      expect(decisao(r)).toMatchObject({
        linhaD17: 4,
        motivoEstado: 'sem-mudanca',
        itensConferem: false,
      });
      expect(
        decisao(montar(corrigido(doc), leitura('SHIPPED', 120), { pagamento })).itensConferem,
      ).toBe(true);
    });

    it('★ one row at a time: the rows that write, mirror or compare equal agree; a reversal, a block, a regression, an unknown status and a mirror that KEPT a stored line value do not', () => {
      const pagamento = pagamentoCriado();
      const conferem = (r: EscritaPedidoAmazon) => {
        const d = decisao(r);
        return { linha: d.linhaD17, conferem: d.itensConferem };
      };
      const novo = { linhas: DUAS };
      const casos: readonly [string, EscritaPedidoAmazon, number, boolean][] = [
        ['create (row 7)', montar(null, novo), 7, true],
        ['create blocked (row 5)', montar(null, { linhas: L2_CANCELADA }), 5, false],
        [
          'congeladas (row 1)',
          montar(PAGO({ hasUserInteraction: true }), {
            linhas: [linhaAmazon('L1', { qtd: 9, preco: '1.00' })],
          }),
          1,
          true,
        ],
        [
          'a reversal (row 4)',
          montar(PAGO(), { status: 'SHIPPED', linhas: DUAS, pacotes: ['RETURNED_TO_SELLER'] }),
          4,
          false,
        ],
        ['a block (row 6)', montar(PAGO(), { linhas: L2_CANCELADA }), 6, false],
        [
          'a PENDING mirror (row 8)',
          montar(PENDENTE(), {
            status: 'PENDING',
            linhas: [linhaAmazon('L1', { qtd: 3, preco: '10.00' })],
          }),
          8,
          true,
        ],
        [
          'a PENDING mirror that KEEPS the stored qty of an executed line (row 8)',
          montar(PENDENTE(), { status: 'PENDING', linhas: L2_CANCELADA }),
          8,
          false,
        ],
        [
          'a PENDING mirror with nothing to compare (row 8)',
          montar(PENDENTE(), { status: 'PENDING', linhas: [] }),
          8,
          false,
        ],
        [
          'the approval moment (row 9)',
          montar(PENDENTE(), { linhas: [linhaAmazon('L1', { qtd: 2, preco: '12.00' })] }),
          9,
          true,
        ],
        ['compared equal (row 10)', montar(PAGO(), novo, { pagamento }), 10, true],
        [
          'compared different (row 10)',
          montar(PAGO(), { linhas: [linhaAmazon('L1', { qtd: 1, preco: '10.00' })] }),
          10,
          false,
        ],
        [
          'the pagamento term (row 10)',
          montar(PAGO(), novo, { pagamento: { ...pagamento, valor: 24 } }),
          10,
          false,
        ],
        ['SHIPPED, equal (row 11)', montar(PAGO(), { ...novo, status: 'SHIPPED' }), 11, true],
        [
          'SHIPPED, a price changed (row 11)',
          montar(PAGO(), {
            status: 'SHIPPED',
            linhas: [linhaAmazon('L1', { qtd: 2, preco: '11.00' }), DUAS[1] ?? {}],
          }),
          11,
          false,
        ],
        [
          // Row 10's comparison, the ORDER money included (the post-shipment
          // divergence log reads the lines only, and would call this equal).
          'SHIPPED, the order discount changed (row 11)',
          montar(PAGO(), {
            status: 'SHIPPED',
            linhas: [
              linhaAmazon('L1', {
                qtd: 2,
                preco: '10.00',
                quebras: [{ type: 'DISCOUNT', subtotal: brl('-2.00') }],
              }),
              DUAS[1] ?? {},
            ],
          }),
          11,
          false,
        ],
        [
          'approved, then PENDING (row 12)',
          montar(PAGO(), { ...novo, status: 'PENDING', atualizadoEm: depois(60) }),
          12,
          false,
        ],
        [
          'an unknown status (row 13)',
          montar(PAGO(), { ...novo, status: 'INVOICE_UNCONFIRMED' }),
          13,
          false,
        ],
      ];
      for (const [nome, r, linha, esperado] of casos) {
        expect(conferem(r), nome).toEqual({ linha, conferem: esperado });
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/*          PR 5-f: what the order money cannot state ⇒ an incidente           */
/* -------------------------------------------------------------------------- */

describe('★ PR 5-f — a money shape the pagamento check cannot see files its incidente on an APPROVED read', () => {
  /** L1 charges SHIPPING 8 and a DISCOUNT 3 whose shipping part is not itemised. */
  const SEM_DETALHE = [
    linhaAmazon('L1', {
      qtd: 2,
      preco: '10.00',
      quebras: [
        { type: 'SHIPPING', subtotal: brl('8.00') },
        { type: 'DISCOUNT', subtotal: brl('3.00') },
      ],
    }),
  ];
  /** The same amounts, the shipping part itemised (as 0: a pure goods discount). */
  const DETALHADO = [
    linhaAmazon('L1', {
      qtd: 2,
      preco: '10.00',
      quebras: [
        { type: 'SHIPPING', subtotal: brl('8.00') },
        {
          type: 'DISCOUNT',
          subtotal: brl('3.00'),
          detailedBreakdowns: [{ subtype: 'SHIPPING', value: brl('0.00') }],
        },
      ],
    }),
  ];
  /** A TAX row that is not 0, on a line with no discount. */
  const COM_IMPOSTO = [
    linhaAmazon('L1', {
      qtd: 2,
      preco: '10.00',
      quebras: [{ type: 'TAX', subtotal: brl('2.00') }],
    }),
  ];
  const DINHEIRO = 'desconto-nao-detalhado';
  const IMPOSTO = 'imposto-destacado';

  it('a create Amazon approved: the incidente, ONE event per shape, and the counts on the decision; the money itself as before', () => {
    const r = montar(null, { linhas: SEM_DETALHE });
    const d = decisao(r);
    expect(d.incidentes).toEqual([DINHEIRO]);
    expect(d.eventos).toContain(EVENTO_PEDIDO_AMAZON.descontoNaoDetalhado);
    expect(d.eventos).not.toContain(EVENTO_PEDIDO_AMAZON.impostoDestacado);
    expect(d.ressalvasDinheiro).toEqual({ linhasDescontoNaoDetalhado: 1, quebrasImposto: 0 });
    const corpo = r.tipo === 'criar' ? r.corpo : {};
    expect(corpo).toMatchObject({ descontoTotal: 3, freteInicial: { valorCobrado: 8 } });

    const t = decisao(montar(null, { linhas: COM_IMPOSTO }));
    expect(t.incidentes).toEqual([IMPOSTO]);
    expect(t.eventos).toContain(EVENTO_PEDIDO_AMAZON.impostoDestacado);
    expect(t.ressalvasDinheiro).toEqual({ linhasDescontoNaoDetalhado: 0, quebrasImposto: 1 });
  });

  it('NEAR-MISS: the same amounts itemised ⇒ no incidente, no event, zero counts', () => {
    const d = decisao(montar(null, { linhas: DETALHADO }));
    expect(d.incidentes).toEqual([]);
    expect(d.eventos).not.toContain(EVENTO_PEDIDO_AMAZON.descontoNaoDetalhado);
    expect(d.ressalvasDinheiro).toEqual({ linhasDescontoNaoDetalhado: 0, quebrasImposto: 0 });
  });

  it('NEAR-MISS: a PENDING read files nothing; the approval moment over it (row 9) files it; SHIPPED does too', () => {
    const pendente = decisao(montar(null, { status: 'PENDING', linhas: SEM_DETALHE }));
    expect(pendente.incidentes).toEqual([]);
    expect(pendente.eventos).not.toContain(EVENTO_PEDIDO_AMAZON.descontoNaoDetalhado);
    expect(pendente.ressalvasDinheiro).toEqual({
      linhasDescontoNaoDetalhado: 0,
      quebrasImposto: 0,
    });

    const guardado = criado({ status: 'PENDING', linhas: SEM_DETALHE });
    const aprovacao = decisao(montar(guardado, { linhas: SEM_DETALHE, atualizadoEm: depois(60) }));
    expect(aprovacao.linhaD17).toBe(9);
    expect(aprovacao.incidentes).toContain(DINHEIRO);
    expect(aprovacao.ressalvasDinheiro.linhasDescontoNaoDetalhado).toBe(1);

    const enviado = decisao(
      montar(criado({ linhas: SEM_DETALHE }), {
        status: 'SHIPPED',
        linhas: SEM_DETALHE,
        atualizadoEm: depois(60),
      }),
    );
    expect(enviado.incidentes).toContain(DINHEIRO);
  });

  it('NEAR-MISS: a CANCELLED read (nothing is emitted for it) and an unknown status file nothing', () => {
    for (const status of ['CANCELLED', 'INVOICE_UNCONFIRMED']) {
      const d = decisao(
        montar(criado({ linhas: SEM_DETALHE }), {
          status,
          linhas: SEM_DETALHE,
          atualizadoEm: depois(60),
        }),
      );
      expect(d.incidentes, status).not.toContain(DINHEIRO);
      expect(d.ressalvasDinheiro, status).toEqual({
        linhasDescontoNaoDetalhado: 0,
        quebrasImposto: 0,
      });
    }
  });

  it('whatever the D17 row: a create BLOCKED by an executed line cancellation (row 5) still files it', () => {
    const r = montar(null, {
      linhas: [...SEM_DETALHE, linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true })],
    });
    const d = decisao(r);
    expect(d.bloqueio).not.toBeNull();
    expect(d.incidentes).toContain(DINHEIRO);
    expect(d.eventos).toEqual(
      expect.arrayContaining([
        EVENTO_PEDIDO_AMAZON.cancelamentoParcial,
        EVENTO_PEDIDO_AMAZON.descontoNaoDetalhado,
      ]),
    );
  });

  it('decision 26: both are pedido INCIDENTES, never aviso motivos (the schema refuses them)', () => {
    for (const codigo of [DINHEIRO, IMPOSTO]) {
      expect(motivoPedidoAmazonSchema.safeParse(codigo).success, codigo).toBe(false);
    }
  });
});
