import { describe, expect, it } from 'vitest';
import { calcularPreco, type FormulaCalculoPreco } from '@delfrance/schemas';
import { listaDePrecosFormSchema } from './listaDePrecosFormSchema';
import {
  COEFFICIENTS,
  FORMULA_PADRAO,
  FORMULA_REGRAS,
  FORMULA_VARIAVEIS,
  LIMIAR_AJUDA,
  normalizeFormulaInput,
} from './formulaVariaveis';

/** A `listaDePrecos` carrying one formula row, so the row refinement runs. */
function listaComFormula(formula: string) {
  return {
    nome: 'Padrão',
    padrao: false,
    ativo: true,
    formulasCalculoPreco: [
      {
        limiar: 100,
        formula,
        taxaFixa: 0,
        custoFixo: 0,
        margemDeLucro: 0,
        comissaoMarketplace: 0,
        imposto: 0,
        frete: 0,
        marketing: 0,
        faixasTaxaFixaPeso: null,
      },
    ],
    formulasPorCategoria: null,
    ultimaModificacao: null,
    timestamp: null,
  };
}

function issuePaths(formula: string): string[] {
  const result = listaDePrecosFormSchema.safeParse(listaComFormula(formula));
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('FORMULA_PADRAO (the formula seeded into a new row)', () => {
  // The default is seeded into `EMPTY_ROW.formula`, and `normalizeFormulaInput`
  // runs on every keystroke in that same field. If the two ever disagreed, the
  // pre-filled value would be silently rewritten the first time the operator
  // typed into it — and, per the `.` -> `,` note in `formulaVariaveis.ts`, the
  // rewrite can stay perfectly parseable, so nothing would ever surface it.
  it('survives the input sanitizer unchanged', () => {
    expect(normalizeFormulaInput(FORMULA_PADRAO)).toBe(FORMULA_PADRAO);
  });

  // Control for the assertion above: the sanitizer is not a no-op, so passing
  // is a real property of FORMULA_PADRAO rather than of normalizeFormulaInput.
  it('the sanitizer it survives does reject other input (control)', () => {
    expect(normalizeFormulaInput('C * 1.5 ^ 2')).toBe('C*1,52');
  });

  it('passes the form schema, so a freshly added row shows no "Fórmula inválida"', () => {
    expect(issuePaths(FORMULA_PADRAO)).not.toContain('formulasCalculoPreco.0.formula');
  });

  // Control for the assertion above.
  it('the schema it passes does reject an unparsable formula (control)', () => {
    expect(issuePaths('C*')).toContain('formulasCalculoPreco.0.formula');
  });

  it('only uses variables the legend documents', () => {
    const documentados = new Set(FORMULA_VARIAVEIS.map((v) => v.simbolo));
    const usados = FORMULA_PADRAO.match(/[A-Za-z]/g) ?? [];
    expect(usados.length).toBeGreaterThan(0);
    for (const letra of usados) expect(documentados.has(letra)).toBe(true);
  });
});

describe('the variable legend', () => {
  // Written out literally rather than mapped from FORMULA_VARIAVEIS: a test
  // that derives its expectation from the constant under test asserts nothing.
  it('documents exactly the eight formula variables', () => {
    expect(FORMULA_VARIAVEIS.map((v) => v.simbolo)).toEqual([
      'C',
      'c',
      'T',
      'L',
      'M',
      'I',
      'F',
      'K',
    ]);
  });

  it('maps each coefficient symbol to its row field', () => {
    expect(COEFFICIENTS.map((c) => [c.simbolo, c.key])).toEqual([
      ['T', 'taxaFixa'],
      ['c', 'custoFixo'],
      ['L', 'margemDeLucro'],
      ['M', 'comissaoMarketplace'],
      ['I', 'imposto'],
      ['F', 'frete'],
      ['K', 'marketing'],
    ]);
  });

  // FORMULA_VARIAVEIS is spelled out in legend order rather than spread from
  // COEFFICIENTS, so an eighth coefficient could be added to the grid and never
  // reach the legend. The count assertion above would still pass.
  it('leaves no coefficient undocumented', () => {
    const documentados = new Set(FORMULA_VARIAVEIS.map((v) => v.simbolo));
    for (const c of COEFFICIENTS) expect(documentados.has(c.simbolo)).toBe(true);
    expect(FORMULA_VARIAVEIS).toHaveLength(COEFFICIENTS.length + 1);
  });

  it('distinguishes C from c, which differ only by case', () => {
    const c = FORMULA_VARIAVEIS.find((v) => v.simbolo === 'c');
    const C = FORMULA_VARIAVEIS.find((v) => v.simbolo === 'C');
    expect(C?.label).toBe('Custo do produto');
    expect(c?.label).toBe('Custo fixo');
  });

  it('does not carry the legacy "markeplace" typo', () => {
    const texto = [...FORMULA_REGRAS, ...FORMULA_VARIAVEIS.map((v) => v.label)].join(' ');
    expect(texto).not.toContain('markeplace');
    expect(texto).toContain('Comissão marketplace');
  });

  // `evaluateFormula` implements `^`, but FORMULA_DISALLOWED_CHARS strips it
  // before the parser ever sees it (legacy parity). Documenting it would tell
  // the operator to type something the field silently deletes.
  it('does not advertise an operator the input strips', () => {
    expect(normalizeFormulaInput('2^3')).toBe('23');
    expect(FORMULA_REGRAS.join(' ')).not.toContain('^');
  });
});

/**
 * LIMIAR_AJUDA tells the operator how the engine picks a formula. Prose cannot
 * be asserted, but the two claims it makes can be — against `calcularPreco`
 * itself, so the sentence cannot quietly drift away from the behaviour.
 */
describe('LIMIAR_AJUDA matches what calcularPreco does', () => {
  function formula(limiar: number, expr: string): FormulaCalculoPreco {
    return {
      limiar,
      formula: expr,
      taxaFixa: 0,
      custoFixo: 0,
      margemDeLucro: 0,
      comissaoMarketplace: 0,
      imposto: 0,
      frete: 0,
      marketing: 0,
      faixasTaxaFixaPeso: null,
    };
  }
  const lista = (formulasCalculoPreco: FormulaCalculoPreco[]) => ({
    formulasCalculoPreco,
    formulasPorCategoria: null,
  });

  // Rows are given in DESCENDING limiar order, so "the next row in the list"
  // and "the next lowest limiar" name different winners. Both rows qualify on
  // their own (100 <= 1000 and 20 <= 50); only the ordering decides.
  it('evaluates in ascending limiar order, not in row order', () => {
    const preco = calcularPreco(lista([formula(1000, 'C*10'), formula(50, 'C*2')]), 10);
    expect(preco?.valor).toBe(20);
    expect(LIMIAR_AJUDA).toContain('do menor para o maior limiar');
  });

  // The claim that matters most: exceeding every limiar is not a fallback to
  // another row, it is no price at all.
  it('yields no price when nothing fits, rather than falling back', () => {
    expect(calcularPreco(lista([formula(5, 'C*10')]), 10)).toBeNull();
    expect(LIMIAR_AJUDA).toContain('sem preço');
  });
});
