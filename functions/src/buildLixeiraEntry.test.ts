import { describe, expect, it } from 'vitest';
import { lixeiraSchema } from '@delfrance/schemas';
import { buildLixeiraEntry } from './buildLixeiraEntry.js';

describe('buildLixeiraEntry', () => {
  it('produces an entry that satisfies lixeiraSchema', () => {
    const entry = buildLixeiraEntry({
      collectionPath: 'categorias',
      docId: 'abc123',
      data: { nome: 'Camisetas', permiteCadastro: true },
      deletedBy: 'user-1',
    });

    expect(() => lixeiraSchema.parse(entry)).not.toThrow();
    expect(entry.collectionPath).toBe('categorias');
    expect(entry.docId).toBe('abc123');
    expect(entry.label).toBe('Camisetas');
    expect(entry.deletedBy).toBe('user-1');
    expect(typeof entry.deletedAt).toBe('string');
  });

  it('falls back to a null label when the document has no string nome', () => {
    const entry = buildLixeiraEntry({
      collectionPath: 'categorias',
      docId: 'no-name',
      data: { permiteCadastro: false },
      deletedBy: null,
    });

    expect(entry.label).toBeNull();
    expect(entry.deletedBy).toBeNull();
    expect(() => lixeiraSchema.parse(entry)).not.toThrow();
  });

  it('preserves the full document snapshot in `data`', () => {
    const data = { nome: 'X', nomeCompleto: 'X completo', timestamp: null };
    const entry = buildLixeiraEntry({
      collectionPath: 'categorias',
      docId: 'snap',
      data,
      deletedBy: 'user-2',
      deletedAt: '2026-05-18T12:00:00.000Z',
    });

    expect(entry.data).toEqual(data);
    expect(entry.deletedAt).toBe('2026-05-18T12:00:00.000Z');
  });
});
