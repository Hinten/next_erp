/**
 * The Loja Integrada freight `mapa` rules (master plan step 20, #1826). Every fold here is tested
 * from BOTH sides — a pair that must come out equal and a near-miss that must stay distinct —
 * because a test that a fold APPLIES says nothing about where it STOPS (#1372, and the
 * `equivalence-fold-inventory` row that names this file).
 */
import { describe, expect, it } from 'vitest';
import { MOTIVO_FRETE_NAO_SUPORTADO_LI, motivoFreteNaoSuportadoLiSchema } from './aviso';
import { mapaDeIntegracoesSchema } from './intFrete';
import {
  MOTIVO_ROTA_ETIQUETA_LI,
  POLITICA_ALVO_ETIQUETA_LI,
  TIPOS_ALVO_MAPA_FRETE_LI,
  alvoDispensaEnderecoLi,
  avaliarAlvoDoMapaLi,
  chaveFormaEnvioLi,
  classificarDocDoFreteLi,
  concluirRotaEtiquetaLi,
  decidirLinhaDoMapaLi,
  entradaDoMapaPorChaveLi,
  idDoAlvoDoMapaLi,
  idIntFreteDaRefLi,
  idServicoMelhorEnvioLi,
  inteiroPositivoCanonicoLi,
  montarEntradaDoMapaLi,
  motivoRotaEtiquetaLiSchema,
  planejarRotaEtiquetaLi,
  recusaDoDocLiParaRotaLi,
  recusaDoPedidoParaRotaLi,
  type PlanoRotaEtiquetaLi,
  type PoliticaAlvoLi,
} from './mapaFreteLojaIntegrada';
import { ESTADO_PEDIDO } from './pedido/collection/pedido';
import { INTEGRACAO_FRETE, MODALIDADE_FRETE, isFreteMarketplaceOwned } from './shared/frete';
import * as barrel from './index';

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
    // An ARRAY is refused even when it carries the method's fields as properties.
    expect(chaveFormaEnvioLi(Object.assign([], FORMA))).toBeNull();
    expect(montarEntradaDoMapaLi({ forma: Object.assign([], FORMA), numero: 1 })).toBeNull();
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
    // An array element is skipped even when it carries an `idOriginal` property.
    const arranjo = Object.assign([], { idOriginal: CHAVE });
    expect(entradaDoMapaPorChaveLi([arranjo, alvo], CHAVE)).toBe(alvo);
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

/* -------------------------------------------------------------------------- */
/*                 The label route (step 15, #1825): the readers              */
/* -------------------------------------------------------------------------- */

describe('inteiroPositivoCanonicoLi — the one canonical positive-integer reader', () => {
  it('EQUAL pair: a number and its canonical decimal string give the SAME answer', () => {
    expect(inteiroPositivoCanonicoLi(3)).toBe('3');
    expect(inteiroPositivoCanonicoLi('3')).toBe('3');
    expect(inteiroPositivoCanonicoLi(165)).toBe(inteiroPositivoCanonicoLi('165'));
    expect(inteiroPositivoCanonicoLi(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(inteiroPositivoCanonicoLi('9007199254740991')).toBe('9007199254740991');
  });

  it('⚠️ NEAR-MISS: a leading zero, a fraction, an exponent, a sign or a space is NOT canonical', () => {
    const naoCanonicos: unknown[] = [
      '03',
      '3.0',
      '1e3',
      ' 3',
      '3 ',
      '+3',
      '-3',
      '0',
      '',
      '9007199254740992', // past MAX_SAFE_INTEGER
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      1e21,
      true,
      null,
      undefined,
      { id: 3 },
      [3],
    ];
    for (const valor of naoCanonicos) {
      expect(inteiroPositivoCanonicoLi(valor), String(valor)).toBeNull();
    }
  });

  it('is exactly the id part of the mapa key — one rule, never two', () => {
    for (const id of [3, '3', '03', '3.0', 0, 1.5, '1e3', 141909, '141909', ' 1']) {
      const doLeitor = inteiroPositivoCanonicoLi(id);
      expect(chaveFormaEnvioLi({ id, code: 'X' }), String(id)).toBe(
        doLeitor === null ? null : `${doLeitor}---X`,
      );
    }
  });
});

describe('idServicoMelhorEnvioLi — the one Melhor Envio service reader', () => {
  it("EQUAL pair: service `3` ≡ `'3'`", () => {
    expect(idServicoMelhorEnvioLi({ id: 3, name: 'PAC' })).toBe('3');
    expect(idServicoMelhorEnvioLi({ id: '3' })).toBe('3');
  });

  it("⚠️ NEAR-MISS: `'03'`, `'3.0'`, `0` and `'1e3'` name NO service", () => {
    for (const id of ['03', '3.0', 0, '1e3', -3, 3.5]) {
      expect(idServicoMelhorEnvioLi({ id }), String(id)).toBeNull();
    }
  });

  it('a targetData that is not a plain object, or carries no id, names no service', () => {
    for (const targetData of [null, undefined, 3, '3', [3], {}, { servico: 3 }]) {
      expect(idServicoMelhorEnvioLi(targetData), JSON.stringify(targetData)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                           decidirLinhaDoMapaLi                             */
/* -------------------------------------------------------------------------- */

/** A stored `mapa` row, mapped or not. */
const linhaMapa = (over: Record<string, unknown> = {}) => ({
  nomeOriginal: 'Gateway Teste - PAC',
  idOriginal: CHAVE,
  observacao: 'Origem: Pedido 1',
  nomeTarget: null,
  targetData: null,
  integracaoUid: null,
  targetTipoIntegracao: 'outros',
  ...over,
});

describe('decidirLinhaDoMapaLi — the row a shipping method maps to', () => {
  const mapeada = linhaMapa({
    integracaoUid: 'me-1',
    targetTipoIntegracao: 'melhorEnvios',
    targetData: { id: 3 },
  });

  it('EQUAL pair: a numeric forma id and its decimal string decide the SAME row', () => {
    const esperado = {
      tipo: 'mapeado',
      chave: CHAVE,
      alvoId: 'me-1',
      nomeOriginal: 'Gateway Teste - PAC',
      idServico: '3',
    };
    expect(decidirLinhaDoMapaLi([mapeada], { id: 141909, code: 'PAC' })).toEqual(esperado);
    expect(decidirLinhaDoMapaLi([mapeada], { id: '141909', code: 'PAC' })).toEqual(esperado);
  });

  it("⚠️ NEAR-MISS: the same id under another code, case or a trailing space is `nao-mapeado` — never the sibling row's target", () => {
    for (const code of ['SEDEX', 'pac', 'PAC ']) {
      expect(decidirLinhaDoMapaLi([mapeada], { id: 141909, code }), code).toEqual({
        tipo: 'nao-mapeado',
        chave: `141909---${code}`,
      });
    }
  });

  it('EQUAL pair: uid `x` ≡ `int_frete/x` ≡ `documents/int_frete/x` name the SAME target', () => {
    for (const uid of ['x', 'int_frete/x', 'documents/int_frete/x']) {
      const linha = decidirLinhaDoMapaLi([linhaMapa({ integracaoUid: uid })], FORMA);
      expect(linha.tipo === 'mapeado' ? linha.alvoId : null, uid).toBe('x');
    }
  });

  it('⚠️ NEAR-MISS: uid `x1` is ANOTHER target, and a null or empty uid under tipo melhorEnvios is unmapped', () => {
    const outro = decidirLinhaDoMapaLi([linhaMapa({ integracaoUid: 'x1' })], FORMA);
    expect(outro.tipo === 'mapeado' ? outro.alvoId : null).toBe('x1');
    for (const integracaoUid of [null, '']) {
      const linha = linhaMapa({
        integracaoUid,
        targetTipoIntegracao: 'melhorEnvios',
        targetData: { id: 3 },
      });
      expect(decidirLinhaDoMapaLi([linha], FORMA)).toEqual({ tipo: 'nao-mapeado', chave: CHAVE });
    }
  });

  it('⚠️ NEAR-MISS: a uid whose last segment is `.` or `..` is MAPPED to a target no document can be — `alvoId: null`, never an id to read', () => {
    // Every caller judges `alvoId: null` as an absent target, without a read: the
    // filter lives HERE, so no caller can hand `..` to a document read.
    for (const integracaoUid of ['..', '.', 'int_frete/..', 'documents/int_frete/.']) {
      const linha = linhaMapa({ integracaoUid, targetData: { id: 3 } });
      expect(decidirLinhaDoMapaLi([linha], FORMA), integracaoUid).toEqual({
        tipo: 'mapeado',
        chave: CHAVE,
        alvoId: null,
        nomeOriginal: 'Gateway Teste - PAC',
        idServico: '3',
      });
    }
  });

  it('EQUAL pair: an absent or null mapa reads as an EMPTY one ⇒ `nao-mapeado`', () => {
    for (const mapa of [undefined, null, []]) {
      expect(decidirLinhaDoMapaLi(mapa, FORMA), JSON.stringify(mapa)).toEqual({
        tipo: 'nao-mapeado',
        chave: CHAVE,
      });
    }
  });

  it('⚠️ NEAR-MISS: a PRESENT mapa that is not a list ⇒ `mapa-invalido`, never `nao-mapeado`', () => {
    for (const mapa of [{ [CHAVE]: mapeada }, { 0: mapeada }, 'x', 5, true]) {
      expect(decidirLinhaDoMapaLi(mapa, FORMA), JSON.stringify(mapa)).toEqual({
        tipo: 'mapa-invalido',
        chave: CHAVE,
      });
    }
  });

  it('an unkeyable method (`externalOptionData: null` included) ⇒ `sem-chave`, before the mapa is looked at', () => {
    for (const forma of [null, undefined, { id: '0141909', code: 'PAC' }, { id: 1, code: 5 }]) {
      expect(decidirLinhaDoMapaLi('não é lista', forma), JSON.stringify(forma)).toEqual({
        tipo: 'sem-chave',
      });
    }
  });

  it('a row `nomeOriginal` that is not a string is no name — `null`, never the raw value', () => {
    for (const nomeOriginal of [5, { nome: 'x' }, null, undefined]) {
      const linha = linhaMapa({ integracaoUid: 'me-1', nomeOriginal });
      const decisao = decidirLinhaDoMapaLi([linha], FORMA);
      expect(decisao.tipo === 'mapeado' ? decisao.nomeOriginal : 'x', String(nomeOriginal)).toBe(
        null,
      );
    }
  });

  it('never reads `targetTipoIntegracao`: a uid decides, and the service comes from `targetData`', () => {
    const semUid = linhaMapa({ targetTipoIntegracao: 'melhorEnvios', targetData: { id: 3 } });
    expect(decidirLinhaDoMapaLi([semUid], FORMA).tipo).toBe('nao-mapeado');
    const emOutros = linhaMapa({ integracaoUid: 'moto-1', targetData: { id: '03' } });
    expect(decidirLinhaDoMapaLi([emOutros], FORMA)).toEqual({
      tipo: 'mapeado',
      chave: CHAVE,
      alvoId: 'moto-1',
      nomeOriginal: 'Gateway Teste - PAC',
      idServico: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                            avaliarAlvoDoMapaLi                             */
/* -------------------------------------------------------------------------- */

describe('avaliarAlvoDoMapaLi — a target read by id, against a policy', () => {
  const ETIQUETA = POLITICA_ALVO_ETIQUETA_LI;
  /** A test policy in the import's shape: fob and outros recognised, left on the conta's doc. */
  const COM_DELIBERADOS: PoliticaAlvoLi = {
    aceitos: [
      INTEGRACAO_FRETE.melhorEnvios,
      INTEGRACAO_FRETE.motoboy,
      INTEGRACAO_FRETE.retiradaNaLoja,
    ],
    deliberados: [INTEGRACAO_FRETE.fob, INTEGRACAO_FRETE.outros],
  };

  it('an absent target (or one that is not a plain object) ⇒ `alvo-ausente`', () => {
    for (const lido of [null, undefined, 'x', [], 5]) {
      expect(avaliarAlvoDoMapaLi(lido, null, ETIQUETA), JSON.stringify(lido)).toEqual({
        tipo: 'invalido',
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoAusente,
      });
    }
  });

  it('EQUAL pair: an absent `ativo` reads as `true`', () => {
    const esperado = { tipo: 'valido', tipoAlvo: 'motoboy', externalOptionId: null };
    expect(avaliarAlvoDoMapaLi({ tipo: 'motoboy' }, null, ETIQUETA)).toEqual(esperado);
    expect(avaliarAlvoDoMapaLi({ tipo: 'motoboy', ativo: true }, null, ETIQUETA)).toEqual(esperado);
  });

  it('⚠️ NEAR-MISS: `ativo: false` ⇒ `alvo-inativo`, before the tipo is looked at', () => {
    for (const tipo of ['motoboy', 'shopee']) {
      expect(avaliarAlvoDoMapaLi({ tipo, ativo: false }, '3', ETIQUETA), tipo).toEqual({
        tipo: 'invalido',
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo,
      });
    }
  });

  it('⚠️ NEAR-MISS: an INACTIVE target is `alvo-inativo` even when its tipo is deliberate — inactive is judged before deliberate', () => {
    for (const tipo of ['fob', 'outros']) {
      expect(avaliarAlvoDoMapaLi({ tipo, ativo: false }, null, COM_DELIBERADOS), tipo).toEqual({
        tipo: 'invalido',
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo,
      });
    }
  });

  it('EQUAL pair: fob and outros are `valido` under the LABEL policy', () => {
    for (const tipo of ['fob', 'outros']) {
      expect(avaliarAlvoDoMapaLi({ tipo }, null, ETIQUETA), tipo).toEqual({
        tipo: 'valido',
        tipoAlvo: tipo,
        externalOptionId: null,
      });
    }
  });

  it('⚠️ NEAR-MISS: the same targets are `deliberado` under a policy that lists them', () => {
    for (const tipo of ['fob', 'outros']) {
      expect(avaliarAlvoDoMapaLi({ tipo }, null, COM_DELIBERADOS), tipo).toEqual({
        tipo: 'deliberado',
        tipoAlvo: tipo,
      });
    }
  });

  it('⚠️ NEAR-MISS: a marketplace freight, the Loja Integrada doc itself or an unknown tipo ⇒ `tipo-nao-suportado`', () => {
    for (const tipo of ['shopee', 'lojaIntegrada', 'mercadoLivre', 'amz', 'MelhorEnvios', '', 5]) {
      expect(avaliarAlvoDoMapaLi({ tipo }, '3', ETIQUETA), String(tipo)).toEqual({
        tipo: 'invalido',
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado,
      });
    }
    expect(avaliarAlvoDoMapaLi({}, '3', ETIQUETA)).toEqual({
      tipo: 'invalido',
      motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado,
    });
  });

  it('a target tipo outside the policy’s `aceitos` ⇒ `tipo-nao-suportado`', () => {
    const soMotoboy: PoliticaAlvoLi = { aceitos: [INTEGRACAO_FRETE.motoboy], deliberados: [] };
    expect(avaliarAlvoDoMapaLi({ tipo: 'fob' }, null, soMotoboy)).toEqual({
      tipo: 'invalido',
      motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado,
    });
  });

  it('a Melhor Envio target NEEDS a service: none ⇒ `alvo-sem-servico`; one ⇒ valido, carrying it', () => {
    expect(avaliarAlvoDoMapaLi({ tipo: 'melhorEnvios' }, null, ETIQUETA)).toEqual({
      tipo: 'invalido',
      motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoSemServico,
    });
    expect(avaliarAlvoDoMapaLi({ tipo: 'melhorEnvios' }, '3', ETIQUETA)).toEqual({
      tipo: 'valido',
      tipoAlvo: 'melhorEnvios',
      externalOptionId: '3',
    });
  });

  it('any other target never carries the service, even when one is passed', () => {
    for (const tipo of ['motoboy', 'retiradaNaLoja', 'fob', 'outros']) {
      const avaliacao = avaliarAlvoDoMapaLi({ tipo }, '3', ETIQUETA);
      expect(avaliacao.tipo === 'valido' ? avaliacao.externalOptionId : 'x', tipo).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                              idIntFreteDaRefLi                             */
/* -------------------------------------------------------------------------- */

describe('idIntFreteDaRefLi — the one `int_frete` ref reader', () => {
  it('EQUAL pair: `int_frete/<id>` ≡ `documents/int_frete/<id>` name the SAME doc', () => {
    for (const ref of [
      'int_frete/abc',
      'documents/int_frete/abc',
      '/documents/int_frete/abc',
      'documents/int_frete/abc/',
    ]) {
      expect(idIntFreteDaRefLi(ref), ref).toBe('abc');
    }
  });

  it('⚠️ NEAR-MISS: a longer or padded id is ANOTHER doc — the id is never trimmed', () => {
    expect(idIntFreteDaRefLi('int_frete/abcd')).toBe('abcd');
    expect(idIntFreteDaRefLi('int_frete/ abc')).toBe(' abc');
    expect(idIntFreteDaRefLi('documents/int_frete/ABC')).toBe('ABC');
  });

  it('⚠️ NEAR-MISS: another collection, a nested doc, `.`/`..` and an empty ref name NO doc', () => {
    for (const ref of [
      'integracao/abc',
      'documents/integracao/abc',
      // A collection name as long as `int_frete`: only the prefix check refuses it.
      'enderecos/abc',
      'int_frete_x/abc',
      'documents/clientes/c/int_frete/abc',
      'int_frete/abc/sub/x',
      'documents/int_frete/abc/sub/x',
      'int_frete/.',
      'documents/int_frete/..',
      'int_frete',
      'documents/int_frete/',
      ' documents/int_frete/abc',
      '',
      '/',
    ]) {
      expect(idIntFreteDaRefLi(ref), ref).toBeNull();
    }
  });

  it('⚠️ NEAR-MISS: a NAKED id is not a ref — it names no doc, unlike a mapa row’s `integracaoUid`', () => {
    expect(idIntFreteDaRefLi('abc')).toBeNull();
    expect(idDoAlvoDoMapaLi('abc')).toBe('abc');
  });

  it('a non-string names no doc — an object carrying a `path` included', () => {
    for (const ref of [null, undefined, 5, true, { path: 'int_frete/abc' }, ['int_frete', 'abc']]) {
      expect(idIntFreteDaRefLi(ref), JSON.stringify(ref)).toBeNull();
    }
  });

  it('reads back the ref a route writes as its own target id', () => {
    for (const escolha of ['moto-1', 'a.b', '__x__']) {
      const plano = planejarRotaEtiquetaLi(
        { externalOptionData: { ...FORMA }, enderecoFreteOuterReference: 'documents/e/1' },
        [],
        escolha,
      );
      const rota = concluirRotaEtiquetaLi(plano, { tipo: 'motoboy' }, null);
      expect(rota.tipo === 'rota' ? idIntFreteDaRefLi(rota.integracaoFreteOuterRef) : null).toBe(
        escolha,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The guards                                 */
/* -------------------------------------------------------------------------- */

describe('classificarDocDoFreteLi — what the pedido’s freight ref names', () => {
  it('a label target is already routed — active or not', () => {
    for (const tipo of TIPOS_ALVO_MAPA_FRETE_LI) {
      expect(classificarDocDoFreteLi({ tipo, ativo: false }), tipo).toEqual({
        tipo: 'alvo',
        tipoAlvo: tipo,
      });
    }
  });

  it('the Loja Integrada doc still needs a route', () => {
    expect(classificarDocDoFreteLi({ tipo: 'lojaIntegrada' })).toEqual({ tipo: 'doc-li' });
  });

  it('⚠️ NEAR-MISS: an absent doc, another marketplace’s freight or an unknown tipo has NO route', () => {
    for (const lido of [null, undefined, {}, { tipo: 'shopee' }, { tipo: 'LojaIntegrada' }]) {
      expect(classificarDocDoFreteLi(lido), JSON.stringify(lido)).toEqual({ tipo: 'sem-rota-li' });
    }
  });
});

describe('recusaDoPedidoParaRotaLi — the pedido guard', () => {
  const pedido = (over: Record<string, unknown> = {}, frete: Record<string, unknown> = {}) => ({
    estado: ESTADO_PEDIDO.pago,
    freteInicial: { printLabelId: null, modalidade: MODALIDADE_FRETE.cif, ...frete },
    ...over,
  });

  it('EQUAL pair: a `pago` pedido passes the pedido guard', () => {
    expect(recusaDoPedidoParaRotaLi(pedido())).toBeNull();
    expect(recusaDoPedidoParaRotaLi(pedido({}, { modalidade: MODALIDADE_FRETE.fob }))).toBeNull();
  });

  it('⚠️ NEAR-MISS: `carrinho` and `processandoCancelamento` ⇒ `estado-nao-pago`', () => {
    for (const estado of [
      ESTADO_PEDIDO.carrinho,
      ESTADO_PEDIDO.processandoCancelamento,
      ESTADO_PEDIDO.cancelado,
      ESTADO_PEDIDO.estornadoIntegralmente,
      'Pago',
      undefined,
    ]) {
      expect(recusaDoPedidoParaRotaLi(pedido({ estado })), String(estado)).toBe(
        MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago,
      );
    }
    expect(recusaDoPedidoParaRotaLi(null)).toBe(MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago);
  });

  it('a bought label ⇒ `etiqueta-ja-comprada`; a null or absent `printLabelId` passes', () => {
    expect(recusaDoPedidoParaRotaLi(pedido({}, { printLabelId: 'ord-1' }))).toBe(
      MOTIVO_ROTA_ETIQUETA_LI.etiquetaJaComprada,
    );
    expect(
      recusaDoPedidoParaRotaLi(pedido({ freteInicial: { modalidade: MODALIDADE_FRETE.cif } })),
    ).toBeNull();
  });

  it('EQUAL pair: an EMPTY `printLabelId` names no label, as the Melhor Envio buy reads it — ⚠️ NEAR-MISS: any non-empty id is a bought label', () => {
    // The buy's own anchor reads a label id as a NON-EMPTY string; a guard that
    // read `''` as bought would refuse a pedido the buy itself calls label-free.
    for (const printLabelId of ['', null, undefined, 123]) {
      expect(recusaDoPedidoParaRotaLi(pedido({}, { printLabelId })), String(printLabelId)).toBe(
        null,
      );
    }
    for (const printLabelId of ['ord-1', ' ', '0']) {
      expect(recusaDoPedidoParaRotaLi(pedido({}, { printLabelId })), printLabelId).toBe(
        MOTIVO_ROTA_ETIQUETA_LI.etiquetaJaComprada,
      );
    }
  });

  it('modalidade `9` ships nothing ⇒ `sem-frete`', () => {
    expect(
      recusaDoPedidoParaRotaLi(pedido({}, { modalidade: MODALIDADE_FRETE.semTransporte })),
    ).toBe(MOTIVO_ROTA_ETIQUETA_LI.semFrete);
  });

  it('checks in a fixed order: estado, then label, then modalidade', () => {
    const tudoErrado = pedido(
      { estado: ESTADO_PEDIDO.carrinho },
      { printLabelId: 'ord-1', modalidade: MODALIDADE_FRETE.semTransporte },
    );
    expect(recusaDoPedidoParaRotaLi(tudoErrado)).toBe(MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago);
    expect(
      recusaDoPedidoParaRotaLi(
        pedido({}, { printLabelId: 'ord-1', modalidade: MODALIDADE_FRETE.semTransporte }),
      ),
    ).toBe(MOTIVO_ROTA_ETIQUETA_LI.etiquetaJaComprada);
  });
});

describe('recusaDoDocLiParaRotaLi — the Loja Integrada doc guard', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    tipo: 'lojaIntegrada',
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: 'documents/integracao/c',
    ...over,
  });

  it("EQUAL pair: the pedido's conta ref `integracao/c` ≡ `documents/integracao/c`", () => {
    expect(recusaDoDocLiParaRotaLi(doc(), 'integracao/c')).toBeNull();
    expect(recusaDoDocLiParaRotaLi(doc(), 'documents/integracao/c')).toBeNull();
    expect(recusaDoDocLiParaRotaLi(doc(), '/documents/integracao/c')).toBeNull();
  });

  it('⚠️ NEAR-MISS: back-ref `integracao/c2`, or `ativo: false` ⇒ `doc-li-divergente`', () => {
    expect(recusaDoDocLiParaRotaLi(doc(), 'integracao/c2')).toBe(
      MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente,
    );
    expect(recusaDoDocLiParaRotaLi(doc({ ativo: false }), 'integracao/c')).toBe(
      MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente,
    );
  });

  it("⚠️ NEAR-MISS: the DOC's back-ref is compared EXACTLY — a bare `integracao/c` is a doc the import's lookup never finds ⇒ `doc-li-divergente`", () => {
    for (const backRef of ['integracao/c', '/documents/integracao/c', 'documents/integracao/c/']) {
      const docFora = doc({ contaLojaIntegradaEnviosOuterRef: backRef });
      for (const doPedido of ['integracao/c', 'documents/integracao/c']) {
        expect(recusaDoDocLiParaRotaLi(docFora, doPedido), `${backRef} × ${doPedido}`).toBe(
          MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente,
        );
      }
    }
  });

  it('an absent `ativo` reads as active', () => {
    const semAtivo = {
      tipo: 'lojaIntegrada',
      contaLojaIntegradaEnviosOuterRef: 'documents/integracao/c',
    };
    expect(recusaDoDocLiParaRotaLi(semAtivo, 'integracao/c')).toBeNull();
  });

  it('an unreadable ref on either side never matches — not even another unreadable one', () => {
    for (const ref of [null, undefined, '', 'integracao', 5]) {
      expect(recusaDoDocLiParaRotaLi(doc(), ref), String(ref)).toBe(
        MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente,
      );
      expect(
        recusaDoDocLiParaRotaLi(doc({ contaLojaIntegradaEnviosOuterRef: ref }), ref),
        String(ref),
      ).toBe(MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente);
    }
    expect(recusaDoDocLiParaRotaLi(null, 'integracao/c')).toBe(
      MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente,
    );
  });
});

describe('alvoDispensaEnderecoLi — only a pickup needs no address', () => {
  it('retiradaNaLoja dispenses one; motoboy and every other target do not', () => {
    expect(alvoDispensaEnderecoLi(INTEGRACAO_FRETE.retiradaNaLoja)).toBe(true);
    for (const tipo of ['motoboy', 'melhorEnvios', 'fob', 'outros', 'RetiradaNaLoja', null]) {
      expect(alvoDispensaEnderecoLi(tipo), String(tipo)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                 planejarRotaEtiquetaLi + concluirRotaEtiquetaLi            */
/* -------------------------------------------------------------------------- */

describe('planejarRotaEtiquetaLi + concluirRotaEtiquetaLi — the label route', () => {
  const ENDERECO = 'documents/clientes/cli-1/enderecos/end-1';
  /** A pedido still on its conta's Loja Integrada doc, with an address. */
  const frete = (over: Record<string, unknown> = {}) => ({
    integracaoFreteOuterRef: 'documents/int_frete/li-doc',
    integracaoTargetOuterRef: null,
    externalOptionId: null,
    externalOptionData: { ...FORMA },
    enderecoFreteOuterReference: ENDERECO,
    ...over,
  });
  const linhaPara = (alvo: string, targetData: unknown = null) =>
    linhaMapa({ integracaoUid: alvo, targetData });

  const ME = { tipo: 'melhorEnvios', ativo: true, nome: 'Conta ME' };
  const MOTO = { tipo: 'motoboy', nome: 'Moto' };
  const RETIRADA = { tipo: 'retiradaNaLoja', nome: 'Balcão' };

  /** Plan, then conclude with the docs by id. */
  function rotear(
    f: unknown,
    mapa: unknown,
    docs: Record<string, unknown>,
    escolha: string | null = null,
  ) {
    const plano = planejarRotaEtiquetaLi(f, mapa, escolha);
    if (plano.tipo === 'recusa') return concluirRotaEtiquetaLi(plano, null, null);
    return concluirRotaEtiquetaLi(
      plano,
      docs[plano.alvoId],
      plano.lerLinha === null ? null : docs[plano.lerLinha],
    );
  }
  const recusa = (motivo: string) => ({ tipo: 'recusa', motivo });

  it('a mapped Melhor Envio method routes to its target, with the row’s service, and writes no override', () => {
    expect(rotear(frete(), [linhaPara('me-1', { id: 3 })], { 'me-1': ME })).toEqual({
      tipo: 'rota',
      origem: 'mapa',
      alvoId: 'me-1',
      tipoAlvo: 'melhorEnvios',
      integracaoFreteOuterRef: 'documents/int_frete/me-1',
      externalOptionId: '3',
      targetEscolhido: null,
    });
  });

  it('EQUAL pair: a numeric forma id and its decimal string route to the SAME target', () => {
    const mapa = [linhaPara('moto-1')];
    const a = rotear(frete(), mapa, { 'moto-1': MOTO });
    const b = rotear(frete({ externalOptionData: { id: '141909', code: 'PAC' } }), mapa, {
      'moto-1': MOTO,
    });
    expect(a).toEqual(b);
    expect(a.tipo === 'rota' ? a.alvoId : null).toBe('moto-1');
  });

  it("⚠️ NEAR-MISS: the same id under another code (`SEDEX`), case (`pac`) or `'PAC '` ⇒ `sem-mapeamento`, NEVER the sibling row's target", () => {
    const mapa = [linhaPara('moto-1')];
    for (const code of ['SEDEX', 'pac', 'PAC ']) {
      expect(
        rotear(frete({ externalOptionData: { id: 141909, code } }), mapa, { 'moto-1': MOTO }),
        code,
      ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.semMapeamento));
    }
  });

  it('`externalOptionData: null` ⇒ `sem-chave`; an absent mapa ⇒ `sem-mapeamento`; a non-list one ⇒ `mapa-invalido`', () => {
    expect(rotear(frete({ externalOptionData: null }), [linhaPara('moto-1')], {})).toEqual(
      recusa(MOTIVO_ROTA_ETIQUETA_LI.semChave),
    );
    expect(rotear(frete(), null, {})).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.semMapeamento));
    expect(rotear(frete(), undefined, {})).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.semMapeamento));
    expect(rotear(frete(), { [CHAVE]: linhaPara('moto-1') }, {})).toEqual(
      recusa(MOTIVO_ROTA_ETIQUETA_LI.mapaInvalido),
    );
  });

  it("EQUAL pair: service `3` ≡ `'3'` — the same route", () => {
    const comNumero = rotear(frete(), [linhaPara('me-1', { id: 3 })], { 'me-1': ME });
    const comTexto = rotear(frete(), [linhaPara('me-1', { id: '3' })], { 'me-1': ME });
    expect(comNumero).toEqual(comTexto);
  });

  it("⚠️ NEAR-MISS: service `'03'`, `'3.0'`, `0` or `'1e3'` ⇒ `alvo-sem-servico`", () => {
    for (const id of ['03', '3.0', 0, '1e3']) {
      expect(rotear(frete(), [linhaPara('me-1', { id })], { 'me-1': ME }), String(id)).toEqual(
        recusa(MOTIVO_ROTA_ETIQUETA_LI.alvoSemServico),
      );
    }
  });

  it('EQUAL pair: an absent `ativo` ≡ `true` ⇒ routed; ⚠️ NEAR-MISS `ativo: false` ⇒ `alvo-inativo`', () => {
    expect(rotear(frete(), [linhaPara('moto-1')], { 'moto-1': { tipo: 'motoboy' } }).tipo).toBe(
      'rota',
    );
    expect(
      rotear(frete(), [linhaPara('moto-1')], { 'moto-1': { tipo: 'motoboy', ativo: false } }),
    ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.alvoInativo));
    expect(rotear(frete(), [linhaPara('moto-1')], {})).toEqual(
      recusa(MOTIVO_ROTA_ETIQUETA_LI.alvoAusente),
    );
  });

  it('a mapped target of tipo `shopee` or `lojaIntegrada` ⇒ `tipo-nao-suportado`', () => {
    for (const tipo of ['shopee', 'lojaIntegrada']) {
      expect(rotear(frete(), [linhaPara('x')], { x: { tipo } }), tipo).toEqual(
        recusa(MOTIVO_ROTA_ETIQUETA_LI.tipoNaoSuportado),
      );
    }
  });

  it('fob and outros targets are routed (the generic label prints them)', () => {
    for (const tipo of ['fob', 'outros']) {
      const rota = rotear(frete(), [linhaPara('x')], { x: { tipo } });
      expect(rota.tipo === 'rota' ? rota.tipoAlvo : null, tipo).toBe(tipo);
    }
  });

  it('a mapped uid that is not a usable doc id is never read ⇒ `alvo-ausente`', () => {
    expect(planejarRotaEtiquetaLi(frete(), [linhaPara('..')])).toEqual(
      recusa(MOTIVO_ROTA_ETIQUETA_LI.alvoAusente),
    );
  });

  /* ------------------------------- override ------------------------------- */

  it('EQUAL pair: a stored override in bare form ≡ its `documents/` form — read first, before the mapa', () => {
    const mapa = [linhaPara('me-1', { id: 3 })];
    for (const ref of ['int_frete/moto-1', 'documents/int_frete/moto-1']) {
      const rota = rotear(frete({ integracaoTargetOuterRef: ref }), mapa, {
        'moto-1': MOTO,
        'me-1': ME,
      });
      expect(rota, ref).toEqual({
        tipo: 'rota',
        origem: 'override',
        alvoId: 'moto-1',
        tipoAlvo: 'motoboy',
        integracaoFreteOuterRef: 'documents/int_frete/moto-1',
        externalOptionId: null,
        targetEscolhido: null,
      });
    }
  });

  it('⚠️ NEAR-MISS: an override naming `integracao/x` ⇒ `override-invalido`, and an invalid override NEVER falls back to the mapa', () => {
    const mapa = [linhaPara('moto-1')];
    for (const ref of [
      'integracao/x',
      'documents/integracao/x',
      'int_frete/x/sub/y',
      'int_frete',
      // A naked id is not a ref, even one naming a real target (`idIntFreteDaRefLi`).
      'moto-1',
      '',
      5,
    ]) {
      expect(
        rotear(frete({ integracaoTargetOuterRef: ref }), mapa, { 'moto-1': MOTO }),
        String(ref),
      ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido));
    }
  });

  it('⚠️ NEAR-MISS: an override naming a sub-path or a `..` id is refused by the PLAN — no document is ever read for it', () => {
    for (const ref of ['int_frete/x/sub/y', 'documents/int_frete/x/sub/y', 'int_frete/..']) {
      expect(
        planejarRotaEtiquetaLi(frete({ integracaoTargetOuterRef: ref }), [linhaPara('moto-1')]),
        ref,
      ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido));
    }
  });

  it('an override naming an absent, inactive or unsupported target ⇒ `override-invalido` (never the mapa)', () => {
    const mapa = [linhaPara('moto-1')];
    for (const alvo of [undefined, { tipo: 'motoboy', ativo: false }, { tipo: 'shopee' }]) {
      expect(
        rotear(frete({ integracaoTargetOuterRef: 'int_frete/x' }), mapa, {
          x: alvo,
          'moto-1': MOTO,
        }),
        JSON.stringify(alvo),
      ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido));
    }
  });

  /* -------------------------------- escolha ------------------------------- */

  it('an escolha wins over a stored override and the mapa, and is the ONLY origin that writes `integracaoTargetOuterRef`', () => {
    const rota = rotear(
      frete({ integracaoTargetOuterRef: 'int_frete/x' }),
      [linhaPara('me-1', { id: 3 })],
      { 'moto-2': MOTO, x: { tipo: 'shopee' } },
      'moto-2',
    );
    expect(rota).toEqual({
      tipo: 'rota',
      origem: 'escolha',
      alvoId: 'moto-2',
      tipoAlvo: 'motoboy',
      integracaoFreteOuterRef: 'documents/int_frete/moto-2',
      externalOptionId: null,
      targetEscolhido: 'documents/int_frete/moto-2',
    });
  });

  it('⚠️ NEAR-MISS: a mapa route and an override route never write `integracaoTargetOuterRef`', () => {
    const doMapa = rotear(frete(), [linhaPara('moto-1')], { 'moto-1': MOTO });
    const doOverride = rotear(frete({ integracaoTargetOuterRef: 'int_frete/moto-1' }), [], {
      'moto-1': MOTO,
    });
    expect(doMapa.tipo === 'rota' ? doMapa.targetEscolhido : 'x').toBeNull();
    expect(doOverride.tipo === 'rota' ? doOverride.targetEscolhido : 'x').toBeNull();
  });

  it('an escolha that is not a usable doc id ⇒ `override-invalido`, with no read', () => {
    for (const escolha of ['', 'a/b', '.', '..']) {
      expect(planejarRotaEtiquetaLi(frete(), [], escolha), escolha).toEqual(
        recusa(MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido),
      );
    }
  });

  /* ------------------- the service of a hand-picked target ------------------ */

  it("EQUAL pair: a hand-chosen Melhor Envio target takes the service of the method's own row when THAT row's target is Melhor Envio", () => {
    const rota = rotear(
      frete(),
      [linhaPara('me-1', { id: 3 })],
      { 'me-1': ME, 'me-2': ME },
      'me-2',
    );
    expect(rota.tipo === 'rota' ? [rota.alvoId, rota.externalOptionId] : null).toEqual([
      'me-2',
      '3',
    ]);
  });

  it('⚠️ NEAR-MISS: the same row pointing at a MOTOBOY target ⇒ `alvo-sem-servico` (its `targetData.id` is not a service)', () => {
    expect(
      rotear(frete(), [linhaPara('moto-1', { id: 3 })], { 'moto-1': MOTO, 'me-2': ME }, 'me-2'),
    ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.alvoSemServico));
  });

  it('a hand-chosen Melhor Envio target with no row for the method ⇒ `alvo-sem-servico`', () => {
    expect(rotear(frete(), [], { 'me-2': ME }, 'me-2')).toEqual(
      recusa(MOTIVO_ROTA_ETIQUETA_LI.alvoSemServico),
    );
  });

  it('a stored `externalOptionId` applies only BESIDE its own ref (bare ≡ `documents/`)', () => {
    const naPropriaRef = rotear(
      frete({ integracaoFreteOuterRef: 'int_frete/me-2', externalOptionId: '7' }),
      [linhaPara('me-1', { id: 3 })],
      { 'me-1': ME, 'me-2': ME },
      'me-2',
    );
    expect(naPropriaRef.tipo === 'rota' ? naPropriaRef.externalOptionId : null).toBe('7');
    // NEAR-MISS: beside the Loja Integrada doc's ref the stored option is ignored — the row's
    // service applies instead.
    const naRefDoDocLi = rotear(
      frete({ externalOptionId: '7' }),
      [linhaPara('me-1', { id: 3 })],
      { 'me-1': ME, 'me-2': ME },
      'me-2',
    );
    expect(naRefDoDocLi.tipo === 'rota' ? naRefDoDocLi.externalOptionId : null).toBe('3');
  });

  it("EQUAL pair: a stored `externalOptionId` `7` ≡ `'7'` beside its own ref — ⚠️ NEAR-MISS: a stored `'07'` is NO service, so the row's applies", () => {
    const comArmazenado = (externalOptionId: unknown) =>
      rotear(
        frete({ integracaoFreteOuterRef: 'documents/int_frete/me-2', externalOptionId }),
        [linhaPara('me-1', { id: 3 })],
        { 'me-1': ME, 'me-2': ME },
        'me-2',
      );
    for (const armazenado of [7, '7']) {
      const rota = comArmazenado(armazenado);
      expect(rota.tipo === 'rota' ? rota.externalOptionId : null, String(armazenado)).toBe('7');
    }
    for (const armazenado of ['07', '7.0', 0]) {
      const rota = comArmazenado(armazenado);
      expect(rota.tipo === 'rota' ? rota.externalOptionId : null, String(armazenado)).toBe('3');
    }
  });

  /* ------------------------------- endereço ------------------------------- */

  it('EQUAL pair: no endereço + a `retiradaNaLoja` target ⇒ routed', () => {
    for (const enderecoFreteOuterReference of [null, undefined, '']) {
      const rota = rotear(frete({ enderecoFreteOuterReference }), [linhaPara('ret-1')], {
        'ret-1': RETIRADA,
      });
      expect(rota.tipo === 'rota' ? rota.tipoAlvo : null).toBe('retiradaNaLoja');
    }
  });

  it('⚠️ NEAR-MISS: no endereço + a `motoboy` or `melhorEnvios` target ⇒ `sem-endereco`', () => {
    expect(
      rotear(frete({ enderecoFreteOuterReference: null }), [linhaPara('moto-1')], {
        'moto-1': MOTO,
      }),
    ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.semEndereco));
    expect(
      rotear(frete({ enderecoFreteOuterReference: null }), [linhaPara('me-1', { id: 3 })], {
        'me-1': ME,
      }),
    ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.semEndereco));
  });

  it('⚠️ NEAR-MISS: an EMPTY or unreadable endereço ref is no address — a motoboy target ⇒ `sem-endereco`', () => {
    for (const enderecoFreteOuterReference of ['', 'clientes', 'documents/clientes', 5]) {
      expect(
        rotear(frete({ enderecoFreteOuterReference }), [linhaPara('moto-1')], { 'moto-1': MOTO }),
        String(enderecoFreteOuterReference),
      ).toEqual(recusa(MOTIVO_ROTA_ETIQUETA_LI.semEndereco));
    }
  });

  it('the endereço is judged AFTER the target: a failing target refuses with its own motivo', () => {
    expect(rotear(frete({ enderecoFreteOuterReference: null }), [linhaPara('moto-1')], {})).toEqual(
      recusa(MOTIVO_ROTA_ETIQUETA_LI.alvoAusente),
    );
  });

  it('a refusal plan passes through `concluirRotaEtiquetaLi` unchanged, whatever was read', () => {
    const plano: PlanoRotaEtiquetaLi = {
      tipo: 'recusa',
      motivo: MOTIVO_ROTA_ETIQUETA_LI.semChave,
    };
    expect(concluirRotaEtiquetaLi(plano, MOTO, ME)).toBe(plano);
  });

  it('a frete block that is not a plain object reads as empty ⇒ `sem-chave`', () => {
    for (const f of [null, undefined, 'x', []]) {
      expect(planejarRotaEtiquetaLi(f, [linhaPara('moto-1')]), JSON.stringify(f)).toEqual(
        recusa(MOTIVO_ROTA_ETIQUETA_LI.semChave),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       The motivos, the policy, the barrel                  */
/* -------------------------------------------------------------------------- */

describe('MOTIVO_ROTA_ETIQUETA_LI', () => {
  it('names every member of the schema, once', () => {
    expect(Object.values(MOTIVO_ROTA_ETIQUETA_LI).sort()).toEqual(
      [...motivoRotaEtiquetaLiSchema.options].sort(),
    );
    expect(motivoRotaEtiquetaLiSchema.options).toHaveLength(14);
  });

  it('carries the four target motivos of the import’s aviso under the SAME spelling', () => {
    for (const motivo of motivoFreteNaoSuportadoLiSchema.options) {
      expect(motivoRotaEtiquetaLiSchema.safeParse(motivo).success, motivo).toBe(true);
    }
  });
});

describe('POLITICA_ALVO_ETIQUETA_LI', () => {
  it('accepts exactly the five targets and holds none deliberately', () => {
    expect(POLITICA_ALVO_ETIQUETA_LI.aceitos).toEqual(TIPOS_ALVO_MAPA_FRETE_LI);
    expect(POLITICA_ALVO_ETIQUETA_LI.deliberados).toEqual([]);
  });
});

describe('barrel — the label route', () => {
  it('exports the resolver and its guards', () => {
    expect(barrel.planejarRotaEtiquetaLi).toBe(planejarRotaEtiquetaLi);
    expect(barrel.concluirRotaEtiquetaLi).toBe(concluirRotaEtiquetaLi);
    expect(barrel.recusaDoDocLiParaRotaLi).toBe(recusaDoDocLiParaRotaLi);
    expect(barrel.recusaDoPedidoParaRotaLi).toBe(recusaDoPedidoParaRotaLi);
    expect(barrel.idServicoMelhorEnvioLi).toBe(idServicoMelhorEnvioLi);
    expect(barrel.idIntFreteDaRefLi).toBe(idIntFreteDaRefLi);
    expect(barrel.MOTIVO_ROTA_ETIQUETA_LI).toBe(MOTIVO_ROTA_ETIQUETA_LI);
  });
});
