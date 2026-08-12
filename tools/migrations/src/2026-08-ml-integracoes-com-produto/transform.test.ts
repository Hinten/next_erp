import { describe, expect, it } from 'vitest';

import {
  asStringArray,
  contaIdFromRef,
  normalizarCaminho,
  planContaOuterRefBackfill,
  planIntegracoesComProduto,
} from './transform';

const ML_A = 'conta-ml-a';
const ML_B = 'conta-ml-b';
const AMAZON = 'conta-amazon';
const CONTAS_ML = new Set([ML_A, ML_B]);

describe('asStringArray', () => {
  it('keeps strings, drops everything else, and de-duplicates first-seen', () => {
    expect(asStringArray([ML_A, 42, null, ML_A, '', ML_B])).toEqual([ML_A, ML_B]);
  });

  it('is empty for a missing or non-array field', () => {
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray('nope')).toEqual([]);
  });
});

describe('contaIdFromRef', () => {
  it('accepts both stored ref forms', () => {
    expect(contaIdFromRef(`documents/integracao/${ML_A}`)).toBe(ML_A);
    expect(contaIdFromRef(`integracao/${ML_A}`)).toBe(ML_A);
  });

  it('rejects a ref pointing anywhere else, and junk', () => {
    expect(contaIdFromRef('documents/produtos/p1')).toBeNull();
    expect(contaIdFromRef(null)).toBeNull();
    expect(contaIdFromRef(7)).toBeNull();
  });
});

describe('planIntegracoesComProduto', () => {
  it('adds a missing ML conta the links justify', () => {
    expect(planIntegracoesComProduto([], CONTAS_ML, new Set([ML_A]))).toEqual({
      from: [],
      to: [ML_A],
    });
  });

  it('drops an ML conta with no surviving link', () => {
    expect(planIntegracoesComProduto([ML_A], CONTAS_ML, new Set())).toEqual({
      from: [ML_A],
      to: [],
    });
  });

  it('NEVER touches a non-ML id — Amazon writes and reads this same array', () => {
    expect(planIntegracoesComProduto([AMAZON], CONTAS_ML, new Set())).toBeNull();
    expect(planIntegracoesComProduto([AMAZON], CONTAS_ML, new Set([ML_A]))).toEqual({
      from: [AMAZON],
      to: [AMAZON, ML_A],
    });
  });

  it('reconciles ML ids around a foreign one without disturbing it', () => {
    expect(planIntegracoesComProduto([ML_A, AMAZON, ML_B], CONTAS_ML, new Set([ML_B]))).toEqual({
      from: [ML_A, AMAZON, ML_B],
      to: [AMAZON, ML_B],
    });
  });

  it('is a no-op when the array already agrees — the idempotence the runbook checks', () => {
    expect(planIntegracoesComProduto([AMAZON, ML_A], CONTAS_ML, new Set([ML_A]))).toBeNull();
  });

  it('a second run over its own output writes nothing', () => {
    const primeira = planIntegracoesComProduto([ML_A], CONTAS_ML, new Set([ML_B]));
    expect(primeira).toEqual({ from: [ML_A], to: [ML_B] });
    expect(planIntegracoesComProduto(primeira!.to, CONTAS_ML, new Set([ML_B]))).toBeNull();
  });

  it('appends additions in sorted order so a re-run is byte-identical', () => {
    expect(planIntegracoesComProduto([], CONTAS_ML, new Set([ML_B, ML_A]))?.to).toEqual([
      ML_A,
      ML_B,
    ]);
  });

  it('leaves a legacy array that merely repeats an id alone — a duplicate is inert for arrayContains', () => {
    expect(planIntegracoesComProduto([ML_A, ML_A], CONTAS_ML, new Set([ML_A]))).toBeNull();
  });

  it('still reconciles a duplicated array when membership actually moved', () => {
    expect(planIntegracoesComProduto([ML_A, ML_A], CONTAS_ML, new Set([ML_B]))).toEqual({
      from: [ML_A],
      to: [ML_B],
    });
  });
});

describe('planContaOuterRefBackfill', () => {
  it('writes the canonical ref for a row that predates the field', () => {
    expect(planContaOuterRefBackfill(undefined, `integracao/${ML_A}`)).toBe(
      `documents/integracao/${ML_A}`,
    );
  });

  it('skips a row that already carries one', () => {
    expect(
      planContaOuterRefBackfill(`documents/integracao/${ML_A}`, `integracao/${ML_B}`),
    ).toBeNull();
  });

  it('skips rather than guesses when the parent link is gone', () => {
    expect(planContaOuterRefBackfill(undefined, null)).toBeNull();
  });

  it('skips an unparseable parent ref instead of writing junk', () => {
    expect(planContaOuterRefBackfill(undefined, 'integracao')).toBeNull();
  });
});

describe('normalizarCaminho', () => {
  it('lets a stored outer-ref and a live snapshot path compare as one key', () => {
    expect(normalizarCaminho('documents/produtos/p1/produtoMercadoLivre/l1')).toBe(
      'produtos/p1/produtoMercadoLivre/l1',
    );
    expect(normalizarCaminho('produtos/p1/produtoMercadoLivre/l1')).toBe(
      'produtos/p1/produtoMercadoLivre/l1',
    );
  });
});
