import { describe, expect, it } from 'vitest';

import { CONDICAO_PRODUTO, resolveCondicaoAnuncio } from './extraData';

describe('resolveCondicaoAnuncio', () => {
  it('lets the produto win, because "used" is a fact about the product', () => {
    expect(resolveCondicaoAnuncio({ ehUsado: true, condicao: null })).toEqual({
      condition: 'used',
      fonte: 'produto',
    });
  });

  it('beats a listing that stored the opposite', () => {
    // The regression this ordering fixed: `condition` defaults to `'new'` on
    // every link doc, so a listing-first precedence made the produto branches
    // dead code and a produto marked usado published as new.
    expect(
      resolveCondicaoAnuncio({ ehUsado: true, condicao: null, condicaoAnuncio: 'new' }).condition,
    ).toBe('used');
  });

  // ⚠️ THE case the produto editor got wrong. `extraData.condicao` is an
  // independent field, edited by a Select also labelled "Condição" two tabs
  // away, and nothing keeps it in sync with `ehUsado` — the import writes
  // `ehUsado` every time but `condicao` only on create, and the Flutter app
  // writes it independently too.
  it('honours recondicionado even when the produto switch is off', () => {
    expect(
      resolveCondicaoAnuncio({ ehUsado: false, condicao: CONDICAO_PRODUTO.recondicionado }),
    ).toEqual({ condition: 'used', fonte: 'extraData' });
  });

  it('honours usado from extraData the same way', () => {
    expect(resolveCondicaoAnuncio({ ehUsado: false, condicao: CONDICAO_PRODUTO.usado })).toEqual({
      condition: 'used',
      fonte: 'extraData',
    });
  });

  it('lets novo fall through rather than deciding', () => {
    // 1 is the schema DEFAULT, so treating it as an answer would make the
    // last-resort branch unreachable for every produto that never set it.
    expect(
      resolveCondicaoAnuncio({
        ehUsado: false,
        condicao: CONDICAO_PRODUTO.novo,
        condicaoAnuncio: 'used',
      }),
    ).toEqual({ condition: 'used', fonte: 'anuncio' });
  });

  it('falls back to what the listing stored', () => {
    // An imported listing writes `condition`, so it is the best available answer
    // for a produto whose own flags were never set.
    expect(
      resolveCondicaoAnuncio({ ehUsado: false, condicao: null, condicaoAnuncio: 'used' }),
    ).toEqual({ condition: 'used', fonte: 'anuncio' });
  });

  it('defaults to new when nothing says otherwise', () => {
    expect(resolveCondicaoAnuncio({ ehUsado: false, condicao: null })).toEqual({
      condition: 'new',
      fonte: 'anuncio',
    });
    expect(
      resolveCondicaoAnuncio({ ehUsado: false, condicao: null, condicaoAnuncio: null }).condition,
    ).toBe('new');
  });

  it('treats a not-yet-loaded condicao as undecided, not as novo', () => {
    // The editor passes null while the extraData singleton is still loading.
    // Asserting "novo" for a beat would flash the wrong value and then flip.
    expect(
      resolveCondicaoAnuncio({ ehUsado: false, condicao: null, condicaoAnuncio: 'used' }).condition,
    ).toBe('used');
  });
});
