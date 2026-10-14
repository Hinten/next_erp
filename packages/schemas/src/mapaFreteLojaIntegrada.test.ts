/**
 * The Loja Integrada freight `mapa` rules (master plan step 20, #1826). Every fold here is tested
 * from BOTH sides — a pair that must come out equal and a near-miss that must stay distinct —
 * because a test that a fold APPLIES says nothing about where it STOPS (#1372, and the
 * `equivalence-fold-inventory` row that names this file).
 */
import { describe, expect, it } from 'vitest';
import { mapaDeIntegracoesSchema } from './intFrete';
import {
  TIPOS_ALVO_MAPA_FRETE_LI,
  chaveFormaEnvioLi,
  entradaDoMapaPorChaveLi,
  idDoAlvoDoMapaLi,
  montarEntradaDoMapaLi,
} from './mapaFreteLojaIntegrada';
import { isFreteMarketplaceOwned } from './shared/frete';

/** A shipping method as an order carries it. Neutral names only. */
const FORMA = { id: 141909, code: 'PAC', nome: 'Gateway Teste', tipo: 'PAC' } as const;
const CHAVE = '141909---PAC';

/* -------------------------------------------------------------------------- */
/*                              chaveFormaEnvioLi                             */
/* -------------------------------------------------------------------------- */

describe('chaveFormaEnvioLi — the full `<id>---<code>` key', () => {
  it('EQUAL pair: a numeric id and its decimal string give the SAME key', () => {
    expect(chaveFormaEnvioLi(FORMA)).toBe(CHAVE);
    expect(chaveFormaEnvioLi({ id: '141909', code: 'PAC' })).toBe(CHAVE);
  });

  it('⚠️ NEAR-MISS: the code is kept VERBATIM — a trailing space, the case and another service stay distinct', () => {
    expect(chaveFormaEnvioLi({ id: 141909, code: 'PAC ' })).toBe('141909---PAC ');
    expect(chaveFormaEnvioLi({ id: 141909, code: 'pac' })).toBe('141909---pac');
    expect(chaveFormaEnvioLi({ id: 141909, code: 'SEDEX' })).toBe('141909---SEDEX');
    for (const code of ['PAC ', 'pac', 'SEDEX', ' PAC']) {
      expect(chaveFormaEnvioLi({ id: 141909, code }), code).not.toBe(CHAVE);
    }
  });

  it('⚠️ NEAR-MISS: another id is another key, and a leading zero is not a key at all', () => {
    expect(chaveFormaEnvioLi({ id: 14190, code: 'PAC' })).toBe('14190---PAC');
    expect(chaveFormaEnvioLi({ id: '0141909', code: 'PAC' })).toBeNull();
  });

  it('EQUAL pair: a null code and an absent one both render the literal `null`', () => {
    expect(chaveFormaEnvioLi({ id: 141909, code: null })).toBe('141909---null');
    expect(chaveFormaEnvioLi({ id: 141909 })).toBe('141909---null');
    expect(chaveFormaEnvioLi({ id: 141909, code: undefined })).toBe('141909---null');
  });

  it('⚠️ EQUAL pair (accepted collision): a code that IS the string `null` keys like a missing code', () => {
    // The stored key format cannot tell them apart, and the stored rows of a method without a
    // code carry `---null`, so a provider code spelled `null` shares their row. Pinned in this
    // direction on purpose: the collision is the format's, not a fold this module could undo.
    expect(chaveFormaEnvioLi({ id: 141909, code: 'null' })).toBe('141909---null');
    expect(chaveFormaEnvioLi({ id: 141909, code: 'null' })).toBe(
      chaveFormaEnvioLi({ id: 141909, code: null }),
    );
    // …but only that exact spelling: the code is still verbatim.
    expect(chaveFormaEnvioLi({ id: 141909, code: 'NULL' })).toBe('141909---NULL');
    expect(chaveFormaEnvioLi({ id: 141909, code: 'null ' })).toBe('141909---null ');
  });

  it('⚠️ NEAR-MISS: an EMPTY code is not a missing one — `141909---`, never `141909---null`', () => {
    expect(chaveFormaEnvioLi({ id: 141909, code: '' })).toBe('141909---');
    expect(chaveFormaEnvioLi({ id: 141909, code: '' })).not.toBe('141909---null');
  });

  it('refuses an id that is not a canonical positive safe integer', () => {
    const invalidos: unknown[] = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1e21, // String() is '1e+21'
      Number.MAX_SAFE_INTEGER + 2,
      '0',
      '-1',
      '1.5',
      '1e5',
      ' 141909',
      '141909 ',
      '',
      '9007199254740993', // 16 digits, past MAX_SAFE_INTEGER
      '12345678901234567', // 17 digits
      true,
      null,
      undefined,
      { valor: 1 },
      [141909],
    ];
    for (const id of invalidos) {
      expect(chaveFormaEnvioLi({ id, code: 'PAC' }), String(id)).toBeNull();
    }
  });

  it('accepts the largest safe integer, in either form', () => {
    expect(chaveFormaEnvioLi({ id: Number.MAX_SAFE_INTEGER, code: 'X' })).toBe(
      '9007199254740991---X',
    );
    expect(chaveFormaEnvioLi({ id: '9007199254740991', code: 'X' })).toBe('9007199254740991---X');
  });

  it('refuses a code that is neither a string nor missing', () => {
    for (const code of [5, true, { c: 'PAC' }, ['PAC']]) {
      expect(chaveFormaEnvioLi({ id: 141909, code }), JSON.stringify(code)).toBeNull();
    }
  });

  it('refuses a method that is not a plain object — never throws', () => {
    for (const forma of [null, undefined, 'PAC', 141909, [FORMA]]) {
      expect(chaveFormaEnvioLi(forma), JSON.stringify(forma)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                              idDoAlvoDoMapaLi                              */
/* -------------------------------------------------------------------------- */

describe('idDoAlvoDoMapaLi — the target doc id, which decides "mapped"', () => {
  it('EQUAL pair: a bare id and the path forms name the SAME target', () => {
    expect(idDoAlvoDoMapaLi('abc')).toBe('abc');
    expect(idDoAlvoDoMapaLi('int_frete/abc')).toBe('abc');
    expect(idDoAlvoDoMapaLi('documents/int_frete/abc')).toBe('abc');
    expect(idDoAlvoDoMapaLi('documents/int_frete/abc/')).toBe('abc');
  });

  it('⚠️ NEAR-MISS: a longer id is another target', () => {
    expect(idDoAlvoDoMapaLi('abcd')).toBe('abcd');
    expect(idDoAlvoDoMapaLi('abcd')).not.toBe(idDoAlvoDoMapaLi('abc'));
  });

  it('an absent, null, empty or non-string uid is UNMAPPED', () => {
    for (const uid of [null, undefined, '', '/', '///', 5, { id: 'abc' }]) {
      expect(idDoAlvoDoMapaLi(uid), JSON.stringify(uid)).toBeNull();
    }
  });

  it('⚠️ NEAR-MISS: "mapped" is the uid, never the tipo — a cleared row carries `outros` too', () => {
    const limpa = { integracaoUid: null, targetTipoIntegracao: 'outros' };
    const mapeadaEmOutros = { integracaoUid: 'abc', targetTipoIntegracao: 'outros' };
    expect(idDoAlvoDoMapaLi(limpa.integracaoUid)).toBeNull();
    expect(idDoAlvoDoMapaLi(mapeadaEmOutros.integracaoUid)).toBe('abc');
  });
});

/* -------------------------------------------------------------------------- */
/*                           entradaDoMapaPorChaveLi                          */
/* -------------------------------------------------------------------------- */

describe('entradaDoMapaPorChaveLi — the tolerant raw presence read', () => {
  const linha = (over: Record<string, unknown> = {}) => ({
    nomeOriginal: 'Gateway Teste - PAC',
    idOriginal: CHAVE,
    observacao: 'Origem: Pedido 1',
    nomeTarget: null,
    targetData: null,
    integracaoUid: null,
    targetTipoIntegracao: 'outros',
    ...over,
  });

  it('EQUAL pair: the same key with another nome, tipo or order number IS the method', () => {
    const armazenada = linha({
      nomeOriginal: 'Outro Nome - Outro Tipo',
      observacao: 'Origem: Pedido 9',
    });
    expect(entradaDoMapaPorChaveLi([armazenada], CHAVE)).toBe(armazenada);
  });

  it('⚠️ NEAR-MISS: the same id under another code is ABSENT', () => {
    const armazenada = linha({ idOriginal: '141909---SEDEX' });
    expect(entradaDoMapaPorChaveLi([armazenada], CHAVE)).toBeNull();
    expect(entradaDoMapaPorChaveLi([linha({ idOriginal: '141909---PAC ' })], CHAVE)).toBeNull();
  });

  it('returns the FIRST match, as stored (never a copy, never parsed)', () => {
    const primeira = linha({ integracaoUid: 'alvo-1' });
    const segunda = linha({ integracaoUid: 'alvo-2' });
    expect(
      entradaDoMapaPorChaveLi([linha({ idOriginal: 'outra' }), primeira, segunda], CHAVE),
    ).toBe(primeira);
  });

  it('finds a row that FAILS the row schema — a corpus row never makes a known method look new', () => {
    const torta = { idOriginal: CHAVE, campoLegado: 1 }; // no nomeOriginal
    expect(mapaDeIntegracoesSchema.safeParse(torta).success).toBe(false);
    expect(entradaDoMapaPorChaveLi([torta], CHAVE)).toBe(torta);
  });

  it('skips elements that are not plain objects', () => {
    const alvo = linha();
    expect(entradaDoMapaPorChaveLi([null, 'x', 5, [CHAVE], alvo], CHAVE)).toBe(alvo);
  });

  it('a `mapa` that is not an array reads as "no row" — a map-shaped one included', () => {
    for (const mapa of [null, undefined, 'x', 5, { 0: linha() }, { [CHAVE]: linha() }]) {
      expect(entradaDoMapaPorChaveLi(mapa, CHAVE), JSON.stringify(mapa)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                            montarEntradaDoMapaLi                           */
/* -------------------------------------------------------------------------- */

describe('montarEntradaDoMapaLi — the row the importer appends', () => {
  it('builds the SEVEN keys of a stored row, unmapped', () => {
    const entrada = montarEntradaDoMapaLi({ forma: FORMA, numero: 1234 });
    expect(entrada).toEqual({
      nomeOriginal: 'Gateway Teste - PAC',
      idOriginal: CHAVE,
      observacao: 'Origem: Pedido 1234',
      nomeTarget: null,
      targetData: null,
      integracaoUid: null,
      targetTipoIntegracao: 'outros',
    });
    expect(Object.keys(entrada ?? {}).sort()).toEqual(
      [
        'idOriginal',
        'integracaoUid',
        'nomeOriginal',
        'nomeTarget',
        'observacao',
        'targetData',
        'targetTipoIntegracao',
      ].sort(),
    );
    // It is a valid row, unmapped, and found again by its own key.
    expect(mapaDeIntegracoesSchema.parse(entrada)).toEqual(entrada);
    expect(idDoAlvoDoMapaLi(entrada?.integracaoUid)).toBeNull();
    expect(entradaDoMapaPorChaveLi([entrada], CHAVE)).toBe(entrada);
  });

  it('keys the row with the FULL key — the same id under another code is another row', () => {
    const pac = montarEntradaDoMapaLi({ forma: FORMA, numero: 1 });
    const sedex = montarEntradaDoMapaLi({ forma: { ...FORMA, code: 'SEDEX' }, numero: 2 });
    expect(pac?.idOriginal).toBe(CHAVE);
    expect(sedex?.idOriginal).toBe('141909---SEDEX');
    expect(entradaDoMapaPorChaveLi([pac], sedex?.idOriginal ?? '')).toBeNull();
  });

  it('the label trims each part and joins only the non-empty ones; the key is the fallback', () => {
    const rotulo = (forma: Record<string, unknown>) =>
      montarEntradaDoMapaLi({ forma: { id: 141909, code: 'PAC', ...forma }, numero: 1 })
        ?.nomeOriginal;
    expect(rotulo({ nome: '  Gateway Teste ', tipo: ' PAC ' })).toBe('Gateway Teste - PAC');
    expect(rotulo({ nome: 'Gateway Teste' })).toBe('Gateway Teste');
    expect(rotulo({ tipo: 'PAC' })).toBe('PAC');
    expect(rotulo({ nome: '   ', tipo: '' })).toBe(CHAVE);
    expect(rotulo({})).toBe(CHAVE);
    // A non-string part is ignored, never rendered as `[object Object]`.
    expect(rotulo({ nome: { x: 1 }, tipo: 'PAC' })).toBe('PAC');
  });

  it('the observação names the order, numeric or string', () => {
    expect(montarEntradaDoMapaLi({ forma: FORMA, numero: '77' })?.observacao).toBe(
      'Origem: Pedido 77',
    );
  });

  it('a method with no key registers nothing — `null`, never a throw', () => {
    expect(montarEntradaDoMapaLi({ forma: { ...FORMA, id: '0141909' }, numero: 1 })).toBeNull();
    expect(montarEntradaDoMapaLi({ forma: null, numero: 1 })).toBeNull();
    expect(montarEntradaDoMapaLi({ forma: { ...FORMA, code: 5 }, numero: 1 })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                          TIPOS_ALVO_MAPA_FRETE_LI                          */
/* -------------------------------------------------------------------------- */

describe('TIPOS_ALVO_MAPA_FRETE_LI', () => {
  it('is exactly the five targets the conta screen offers', () => {
    expect(TIPOS_ALVO_MAPA_FRETE_LI).toEqual([
      'melhorEnvios',
      'motoboy',
      'retiradaNaLoja',
      'fob',
      'outros',
    ]);
  });

  it('holds no marketplace-owned tipo — another channel’s freight is never a target', () => {
    for (const tipo of TIPOS_ALVO_MAPA_FRETE_LI) {
      expect(isFreteMarketplaceOwned(tipo), tipo).toBe(false);
    }
    for (const marketplace of ['mercadoLivre', 'shopee', 'lojaIntegrada', 'amz', 'magalu']) {
      expect(TIPOS_ALVO_MAPA_FRETE_LI as readonly string[]).not.toContain(marketplace);
    }
  });
});
