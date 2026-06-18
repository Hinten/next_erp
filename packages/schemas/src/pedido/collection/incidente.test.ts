import { describe, expect, it } from 'vitest';
import { TIPO_INCIDENTE, incidenteMeta, incidenteSchema, resolucaoSchema } from './incidente';

describe('incidenteSchema', () => {
  it('defaults tipo to devolução and the rest to null', () => {
    const out = incidenteSchema.parse({});
    expect(out.tipo).toBe(TIPO_INCIDENTE.devolucao); // 'returns'
    expect(out.origem).toBeNull();
    expect(out.motivoDoIncidente).toBeNull();
    expect(out.resolucao).toBeNull();
  });

  it('rejects an unknown tipo / origem', () => {
    expect(incidenteSchema.safeParse({ tipo: 'zzz' }).success).toBe(false);
    expect(incidenteSchema.safeParse({ origem: 42 }).success).toBe(false);
  });

  it('caps motivo / comentarios at 2000 chars', () => {
    expect(incidenteSchema.safeParse({ motivoDoIncidente: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('passes external fields through (passthrough)', () => {
    const out = incidenteSchema.parse({ externalId: 'ml-123', foo: 'bar' });
    expect(out.externalId).toBe('ml-123');
    expect((out as Record<string, unknown>).foo).toBe('bar');
  });

  it('lives at the plural pedidos/{pedidoId}/incidentes path with pedido perms', () => {
    expect(incidenteMeta.collectionPath).toBe('pedidos/{pedidoId}/incidentes');
    expect(incidenteMeta.permissions.read).toBe(1n << 16n);
    expect(incidenteMeta.permissions.write).toBe(1n << 17n);
    expect(incidenteMeta.permissions.delete).toBe(1n << 18n);
  });
});

describe('resolucaoSchema', () => {
  it('requires tipo and defaults valor to 0', () => {
    expect(resolucaoSchema.safeParse({}).success).toBe(false);
    const out = resolucaoSchema.parse({ tipo: 0 });
    expect(out.valor).toBe(0);
    expect(out.data).toBeNull();
  });
});
