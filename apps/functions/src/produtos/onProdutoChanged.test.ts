import { describe, expect, it } from 'vitest';

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
