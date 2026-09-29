import { describe, expect, it } from 'vitest';
import { ESTADO_NFE } from '../../nfe';
import { ESTADO_PEDIDO } from '../collection/pedido';
import {
  estadoAoGerarLinkPagamento,
  nfeFiscalEncerrada,
  pagamentoInesperado,
  podeGerarLinkPagamento,
  podeTrocar,
  travarInclusaoProduto,
  travarPagamentoComNFe,
} from './estado';

describe('podeTrocar', () => {
  it('allows returns only from paid/settled orders', () => {
    expect(podeTrocar(ESTADO_PEDIDO.pago)).toBe(true);
    expect(podeTrocar(ESTADO_PEDIDO.estornadoParcialmente)).toBe(true);
    expect(podeTrocar(ESTADO_PEDIDO.finalizado)).toBe(true);
  });

  it('rejects open / cancelled / error states', () => {
    for (const estado of [
      'iniciado',
      'carrinho',
      'escolhendoFormaDePagamento',
      'aguardandoConfirmacaoDePagamento',
      'emAnalise',
      'emProcessamento',
      'estornadoIntegralmente',
      'cancelado',
      'fraude',
      'error',
    ] as const) {
      expect(podeTrocar(estado)).toBe(false);
    }
  });
});

describe('travarInclusaoProduto', () => {
  it('keeps items editable only in the cart/checkout phase (+ error)', () => {
    for (const estado of [
      'iniciado',
      'carrinho',
      'carrinhoAbandonado',
      'escolhendoFormaDePagamento',
      'error',
    ] as const) {
      expect(travarInclusaoProduto(estado)).toBe(false);
    }
  });

  it('locks items from "aguardando pagamento" onward (verbatim legacy list)', () => {
    for (const estado of [
      'aguardandoConfirmacaoDePagamento',
      'pagamentoNaoRealizado',
      'emAnalise',
      'emProcessamento',
      'pago',
      'estornadoParcialmente',
      'estornadoIntegralmente',
      'processandoCancelamento',
      'cancelado',
      'fraude',
      'finalizado',
    ] as const) {
      expect(travarInclusaoProduto(estado)).toBe(true);
    }
  });
});

describe('travarPagamentoComNFe', () => {
  it('keeps pagamentos editable in the legacy carve-out estados (even with an aprovada NF-e)', () => {
    // Legacy `cadastroPedidoProvider.dart:1058-1062` re-allows the write.
    for (const estado of ['iniciado', 'aguardandoConfirmacaoDePagamento', 'cancelado'] as const) {
      expect(travarPagamentoComNFe(estado)).toBe(false);
    }
  });

  it('locks pagamentos for every other estado (paired with an aprovada NF-e)', () => {
    for (const estado of [
      'carrinho',
      'carrinhoAbandonado',
      'escolhendoFormaDePagamento',
      'pagamentoNaoRealizado',
      'emAnalise',
      'emProcessamento',
      'pago',
      'estornadoParcialmente',
      'estornadoIntegralmente',
      'processandoCancelamento',
      'fraude',
      'finalizado',
      'error',
    ] as const) {
      expect(travarPagamentoComNFe(estado)).toBe(true);
    }
  });
});

describe('pagamentoInesperado', () => {
  it('flags the already-paid / settled estados', () => {
    for (const estado of [
      'pago',
      'emProcessamento',
      'finalizado',
      'estornadoParcialmente',
      'estornadoIntegralmente',
    ] as const) {
      expect(pagamentoInesperado(estado)).toBe(true);
    }
  });

  it('does not flag the still-collecting / cancelled estados', () => {
    for (const estado of [
      'iniciado',
      'carrinho',
      'carrinhoAbandonado',
      'escolhendoFormaDePagamento',
      'aguardandoConfirmacaoDePagamento',
      'pagamentoNaoRealizado',
      'emAnalise',
      'processandoCancelamento',
      'cancelado',
      'fraude',
      'error',
    ] as const) {
      expect(pagamentoInesperado(estado)).toBe(false);
    }
  });
});

describe('nfeFiscalEncerrada', () => {
  it('flags cancelada and numeração-inutilizada', () => {
    expect(nfeFiscalEncerrada(ESTADO_NFE.cancelada)).toBe(true);
    expect(nfeFiscalEncerrada(ESTADO_NFE.numeracaoInutilizada)).toBe(true);
  });

  it('does not flag aprovada or any in-flight / rejected estado', () => {
    for (const value of Object.values(ESTADO_NFE)) {
      if (value === ESTADO_NFE.cancelada || value === ESTADO_NFE.numeracaoInutilizada) continue;
      expect(nfeFiscalEncerrada(value)).toBe(false);
    }
  });
});

describe('podeGerarLinkPagamento', () => {
  // The exact allow-list, spelled out with the constants: a plausible wrong
  // implementation (an exclusion list, or adding emAnalise / pago) fails the
  // exhaustive table below, not just one spot check.
  const PERMITIDOS = new Set<string>([
    ESTADO_PEDIDO.iniciado,
    ESTADO_PEDIDO.carrinho,
    ESTADO_PEDIDO.escolhendoFormaDePagamento,
    ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    ESTADO_PEDIDO.pagamentoNaoRealizado,
  ]);

  it('is true for exactly the five "still collecting payment" estados, false for every other one', () => {
    const todos = Object.values(ESTADO_PEDIDO);
    expect(todos).toHaveLength(16); // a new estado must make this table a conscious choice
    for (const estado of todos) {
      expect(podeGerarLinkPagamento(estado), estado).toBe(PERMITIDOS.has(estado));
    }
    expect(todos.filter(podeGerarLinkPagamento).sort()).toEqual([...PERMITIDOS].sort());
  });

  it('refuses the settled, in-flight and cancelled estados (near-misses of the allow-list)', () => {
    for (const estado of [
      ESTADO_PEDIDO.pago, // already paid: a link can only overpay
      ESTADO_PEDIDO.emAnalise, // not in the legacy set (the owner may widen it)
      ESTADO_PEDIDO.emProcessamento,
      ESTADO_PEDIDO.finalizado,
      ESTADO_PEDIDO.cancelado,
      ESTADO_PEDIDO.carrinhoAbandonado,
      ESTADO_PEDIDO.error,
    ]) {
      expect(podeGerarLinkPagamento(estado), estado).toBe(false);
    }
  });
});

describe('estadoAoGerarLinkPagamento', () => {
  it('flips ONLY iniciado to aguardandoConfirmacaoDePagamento', () => {
    expect(estadoAoGerarLinkPagamento(ESTADO_PEDIDO.iniciado)).toBe(
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    );
  });

  it('leaves every other estado alone, including the ones that may generate a link', () => {
    for (const estado of Object.values(ESTADO_PEDIDO)) {
      if (estado === ESTADO_PEDIDO.iniciado) continue;
      expect(estadoAoGerarLinkPagamento(estado), estado).toBeNull();
    }
    // carrinho is the near-miss: it may generate a link but it is not iniciado.
    expect(podeGerarLinkPagamento(ESTADO_PEDIDO.carrinho)).toBe(true);
    expect(estadoAoGerarLinkPagamento(ESTADO_PEDIDO.carrinho)).toBeNull();
  });

  it('only ever flips from an estado that may generate a link at all', () => {
    for (const estado of Object.values(ESTADO_PEDIDO)) {
      if (estadoAoGerarLinkPagamento(estado) !== null) {
        expect(podeGerarLinkPagamento(estado), estado).toBe(true);
      }
    }
  });
});
