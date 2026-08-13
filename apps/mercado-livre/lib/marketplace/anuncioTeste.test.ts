import { describe, expect, it } from 'vitest';

import {
  CATEGORIA_TESTE_NOME,
  DESCRICAO_ANUNCIO_TESTE,
  TITULO_ANUNCIO_TESTE,
  encontrarCategoriaTeste,
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

  it('does not mistake a real seller for one', () => {
    expect(isContaDeTeste('VESTEFRANCE')).toBe(false);
    expect(isContaDeTeste('LOJA_TEST')).toBe(false);
    expect(isContaDeTeste(null)).toBe(false);
    expect(isContaDeTeste(undefined)).toBe(false);
  });
});
