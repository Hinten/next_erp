import { describe, expect, it } from 'vitest';

import { CAMPOS_ROLLUP_KIT } from './kitRollupPayload';
import { PRODUTO_HISTORY_IGNORE_FIELDS, produtoExtraIgnores } from './onProdutoChanged';

describe('PRODUTO_HISTORY_IGNORE_FIELDS', () => {
  it('is exactly the noisy/denorm-churn field set (owner list, 2026-07-21; +integracoesComProduto #920, +marketplaceIds #961)', () => {
    expect([...PRODUTO_HISTORY_IGNORE_FIELDS].sort()).toEqual(
      [
        'componentesKitKeys',
        'fotosArquivosIds',
        // #920 moved this array's maintenance into the two ML link triggers, so
        // every publish/import/cancel now writes it from the server. It is
        // denorm churn exactly like its `marketplace` sibling above, and an
        // operator never edits it by hand.
        'integracoesComProduto',
        'marketplace',
        // #961: written by the same five stamps as `marketplace`, but it was
        // missing from this list — so one of the pair produced history rows and
        // the other did not.
        'marketplaceIds',
        'nome_embedding',
        'statusProdutosMarketplace',
        'timestamp',
        'ultimaModificacao',
      ].sort(),
    );
  });
});

describe('produtoExtraIgnores', () => {
  it('is empty for a parent write (paiId null via after)', () => {
    expect(produtoExtraIgnores({}, { paiId: null })).toEqual([]);
  });

  it('is empty for a parent write (paiId absent via after)', () => {
    expect(produtoExtraIgnores({}, {})).toEqual([]);
  });

  it('ignores precos for a variation child write (paiId set via after)', () => {
    expect(produtoExtraIgnores({}, { paiId: 'pai1' })).toEqual(['precos']);
  });

  it('falls back to before.paiId when after is undefined (delete of a variation child)', () => {
    expect(produtoExtraIgnores({ paiId: 'pai1' }, undefined)).toEqual(['precos']);
  });

  it('is empty on a parent delete (before.paiId null, after undefined)', () => {
    expect(produtoExtraIgnores({ paiId: null }, undefined)).toEqual([]);
  });

  it('is empty when both revisions are undefined', () => {
    expect(produtoExtraIgnores(undefined, undefined)).toEqual([]);
  });
});

describe('produtoExtraIgnores — kit rollup fields (#1152)', () => {
  it('ignores the five derived fields on a kit write', () => {
    expect([...produtoExtraIgnores({}, { ehKit: true })].sort()).toEqual(
      ['alturaCm', 'larguraCm', 'pesoBrutoKg', 'pesoLiquidoKg', 'profundidadeCm'].sort(),
    );
  });

  it('does NOT ignore them on an ordinary produto — that is the operator edit worth auditing', () => {
    expect(produtoExtraIgnores({}, { ehKit: false })).toEqual([]);
    expect(produtoExtraIgnores({}, {})).toEqual([]);
  });

  it('stacks with the variation-child precos rule', () => {
    expect([...produtoExtraIgnores({}, { ehKit: true, paiId: 'pai1' })].sort()).toEqual(
      ['alturaCm', 'larguraCm', 'pesoBrutoKg', 'pesoLiquidoKg', 'precos', 'profundidadeCm'].sort(),
    );
  });

  it('falls back to before on a kit delete', () => {
    expect(produtoExtraIgnores({ ehKit: true }, undefined)).toContain('pesoBrutoKg');
  });

  it('covers EVERY field the rollup writes', () => {
    // Derived from the rollup's own field list rather than retyped, so a sixth
    // derived field cannot start generating phantom history rows on kits.
    expect([...produtoExtraIgnores({}, { ehKit: true })].sort()).toEqual(
      [...CAMPOS_ROLLUP_KIT].sort(),
    );
  });
});
