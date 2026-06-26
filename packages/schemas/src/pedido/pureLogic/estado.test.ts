import { describe, expect, it } from 'vitest';
import { podeTrocar, travarInclusaoProduto } from './estado';

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
