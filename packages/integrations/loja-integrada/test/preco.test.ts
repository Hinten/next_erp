import { readdirSync, readFileSync } from 'node:fs';

import * as schemas from '@delfrance/schemas';
import { idDoRecursoLi, RECURSO_URI_LI } from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ChamadaLi,
  criarClienteLeituraLi,
  type LiLeituraClient,
  URL_BASE_LI,
} from '../src/client';
import { criarClienteEscritaLi } from '../src/escrita';
import {
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiNotFoundError,
  LiSchemaError,
  LiThrottleError,
} from '../src/errors';
import * as barril from '../src/index';
import {
  CAMINHO_PRECO_LI,
  caminhoSetPrecoLi,
  classificarSetPrecoLi,
  idsSetPrecoLi,
  type LeituraSetPrecoLi,
  lerPrecosPorIdLi,
  MAX_IDS_SET_PRECO_LI,
  produtoIdDoPrecoLi,
  type ResultadoIdPrecoLi,
} from '../src/preco';
import {
  liEcoPrecoProdutoSchema,
  liPrecoProdutoLinhaSchema,
  liProdutoComPrecoDetalheSchema,
  liSetPrecoSchema,
} from '../src/types';
import {
  corpo400Gateway,
  precoRecursoExemplo,
  precoSetExemplo,
  produtoDetalheExemplo,
} from './_fixtures/especificacao';
import { json, mockFetch, requisicao, TOKEN, texto, verificarSoGet } from './_helpers/mockFetch';

/**
 * The by-id price read (`preco.ts`) and the price schemas (`types.ts`).
 *
 * Two kinds of row. The public document's own price examples
 * (`_fixtures/especificacao.ts`: every leaf verbatim, the ids replaced) pin
 * what the document shows. Every other row is INVENTED, shaped like the rows
 * the owner's read-only price capture (2026-11-24, both stores) measured —
 * seven keys, the amounts as 4-decimal text or `null`, the row's own `id`
 * different from the produto id — with small synthetic ids (`1001`…, `9001`…)
 * that are no real store's. The capture's pages are not committed, by the
 * owner's decision, so every row here stays invented. Nothing here reaches Loja
 * Integrada — every client gets a stub `fetch`, the global one throws for the
 * whole file, and the `afterEach` asserts every request was a `GET` with no
 * body.
 */

const fetchGlobal = vi.fn(() => {
  throw new Error('fetch global chamado num teste do preço');
});

beforeEach(() => {
  fetchGlobal.mockClear();
  vi.stubGlobal('fetch', fetchGlobal);
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchGlobal).not.toHaveBeenCalled();
  verificarSoGet();
});

function cliente(
  fetch: typeof globalThis.fetch,
  onChamada?: (e: ChamadaLi) => void,
): { c: LiLeituraClient; credenciais: () => number } {
  let n = 0;
  let pedidas = 0;
  const c = criarClienteLeituraLi({
    obterCredencial: () => {
      pedidas += 1;
      return { token: TOKEN, ref: 'ref-A' };
    },
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-${String(n)}`;
    },
    agora: () => 0,
    ...(onChamada === undefined ? {} : { onChamada }),
  });
  return { c, credenciais: () => pedidas };
}

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

/**
 * One price row in the measured shape: exactly seven keys, the amounts as text
 * with four decimals, the row's own `id` different from the produto id.
 */
function linha(produtoId: number, extra: Record<string, unknown> = {}) {
  return {
    cheio: '160.0000',
    custo: '80.0000',
    id: produtoId + 6000,
    produto: `/api/v1/produto/${String(produtoId)}`,
    promocional: null,
    resource_uri: `/api/v1/produto_preco/${String(produtoId)}`,
    sob_consulta: false,
    ...extra,
  };
}

/** A by-id answer: `objects`, and `not_found` only when given (absent when complete). */
function resposta(objects: readonly unknown[], notFound?: unknown) {
  return notFound === undefined ? { objects } : { objects, not_found: notFound };
}

/** The envelope as `liSetPrecoSchema` hands it to the classifier. */
function corpo(objects: readonly unknown[], notFound: readonly unknown[] = []) {
  return { objects, not_found: notFound };
}

const ok = (c: unknown) => mockFetch(() => json(c));

async function ler(corpoResposta: unknown, ids: readonly (number | string)[]) {
  const f = ok(corpoResposta);
  const r = await lerPrecosPorIdLi(cliente(f).c, ids);
  return { r, f };
}

/** The result of one asked id. */
function de(leitura: LeituraSetPrecoLi, id: string): ResultadoIdPrecoLi | undefined {
  return leitura.resultados.find((r) => r.id === id)?.resultado;
}

/** A seeded PRNG (mulberry32): the same cases on every run. */
function prng(semente: number): () => number {
  let a = semente;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------------- */

describe('the ids and the path — checked before anything is read or sent', () => {
  it('builds exactly /v1/produto_preco/set/1003;1001;1002: the order given, never sorted, no slash, no query', async () => {
    const f = ok(resposta([linha(1003), linha(1001), linha(1002)]));
    await lerPrecosPorIdLi(cliente(f).c, [1003, 1001, 1002]);
    const { url, init } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(url.href).toBe(`${URL_BASE_LI}/v1/produto_preco/set/1003;1001;1002`);
    expect(url.pathname).toBe('/v1/produto_preco/set/1003;1001;1002');
    expect(url.search).toBe('');
    expect(url.pathname.endsWith('/')).toBe(false);
    expect(caminhoSetPrecoLi([1003, 1001, 1002])).toBe('/v1/produto_preco/set/1003;1001;1002');
    expect(CAMINHO_PRECO_LI).toBe('/v1/produto_preco');
  });

  it('a number and its canonical decimal text name the same product, and the same URL', async () => {
    const f = ok(resposta([linha(1001)]));
    const { c } = cliente(f);
    await lerPrecosPorIdLi(c, [1001]);
    await lerPrecosPorIdLi(c, ['1001']);
    expect(requisicao(f, 0).url.href).toBe(requisicao(f, 1).url.href);
    expect(idsSetPrecoLi([1001, '1002'])).toEqual(['1001', '1002']);
  });

  it('pins the bound: the schemas binding, 100', () => {
    expect(MAX_IDS_SET_PRECO_LI).toBe(100);
    expect(MAX_IDS_SET_PRECO_LI).toBe(schemas.MAX_IDS_SET_PRECO_LI);
  });

  it("near-miss: 100 ids ARE sent, in ONE GET with exactly 99 ';'", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => 1001 + i);
    const f = ok(resposta(ids.map((id) => linha(id))));
    const r = await lerPrecosPorIdLi(cliente(f).c, ids);
    expect(f).toHaveBeenCalledTimes(1);
    const { pathname } = requisicao(f).url;
    expect(pathname.split(';')).toHaveLength(100);
    expect(pathname.match(/;/g)).toHaveLength(99);
    expect(r.dados.contabilizados).toBe(100);
  });

  it.each<[string, readonly (number | string)[]]>([
    ['no id', []],
    ['101 ids', Array.from({ length: 101 }, (_, i) => 1001 + i)],
    ['one id twice, in two spellings', [1001, '1001']],
    ['one id twice', [1001, 1002, 1001]],
  ])('%s → LiConfigError("ids"); nothing fetched, no credential read', async (_caso, ids) => {
    const f = ok(resposta([]));
    const { c, credenciais } = cliente(f);
    const err = await falha(lerPrecosPorIdLi(c, ids));
    expect(err).toBeInstanceOf(LiConfigError);
    expect(err).toMatchObject({ motivo: 'ids', operacao: 'lerPrecosPorId' });
    expect((err as LiConfigError).message).toContain('Nada foi enviado');
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
  });

  it.each<number | string>([
    '0',
    '00',
    '-1',
    '1.5',
    '01',
    ' 1',
    '1 ',
    '+1',
    '1e3',
    '',
    '1/2',
    '1;2',
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    '9007199254740993',
  ])('an id of %j → LiConfigError("caminho"); nothing fetched, no credential read', async (id) => {
    const f = ok(resposta([]));
    const { c, credenciais } = cliente(f);
    const err = await falha(lerPrecosPorIdLi(c, [1001, id]));
    expect(err).toBeInstanceOf(LiConfigError);
    expect(err).toMatchObject({ motivo: 'caminho', operacao: 'lerPrecosPorId' });
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
  });

  it('the exported helpers refuse as the by-id read: each refusal names `lerPrecosPorId`', () => {
    for (const [ler, motivo] of [
      [() => idsSetPrecoLi([]), 'ids'],
      [() => idsSetPrecoLi([1001, '1001']), 'ids'],
      [() => caminhoSetPrecoLi([]), 'ids'],
      [() => caminhoSetPrecoLi([0]), 'caminho'],
      [() => idsSetPrecoLi(['01']), 'caminho'],
    ] as const) {
      expect(ler).toThrow(LiConfigError);
      expect(ler).toThrow(expect.objectContaining({ motivo, operacao: 'lerPrecosPorId' }));
    }
  });

  it('property: 500 random id lists of 1 to 100 build a path that splits back to the ids, in order', () => {
    const aleatorio = prng(13_2024);
    const forma = /^\/v1\/produto_preco\/set\/[1-9]\d*(;[1-9]\d*)*$/;
    for (let caso = 0; caso < 500; caso++) {
      const n = 1 + Math.floor(aleatorio() * 100);
      const ids = new Set<number>();
      while (ids.size < n) ids.add(1 + Math.floor(aleatorio() * 1e12));
      const lista = [...ids];
      const caminho = caminhoSetPrecoLi(lista);
      expect(caminho, String(caso)).toMatch(forma);
      expect(caminho.slice('/v1/produto_preco/set/'.length).split(';').map(Number)).toEqual(lista);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('the price row schema — the fold judges the two amounts, nothing else is judged', () => {
  it('the measured row (seven keys, 4-decimal text) reads, every value VERBATIM', () => {
    const r = linha(1001, { promocional: '0.0000' });
    expect(Object.keys(r)).toHaveLength(7);
    const lida = liPrecoProdutoLinhaSchema.parse(r);
    expect(lida).toEqual(r);
    expect(lida.cheio).toBe('160.0000');
    expect(lida.promocional).toBe('0.0000');
    expect(liPrecoProdutoLinhaSchema.parse(linha(1001)).promocional).toBeNull();
  });

  it.each<[string, unknown]>([
    ['a JSON number', 160],
    ['the document’s 2-decimal text', '12.00'],
    ['a 5-decimal text (the fold reads it; the wire counts no decimals)', '160.00001'],
    ['null', null],
    ['zero', 0],
  ])('EQUAL: cheio as %s reads, verbatim', (_caso, cheio) => {
    expect(liPrecoProdutoLinhaSchema.parse(linha(1001, { cheio })).cheio).toBe(cheio);
    expect(liPrecoProdutoLinhaSchema.parse(linha(1001, { promocional: cheio })).promocional).toBe(
      cheio,
    );
  });

  it.each<[string, unknown]>([
    ['a comma decimal', '1,50'],
    ['a negative text', '-1.00'],
    ['a negative number', -1],
    ['an object', {}],
    ['a boolean', true],
    ['an empty text', ''],
  ])('NEAR-MISS: %s makes the row unreadable, at its own leaf', (_caso, valor) => {
    const cheio = liPrecoProdutoLinhaSchema.safeParse(linha(1001, { cheio: valor }));
    expect(cheio.success).toBe(false);
    expect(cheio.error?.issues.map((i) => i.path)).toEqual([['cheio']]);
    const promo = liPrecoProdutoLinhaSchema.safeParse(linha(1001, { promocional: valor }));
    expect(promo.success).toBe(false);
    expect(promo.error?.issues.map((i) => i.path)).toEqual([['promocional']]);
    // The fold itself says so: the wire keeps no rule of its own.
    expect(schemas.valorPrecoLi(valor)).toBe('ilegivel');
  });

  it.each(['cheio', 'promocional'])(
    'NEAR-MISS: an ABSENT %s makes the row unreadable — while an explicit null reads',
    (campo) => {
      const sem = Object.fromEntries(Object.entries(linha(1001)).filter(([k]) => k !== campo));
      expect(Object.keys(sem)).not.toContain(campo);
      const lida = liPrecoProdutoLinhaSchema.safeParse(sem);
      expect(lida.success).toBe(false);
      expect(lida.error?.issues.map((i) => i.path)).toEqual([[campo]]);
      expect(liPrecoProdutoLinhaSchema.safeParse(linha(1001, { [campo]: null })).success).toBe(
        true,
      );
    },
  );

  it.each(['cheio', 'promocional'])(
    'NEAR-MISS: %s present with the value undefined (no JSON carries it) is refused too — the fold alone would read it as empty',
    (campo) => {
      const comUndefined = linha(1001, { [campo]: undefined });
      expect(Object.keys(comUndefined)).toContain(campo);
      // Anti-vacuity: the fold reads `undefined` as empty, so only the leaf's own check refuses it.
      expect(schemas.valorPrecoLi(undefined)).toBe('vazio');
      const lida = liPrecoProdutoLinhaSchema.safeParse(comUndefined);
      expect(lida.success).toBe(false);
      expect(lida.error?.issues.map((i) => i.path)).toEqual([[campo]]);
    },
  );

  it.each<[string, unknown]>([
    ['a faked text', 'REDACTED'],
    ['a faked number', 0],
    ['the store’s zero text', '0.0000'],
    ['a comma decimal', '1,50'],
    ['a negative', -1],
  ])('custo as %s never makes a row unreadable, and is kept verbatim', (_caso, custo) => {
    expect(liPrecoProdutoLinhaSchema.parse(linha(1001, { custo })).custo).toBe(custo);
  });

  it('an ABSENT custo, an odd sob_consulta, an odd own id and extra keys never refuse a row', () => {
    const { custo: _custo, ...semCusto } = linha(1001);
    expect(liPrecoProdutoLinhaSchema.safeParse(semCusto).success).toBe(true);
    const r = liPrecoProdutoLinhaSchema.parse(
      linha(1001, { sob_consulta: 'x', id: 'x', resource_uri: null, novo: { a: 1 } }),
    );
    expect(r).toMatchObject({ sob_consulta: 'x', id: 'x', resource_uri: null, novo: { a: 1 } });
  });

  it('NEAR-MISS: a produto that is not a string refuses the row at `produto`', () => {
    for (const produto of [1001, null, undefined]) {
      const lida = liPrecoProdutoLinhaSchema.safeParse(linha(1001, { produto }));
      expect(lida.success, String(produto)).toBe(false);
    }
  });

  it('the envelope: `objects` required, `not_found` absent ≡ null ≡ "" ≡ [], a `meta` kept', () => {
    for (const nf of [undefined, null, '', []]) {
      const lido = liSetPrecoSchema.parse(resposta([linha(1001)], nf));
      expect(lido.not_found, JSON.stringify(nf)).toEqual([]);
    }
    expect(liSetPrecoSchema.parse({ objects: [], meta: { x: 1 } })).toMatchObject({
      meta: { x: 1 },
    });
    for (const ruim of [
      {},
      { objects: null },
      { objects: {} },
      { objects: [], not_found: '9001' },
    ]) {
      expect(liSetPrecoSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(false);
    }
  });

  it('the write echo: every field optional and raw, unknown keys kept', () => {
    expect(liEcoPrecoProdutoSchema.parse({})).toEqual({});
    expect(liEcoPrecoProdutoSchema.parse({ cheio: '32.84', promocional: 'x', id: 1 })).toEqual({
      cheio: '32.84',
      promocional: 'x',
      id: 1,
    });
    // Raw on BOTH amounts, whatever the type: a JSON number stays a number, an object stays.
    for (const valor of [32.84, null, {}, true]) {
      expect(liEcoPrecoProdutoSchema.parse({ cheio: valor }).cheio, JSON.stringify(valor)).toBe(
        valor,
      );
      expect(
        liEcoPrecoProdutoSchema.parse({ promocional: valor }).promocional,
        JSON.stringify(valor),
      ).toBe(valor);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('the public document’s own price examples', () => {
  it('every row of the set example parses — and none names a store produto: its `produto` carries ?id_externo=1', () => {
    const lidos = precoSetExemplo.objects.map((r) => liPrecoProdutoLinhaSchema.parse(r));
    expect(lidos).toEqual(precoSetExemplo.objects);
    for (const r of precoSetExemplo.objects) {
      expect(produtoIdDoPrecoLi(r.produto)).toBeNull();
      // Anti-vacuity: the URI does name an id, just not one this package keys on.
      expect(r.produto).toMatch(/^\/api\/v1\/produto\/[1-9]\d*\?id_externo=1$/);
    }
  });

  it('…so the set example, asked by the ids its resource URIs carry, accounts for none of them', async () => {
    const ids = precoSetExemplo.objects.map((r) => Number(r.resource_uri.split('/').at(-1)));
    const err = await falha(lerPrecosPorIdLi(cliente(ok(precoSetExemplo)).c, ids));
    expect(err).toBeInstanceOf(LiSchemaError);
    const leitura = classificarSetPrecoLi(ids.map(String), corpo(precoSetExemplo.objects));
    expect(leitura.semProduto.map((s) => s.campos)).toEqual([
      ['produto'],
      ['produto'],
      ['produto'],
    ]);
  });

  it('the single-resource example parses as a row, matched by its produto, never by its own id', () => {
    const r = liPrecoProdutoLinhaSchema.parse(precoRecursoExemplo);
    expect(r).toEqual(precoRecursoExemplo);
    expect(produtoIdDoPrecoLi(r.produto)).toBe(2301);
    expect(produtoIdDoPrecoLi(r.produto)).not.toBe(precoRecursoExemplo.id);
  });
});

/* -------------------------------------------------------------------------- */

describe('produtoIdDoPrecoLi — the produto a price row names', () => {
  it.each([
    '/api/v1/produto/1001',
    '/api/v1/produto/1001/',
    '/v1/produto/1001',
    '/v1/produto/1001/',
  ])('EQUAL: %j ⇒ 1001', (uri) => {
    expect(produtoIdDoPrecoLi(uri)).toBe(1001);
  });

  it.each<unknown>([
    '/api/v1/produto/1001?id_externo=1',
    '/api/v1/produto_preco/1001',
    '/v1/produto_preco/1001',
    '/api/v1/produto/01001',
    '/api/v1/produto/1001//',
    '/api/v1/produto/10/01',
    '/api/v1/produtos/1001',
    '',
    '1001',
    1001,
    null,
    undefined,
  ])('NEAR-MISS: %j ⇒ null', (uri) => {
    expect(produtoIdDoPrecoLi(uri)).toBeNull();
  });

  it('keeps no rule of its own: it answers exactly what the shared reader answers for `produto`', () => {
    for (const uri of ['/api/v1/produto/987654321', '/v1/produto/42/', '/api/v1/produto/07', 7]) {
      expect(produtoIdDoPrecoLi(uri)).toBe(idDoRecursoLi(uri, RECURSO_URI_LI.produto));
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('classificarSetPrecoLi — every asked id gets exactly one result', () => {
  it('a complete answer: every id `linha`, the row as it read', () => {
    const l = classificarSetPrecoLi(['1001', '1002'], corpo([linha(1001), linha(1002)]));
    expect(l.resultados).toEqual([
      { id: '1001', resultado: { tipo: 'linha', linha: linha(1001) } },
      { id: '1002', resultado: { tipo: 'linha', linha: linha(1002) } },
    ]);
    expect(l).toMatchObject({
      contabilizados: 2,
      naoPedidos: [],
      semProduto: [],
      naoEncontradosIlegiveis: [],
    });
  });

  it('the same rows REORDERED give the same result: matched by produto, never by place', () => {
    const pedidos = ['1003', '1001', '1002'];
    const emOrdem = classificarSetPrecoLi(pedidos, corpo([linha(1003), linha(1001), linha(1002)]));
    const fora = classificarSetPrecoLi(pedidos, corpo([linha(1002), linha(1003), linha(1001)]));
    expect(fora).toEqual(emOrdem);
    // Every asked id once, in the order ASKED.
    expect(fora.resultados.map((r) => r.id)).toEqual(pedidos);
    expect(de(fora, '1001')).toMatchObject({ linha: { produto: '/api/v1/produto/1001' } });
  });

  it('a row whose OWN id is another asked id is still matched by the produto it names', () => {
    const l = classificarSetPrecoLi(
      ['1001', '7001'],
      corpo([linha(1001, { id: 7001 }), linha(7001, { id: 1001, cheio: '9.0000' })]),
    );
    expect(de(l, '1001')).toMatchObject({
      tipo: 'linha',
      linha: { produto: '/api/v1/produto/1001', cheio: '160.0000' },
    });
    expect(de(l, '7001')).toMatchObject({
      tipo: 'linha',
      linha: { produto: '/api/v1/produto/7001', cheio: '9.0000' },
    });
  });

  it('the mixed set: five children, a parent and a trashed product as rows, two ids not found — no throw', () => {
    const pedidos = ['1001', '1002', '1003', '1004', '1005', '1000', '1006', '9001', '9002'];
    const pai = linha(1000, { cheio: null, custo: null });
    const lixeira = linha(1006, { cheio: '45.5000', promocional: '0.0000' });
    const l = classificarSetPrecoLi(
      pedidos,
      corpo(
        [linha(1001), linha(1002), linha(1003), linha(1004), linha(1005), pai, lixeira],
        ['9001', '9002'],
      ),
    );
    const tipos = l.resultados.map((r) => r.resultado.tipo);
    expect(tipos.filter((t) => t === 'linha')).toHaveLength(7);
    expect(de(l, '9001')).toEqual({ tipo: 'nao-encontrado' });
    expect(de(l, '9002')).toEqual({ tipo: 'nao-encontrado' });
    expect(l.contabilizados).toBe(9);
  });

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['null', null],
    ['the empty text', ''],
    ['an empty list', []],
  ])('`not_found` %s means none: the reader answers the same', async (_caso, nf) => {
    const { r } = await ler(resposta([linha(1001), linha(1002)], nf), [1001, 1002]);
    expect(r.dados.resultados.map((x) => x.resultado.tipo)).toEqual(['linha', 'linha']);
    expect(r.dados).toMatchObject({
      naoPedidos: [],
      naoEncontradosIlegiveis: [],
      contabilizados: 2,
    });
  });

  it('EQUAL: a `not_found` id as a number ≡ as its text', () => {
    const comoNumero = classificarSetPrecoLi(['1001', '9001'], corpo([linha(1001)], [9001]));
    const comoTexto = classificarSetPrecoLi(['1001', '9001'], corpo([linha(1001)], ['9001']));
    expect(comoNumero).toEqual(comoTexto);
    expect(de(comoNumero, '9001')).toEqual({ tipo: 'nao-encontrado' });
  });

  it.each<[string, unknown]>([
    ['a leading zero', '09001'],
    ['a leading space', ' 9001'],
    ['a fraction', 1.5],
    ['an object', {}],
    ['null', null],
    ['zero', 0],
  ])(
    'NEAR-MISS: a `not_found` element that is %s is no id: counted by position, and the asked id stays unanswered',
    (_caso, elemento) => {
      const l = classificarSetPrecoLi(['1001', '9001'], corpo([linha(1001)], [elemento]));
      expect(l.naoEncontradosIlegiveis).toEqual([0]);
      expect(de(l, '9001')).toEqual({ tipo: 'sem-resposta' });
      expect(l.contabilizados).toBe(1);
    },
  );

  it('`naoEncontradosIlegiveis` holds the POSITIONS in `not_found`, not a count', () => {
    const l = classificarSetPrecoLi(['1001', '9001'], corpo([linha(1001)], ['9001', {}, '01']));
    expect(l.naoEncontradosIlegiveis).toEqual([1, 2]);
    expect(de(l, '9001')).toEqual({ tipo: 'nao-encontrado' });
    expect(l.contabilizados).toBe(2);
  });

  it('a `not_found` that is one bare string is a malformed envelope: LiSchemaError', async () => {
    const err = await falha(ler(resposta([linha(1001)], '9001'), [1001, 9001]));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect(err).toMatchObject({ motivo: 'formato', campos: ['not_found'] });
  });

  it('an id NOT asked, in a row or in `not_found`, is counted apart and never matched', () => {
    const l = classificarSetPrecoLi(['1001'], corpo([linha(1001), linha(1009)], ['9009']));
    expect(de(l, '1001')).toMatchObject({ tipo: 'linha' });
    expect(l.naoPedidos).toEqual([
      { origem: 'linha', indice: 1, id: '1009' },
      { origem: 'nao-encontrado', indice: 0, id: '9009' },
    ]);
    expect(l.resultados).toHaveLength(1);
  });

  it('an asked id the answer neither returns nor lists is `sem-resposta`; the others are still classified', () => {
    const l = classificarSetPrecoLi(['1001', '1002', '1003'], corpo([linha(1001), linha(1003)]));
    expect(l.resultados.map((r) => [r.id, r.resultado.tipo])).toEqual([
      ['1001', 'linha'],
      ['1002', 'sem-resposta'],
      ['1003', 'linha'],
    ]);
    expect(l.contabilizados).toBe(2);
  });

  it.each<[string, readonly unknown[], readonly unknown[], number, number]>([
    ['two rows', [linha(1001), linha(1001, { cheio: '1.0000' })], [], 2, 0],
    ['a row and a `not_found` entry', [linha(1001)], ['1001'], 1, 1],
    ['two `not_found` entries', [], ['1001', 1001], 0, 2],
    ['a readable and an unreadable row', [linha(1001), linha(1001, { cheio: '1,50' })], [], 2, 0],
  ])(
    'an id answered twice — %s — is `repetido`, never the first answer',
    (_caso, objs, nf, linhas, naoEncontrado) => {
      const l = classificarSetPrecoLi(['1001', '1002'], corpo([...objs, linha(1002)], nf));
      expect(de(l, '1001')).toEqual({ tipo: 'repetido', linhas, naoEncontrado });
      expect(de(l, '1002')).toMatchObject({ tipo: 'linha' });
      expect(l.contabilizados).toBe(2);
    },
  );

  it.each<[string, Record<string, unknown>, readonly string[]]>([
    ['cheio with a comma', { cheio: '1,50' }, ['cheio']],
    ['a negative promotion', { promocional: '-1.00' }, ['promocional']],
    ['both amounts unreadable', { cheio: {}, promocional: true }, ['cheio', 'promocional']],
    ['no cheio at all', { cheio: undefined }, ['cheio']],
  ])(
    'an unreadable row naming an asked id — %s — is `ilegivel`, with its field paths',
    (_caso, extra, campos) => {
      const bruta = linha(1001, extra);
      const l = classificarSetPrecoLi(['1001'], corpo([JSON.parse(JSON.stringify(bruta))]));
      expect(de(l, '1001')).toEqual({ tipo: 'ilegivel', campos });
    },
  );

  it('an unreadable row reports field PATHS, never the values it carried', () => {
    const l = classificarSetPrecoLi(
      ['1001'],
      corpo([linha(1001, { cheio: 'VALOR-QUE-NAO-PODE-SAIR' })]),
    );
    expect(JSON.stringify(l)).not.toContain('VALOR-QUE-NAO-PODE-SAIR');
  });

  it.each<[string, unknown, readonly string[]]>([
    [
      'the row’s own price URI',
      linha(1001, { produto: '/api/v1/produto_preco/1001' }),
      ['produto'],
    ],
    [
      'an external-id URI',
      linha(1001, { produto: '/api/v1/produto/1001?id_externo=1' }),
      ['produto'],
    ],
    ['a leading zero', linha(1001, { produto: '/api/v1/produto/01001' }), ['produto']],
    ['a number', linha(1001, { produto: 1001 }), ['produto']],
    ['no produto', { ...linha(1001), produto: undefined }, ['produto']],
    [
      'another resource AND an unreadable amount',
      linha(1001, { produto: '/api/v1/marca/1001', cheio: '1,50' }),
      ['produto', 'cheio'],
    ],
    ['null', null, ['(raiz)']],
    ['a text', 'abc', ['(raiz)']],
    ['a list', [linha(1001)], ['(raiz)']],
  ])(
    'a row naming no produto — %s — is `semProduto`, by position, and the asked id stays unanswered',
    (_caso, bruta, campos) => {
      const l = classificarSetPrecoLi(['1001', '1002'], corpo([linha(1002), bruta]));
      expect(l.semProduto).toEqual([{ indice: 1, campos }]);
      expect(de(l, '1001')).toEqual({ tipo: 'sem-resposta' });
      expect(de(l, '1002')).toMatchObject({ tipo: 'linha' });
    },
  );

  it('a list of asked ids that is not distinct and canonical is a bug: RangeError', () => {
    expect(() => classificarSetPrecoLi(['1001', '1001'], corpo([]))).toThrow(RangeError);
    expect(() => classificarSetPrecoLi(['01001'], corpo([]))).toThrow(RangeError);
    expect(() => classificarSetPrecoLi(['1001', '1002'], corpo([]))).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */

describe('lerPrecosPorIdLi — one by-id read', () => {
  it('answers the classification with the request’s status, correlation id and credential ref', async () => {
    const { r } = await ler(resposta([linha(1002), linha(1001)], ['9001']), [1001, 1002, 9001]);
    expect(r).toMatchObject({ status: 200, correlationId: 'corr-1', refCredencial: 'ref-A' });
    expect(r.dados.resultados.map((x) => [x.id, x.resultado.tipo])).toEqual([
      ['1001', 'linha'],
      ['1002', 'linha'],
      ['9001', 'nao-encontrado'],
    ]);
  });

  it.each<[string, unknown]>([
    ['no row and no `not_found`', resposta([])],
    ['only rows naming ids not asked', resposta([linha(1009), linha(1008)])],
    [
      'only rows naming no produto',
      resposta([linha(1001, { produto: '/api/v1/produto_preco/1001' })]),
    ],
    ['only `not_found` ids not asked', resposta([], ['9009'])],
  ])(
    'an answer that accounts for NONE of the asked ids — %s — is LiSchemaError',
    async (_caso, c) => {
      const err = await falha(ler(c, [1001, 1002]));
      expect(err).toBeInstanceOf(LiSchemaError);
      expect(err).toMatchObject({
        motivo: 'formato',
        campos: ['objects', 'not_found'],
        status: 200,
        operacao: 'lerPrecosPorId',
        caminho: '/v1/produto_preco/set/1001;1002',
        correlationId: 'corr-1',
        refCredencial: 'ref-A',
      });
      expect((err as LiSchemaError).message).toContain('GET /v1/produto_preco/set/1001;1002');
    },
  );

  it('NEAR-MISS: every asked id in `not_found` and no row accounts for all of them — no throw', async () => {
    const { r } = await ler(resposta([], ['1001', '1002']), [1001, 1002]);
    expect(r.dados.contabilizados).toBe(2);
    expect(r.dados.resultados.map((x) => x.resultado.tipo)).toEqual([
      'nao-encontrado',
      'nao-encontrado',
    ]);
  });

  it('NEAR-MISS: one of three answered is a partial answer — no throw, the two others unanswered', async () => {
    const { r } = await ler(resposta([linha(1002)]), [1001, 1002, 1003]);
    expect(r.dados.contabilizados).toBe(1);
    expect(r.dados.resultados.map((x) => x.resultado.tipo)).toEqual([
      'sem-resposta',
      'linha',
      'sem-resposta',
    ]);
  });

  it('NEAR-MISS: one id answered twice is accounted for — no throw', async () => {
    const { r } = await ler(resposta([linha(1001), linha(1001)]), [1001]);
    expect(de(r.dados, '1001')).toEqual({ tipo: 'repetido', linhas: 2, naoEncontrado: 0 });
  });

  it('NEAR-MISS: an answer whose only row is UNREADABLE accounts for its id — no throw, `ilegivel`', async () => {
    const { r } = await ler(resposta([linha(1001, { cheio: '1,50' })]), [1001]);
    expect(r.dados.contabilizados).toBe(1);
    expect(de(r.dados, '1001')).toEqual({ tipo: 'ilegivel', campos: ['cheio'] });
  });

  it('one odd row costs only itself at the READER: an unreadable row beside a readable one', async () => {
    const { r } = await ler(resposta([linha(1001), linha(1002, { cheio: '1,50' })]), [1001, 1002]);
    expect(de(r.dados, '1001')).toMatchObject({ tipo: 'linha' });
    expect(de(r.dados, '1002')).toEqual({ tipo: 'ilegivel', campos: ['cheio'] });
    expect(r.dados.contabilizados).toBe(2);
  });

  it('…rows that are no object at all, beside a readable one, are `semProduto` — the answer still reads', async () => {
    const { r } = await ler(resposta([linha(1001), null, 'abc']), [1001]);
    expect(de(r.dados, '1001')).toMatchObject({ tipo: 'linha' });
    expect(r.dados.semProduto).toEqual([
      { indice: 1, campos: ['(raiz)'] },
      { indice: 2, campos: ['(raiz)'] },
    ]);
  });

  it('…and a `not_found` holding a number and an object: the number is an id, the object costs only itself', async () => {
    const { r } = await ler(resposta([linha(1001)], [9001, {}]), [1001, 9001]);
    expect(de(r.dados, '9001')).toEqual({ tipo: 'nao-encontrado' });
    expect(r.dados.naoEncontradosIlegiveis).toEqual([1]);
    expect(r.dados.contabilizados).toBe(2);
  });

  it.each<[string, unknown]>([
    ['`objects` absent', {}],
    ['`objects` null', { objects: null }],
    ['`objects` an object', { objects: { 0: linha(1001) } }],
    ['`not_found` an object', { objects: [linha(1001)], not_found: { 0: '9001' } }],
    ['`not_found` a number', { objects: [linha(1001)], not_found: 9001 }],
    ['the body a list', [linha(1001)]],
  ])('NEAR-MISS: a malformed envelope — %s — is LiSchemaError', async (_caso, c) => {
    const err = await falha(ler(c, [1001]));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect(err).toMatchObject({ motivo: 'formato', operacao: 'lerPrecosPorId' });
  });

  it('a `meta` the store might add is kept by the envelope and changes nothing', async () => {
    const { r } = await ler({ ...resposta([linha(1001)]), meta: { total_count: 1 } }, [1001]);
    expect(de(r.dados, '1001')).toMatchObject({ tipo: 'linha' });
  });

  it('a 404 with an empty body is the client’s LiNotFoundError, rethrown as-is', async () => {
    const err = await falha(lerPrecosPorIdLi(cliente(mockFetch(() => texto('', 404))).c, [1001]));
    expect(err).toBeInstanceOf(LiNotFoundError);
  });

  it('a 400 in the gateway’s JSON shape is a non-transient LiHttpError, never a 404', async () => {
    const err = await falha(
      lerPrecosPorIdLi(cliente(mockFetch(() => texto(corpo400Gateway, 400))).c, [1001]),
    );
    expect(err).toBeInstanceOf(LiHttpError);
    expect(err).not.toBeInstanceOf(LiNotFoundError);
    expect(err).toMatchObject({ status: 400, transitorio: false });
  });

  it('a 3xx is a LiHttpError, never followed', async () => {
    const f = mockFetch(() => texto('', 301, { location: '/v1/produto_preco/set/1001/' }));
    const err = await falha(lerPrecosPorIdLi(cliente(f).c, [1001]));
    expect(err).toBeInstanceOf(LiHttpError);
    expect(err).toMatchObject({ status: 301, transitorio: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a 429 is LiThrottleError, a 500 a transient LiHttpError, a 401 LiAuthError', async () => {
    const throttle = await falha(
      lerPrecosPorIdLi(cliente(mockFetch(() => texto('', 429))).c, [1001]),
    );
    expect(throttle).toBeInstanceOf(LiThrottleError);
    const erro5xx = await falha(
      lerPrecosPorIdLi(cliente(mockFetch(() => texto('', 500))).c, [1001]),
    );
    expect(erro5xx).toBeInstanceOf(LiHttpError);
    expect(erro5xx).toMatchObject({ status: 500, transitorio: true });
    const auth = await falha(lerPrecosPorIdLi(cliente(mockFetch(() => texto('', 401))).c, [1001]));
    expect(auth).toBeInstanceOf(LiAuthError);
  });

  it('an already-aborted signal: its reason comes back, nothing sent, no credential read', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = ok(resposta([linha(1001)]));
    const { c, credenciais } = cliente(f);
    await expect(lerPrecosPorIdLi(c, [1001], { sinal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
  });

  it('the observer sees the call as `lerPrecosPorId`, a GET on the set path', async () => {
    const eventos: ChamadaLi[] = [];
    const f = ok(resposta([linha(1001)]));
    await lerPrecosPorIdLi(cliente(f, (e) => eventos.push(e)).c, [1001]);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      operacao: 'lerPrecosPorId',
      metodo: 'GET',
      caminho: '/v1/produto_preco/set/1001',
      query: [],
      resultado: 'ok',
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('liProdutoComPrecoDetalheSchema — the detail a price write decides on', () => {
  /** A variation's detail as the owner's capture shows it: the prices as JSON numbers. */
  const variacao = {
    id: 1001,
    tipo: 'atributo_opcao',
    ativo: true,
    bloqueado: false,
    removido: false,
    preco_cheio: 274.42,
    preco_promocional: null,
    preco_custo: null,
    preco_sob_consulta: false,
    pai: '/api/v1/produto/1000',
    sku: 'SKU-SINTETICO-1',
    peso: '0.450',
  };

  const FOLHAS = [
    'id',
    'tipo',
    'ativo',
    'bloqueado',
    'removido',
    'preco_cheio',
    'preco_promocional',
    'preco_custo',
    'preco_sob_consulta',
  ] as const;

  it('the document’s produto detail parses, its four price leaves as they came', () => {
    const r = liProdutoComPrecoDetalheSchema.parse(produtoDetalheExemplo);
    expect(r).toMatchObject({
      preco_cheio: 100,
      preco_custo: null,
      preco_promocional: null,
      preco_sob_consulta: false,
    });
    expect(r).toEqual(produtoDetalheExemplo);
  });

  it('a variation’s detail parses VERBATIM, every other leaf kept', () => {
    expect(liProdutoComPrecoDetalheSchema.parse(variacao)).toEqual(variacao);
  });

  it.each(FOLHAS)('NEAR-MISS: a detail without %s is refused — it cannot be restored', (folha) => {
    const sem = Object.fromEntries(Object.entries(variacao).filter(([k]) => k !== folha));
    expect(Object.keys(sem)).not.toContain(folha);
    const lida = liProdutoComPrecoDetalheSchema.safeParse(sem);
    expect(lida.success).toBe(false);
    expect(lida.error?.issues.map((i) => i.path)).toEqual([[folha]]);
  });

  it.each<[string, unknown]>([
    ['a text the fold cannot read', 'abc'],
    ['a negative', -1],
    ['the store’s zero text', '0.0000'],
    ['an object', {}],
    ['an empty text', ''],
  ])('an odd price leaf (%s) parses RAW: the detail never judges it', (_caso, valor) => {
    for (const folha of ['preco_cheio', 'preco_promocional', 'preco_custo', 'preco_sob_consulta']) {
      const r = liProdutoComPrecoDetalheSchema.parse({ ...variacao, [folha]: valor });
      expect(r[folha as keyof typeof r], folha).toBe(valor);
    }
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a text', 'x'],
    ['zero', 0],
  ])(
    'an odd guard leaf (%s) parses RAW too: `ativo`, `bloqueado`, `removido` are the send’s to judge',
    (_caso, valor) => {
      for (const folha of ['ativo', 'bloqueado', 'removido']) {
        const r = liProdutoComPrecoDetalheSchema.parse({ ...variacao, [folha]: valor });
        expect(r[folha as keyof typeof r], folha).toBe(valor);
      }
    },
  );

  it('`tipo` is a plain text, never an enum: a tipo no one knows yet still reads', () => {
    expect(liProdutoComPrecoDetalheSchema.parse({ ...variacao, tipo: 'kit' }).tipo).toBe('kit');
    expect(liProdutoComPrecoDetalheSchema.parse({ ...variacao, tipo: '' }).tipo).toBe('');
  });

  it('`tipo` must be text; a quoted `id` reads as the number', () => {
    expect(liProdutoComPrecoDetalheSchema.safeParse({ ...variacao, tipo: 3 }).success).toBe(false);
    expect(liProdutoComPrecoDetalheSchema.parse({ ...variacao, id: '1001' }).id).toBe(1001);
    expect(liProdutoComPrecoDetalheSchema.safeParse({ ...variacao, id: '01001x' }).success).toBe(
      false,
    );
  });

  it('read through the WRITE client’s deciding read: the parsed detail and its scrubbed text', async () => {
    const f = mockFetch(() => json(variacao));
    const escrita = criarClienteEscritaLi({
      obterCredencial: () => ({ token: TOKEN, ref: 'ref-A' }),
      fetch: f,
      gerarCorrelationId: () => 'corr-1',
      agora: () => 0,
    });
    const r = await escrita.lerAntesDeEscreverLi({
      operacao: 'lerDetalheDoPreco',
      caminho: '/v1/produto/1001/',
      schema: liProdutoComPrecoDetalheSchema,
    });
    expect(r.dados).toEqual(variacao);
    expect(JSON.parse(r.texto)).toEqual(variacao);
    expect(requisicao(f).url.pathname).toBe('/v1/produto/1001/');
  });
});

/* -------------------------------------------------------------------------- */

describe('the price list is never read', () => {
  const SRC = new URL('../src/', import.meta.url);

  it('the barrel exports no list reader, no single-resource reader and no list page bound', () => {
    const nomes = Object.keys(barril);
    for (const nome of ['lerPaginaPrecoLi', 'buscarPrecoProdutoLi', 'MAX_LIMITE_PAGINA_PRECO_LI']) {
      expect(nomes, nome).not.toContain(nome);
    }
    // Anti-vacuity: the barrel does export the by-id read.
    expect(barril.lerPrecosPorIdLi).toBe(lerPrecosPorIdLi);
  });

  it('`preco.ts` reaches neither pager', () => {
    const fonte = readFileSync(new URL('preco.ts', SRC), 'utf8');
    for (const proibido of [
      'lerPaginaLi',
      'paginarLi',
      "from './paginacao'",
      "from './produtos'",
    ]) {
      expect(fonte, proibido).not.toContain(proibido);
    }
  });

  it('outside comments, only `preco.ts` and `rotasEscrita.ts` spell the price resource under src/', () => {
    const comentario = /^\s*(?:\/\/|\/\*|\*)/;
    const quem = readdirSync(SRC)
      .filter((nome) => nome.endsWith('.ts'))
      .filter((nome) =>
        readFileSync(new URL(nome, SRC), 'utf8')
          .split('\n')
          .some((l) => !comentario.test(l) && l.includes('produto_preco')),
      )
      .sort();
    expect(quem).toEqual(['preco.ts', 'rotasEscrita.ts']);
  });
});

describe('the barrel', () => {
  it('exports the by-id read, its helpers and the price schemas', () => {
    expect(barril.classificarSetPrecoLi).toBe(classificarSetPrecoLi);
    expect(barril.idsSetPrecoLi).toBe(idsSetPrecoLi);
    expect(barril.caminhoSetPrecoLi).toBe(caminhoSetPrecoLi);
    expect(barril.produtoIdDoPrecoLi).toBe(produtoIdDoPrecoLi);
    expect(barril.CAMINHO_PRECO_LI).toBe(CAMINHO_PRECO_LI);
    expect(barril.MAX_IDS_SET_PRECO_LI).toBe(MAX_IDS_SET_PRECO_LI);
    expect(barril.liPrecoProdutoLinhaSchema).toBe(liPrecoProdutoLinhaSchema);
    expect(barril.liSetPrecoSchema).toBe(liSetPrecoSchema);
    expect(barril.liProdutoComPrecoDetalheSchema).toBe(liProdutoComPrecoDetalheSchema);
    expect(barril.liEcoPrecoProdutoSchema).toBe(liEcoPrecoProdutoSchema);
  });
});
