/**
 * The one test that crosses the import's money mappers — `itensMapeamento.ts`,
 * `freteMapeamento.ts`, `pedidoMapeamento.ts` and `pagamentoMapeamento.ts` — with
 * the ERP's own derivations in `@delfrance/schemas`: `derivePedidoFreteTotals`
 * (what the operator's first save, the pedido footer and the print recompute)
 * and `sumPagamentosPagos` (the paid sum every reconcile and the NF-e read).
 *
 * Neither side can see a disagreement alone: the line mapper proves the
 * discount is mapped, the pedido mapper that the header is written, and only
 * adding them up the way the ERP does says whether the imported pedido and its
 * payments agree to the centavo. The Shopee `totais.test.ts` shape.
 *
 * ⚠️ The NF-e adds the freight to its total only under CIF, and on a
 * marketplace tipo it refuses payments that do not sum to that total. So the
 * identity checked here is the NF-e's: Σ payments == the derived total minus
 * the freight when the block is NOT CIF. An order with freight imported as FOB
 * fails it — which is why freight forces CIF.
 *
 * ⚠️ Captures are compared as booleans (`wireCorpus.test.ts` convention): a
 * failure never prints a body value.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { roundReais } from '@delfrance/core/money';
import { liPedidoSchema, type PedidoLi } from '@delfrance/integrations-loja-integrada';
import {
  MODALIDADE_FRETE,
  STATUS_PAGAMENTO,
  derivePedidoFreteTotals,
  sumPagamentosPagos,
  type FreteDoPedido,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { DIRETORIO_WIRE_LI, lerFixtureLi } from '../fixtures/wireCorpus';
import { dataLiParaMicros } from './dataLi';
import { MODO_HISTORICO_LI, lerHistoricoLi } from './estadoPedidoLi';
import { freteDeCriacaoLi, mapearFreteLi } from './freteMapeamento';
import { mapearItensLi } from './itensMapeamento';
import { mapearPagamentosLi } from './pagamentoMapeamento';
import { mapearPedidoLi, montarEscritaPedidoLi } from './pedidoMapeamento';

const PEDIDOS = [
  'pedido-aguardando.json',
  'pedido-boleto.json',
  'pedido-cancelado.json',
  'pedido-cartao.json',
  'pedido-pix.json',
] as const;

const AGORA_US = 1_900_000_000_000_000;

function detalhe(nome: string): PedidoLi {
  const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, nome), 'utf8'));
  if (!leitura.ok) throw new Error(`${nome}: not a fixture envelope`);
  const r = liPedidoSchema.safeParse(leitura.data.resposta.corpo);
  if (!r.success) throw new Error(`${nome}: does not parse`);
  return r.data;
}

/** The whole money path for one order: lines → freight → pedido → payments, then the ERP's sums. */
function importar(pedido: PedidoLi, modalidadeConta = MODALIDADE_FRETE.fob) {
  const h = lerHistoricoLi({
    numero: pedido.numero,
    codigoDetalhe: pedido.situacao.codigo,
    linhas: [],
    modo: MODO_HISTORICO_LI.degradado,
  });
  if (!h.ok) throw new Error('history refused');
  const itens = mapearItensLi({
    itens: pedido.itens,
    valorSubtotal: pedido.valor_subtotal,
    resolucoes: new Map(),
    nowUs: AGORA_US,
  });
  if (!itens.ok) throw new Error('lines refused');
  const frete = mapearFreteLi({
    pedido,
    modalidadeConta,
    roteamento: {
      integracaoFreteOuterRef: null,
      externalOptionId: null,
      aviso: null,
      deliberado: false,
    },
    horarioDeCorteConta: null,
    dataAprovacaoUs: null,
    enderecoFiscalOuterRef: null,
  });
  const watermarkUs = dataLiParaMicros(pedido.data_modificacao)!;
  const mapeado = mapearPedidoLi({
    contaId: 'CONTA1',
    operacaoOuterRef: null,
    pedido,
    watermarkUs,
    capturado: h.capturado,
    itens: itens.itens,
    descontoExtra: itens.descontoExtra,
    frete,
    clientePedidoOuterRef: null,
    enderecoFiscalOuterRef: null,
  });
  const escrita = montarEscritaPedidoLi(null, mapeado, AGORA_US);
  if (escrita.tipo !== 'criar') throw new Error('expected a create');
  const pagamentos = mapearPagamentosLi({
    contaId: 'CONTA1',
    pedido,
    statusPagamento: escrita.decisao.statusPagamento,
    dataAprovacao: h.dataAprovacao,
    dataCancelamento: h.dataCancelamento,
    watermarkUs,
  });
  if (!pagamentos.ok) throw new Error('payments refused');
  const blocoFrete = frete === null ? null : freteDeCriacaoLi(frete, escrita.decisao.estado);
  const derivado = derivePedidoFreteTotals({
    itens: [...mapeado.congelaveis.itens],
    descontoTotal: mapeado.congelaveis.descontoTotal,
    freteInicial: blocoFrete,
  });
  const somaPagamentos = roundReais(pagamentos.pagamentos.reduce((s, p) => s + p.valor, 0));
  const pagos = sumPagamentosPagos(
    pagamentos.pagamentos.map((p) => ({ valor: p.valor, status_pagamento: p.statusCriacao })),
  );
  return { itens, mapeado, blocoFrete, derivado, somaPagamentos, pagos, escrita };
}

/** What the NF-e totals: the derived total, minus the freight when it is not CIF. */
function totalDaNota(derivado: { valorCobrado: number }, frete: FreteDoPedido | null): number {
  const naoCif = frete !== null && frete.modalidade !== MODALIDADE_FRETE.cif;
  return roundReais(derivado.valorCobrado - (naoCif ? (frete.valorCobrado ?? 0) : 0));
}

describe('the captures: the imported pedido and its payments agree to the centavo', () => {
  it.each(PEDIDOS)('%s: derived total == valor_total == Σ payments == the NF-e total', (nome) => {
    const pedido = detalhe(nome);
    const r = importar(pedido);
    expect(r.mapeado.congelaveis.valorCobrado === pedido.valor_total, 'valorCobrado').toBe(true);
    expect(r.derivado.valorCobrado === r.mapeado.congelaveis.valorCobrado, 'derived').toBe(true);
    expect(r.somaPagamentos === r.derivado.valorCobrado, 'Σ payments').toBe(true);
    expect(totalDaNota(r.derivado, r.blocoFrete) === r.somaPagamentos, 'NF-e total').toBe(true);
    // The freight block carries the order's freight value.
    expect(r.derivado.valorFreteInicial === roundReais(pedido.valor_envio ?? 0), 'freight').toBe(
      true,
    );
  });

  it('⚠️ freight forces CIF: the 4 orders with freight would break the NF-e identity as FOB', () => {
    let comFrete = 0;
    for (const nome of PEDIDOS) {
      const r = importar(detalhe(nome));
      const frete = r.blocoFrete!;
      if ((frete.valorCobrado ?? 0) > 0) {
        comFrete += 1;
        expect(frete.modalidade, nome).toBe(MODALIDADE_FRETE.cif);
        // The mutant "modalidade = conta ?? '1'", applied to this very block.
        const comoFob = { ...frete, modalidade: MODALIDADE_FRETE.fob };
        expect(totalDaNota(r.derivado, comoFob) === r.somaPagamentos, `${nome} as FOB`).toBe(false);
      }
    }
    expect(comFrete).toBe(4);
  });

  it('the paid sum follows the situação: the paid orders cover the total; the unpaid and the cancelled cover nothing', () => {
    for (const nome of PEDIDOS) {
      const r = importar(detalhe(nome));
      const criacao = r.escrita.decisao.statusPagamento.criacao;
      if (criacao === STATUS_PAGAMENTO.aprovado) {
        expect(r.pagos === r.derivado.valorCobrado, `${nome} paid`).toBe(true);
      } else {
        expect(r.pagos, nome).toBe(0);
      }
    }
  });
});

describe('synthetic orders', () => {
  const base = {
    numero: 165,
    situacao: { codigo: 'pedido_pago' },
    data_criacao: '2026-03-09T11:00:00',
    data_modificacao: '2026-03-10T15:20:10',
    envios: [
      {
        id: 1,
        valor: '10.00',
        prazo: 5,
        data_criacao: '2026-03-09T11:00:00',
        forma_envio: { id: 1, code: 'PAC' },
      },
    ],
  };

  it('⚠️ a 4-dp price on q = 3 whose subtotal the platform cut: the residual joins descontoTotal and the totals still agree', () => {
    const pedido = liPedidoSchema.parse({
      ...base,
      valor_subtotal: '99.99',
      valor_envio: '10.00',
      valor_desconto: '0.00',
      valor_total: '109.99',
      itens: [{ id: 1, quantidade: '3.000', preco_venda: '33.3333', preco_subtotal: '99.9999' }],
      pagamentos: [{ id: 1, valor: '109.99', pagamento_tipo: 'instantPayment' }],
    });
    const r = importar(pedido);
    expect(r.itens.ok && r.itens.descontoExtra).toBe(0.01);
    expect(r.mapeado.congelaveis.descontoTotal).toBe(0.01);
    expect(r.derivado.valorCobrado).toBe(109.99);
    expect(r.somaPagamentos).toBe(109.99);
  });

  it('a 4-dp price on q = 3 whose subtotal the platform rounded: no residual, the totals agree', () => {
    const pedido = liPedidoSchema.parse({
      ...base,
      valor_subtotal: '100.00',
      valor_envio: '10.00',
      valor_desconto: '0.00',
      valor_total: '110.00',
      itens: [{ id: 1, quantidade: '3.000', preco_venda: '33.3333', preco_subtotal: '99.9999' }],
      pagamentos: [{ id: 1, valor: '110.00', pagamento_tipo: 'instantPayment' }],
    });
    const r = importar(pedido);
    expect(r.mapeado.congelaveis.descontoTotal).toBe(0);
    expect(r.derivado.valorCobrado).toBe(110);
    expect(r.somaPagamentos).toBe(110);
  });

  it('⚠️ a negative residual is reported and NOT adjusted: the derived total then disagrees, as the NF-e guard will', () => {
    const pedido = liPedidoSchema.parse({
      ...base,
      valor_subtotal: '50.00',
      valor_envio: '0.00',
      valor_desconto: '0.00',
      valor_total: '50.00',
      envios: [{ ...base.envios[0], valor: '0.00' }],
      itens: [{ id: 1, quantidade: '1.000', preco_venda: '40.0000', preco_subtotal: '40.0000' }],
      pagamentos: [{ id: 1, valor: '50.00', pagamento_tipo: 'instantPayment' }],
    });
    const r = importar(pedido);
    expect(r.itens.ok && r.itens.divergente).toBe(true);
    expect(r.mapeado.congelaveis.descontoTotal).toBe(0);
    expect(r.derivado.valorCobrado).not.toBe(r.somaPagamentos);
  });

  it('two payments: both documents, and Σ equals the total', () => {
    const pedido = liPedidoSchema.parse({
      ...base,
      valor_subtotal: '90.00',
      valor_envio: '10.00',
      valor_desconto: '0.00',
      valor_total: '100.00',
      itens: [{ id: 1, quantidade: '1.000', preco_venda: '90.0000', preco_subtotal: '90.0000' }],
      pagamentos: [
        { id: 1, valor: '60.00', pagamento_tipo: 'instantPayment' },
        { id: 2, valor: '40.00', pagamento_tipo: 'creditCard' },
      ],
    });
    const r = importar(pedido);
    expect(r.somaPagamentos).toBe(100);
    expect(r.derivado.valorCobrado).toBe(100);
    expect(r.pagos).toBe(100);
  });

  it('a line discount: the derived total nets it once', () => {
    const pedido = liPedidoSchema.parse({
      ...base,
      valor_subtotal: '18.00',
      valor_envio: '10.00',
      valor_desconto: '3.00',
      valor_total: '25.00',
      itens: [{ id: 1, quantidade: '2.000', preco_venda: '10.0000', preco_subtotal: '18.0000' }],
      pagamentos: [{ id: 1, valor: '25.00', pagamento_tipo: 'instantPayment' }],
    });
    const r = importar(pedido);
    expect(r.itens.ok && r.itens.itens[0]?.descontoUnitario).toBe(1);
    expect(r.derivado.valorCobrado).toBe(25);
    expect(r.somaPagamentos).toBe(25);
  });
});
