import { describe, expect, it } from 'vitest';
import { podeTrocar } from './estado';

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
