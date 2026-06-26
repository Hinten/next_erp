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

  it('flags a non-kit child whose parent is a kit (child-edit guard, #298)', () => {
    const issues = produtoPageIssues({ parentIsKit: true, ehKit: false });
    expect(issues).toContainEqual({
      path: 'ehKit',
      message: 'Esta variação pertence a um kit; ela também precisa ser um kit.',
    });
  });

  it('accepts a kit child whose parent is a kit', () => {
    expect(
      produtoPageIssues({
        parentIsKit: true,
        ehKit: true,
        componentesKit: { p1: { quantidade: 1 } },
      }),
    ).toEqual([]);
  });

  it('does not flag ehKit when the parent is not a kit', () => {
    expect(produtoPageIssues({ parentIsKit: false, ehKit: false })).toEqual([]);
  });

  it('flags a kit-of-kit when a component is itself a kit (#239, agent path)', () => {
    const issues = produtoPageIssues({
      ehKit: true,
      componentesKit: { p1: { quantidade: 1 }, p2: { quantidade: 1 } },
      componentKitIds: ['p2'],
    });
    expect(issues).toContainEqual({
      path: 'componentesKit',
      message: 'Um kit não pode conter outro kit como componente: p2.',
    });
  });

  it('does not flag kit-of-kit when no component is a kit (empty/absent componentKitIds)', () => {
    expect(
      produtoPageIssues({
        ehKit: true,
        componentesKit: { p1: { quantidade: 1 } },
        componentKitIds: [],
      }),
    ).toEqual([]);
  });

  it('does not flag kit-of-kit for a NON-kit with stale componentKitIds (gated on ehKit)', () => {
    // A non-kit's componentesKit is cleared on save, so its (stale) components
    // are not validated — mirror of the kit-needs-component rule's ehKit gate.
    expect(
      produtoPageIssues({
        ehKit: false,
        componentesKit: { p1: { quantidade: 1 }, p2: { quantidade: 1 } },
        componentKitIds: ['p2'],
      }),
    ).toEqual([]);
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
