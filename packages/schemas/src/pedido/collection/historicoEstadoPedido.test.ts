import { describe, expect, it } from 'vitest';
import { historicoEstadoPedidoMeta, historicoEstadoPedidoSchema } from './historicoEstadoPedido';

describe('historicoEstadoPedidoSchema', () => {
  it('requires estado and defaults the rest to null', () => {
    expect(historicoEstadoPedidoSchema.safeParse({}).success).toBe(false);
    const out = historicoEstadoPedidoSchema.parse({ estado: 'pago' });
    expect(out.estado).toBe('pago');
    expect(out.data).toBeNull();
    expect(out.usuarioHistoricoEstadosPedidoOuterRef).toBeNull();
  });

  it('rejects an unknown estado', () => {
    expect(historicoEstadoPedidoSchema.safeParse({ estado: 'zzz' }).success).toBe(false);
  });

  it('lives at pedidos/{pedidoId}/historicoEstadoPedido with pedido perms', () => {
    expect(historicoEstadoPedidoMeta.collectionPath).toBe(
      'pedidos/{pedidoId}/historicoEstadoPedido',
    );
    expect(historicoEstadoPedidoMeta.permissions.write).toBe(1n << 17n);
  });
});
