import { describe, expect, it } from 'vitest';
import { etiquetaMeta, etiquetaSchema, itemTelaEtiquetaSchema } from './etiqueta';

describe('etiquetaSchema', () => {
  it('accepts a minimal valid etiqueta and applies defaults', () => {
    const out = etiquetaSchema.parse({ nome: 'Reposição segunda-feira' });
    expect(out).toEqual({
      nome: 'Reposição segunda-feira',
      itens: [],
      preco: false,
      localizacao: false,
      data: false,
      dataCriacao: null,
      dataAtualizacao: null,
    });
  });

  it('rejects missing nome', () => {
    expect(etiquetaSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty nome', () => {
    expect(etiquetaSchema.safeParse({ nome: '' }).success).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    expect(etiquetaSchema.safeParse({ nome: 'x'.repeat(256) }).success).toBe(false);
  });

  it('accepts a populated itens list with a nullable produtoEtiquetaOuterRef', () => {
    const out = etiquetaSchema.parse({
      nome: 'Etiquetas loja',
      itens: [
        { produtoEtiquetaOuterRef: 'documents/produtos/abc123', quantidade: 3 },
        { produtoEtiquetaOuterRef: null, quantidade: 1 },
      ],
      preco: true,
      localizacao: true,
      data: true,
    });
    expect(out.itens).toHaveLength(2);
    expect(out.itens[0]).toEqual({
      produtoEtiquetaOuterRef: 'documents/produtos/abc123',
      quantidade: 3,
    });
    expect(out.itens[1]?.produtoEtiquetaOuterRef).toBeNull();
  });

  it('rejects itens with quantidade 0', () => {
    expect(
      etiquetaSchema.safeParse({
        nome: 'Inválida',
        itens: [{ produtoEtiquetaOuterRef: null, quantidade: 0 }],
      }).success,
    ).toBe(false);
  });

  it('defaults quantidade to 1 when omitted', () => {
    const out = itemTelaEtiquetaSchema.parse({});
    expect(out).toEqual({ produtoEtiquetaOuterRef: null, quantidade: 1 });
  });
});

describe('etiquetaMeta', () => {
  it('targets the etiquetas collection', () => {
    expect(etiquetaMeta.collectionPath).toBe('etiquetas');
  });

  it('reuses the estoque BigInt permission bits (byte 8), same as deposito', () => {
    expect(typeof etiquetaMeta.permissions.read).toBe('bigint');
    expect(etiquetaMeta.permissions.read).toBe(1n << 64n);
    expect(etiquetaMeta.permissions.write).toBe(1n << 65n);
    expect(etiquetaMeta.permissions.delete).toBe(1n << 66n);
  });
});
