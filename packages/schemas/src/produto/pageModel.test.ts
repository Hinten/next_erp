import { describe, expect, it } from 'vitest';
import { produtoPageBaseSchema, produtoPageIssues, produtoPageSchema } from './pageModel';

const baseProduto = { nome: 'Camiseta' };

describe('produtoPageIssues (cross-document rules)', () => {
  it('is empty for a plain non-kit produto', () => {
    expect(produtoPageIssues({ ehKit: false })).toEqual([]);
  });

  it('flags a kit with no components', () => {
    const issues = produtoPageIssues({ ehKit: true, componentesKit: {} });
    expect(issues).toEqual([
      { path: 'componentesKit', message: 'Um kit precisa de ao menos um componente.' },
    ]);
  });

  it('accepts a kit that has components', () => {
    expect(produtoPageIssues({ ehKit: true, componentesKit: { p1: { quantidade: 1 } } })).toEqual(
      [],
    );
  });

  it('flags a produto listed as a component of itself', () => {
    const issues = produtoPageIssues({
      id: 'self',
      ehKit: true,
      componentesKit: { self: { quantidade: 1 } },
    });
    expect(issues).toContainEqual({
      path: 'componentesKit',
      message: 'Um produto não pode ser componente de si mesmo.',
    });
  });

  it('flags reserved stock greater than the quantity on hand, keyed by row index', () => {
    const issues = produtoPageIssues({
      estoques: [
        { quantidade: 5, quantidadeReservada: 2 },
        { quantidade: 1, quantidadeReservada: 4 },
      ],
    });
    expect(issues).toEqual([
      {
        path: 'estoques.1.quantidadeReservada',
        message: 'A quantidade reservada não pode ser maior que a quantidade em estoque.',
      },
    ]);
  });
});

describe('produtoPageSchema (refined aggregate)', () => {
  it('parses a valid aggregate', () => {
    const parsed = produtoPageSchema.parse({
      ...baseProduto,
      ehKit: true,
      componentesKit: { p1: { quantidade: 2 } },
    });
    expect(parsed.nome).toBe('Camiseta');
    expect(parsed.componentesKit?.p1?.limitarEstoque).toBe(true); // kitSchema default
  });

  it('rejects an empty kit and reports the issue on componentesKit', () => {
    const result = produtoPageSchema.safeParse({ ...baseProduto, ehKit: true, componentesKit: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['componentesKit'],
          message: 'Um kit precisa de ao menos um componente.',
        }),
      );
    }
  });

  it('base schema carries the related-document fields with null defaults', () => {
    const parsed = produtoPageBaseSchema.parse(baseProduto);
    expect(parsed.extraData).toBeNull();
    expect(parsed.estoques).toBeNull();
    expect(parsed.impostos).toBeNull();
  });
});
