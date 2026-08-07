import { describe, expect, it } from 'vitest';
import { marcarInteracaoDoUsuario } from './interacaoDoUsuario';

describe('marcarInteracaoDoUsuario', () => {
  it('stamps hasUserInteraction on a non-empty patch', () => {
    expect(marcarInteracaoDoUsuario({ estado: 'pago' })).toEqual({
      estado: 'pago',
      hasUserInteraction: true,
    });
  });

  it('leaves an EMPTY patch empty', () => {
    // Load-bearing: `savePedido` reads an empty patch as "nothing changed" and
    // throws `PedidoNothingChangedError`. Stamping unconditionally would turn
    // every no-op "Salvar" into a real write.
    expect(marcarInteracaoDoUsuario({})).toEqual({});
  });

  it('does not mutate the input', () => {
    const patch = { numero: 'VEN-000001' };
    marcarInteracaoDoUsuario(patch);
    expect(patch).toEqual({ numero: 'VEN-000001' });
  });

  it('overrides a stale false/null carried in from form state', () => {
    // `PedidoForm`'s EMPTY_DEFAULTS seeds the field as `null`, and an edited
    // pedido carries whatever is stored. A human save always wins.
    expect(marcarInteracaoDoUsuario({ hasUserInteraction: null })).toMatchObject({
      hasUserInteraction: true,
    });
    expect(marcarInteracaoDoUsuario({ hasUserInteraction: false })).toMatchObject({
      hasUserInteraction: true,
    });
  });
});
