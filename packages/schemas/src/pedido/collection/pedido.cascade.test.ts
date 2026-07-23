import { describe, expect, it } from 'vitest';
import { pedidoMeta } from './pedido';
import { checkoutFretePedidoMeta } from './checkout';

describe('pedidoMeta cascade', () => {
  const paths = (pedidoMeta.cascade ?? []).map((decl) => decl.path);

  it('cleans the freight-history / checkout / checkin subcollections (#372)', () => {
    expect(paths).toContain('pedidos/{pedidoId}/historicoFtIni');
    expect(paths).toContain('pedidos/{pedidoId}/checkout');
    expect(paths).toContain('pedidos/{pedidoId}/checkin');
  });

  it('keeps the checkout cascade path aligned with its schema collectionPath', () => {
    expect(paths).toContain(checkoutFretePedidoMeta.collectionPath);
  });

  it('does not cascade the dead `histestq` legacy constant', () => {
    expect(paths).not.toContain('pedidos/{pedidoId}/histestq');
  });

  it('deletes (not restricts) every cascade-declared subcollection', () => {
    for (const decl of pedidoMeta.cascade ?? []) {
      expect(decl.onDelete).toBe('cascade');
    }
  });
});
