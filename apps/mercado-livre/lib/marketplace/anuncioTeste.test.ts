import { describe, expect, it } from 'vitest';

import {
  CATEGORIA_TESTE_NOME,
  DESCRICAO_ANUNCIO_TESTE,
  TITULO_ANUNCIO_TESTE,
  encontrarCategoriaTeste,
  escolherDescendenteTeste,
  escolherTipoAnuncioTeste,
  isContaDeTeste,
} from './anuncioTeste';

describe('the documented test-listing title', () => {
  it('is ML’s exact string, not a paraphrase', () => {
    // Quoted from "Realização de testes": «Os anúncios devem ter o título "Item
    // de Teste – Por favor, NÃO OFERTAR!"». ML asks for this text so its own
    // staff can recognise a test listing; a reworded version is not the same
    // signal. Note the EN DASH and the trailing exclamation mark.
    expect(TITULO_ANUNCIO_TESTE).toBe('Item de Teste – Por favor, NÃO OFERTAR!');
  });

  it('explains itself to whoever finds the listing', () => {
    expect(DESCRICAO_ANUNCIO_TESTE).toMatch(/não oferte/i);
  });
});

describe('escolherTipoAnuncioTeste', () => {
  it('prefers `free`, the lowest exposure ML publishes', () => {
    // `free` is `listing_exposure: lowest`, `home_page: false` — precisely what
    // ML's "não apareça na nossa página de início" rule is protecting.
    expect(
      escolherTipoAnuncioTeste([{ id: 'gold_pro' }, { id: 'gold_special' }, { id: 'free' }]),
    ).toBe('free');
  });

  it('NEVER picks a forbidden type, even as the only option', () => {
    // ⚠️ The rule this file exists for. `gold_pro` is Premium and this repo's
    // default since #968, so "just take the first available" would put a test
    // listing at top exposure.
    expect(escolherTipoAnuncioTeste([{ id: 'gold_pro' }])).toBeNull();
    expect(escolherTipoAnuncioTeste([{ id: 'gold' }, { id: 'gold_premium' }])).toBeNull();
  });

  it('falls back down the exposure ladder when `free` is not offered', () => {
    expect(escolherTipoAnuncioTeste([{ id: 'gold_pro' }, { id: 'gold_special' }])).toBe(
      'gold_special',
    );
    expect(escolherTipoAnuncioTeste([{ id: 'gold_pro' }, { id: 'silver' }])).toBe('silver');
  });

  it('takes an unknown type over a forbidden one', () => {
    // ML adds listing types; an unrecognised id is not automatically high
    // exposure, whereas the forbidden three certainly are.
    expect(escolherTipoAnuncioTeste([{ id: 'gold_pro' }, { id: 'novo_tipo' }])).toBe('novo_tipo');
  });

  it('returns null rather than guessing when nothing is offered', () => {
    // The caller leaves the field for the operator. Choosing anything here
    // would be choosing Premium.
    expect(escolherTipoAnuncioTeste([])).toBeNull();
  });
});

describe('encontrarCategoriaTeste', () => {
  it('finds "Outros" among the site roots', () => {
    expect(
      encontrarCategoriaTeste([
        { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
        { id: 'MLB5672', name: 'Outros' },
      ]),
    ).toBe('MLB5672');
  });

  it('matches regardless of case and accents', () => {
    // Matched by NAME on purpose: the MLB id for "Outros" cannot be verified
    // offline, and a hardcoded guess would file a test listing into a real
    // category.
    expect(encontrarCategoriaTeste([{ id: 'X', name: 'OUTROS' }])).toBe('X');
    expect(encontrarCategoriaTeste([{ id: 'X', name: ' outros ' }])).toBe('X');
  });

  it('returns null when ML offers no such root', () => {
    // The caller then leaves the category empty and the operator picks — the
    // cascade is right there.
    expect(encontrarCategoriaTeste([{ id: 'MLB1430', name: 'Roupas' }])).toBeNull();
    expect(encontrarCategoriaTeste([{ id: 'MLB1430', name: null }])).toBeNull();
    expect(encontrarCategoriaTeste([])).toBeNull();
  });

  it('never matches a category that merely CONTAINS the word', () => {
    // "Outros Serviços" is a different category; an includes() match would pick
    // whichever happened to come first.
    expect(encontrarCategoriaTeste([{ id: 'X', name: 'Outros Serviços' }])).toBeNull();
    expect(CATEGORIA_TESTE_NOME).toBe('Outros');
  });
});

describe('isContaDeTeste', () => {
  it('recognises ML’s TEST nickname', () => {
    // `POST /users/test_user` returns nicknames like `TEST0548`; there is no
    // other marker on /users/me, so the nickname is the only signal available.
    expect(isContaDeTeste('TEST0548')).toBe(true);
    expect(isContaDeTeste('  test1234  ')).toBe(true);
  });

  it('recognises the TETE… form ML actually mints', () => {
    // ⚠️ Source: this repo's own captured test-user order, `orderMLWire.test.ts`
    // — a payload tagged `test_order` whose buyer is `nickname: 'TETE8127263'`.
    // A `/^TEST/` predicate misses it, and the direction of that failure is the
    // problem: the operator who does exactly what the alert asks (mint a test
    // user, connect it as a second conta) would be told their COMPLIANT account
    // is not a test account. A warning that fires on the correct setup is one
    // people learn to click past, which costs the single case it exists for.
    expect(isContaDeTeste('TETE8127263')).toBe(true);
    expect(isContaDeTeste('  tete8127263 ')).toBe(true);
  });

  it('does not mistake a real seller for one', () => {
    expect(isContaDeTeste('VESTEFRANCE')).toBe(false);
    expect(isContaDeTeste('LOJA_TEST')).toBe(false);
    expect(isContaDeTeste(null)).toBe(false);
    expect(isContaDeTeste(undefined)).toBe(false);
  });

  it('stays narrow enough to still reject a real seller starting in TE', () => {
    // The widening is `TE(ST|TE)`, not `TE` — "TECIDOS…" must stay a seller.
    expect(isContaDeTeste('TECIDOS_BRASIL')).toBe(false);
    expect(isContaDeTeste('TERRA_MODA')).toBe(false);
  });
});

describe('escolherDescendenteTeste', () => {
  // ⚠️ This is the fix for the defect that made the whole test-fill look broken.
  // ML's "Outros" is a ROOT WITH CHILDREN, and only a leaf can be published into
  // — so requiring the root itself to be a leaf meant the route answered
  // `categoryId: null` on EVERY call, the form's null-guard skipped the write,
  // and the operator watched the título change while the category and the entire
  // attribute grid sat still.
  it('prefers a child that is also named "Outros"', () => {
    expect(
      escolherDescendenteTeste([
        { id: 'MLB1', name: 'Antiguidades' },
        { id: 'MLB2', name: 'Outros' },
      ]),
    ).toBe('MLB2');
  });

  it('matches that child accent- and case-insensitively', () => {
    expect(escolherDescendenteTeste([{ id: 'MLB9', name: 'OUTROS' }])).toBe('MLB9');
  });

  it('falls back to the first child, still inside "Outros"', () => {
    // No homonym: anything under "Outros" is the category ML's documentation
    // asks test listings to use, and the resolved path is shown so the operator
    // can change it. Never a hardcoded id.
    expect(
      escolherDescendenteTeste([
        { id: 'MLB1', name: 'Antiguidades' },
        { id: 'MLB2', name: 'Coleções' },
      ]),
    ).toBe('MLB1');
  });

  it('reports nothing to descend into when there are no children', () => {
    expect(escolherDescendenteTeste([])).toBeNull();
  });

  it('tolerates a child with no name', () => {
    expect(escolherDescendenteTeste([{ id: 'MLB1' }])).toBe('MLB1');
  });
});

describe('the root that stands in for "Outros"', () => {
  // ⚠️ Verified against MLB's LIVE catalogue on 2026-08-14 (conta Lucas Teste):
  // the site has NO root named "Outros". Its 32 roots end in "Mais Categorias",
  // and `Mais Categorias › Outros` is a leaf one level down. Matching only the
  // documented name found nothing, so the route answered `categoryId: null` on
  // every call and the descent never even started — the whole test-fill silently
  // did nothing, which is exactly what Lucas reported twice.
  it('accepts MLB’s "Mais Categorias", which is what the site actually exposes', () => {
    expect(
      encontrarCategoriaTeste([
        { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
        { id: 'MLB5672', name: 'Mais Categorias' },
      ]),
    ).toBe('MLB5672');
  });

  it('still prefers a real "Outros" root when a site has one', () => {
    // Preference order matters: a site exposing both should use the documented
    // one rather than the catch-all.
    expect(
      encontrarCategoriaTeste([
        { id: 'MLB9', name: 'Mais Categorias' },
        { id: 'MLB1', name: 'Outros' },
      ]),
    ).toBe('MLB1');
  });

  it('matches case- and accent-insensitively', () => {
    expect(encontrarCategoriaTeste([{ id: 'X', name: 'MAIS CATEGORIAS' }])).toBe('X');
  });

  it('still reports nothing when neither name is present', () => {
    expect(encontrarCategoriaTeste([{ id: 'MLB1430', name: 'Calçados' }])).toBeNull();
  });
});
