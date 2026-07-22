import { describe, expect, it } from 'vitest';
import { motivoIncidenteMeta, motivoIncidenteSchema } from './motivoIncidente';

describe('motivoIncidenteSchema', () => {
  it('accepts a minimal valid motivo and applies ativo default', () => {
    const out = motivoIncidenteSchema.parse({ nome: 'Atraso na entrega' });
    expect(out).toEqual({
      nome: 'Atraso na entrega',
      ativo: true,
      timestamp: null,
    });
  });

  it('rejects empty nome', () => {
    expect(motivoIncidenteSchema.safeParse({ nome: '' }).success).toBe(false);
  });

  it('accepts explicit ativo=false', () => {
    const out = motivoIncidenteSchema.parse({ nome: 'Inativo', ativo: false });
    expect(out.ativo).toBe(false);
  });
});

describe('motivoIncidenteMeta', () => {
  it('targets the motivosincidentes collection (Flutter wire name)', () => {
    expect(motivoIncidenteMeta.collectionPath).toBe('motivosincidentes');
  });

  it('reuses the pedido BigInt permission bits', () => {
    expect(motivoIncidenteMeta.permissions.read).toBe(1n << 16n);
    expect(motivoIncidenteMeta.permissions.write).toBe(1n << 17n);
    expect(motivoIncidenteMeta.permissions.delete).toBe(1n << 18n);
  });
});
