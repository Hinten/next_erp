import { describe, expect, it } from 'vitest';
import { historicoFreteInicialMeta, historicoFreteInicialSchema } from './historicoFreteInicial';

describe('historicoFreteInicialSchema', () => {
  it('requires estado and defaults obs/data to null', () => {
    expect(historicoFreteInicialSchema.safeParse({}).success).toBe(false);
    const out = historicoFreteInicialSchema.parse({ estado: 'postado' });
    expect(out.estado).toBe('postado');
    expect(out.obs).toBeNull();
    expect(out.data).toBeNull();
  });

  it('accepts an explicit ms-epoch data and obs', () => {
    const out = historicoFreteInicialSchema.parse({
      estado: 'entregue',
      obs: 'entregue ao destinatário',
      data: 1720000000000,
    });
    expect(out.data).toBe(1720000000000);
    expect(out.obs).toBe('entregue ao destinatário');
  });

  it('rejects an unknown estado', () => {
    expect(historicoFreteInicialSchema.safeParse({ estado: 'zzz' }).success).toBe(false);
  });

  it('lives at pedidos/{pedidoId}/historicoFtIni with pedido perms, server-owned', () => {
    expect(historicoFreteInicialMeta.collectionPath).toBe('pedidos/{pedidoId}/historicoFtIni');
    expect(historicoFreteInicialMeta.permissions.write).toBe(1n << 17n);
    expect(historicoFreteInicialMeta.serverOwned).toBe(true);
  });

  it('declares a newest-first defaultQuery so the index is index-mandatory', () => {
    expect(historicoFreteInicialMeta.defaultQuery).toEqual({
      orderBy: [{ field: 'data', direction: 'desc' }],
      limit: 50,
    });
  });
});
