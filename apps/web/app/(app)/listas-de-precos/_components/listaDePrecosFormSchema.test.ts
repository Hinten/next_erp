import { describe, expect, it } from 'vitest';
import { DELETE_MARK } from '@delfrance/ui';
import { listaDePrecosFormSchema } from './listaDePrecosFormSchema';

/** Minimal valid `listaDePrecos` document, `formulasCalculoPreco` overridable per test. */
function baseLista(formulasCalculoPreco: unknown = null, formulasPorCategoria: unknown = null) {
  return {
    nome: 'Padrão',
    padrao: false,
    ativo: true,
    formulasCalculoPreco,
    formulasPorCategoria,
    ultimaModificacao: null,
    timestamp: null,
  };
}

/** Full-shaped valid row, `overrides` layered on top. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    limiar: 100,
    formula: 'C*1.5',
    taxaFixa: 0,
    custoFixo: 0,
    margemDeLucro: 0,
    comissaoMarketplace: 0,
    imposto: 0,
    frete: 0,
    marketing: 0,
    faixasTaxaFixaPeso: null,
    ...overrides,
  };
}

function issuePaths(data: unknown): string[] {
  const result = listaDePrecosFormSchema.safeParse(data);
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.join('.'));
}

describe('listaDePrecosFormSchema', () => {
  it('accepts a well-formed row', () => {
    const result = listaDePrecosFormSchema.safeParse(baseLista([row()]));
    expect(result.success).toBe(true);
  });

  it('rejects limiar <= 0', () => {
    const issues = issuePaths(baseLista([row({ limiar: 0 })]));
    expect(issues).toContain('formulasCalculoPreco.0.limiar');
  });

  it('rejects a cleared (null) limiar with the same message as <= 0', () => {
    const result = listaDePrecosFormSchema.safeParse(baseLista([row({ limiar: null })]));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join('.') === 'formulasCalculoPreco.0.limiar',
      );
      expect(issue?.message).toBe('Limiar deve ser maior que zero');
    }
  });

  it('rejects limiar above the legacy cap (9999999999)', () => {
    const issues = issuePaths(baseLista([row({ limiar: 10_000_000_000 })]));
    expect(issues).toContain('formulasCalculoPreco.0.limiar');
  });

  it('accepts limiar exactly at the legacy cap', () => {
    const result = listaDePrecosFormSchema.safeParse(baseLista([row({ limiar: 9_999_999_999 })]));
    expect(result.success).toBe(true);
  });

  it('rejects an unparsable formula', () => {
    const issues = issuePaths(baseLista([row({ formula: 'abc' })]));
    expect(issues).toContain('formulasCalculoPreco.0.formula');
  });

  it('rejects an incomplete formula (trailing operator)', () => {
    const issues = issuePaths(baseLista([row({ formula: 'C*' })]));
    expect(issues).toContain('formulasCalculoPreco.0.formula');
  });

  it('rejects an empty formula', () => {
    const issues = issuePaths(baseLista([row({ formula: '' })]));
    expect(issues).toContain('formulasCalculoPreco.0.formula');
  });

  it('accepts a formula that divides by zero at only ONE of the two probe points', () => {
    // PROBE_VARS_B binds T = 2.03 — this formula only blows up there; it must
    // not be rejected on the strength of a single coincidental probe failure.
    const result = listaDePrecosFormSchema.safeParse(baseLista([row({ formula: 'C/(T-2.03)' })]));
    expect(result.success).toBe(true);
  });

  it('skips validation entirely for a row staged for deletion', () => {
    const result = listaDePrecosFormSchema.safeParse(
      baseLista([row({ limiar: 0, formula: 'not a formula', [DELETE_MARK]: true })]),
    );
    expect(result.success).toBe(true);
  });

  it('validates rows nested inside a formulasPorCategoria bucket at the correct path', () => {
    const issues = issuePaths(
      baseLista(null, {
        cat1: { name: 'Categoria 1', formulasCalculoPreco: [row({ limiar: -5 })] },
      }),
    );
    expect(issues).toContain('formulasPorCategoria.cat1.formulasCalculoPreco.0.limiar');
  });

  it('skips a deletion-marked row nested inside a formulasPorCategoria bucket', () => {
    const result = listaDePrecosFormSchema.safeParse(
      baseLista(null, {
        cat1: {
          name: 'Categoria 1',
          formulasCalculoPreco: [row({ formula: 'abc', [DELETE_MARK]: true })],
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('a null formulasCalculoPreco / formulasPorCategoria (unset lists) parses cleanly', () => {
    const result = listaDePrecosFormSchema.safeParse(baseLista(null, null));
    expect(result.success).toBe(true);
  });
});
