import { describe, expect, it } from 'vitest';
import { tabelaDeMedidasMeta, tabelaDeMedidasSchema } from './tabelaDeMedidas';

describe('tabelaDeMedidasSchema', () => {
  it('accepts a minimal valid record with null codigo and descricao', () => {
    const out = tabelaDeMedidasSchema.parse({
      nome: 'Camiseta P/M/G',
      codigo: null,
      descricao: null,
    });
    expect(out.nome).toBe('Camiseta P/M/G');
  });

  it('rejects empty nome', () => {
    expect(
      tabelaDeMedidasSchema.safeParse({
        nome: '',
        codigo: null,
        descricao: null,
      }).success,
    ).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    expect(
      tabelaDeMedidasSchema.safeParse({
        nome: 'x'.repeat(256),
        codigo: null,
        descricao: null,
      }).success,
    ).toBe(false);
  });

  it('rejects descricao longer than 1000 chars', () => {
    expect(
      tabelaDeMedidasSchema.safeParse({
        nome: 'X',
        codigo: null,
        descricao: 'a'.repeat(1001),
      }).success,
    ).toBe(false);
  });

  // Regression: Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc.
  it('rejects missing codigo (must be string | null, not undefined)', () => {
    expect(tabelaDeMedidasSchema.safeParse({ nome: 'X', descricao: null }).success).toBe(false);
  });

  it('accepts marketplace integration maps keyed by integracao_id', () => {
    const out = tabelaDeMedidasSchema.parse({
      nome: 'Tabela X',
      codigo: 'TX',
      descricao: null,
      tabelasDeMedidasMercadoLivre: { 'conta-1': { tabelas: [] } },
      tabelasMedidasShopee: { 'conta-2': [] },
    });
    expect(out.tabelasDeMedidasMercadoLivre).toBeDefined();
    expect(out.tabelasMedidasShopee).toBeDefined();
  });
});

describe('tabelaDeMedidasMeta', () => {
  it('targets the tabMedi collection (Flutter wire name)', () => {
    expect(tabelaDeMedidasMeta.collectionPath).toBe('tabMedi');
  });

  it('reuses the produto BigInt permission bits', () => {
    expect(tabelaDeMedidasMeta.permissions.read).toBe(1n << 8n);
    expect(tabelaDeMedidasMeta.permissions.write).toBe(1n << 9n);
    expect(tabelaDeMedidasMeta.permissions.delete).toBe(1n << 10n);
  });
});
