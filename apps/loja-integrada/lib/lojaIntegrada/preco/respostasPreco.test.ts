/**
 * Invented price answers (`testing/precoLi.ts`), in the shape the owner's read-only price captures
 * showed, replayed end to end through the package's REAL by-id read (`lerPrecosPorIdLi` over
 * `criarClienteLeituraLi`), the WRITE client's deciding read of the produto detail
 * (`liProdutoComPrecoDetalheSchema`), and the shared price fold. The captures are not committed,
 * by the owner's decision; every id, price and count here is invented.
 *
 * It does not repeat the package's unit tests one for one: the point is the whole path through
 * the client on capture-shaped answers — the request the package builds against a store that
 * answers only the exact request, the classification of complete, mixed and edited answers, the
 * two ways an all-unknown set may come back, and the detail and the price row of one produto
 * agreeing through the fold in both spellings.
 *
 * Nothing reaches Loja Integrada: every client gets the scripted store, the global `fetch` throws
 * for the whole file, and every case asserts it was never called.
 */
import { roundReais } from '@delfrance/core/money';
import {
  criarClienteEscritaLi,
  criarClienteLeituraLi,
  type LeituraSetPrecoLi,
  lerPrecosPorIdLi,
  LiHttpError,
  liProdutoComPrecoDetalheSchema,
  LiNotFoundError,
  type PrecoProdutoLinhaLi,
  produtoIdDoPrecoLi,
  type ResultadoIdPrecoLi,
  URL_BASE_LI,
} from '@delfrance/integrations-loja-integrada';
import {
  efetivoPrecoLi,
  FORMA_PROMO_LIMPA_LI,
  FORMA_PROMO_LIMPA_PADRAO_LI,
  mesmoPrecoLi,
  promocionalLimpoLi,
  promocionalLimpoNaFormaLi,
  TIPO_PRODUTO_LI,
  valorPrecoLi,
} from '@delfrance/schemas';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ID_PAI_PRECO_LI,
  ID_SEM_PRODUTO_PRECO_LI,
  IDS_SET_COMPLETO_PRECO_LI,
  IDS_SET_MISTO_PRECO_LI,
  idDaLinhaDePrecoLi,
  LINHAS_LIMPEZA_PRECO_LI,
  linhaPrecoLi,
  PARES_DETALHE_PRECO_LI,
  type PlataformaPrecoLi,
  plataformaPrecoLi,
  type RespostaPrecoLi,
  type RespostaSetPrecoInventadaLi,
  respostaSetCompletaPrecoLi,
  respostaSetMistaPrecoLi,
  respostaSetPrecoLi,
  uriProdutoPrecoLi,
} from '../testing/precoLi';

/* -------------------------------------------------------------------------- */
/*                                  Harness                                    */
/* -------------------------------------------------------------------------- */

const CREDENCIAL_DE_TESTE = { token: 'token-de-teste-preco', ref: 'conta-de-teste' } as const;

/** The by-id request path the store is scripted with: the ids `;`-joined, no slash, no query. */
const caminhoSet = (ids: readonly number[]) => `/v1/produto_preco/set/${ids.join(';')}`;

/** A produto detail's path, as a price write's deciding read asks it. */
const caminhoDetalhe = (id: number) => `/v1/produto/${String(id)}/`;

const ok = (corpo: unknown): RespostaPrecoLi => ({ status: 200, corpo });

const leitor = (plataforma: PlataformaPrecoLi) =>
  criarClienteLeituraLi({ obterCredencial: () => CREDENCIAL_DE_TESTE, fetch: plataforma.fetch });

const escritor = (plataforma: PlataformaPrecoLi) =>
  criarClienteEscritaLi({ obterCredencial: () => CREDENCIAL_DE_TESTE, fetch: plataforma.fetch });

/** A promise's rejection, or `null` when it resolved — never a catch clause. */
function rejeicaoDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (err: unknown) => err,
  );
}

/** Each asked id with its result's kind, in the order asked. */
const tipos = (l: LeituraSetPrecoLi) => l.resultados.map((r) => [r.id, r.resultado.tipo]);

/** The row an id's result carries; fails the test when the result is not a row. */
function linhaDe(l: LeituraSetPrecoLi, id: number): PrecoProdutoLinhaLi {
  const resultado = l.resultados.find((r) => r.id === String(id))?.resultado;
  expect(resultado?.tipo, `produto ${String(id)}`).toBe('linha');
  if (resultado?.tipo !== 'linha') throw new TypeError(`produto ${String(id)}: no row`);
  return resultado.linha;
}

/** A value's centavos through the shared fold; `NaN` when it reads as none or as unreadable. */
function centavosDe(v: unknown): number {
  const lido = valorPrecoLi(v);
  return typeof lido === 'string' ? Number.NaN : lido.centavos;
}

let fetchGlobal: Mock<typeof globalThis.fetch>;

beforeEach(() => {
  fetchGlobal = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('the price replay never calls the global fetch');
  });
  vi.stubGlobal('fetch', fetchGlobal);
});

afterEach(() => {
  expect(fetchGlobal).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                 S0 — the invented answers keep the measured shape           */
/* -------------------------------------------------------------------------- */

describe('the invented answers keep the measured shape (the mock’s contract)', () => {
  const CHAVES_DA_LINHA = [
    'cheio',
    'custo',
    'id',
    'produto',
    'promocional',
    'resource_uri',
    'sob_consulta',
  ];
  const QUATRO_DECIMAIS = /^\d+\.\d{4}$/;
  const textoOuNulo = (v: unknown) =>
    v === null || (typeof v === 'string' && QUATRO_DECIMAIS.test(v));
  /** A row's leaves by key (none for a value that is no object). */
  const folhas = (v: unknown): ReadonlyMap<string, unknown> =>
    new Map<string, unknown>(typeof v === 'object' && v !== null ? Object.entries(v) : []);

  const completa = respostaSetCompletaPrecoLi();
  const mista = respostaSetMistaPrecoLi();
  /** Every invented row, with the produto id it was built for (never read from the row). */
  const linhas: readonly { readonly produtoId: number; readonly linha: unknown }[] = [
    ...IDS_SET_COMPLETO_PRECO_LI.map((produtoId, i) => ({
      produtoId,
      linha: completa.objects[i],
    })),
    ...[1001, ID_PAI_PRECO_LI, 1002, 1050].map((produtoId, i) => ({
      produtoId,
      linha: mista.objects[i],
    })),
    ...PARES_DETALHE_PRECO_LI.map(({ produtoId, linha }) => ({ produtoId, linha })),
    ...[1201, 1202, 1203].map((produtoId, i) => ({
      produtoId,
      linha: LINHAS_LIMPEZA_PRECO_LI[i],
    })),
  ];

  it('the four-decimal check refuses a two-decimal text and a JSON number (non-vacuous)', () => {
    expect(textoOuNulo('11.1100')).toBe(true);
    expect(textoOuNulo(null)).toBe(true);
    expect(textoOuNulo('11.11')).toBe(false);
    expect(textoOuNulo(11.11)).toBe(false);
    expect(linhas).toHaveLength(100 + 4 + PARES_DETALHE_PRECO_LI.length + 3);
  });

  it('every price row: exactly seven keys, four-decimal text or null, its own id not the produto’s', () => {
    for (const { produtoId, linha } of linhas) {
      const rotulo = `produto ${String(produtoId)}`;
      expect(typeof linha === 'object' && linha !== null, rotulo).toBe(true);
      const l = folhas(linha);
      expect([...l.keys()].sort(), rotulo).toEqual(CHAVES_DA_LINHA);
      expect(textoOuNulo(l.get('cheio')), rotulo).toBe(true);
      expect(textoOuNulo(l.get('promocional')), rotulo).toBe(true);
      expect(textoOuNulo(l.get('custo')), rotulo).toBe(true);
      expect(l.get('sob_consulta'), rotulo).toBe(false);
      const id = l.get('id');
      expect(Number.isSafeInteger(id) && id !== produtoId, rotulo).toBe(true);
      expect(l.get('produto'), rotulo).toBe(`/api/v1/produto/${String(produtoId)}`);
      expect(l.get('resource_uri'), rotulo).toBe(`/api/v1/produto_preco/${String(produtoId)}`);
    }
  });

  it('every set/ answer: objects, no meta, and a not_found only as a list of id strings', () => {
    const respostas: readonly RespostaSetPrecoInventadaLi[] = [
      completa,
      mista,
      respostaSetPrecoLi(PARES_DETALHE_PRECO_LI.map((p) => p.linha)),
      respostaSetPrecoLi(LINHAS_LIMPEZA_PRECO_LI),
    ];
    for (const r of respostas) {
      expect(Object.keys(r).every((k) => k === 'objects' || k === 'not_found')).toBe(true);
      if (!('not_found' in r)) continue;
      const lista: unknown = r.not_found;
      expect(Array.isArray(lista) && lista.length > 0).toBe(true);
      const elementos: readonly unknown[] = Array.isArray(lista) ? lista : [];
      expect(elementos.every((v) => typeof v === 'string' && /^\d+$/.test(v))).toBe(true);
    }
    expect('not_found' in completa).toBe(false);
    expect('not_found' in mista).toBe(true);
  });

  it('every detail: its price leaves are JSON numbers of whole centavos, or null', () => {
    for (const { produtoId, detalhe } of PARES_DETALHE_PRECO_LI) {
      const rotulo = `produto ${String(produtoId)}`;
      for (const v of [detalhe.preco_cheio, detalhe.preco_promocional, detalhe.preco_custo]) {
        expect(v === null || (typeof v === 'number' && roundReais(v) === v), rotulo).toBe(true);
      }
      expect(detalhe.preco_sob_consulta, rotulo).toBe(false);
    }
  });

  it('every id anywhere is below 10 000: no pasted pseudonym, no real product id', () => {
    const ids: unknown[] = [
      ...IDS_SET_COMPLETO_PRECO_LI,
      ...IDS_SET_MISTO_PRECO_LI,
      ID_PAI_PRECO_LI,
      ID_SEM_PRODUTO_PRECO_LI,
      ...linhas.flatMap(({ produtoId, linha }) => [
        produtoId,
        typeof linha === 'object' && linha !== null && 'id' in linha ? linha.id : null,
      ]),
      ...(mista.not_found ?? []).map(Number),
      ...PARES_DETALHE_PRECO_LI.flatMap(({ produtoId, detalhe }) => [
        produtoId,
        detalhe.id,
        produtoIdDoPrecoLi(detalhe.pai),
      ]),
    ];
    expect(ids.length).toBeGreaterThan(200);
    expect(
      ids.filter((n) => !(typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n < 10_000)),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                  S1 — a complete 100-id answer, end to end                  */
/* -------------------------------------------------------------------------- */

describe('a complete 100-id answer, through the real client', () => {
  it('one GET of the exact path; every id a row matched by the produto it names, leaf for leaf', async () => {
    const caminho = caminhoSet(IDS_SET_COMPLETO_PRECO_LI);
    const resposta = respostaSetCompletaPrecoLi();
    const plataforma = plataformaPrecoLi({ [caminho]: ok(resposta) });

    const { dados } = await lerPrecosPorIdLi(leitor(plataforma), IDS_SET_COMPLETO_PRECO_LI);

    expect(plataforma.semResposta()).toBe(0);
    expect([...plataforma.consumidas]).toEqual([[caminho, 1]]);
    expect(plataforma.chamadas).toEqual([
      { metodo: 'GET', caminho, consulta: '', comCorpo: false },
    ]);
    const [enviada] = plataforma.chamadas;
    expect(enviada?.caminho.endsWith('/')).toBe(false);
    expect(enviada?.caminho.split(';')).toHaveLength(100);
    expect(enviada?.caminho).not.toContain('%3B');

    expect(dados.resultados.map((r) => r.id)).toEqual(IDS_SET_COMPLETO_PRECO_LI.map(String));
    for (const [i, produtoId] of IDS_SET_COMPLETO_PRECO_LI.entries()) {
      const rotulo = `produto ${String(produtoId)}`;
      const linha = linhaDe(dados, produtoId);
      expect(linha, rotulo).toEqual(resposta.objects[i]);
      expect(produtoIdDoPrecoLi(linha.produto), rotulo).toBe(produtoId);
      expect(linha.id, rotulo).not.toBe(produtoId);
    }
    expect(dados.contabilizados).toBe(100);
    expect(dados.naoPedidos).toEqual([]);
    expect(dados.semProduto).toEqual([]);
    expect(dados.naoEncontradosIlegiveis).toEqual([]);
  });

  it('NEAR-MISS: the same rows reversed read identically (matched by produto, never by place)', async () => {
    const caminho = caminhoSet(IDS_SET_COMPLETO_PRECO_LI);
    const resposta = respostaSetCompletaPrecoLi();
    const emOrdem = await lerPrecosPorIdLi(
      leitor(plataformaPrecoLi({ [caminho]: ok(resposta) })),
      IDS_SET_COMPLETO_PRECO_LI,
    );
    const invertida = await lerPrecosPorIdLi(
      leitor(plataformaPrecoLi({ [caminho]: ok({ objects: [...resposta.objects].reverse() }) })),
      IDS_SET_COMPLETO_PRECO_LI,
    );
    expect(invertida.dados).toEqual(emOrdem.dados);
  });
});

/* -------------------------------------------------------------------------- */
/*                 S2 — a trailing-slash request is never sent                 */
/* -------------------------------------------------------------------------- */

describe('the path form: the no-slash request only', () => {
  const IDS = [1001, 1002, 1003];
  const semBarra = caminhoSet(IDS);
  const comBarra = `${semBarra}/`;
  const corpo = respostaSetPrecoLi(IDS.map((id) => linhaPrecoLi(id)));

  it('offered both forms with the same body, the read consumes only the no-slash one, once', async () => {
    const plataforma = plataformaPrecoLi({ [semBarra]: ok(corpo), [comBarra]: ok(corpo) });
    const { dados } = await lerPrecosPorIdLi(leitor(plataforma), IDS);
    expect([...plataforma.consumidas]).toEqual([[semBarra, 1]]);
    expect(plataforma.consumidas.has(comBarra)).toBe(false);
    expect(tipos(dados)).toEqual(IDS.map((id) => [String(id), 'linha']));
  });

  it('NEAR-MISS: offered only the slash form, the read fails visibly (500), with no result', async () => {
    const plataforma = plataformaPrecoLi({ [comBarra]: ok(corpo) });
    const erro = await rejeicaoDe(lerPrecosPorIdLi(leitor(plataforma), IDS));
    expect(erro).toBeInstanceOf(LiHttpError);
    expect(erro).toMatchObject({ status: 500 });
    expect(plataforma.semResposta()).toBe(1);
    expect(plataforma.consumidas.size).toBe(0);
  });

  it('NEAR-MISS: the same ids reversed are another request', async () => {
    const plataforma = plataformaPrecoLi({ [semBarra]: ok(corpo) });
    const invertidos = [...IDS].reverse();
    const erro = await rejeicaoDe(lerPrecosPorIdLi(leitor(plataforma), invertidos));
    expect(erro).toBeInstanceOf(LiHttpError);
    expect(plataforma.semResposta()).toBe(1);
    expect(plataforma.chamadas.map((c) => c.caminho)).toEqual([caminhoSet(invertidos)]);
  });

  it('the scripted store answers only the exact GET (the harness itself)', async () => {
    const plataforma = plataformaPrecoLi({ [semBarra]: ok(corpo) });
    const url = `${URL_BASE_LI}${semBarra}`;
    const status = async (entrada: string, init: RequestInit) =>
      (await plataforma.fetch(entrada, init)).status;
    expect(await status(url, { method: 'GET' })).toBe(200);
    expect(await status(`${url}/`, { method: 'GET' })).toBe(500);
    expect(await status(`https://loja.invalid${semBarra}`, { method: 'GET' })).toBe(500);
    expect(await status(url, { method: 'PUT' })).toBe(500);
    expect(await status(url, { method: 'GET', body: '{}' })).toBe(500);
    expect(await status(`${url}?limit=10`, { method: 'GET' })).toBe(500);
    expect(plataforma.semResposta()).toBe(5);
    expect([...plataforma.consumidas]).toEqual([[semBarra, 1]]);
  });

  it('the scripted store: a semCorpo answer has no body and no content type (the 404 shape)', async () => {
    const plataforma = plataformaPrecoLi({ [semBarra]: { status: 404, semCorpo: true } });
    const res = await plataforma.fetch(`${URL_BASE_LI}${semBarra}`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-type')).toBeNull();
    expect(await res.text()).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/*                           S3 — the mixed answer                             */
/* -------------------------------------------------------------------------- */

/** The mixed set read through the client, against `resposta` (default: the invented mixed answer). */
async function lerMisto(resposta: unknown = respostaSetMistaPrecoLi()) {
  const plataforma = plataformaPrecoLi({ [caminhoSet(IDS_SET_MISTO_PRECO_LI)]: ok(resposta) });
  const { dados } = await lerPrecosPorIdLi(leitor(plataforma), IDS_SET_MISTO_PRECO_LI);
  expect(plataforma.semResposta()).toBe(0);
  return dados;
}

describe('the mixed answer: found, parent, trashed, a row’s own id and no product', () => {
  it('every asked id settled once, in request order; only the listed ids are not found', async () => {
    const dados = await lerMisto();
    const idDaLinha1001 = idDaLinhaDePrecoLi(1001);
    expect(tipos(dados)).toEqual([
      ['1001', 'linha'],
      [String(ID_PAI_PRECO_LI), 'linha'],
      [String(idDaLinha1001), 'nao-encontrado'],
      ['1002', 'linha'],
      ['1050', 'linha'],
      [String(ID_SEM_PRODUTO_PRECO_LI), 'nao-encontrado'],
    ]);
    expect(dados.contabilizados).toBe(6);
    // Keyed by the produto, never by the row's own id: 1001's row carries 9001, yet 9001 is
    // not found.
    expect(linhaDe(dados, 1001).id, 'produto 1001').toBe(idDaLinha1001);
    expect(linhaDe(dados, 1050).promocional, 'produto 1050').toBe('0.0000');
    expect(dados.naoPedidos).toEqual([]);
    expect(dados.semProduto).toEqual([]);
    expect(dados.naoEncontradosIlegiveis).toEqual([]);
  });

  it('the raw not_found is the two ids with no row, as STRINGS, in request order', () => {
    const { not_found: naoEncontrados } = respostaSetMistaPrecoLi();
    expect(naoEncontrados).toEqual([
      String(idDaLinhaDePrecoLi(1001)),
      String(ID_SEM_PRODUTO_PRECO_LI),
    ]);
    expect(naoEncontrados?.every((v) => typeof v === 'string')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*            S4 — edited mixed answers are never read as "no row"             */
/* -------------------------------------------------------------------------- */

interface CasoEditadoLi {
  readonly nome: string;
  readonly editar: (r: RespostaSetPrecoInventadaLi) => RespostaSetPrecoInventadaLi;
  /** The results that change against the unedited answer's, by id. */
  readonly trocas: Readonly<Record<string, ResultadoIdPrecoLi>>;
  readonly contabilizados: number;
  readonly naoPedidos: LeituraSetPrecoLi['naoPedidos'];
}

/** The mixed answer's rows with the row of `produtoId` replaced by `troca(row)`. */
const trocarLinha =
  (produtoId: number, troca: (l: object) => unknown) =>
  (r: RespostaSetPrecoInventadaLi): RespostaSetPrecoInventadaLi => ({
    ...r,
    objects: r.objects.map((l) =>
      typeof l === 'object' &&
      l !== null &&
      'produto' in l &&
      l.produto === uriProdutoPrecoLi(produtoId)
        ? troca(l)
        : l,
    ),
  });

const CASOS_EDITADOS: readonly CasoEditadoLi[] = [
  {
    nome: 'rows reversed: the same results',
    editar: (r) => ({ ...r, objects: [...r.objects].reverse() }),
    trocas: {},
    contabilizados: 6,
    naoPedidos: [],
  },
  {
    nome: 'not_found removed: the two ids have NO answer, never "not found"',
    editar: (r) => respostaSetPrecoLi(r.objects),
    trocas: {
      [String(idDaLinhaDePrecoLi(1001))]: { tipo: 'sem-resposta' },
      [String(ID_SEM_PRODUTO_PRECO_LI)]: { tipo: 'sem-resposta' },
    },
    contabilizados: 4,
    naoPedidos: [],
  },
  {
    nome: 'a row naming an unasked produto: reported apart, and 1001 has no answer',
    editar: trocarLinha(1001, (l) => ({ ...l, produto: uriProdutoPrecoLi(1999) })),
    trocas: { '1001': { tipo: 'sem-resposta' } },
    contabilizados: 5,
    naoPedidos: [{ origem: 'linha', indice: 0, id: '1999' }],
  },
  {
    nome: 'a row whose full price the fold cannot read: unreadable, with its field',
    editar: trocarLinha(1002, (l) => ({ ...l, cheio: '1,50' })),
    trocas: { '1002': { tipo: 'ilegivel', campos: ['cheio'] } },
    contabilizados: 6,
    naoPedidos: [],
  },
  {
    nome: 'a row served twice: repeated, never one of them chosen',
    editar: (r) => ({ ...r, objects: [r.objects[0], ...r.objects] }),
    trocas: { '1001': { tipo: 'repetido', linhas: 2, naoEncontrado: 0 } },
    contabilizados: 6,
    naoPedidos: [],
  },
];

describe('edited mixed answers are never read as "no row"', () => {
  it.each(CASOS_EDITADOS)('$nome', async ({ editar, trocas, contabilizados, naoPedidos }) => {
    const base = await lerMisto();
    const editada = editar(respostaSetMistaPrecoLi());
    const dados = await lerMisto(editada);

    expect(dados.resultados).toEqual(
      base.resultados.map(({ id, resultado }) => ({ id, resultado: trocas[id] ?? resultado })),
    );
    expect(dados.contabilizados).toBe(contabilizados);
    expect(dados.naoPedidos).toEqual(naoPedidos);
    // Only an id the edited answer LISTS is "not found".
    const listados = new Set(editada.not_found ?? []);
    for (const { id, resultado } of dados.resultados) {
      if (resultado.tipo === 'nao-encontrado') expect(listados.has(id), `produto ${id}`).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*              S5 — a set of only ids the store does not know                 */
/* -------------------------------------------------------------------------- */

// Whether the store answers such a set with a 200 listing them or with a bodiless 404 was not
// measured, so both are read: either way the id is never a row.
describe.each<[string, number]>([
  ['no product', ID_SEM_PRODUTO_PRECO_LI],
  ['a price row’s own id', idDaLinhaDePrecoLi(1001)],
])('a set asking only %s', (_caso, id) => {
  const caminho = caminhoSet([id]);

  it('answered 200 listing it: the one result is "not found"', async () => {
    const plataforma = plataformaPrecoLi({
      [caminho]: ok(respostaSetPrecoLi([], [String(id)])),
    });
    const { dados } = await lerPrecosPorIdLi(leitor(plataforma), [id]);
    expect(tipos(dados)).toEqual([[String(id), 'nao-encontrado']]);
    expect(dados.contabilizados).toBe(1);
    expect([...plataforma.consumidas]).toEqual([[caminho, 1]]);
  });

  it('answered 404 with no body: rejected as not found, never an empty result', async () => {
    const plataforma = plataformaPrecoLi({ [caminho]: { status: 404, semCorpo: true } });
    const erro = await rejeicaoDe(lerPrecosPorIdLi(leitor(plataforma), [id]));
    expect(erro).toBeInstanceOf(LiNotFoundError);
    expect([...plataforma.consumidas]).toEqual([[caminho, 1]]);
  });
});

/* -------------------------------------------------------------------------- */
/*   S6 — the detail and the price row of one produto agree through the fold   */
/* -------------------------------------------------------------------------- */

describe('the produto detail and its price row agree through the shared fold', () => {
  it('per pair: the guard reads, and full price, promotion, effective price, sob_consulta and custo agree', async () => {
    const ids = PARES_DETALHE_PRECO_LI.map((p) => p.produtoId);
    const plataforma = plataformaPrecoLi({
      [caminhoSet(ids)]: ok(respostaSetPrecoLi(PARES_DETALHE_PRECO_LI.map((p) => p.linha))),
      ...Object.fromEntries(
        PARES_DETALHE_PRECO_LI.map((p) => [caminhoDetalhe(p.produtoId), ok(p.detalhe)]),
      ),
    });
    const { dados } = await lerPrecosPorIdLi(leitor(plataforma), ids);
    const escrita = escritor(plataforma);

    for (const par of PARES_DETALHE_PRECO_LI) {
      const rotulo = `produto ${String(par.produtoId)}`;
      const { dados: d } = await escrita.lerAntesDeEscreverLi({
        operacao: 'lerDetalheDoPreco',
        caminho: caminhoDetalhe(par.produtoId),
        schema: liProdutoComPrecoDetalheSchema,
      });
      const r = linhaDe(dados, par.produtoId);

      // The guard a price write reads before anything else.
      expect(d.tipo, rotulo).toBe(TIPO_PRODUTO_LI.atributoOpcao);
      expect(d.removido, rotulo).toBe(false);
      expect(d.bloqueado, rotulo).toBe(false);
      expect(d.id, rotulo).toBe(par.produtoId);

      expect(mesmoPrecoLi(d.preco_cheio, r.cheio), rotulo).toBe(true);
      if (par.classe === 'promocao-abaixo') {
        expect(mesmoPrecoLi(d.preco_promocional, r.promocional), rotulo).toBe(true);
        expect(promocionalLimpoLi(d.preco_promocional), rotulo).toBe(false);
        expect(promocionalLimpoLi(r.promocional), rotulo).toBe(false);
      } else {
        // The zero pair: JSON 0 in the detail, '0.0000' in the row — both a clear.
        expect(promocionalLimpoLi(d.preco_promocional), rotulo).toBe(true);
        expect(promocionalLimpoLi(r.promocional), rotulo).toBe(true);
      }
      expect(efetivoPrecoLi(d.preco_cheio, d.preco_promocional), rotulo).toEqual(
        efetivoPrecoLi(r.cheio, r.promocional),
      );
      expect(d.preco_sob_consulta, rotulo).toBe(r.sob_consulta);
      expect(d.preco_custo === null, rotulo).toBe(r.custo === null);
      if (d.preco_custo !== null) {
        expect(typeof d.preco_custo, rotulo).toBe('number');
        expect(typeof r.custo, rotulo).toBe('string');
        expect(mesmoPrecoLi(d.preco_custo, r.custo), rotulo).toBe(true);
      }

      // NEAR-MISS: the spellings differ, so strict equality cannot be the comparison; and one
      // centavo either side is another price.
      expect(d.preco_cheio === r.cheio, rotulo).toBe(false);
      const c = centavosDe(d.preco_cheio);
      expect(Number.isSafeInteger(c) && c > 1, rotulo).toBe(true);
      expect(mesmoPrecoLi((c + 1) / 100, r.cheio), rotulo).toBe(false);
      expect(mesmoPrecoLi((c - 1) / 100, r.cheio), rotulo).toBe(false);
    }

    expect(plataforma.semResposta()).toBe(0);
    expect(plataforma.chamadas.every((c) => c.metodo === 'GET' && !c.comCorpo)).toBe(true);
    expect(plataforma.chamadas).toHaveLength(1 + PARES_DETALHE_PRECO_LI.length);
  });

  it('the three promotion classes are all here (non-vacuous)', () => {
    expect(PARES_DETALHE_PRECO_LI.map((p) => p.classe).sort()).toEqual([
      'promocao-abaixo',
      'promocao-zero',
      'sem-promocao',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         S7 — the clear spellings                            */
/* -------------------------------------------------------------------------- */

describe('the clear spellings, read through the client', () => {
  const ids = [1201, 1202, 1203];

  async function lerLimpeza(): Promise<readonly PrecoProdutoLinhaLi[]> {
    const plataforma = plataformaPrecoLi({
      [caminhoSet(ids)]: ok(respostaSetPrecoLi(LINHAS_LIMPEZA_PRECO_LI)),
    });
    const { dados } = await lerPrecosPorIdLi(leitor(plataforma), ids);
    return ids.map((id) => linhaDe(dados, id));
  }

  const parZero = PARES_DETALHE_PRECO_LI.find((p) => p.classe === 'promocao-zero');

  it('null and the zero text are a clear; one centavo is a promotion — under the default clear too', async () => {
    const linhas = await lerLimpeza();
    expect(linhas.map((l) => promocionalLimpoLi(l.promocional))).toEqual([true, true, false]);
    for (const forma of [FORMA_PROMO_LIMPA_PADRAO_LI, FORMA_PROMO_LIMPA_LI.zero]) {
      expect(
        linhas.map((l) =>
          promocionalLimpoNaFormaLi({ forma, cheio: l.cheio, promocional: l.promocional }),
        ),
        forma,
      ).toEqual([true, true, false]);
    }
    expect(parZero?.detalhe.preco_promocional, 'produto 1102').toBe(0);
    expect(promocionalLimpoLi(parZero?.detalhe.preco_promocional), 'produto 1102').toBe(true);
  });

  it('NEAR-MISS: a null-only reader misreads exactly the zero spellings, and agrees on one centavo', async () => {
    const linhas = await lerLimpeza();
    const soNulo = (v: unknown) => v === null;
    const valores = [...linhas.map((l) => l.promocional), parZero?.detalhe.preco_promocional];
    expect(valores.filter((v) => soNulo(v) !== promocionalLimpoLi(v))).toEqual(['0.0000', 0]);
    const umCentavo = linhas[2]?.promocional;
    expect(umCentavo, 'produto 1203').toBe('0.0100');
    expect(soNulo(umCentavo) || promocionalLimpoLi(umCentavo), 'produto 1203').toBe(false);
  });
});
