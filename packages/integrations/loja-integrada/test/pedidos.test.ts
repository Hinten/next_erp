import { afterEach, describe, expect, it } from 'vitest';

import { criarClienteLeituraLi, type LiLeituraClient, URL_BASE_LI } from '../src/client';
import { LiConfigError, LiNotFoundError, LiPaginacaoError, LiSchemaError } from '../src/errors';
import {
  buscarPedidoLi,
  buscarProdutoPorIdExternoLi,
  CAMINHO_HISTORICO_SITUACAO_LI,
  LIMITE_HISTORICO_SITUACAO_LI,
  listarHistoricoSituacaoLi,
  MAX_PAGINAS_HISTORICO_SITUACAO_LI,
} from '../src/pedidos';
import { json, mockFetch, requisicao, TOKEN, texto, verificarSoGet } from './_helpers/mockFetch';

/**
 * The request shapes of the order import's three reads. Every id here is the
 * public document's own example: numero `165` (its `GET /v1/pedido/{pedido_id}`
 * example) — no captured value.
 */

afterEach(verificarSoGet);

const NUMERO = 165;

function cliente(fetch: typeof globalThis.fetch): LiLeituraClient {
  let n = 0;
  return criarClienteLeituraLi({
    obterCredencial: () => ({ token: TOKEN, ref: 'ref-A' }),
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-${String(n)}`;
    },
    agora: () => 0,
  });
}

/** Serves the bodies in order; a request past the last one is a test failure. */
function sequencia(...respostas: readonly Response[]) {
  let i = 0;
  return mockFetch(() => {
    const r = respostas[i];
    i += 1;
    if (r === undefined) throw new RangeError('fetch além da última resposta');
    return r;
  });
}

const PEDIDO = {
  numero: NUMERO,
  situacao: { codigo: 'pedido_pago' },
  data_modificacao: '2026-09-12T09:15:42.105377',
};

function linhaHistorico(id: number, codigo: string, anterior: string | null) {
  return {
    id,
    numero: NUMERO,
    data: `2026-09-1${String(id % 10)}T10:00:00.000000`,
    situacao: { codigo },
    situacao_anterior: anterior === null ? null : { codigo: anterior },
  };
}

function paginaHistorico(offset: number, next: string | null, linhas: readonly unknown[]) {
  return { meta: { limit: 50, next, offset, previous: null, total_count: 99 }, objects: linhas };
}

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

const IDS_INVALIDOS: readonly (number | string)[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  2 ** 53,
  '0',
  '-1',
  '+165',
  '0165',
  ' 165',
  '165 ',
  '16 5',
  '1e3',
  '165/../1',
  'abc',
  '',
  '9007199254740993',
];

describe('buscarPedidoLi', () => {
  it('GETs the slash-form detail path, with no query, and parses the body', async () => {
    const f = sequencia(json(PEDIDO));
    const r = await buscarPedidoLi(cliente(f), NUMERO);
    const { url } = requisicao(f);
    expect(url.href).toBe(`${URL_BASE_LI}/v1/pedido/165/`);
    expect(url.search).toBe('');
    expect(r.dados.numero).toBe(165);
    expect(r.dados.itens).toEqual([]);
    expect(r.correlationId).toBe('corr-1');
    expect(r.refCredencial).toBe('ref-A');
  });

  it('takes the numero as its plain decimal text too (the task payload carries a string)', async () => {
    const f = sequencia(json(PEDIDO));
    await buscarPedidoLi(cliente(f), '165');
    expect(requisicao(f).url.pathname).toBe('/v1/pedido/165/');
  });

  it.each(IDS_INVALIDOS)(
    'refuses numero %j with LiConfigError("caminho") and fetches nothing',
    async (numero) => {
      const f = sequencia(json(PEDIDO));
      const err = await falha(buscarPedidoLi(cliente(f), numero));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('caminho');
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('a 404 is the client’s LiNotFoundError, rethrown as-is', async () => {
    const f = sequencia(texto('', 404));
    await expect(buscarPedidoLi(cliente(f), NUMERO)).rejects.toBeInstanceOf(LiNotFoundError);
  });

  it('a body missing a required field is LiSchemaError — nothing is mapped half-way', async () => {
    const { data_modificacao: _omitida, ...semData } = PEDIDO;
    const f = sequencia(json(semData));
    await expect(buscarPedidoLi(cliente(f), NUMERO)).rejects.toBeInstanceOf(LiSchemaError);
  });
});

describe('listarHistoricoSituacaoLi', () => {
  it(`asks for numero AND an explicit limit of ${String(LIMITE_HISTORICO_SITUACAO_LI)}, on the slash-form path`, async () => {
    // Without the explicit limit the provider answers 20 rows a page.
    const f = sequencia(
      json(
        paginaHistorico(0, null, [linhaHistorico(1, 'aguardando_pagamento', 'pedido_efetuado')]),
      ),
    );
    await listarHistoricoSituacaoLi(cliente(f), NUMERO);
    const { url } = requisicao(f);
    expect(url.pathname).toBe(CAMINHO_HISTORICO_SITUACAO_LI);
    expect(CAMINHO_HISTORICO_SITUACAO_LI).toBe('/v1/situacao_historico/search/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ numero: '165', limit: '50' });
  });

  it('reads EVERY page and returns the rows in the order received', async () => {
    const f = sequencia(
      json(
        paginaHistorico(0, '/api/v1/situacao_historico/search?numero=165&limit=50&offset=50', [
          linhaHistorico(1, 'aguardando_pagamento', 'pedido_efetuado'),
          linhaHistorico(2, 'pedido_pago', 'aguardando_pagamento'),
        ]),
      ),
      json(paginaHistorico(50, null, [linhaHistorico(3, 'pedido_enviado', 'pedido_pago')])),
    );
    const h = await listarHistoricoSituacaoLi(cliente(f), NUMERO);
    expect(h.linhas.map((l) => l.situacao.codigo)).toEqual([
      'aguardando_pagamento',
      'pedido_pago',
      'pedido_enviado',
    ]);
    expect(h.correlationIds).toEqual(['corr-1', 'corr-2']);
    const segunda = requisicao(f, 1).url.searchParams;
    expect(Object.fromEntries(segunda)).toEqual({ numero: '165', limit: '50', offset: '50' });
  });

  it('a first row without a previous situação is kept', async () => {
    const f = sequencia(
      json(paginaHistorico(0, null, [linhaHistorico(1, 'pedido_efetuado', null)])),
    );
    const h = await listarHistoricoSituacaoLi(cliente(f), NUMERO);
    expect(h.linhas[0]?.situacao_anterior).toBeNull();
  });

  it(`stops at ${String(MAX_PAGINAS_HISTORICO_SITUACAO_LI)} pages with LiPaginacaoError — never a silent truncation`, async () => {
    let offset = 0;
    const f = mockFetch(() => {
      const corpo = paginaHistorico(
        offset,
        `/api/v1/situacao_historico/search?offset=${String(offset + 50)}`,
        [linhaHistorico(1, 'pedido_pago', 'aguardando_pagamento')],
      );
      offset += 50;
      return json(corpo);
    });
    const err = await falha(listarHistoricoSituacaoLi(cliente(f), NUMERO));
    expect(err).toBeInstanceOf(LiPaginacaoError);
    expect(err).toMatchObject({
      motivo: 'limite-de-paginas',
      paginas: MAX_PAGINAS_HISTORICO_SITUACAO_LI,
    });
    expect(f).toHaveBeenCalledTimes(MAX_PAGINAS_HISTORICO_SITUACAO_LI);
  });

  it('honours a caller cap', async () => {
    const f = sequencia(
      json(paginaHistorico(0, '/api/v1/situacao_historico/search?offset=50', [])),
      json(paginaHistorico(50, null, [])),
    );
    const err = await falha(listarHistoricoSituacaoLi(cliente(f), NUMERO, { maxPaginas: 1 }));
    expect(err).toMatchObject({ motivo: 'limite-de-paginas', paginas: 1 });
  });

  it('a row missing its data is LiSchemaError for the whole listing', async () => {
    const { data: _omitida, ...semData } = linhaHistorico(1, 'pedido_pago', 'aguardando_pagamento');
    const f = sequencia(json(paginaHistorico(0, null, [semData])));
    await expect(listarHistoricoSituacaoLi(cliente(f), NUMERO)).rejects.toBeInstanceOf(
      LiSchemaError,
    );
  });

  it.each(IDS_INVALIDOS)('refuses numero %j before any request', async (numero) => {
    const f = sequencia(json(paginaHistorico(0, null, [])));
    const err = await falha(listarHistoricoSituacaoLi(cliente(f), numero));
    expect(err).toBeInstanceOf(LiConfigError);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('buscarProdutoPorIdExternoLi', () => {
  it('GETs /v1/produto/{id}/ with id_externo=1 and reads the LI id', async () => {
    const f = sequencia(json({ id: '98765', sku: 'SKU-1', nome: 'Produto' }));
    const r = await buscarProdutoPorIdExternoLi(cliente(f), 123);
    const { url } = requisicao(f);
    expect(url.pathname).toBe('/v1/produto/123/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ id_externo: '1' });
    expect(r.dados.id).toBe(98765);
  });

  it('a 404 is LiNotFoundError — the importer turns it into an unmatched line', async () => {
    const f = sequencia(texto('', 404));
    await expect(buscarProdutoPorIdExternoLi(cliente(f), '123')).rejects.toBeInstanceOf(
      LiNotFoundError,
    );
  });

  it('a body without an id is LiSchemaError', async () => {
    const f = sequencia(json({ sku: 'SKU-1' }));
    await expect(buscarProdutoPorIdExternoLi(cliente(f), 123)).rejects.toBeInstanceOf(
      LiSchemaError,
    );
  });

  it.each(IDS_INVALIDOS)('refuses id %j before any request', async (id) => {
    const f = sequencia(json({ id: 1 }));
    const err = await falha(buscarProdutoPorIdExternoLi(cliente(f), id));
    expect(err).toBeInstanceOf(LiConfigError);
    expect(f).not.toHaveBeenCalled();
  });
});
