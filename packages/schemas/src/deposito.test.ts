import { describe, expect, it } from 'vitest';
import { depositoMeta, depositoSchema } from './deposito';

describe('depositoSchema', () => {
  it('accepts a minimal valid deposito and applies `ativo` default', () => {
    const out = depositoSchema.parse({ nome: 'Galpão Central' });
    expect(out).toEqual({ nome: 'Galpão Central', ativo: true });
  });

  it('rejects empty nome', () => {
    expect(depositoSchema.safeParse({ nome: '' }).success).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    expect(
      depositoSchema.safeParse({ nome: 'x'.repeat(256) }).success,
    ).toBe(false);
  });

  it('accepts explicit ativo=false', () => {
    const out = depositoSchema.parse({ nome: 'Inativo', ativo: false });
    expect(out.ativo).toBe(false);
  });
});

describe('depositoMeta', () => {
  it('targets the depositos collection', () => {
    expect(depositoMeta.collectionPath).toBe('depositos');
  });

  it('uses the new estoque BigInt permission bits (byte 8)', () => {
    expect(typeof depositoMeta.permissions.read).toBe('bigint');
    expect(depositoMeta.permissions.read).toBe(1n << 64n);
    expect(depositoMeta.permissions.write).toBe(1n << 65n);
    expect(depositoMeta.permissions.delete).toBe(1n << 66n);
  });
});
