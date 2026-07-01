import { describe, expect, it } from 'vitest';
import {
  pagamentoInesperado,
  podeTrocar,
  travarInclusaoProduto,
  travarPagamentoComNFe,
} from './estado';

describe('podeTrocar', () => {
  it('allows returns only from paid/settled orders', () => {
    expect(podeTrocar('pago')).toBe(true);
    expect(podeTrocar('estornadoParcialmente')).toBe(true);
    expect(podeTrocar('finalizado')).toBe(true);
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
