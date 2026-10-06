import { describe, expect, it } from 'vitest';

import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  createShopeeClient,
} from './client';
import {
  CODIGO_FALHA_SHOPEE,
  MENSAGEM_CATEGORIA_DESCONHECIDA,
  MENSAGEM_TABELA_INEXISTENTE,
  SHOPEE_QUERY_MAX_RETRIES,
  codigoDaFalhaShopee,
  descreverFalhaShopee,
  shopeeQueryRetry,
} from './erros';

/**
 * The operator copy of the `/medidas` Shopee tab's failures, and the one
 * automatic-retry predicate. What these pin is that both are keyed on the
 * backend's `code` and `kind` — never on the status, which means four
 * different things at 404 and two opposite things at 502 — and that a 502 is
 * never repeated automatically (M65): a rate limit IS a 502 today.
 */

const OPTS = { desconhecido: 'Falha desconhecida.' };
const LIMITE = 'A Shopee limitou as consultas — tente em alguns minutos.';
const RECONECTAR = 'Reconecte a conta Shopee em Canais de venda.';

const http = (status: number, code: string | null, kind: string | null = null, msg = 'msg') =>
  new ShopeeClientHttpError(msg, status, code, null, kind);

const abortada = () =>
  new ShopeeClientNetworkError('aborted', new DOMException('aborted', 'AbortError'));

describe('descreverFalhaShopee — keyed on the code', () => {
  it('⭐ a stale template says to choose another, and offers no retry', () => {
    expect(
      descreverFalhaShopee(http(404, CODIGO_FALHA_SHOPEE.tabelaMedidasInexistente), OPTS),
    ).toEqual({
      mensagem: 'Esta tabela não existe mais na loja — escolha outra.',
      repetivel: false,
    });
  });

  it('a category gone from the tree says so — and what to do', () => {
    expect(
      descreverFalhaShopee(http(404, CODIGO_FALHA_SHOPEE.categoriaDesconhecida), OPTS),
    ).toEqual({
      mensagem: 'A categoria guardada não existe mais na árvore desta conta — escolha outra.',
      repetivel: false,
    });
  });

  it('the two stale-pick sentences are the EXPORTED constants the tab and the browser render (one spelling each)', () => {
    expect(
      descreverFalhaShopee(http(404, CODIGO_FALHA_SHOPEE.tabelaMedidasInexistente), OPTS).mensagem,
    ).toBe(MENSAGEM_TABELA_INEXISTENTE);
    expect(
      descreverFalhaShopee(http(404, CODIGO_FALHA_SHOPEE.categoriaDesconhecida), OPTS).mensagem,
    ).toBe(MENSAGEM_CATEGORIA_DESCONHECIDA);
  });

  it('a category Shopee refuses for templates reads the backend’s own sentence', () => {
    const err = http(
      404,
      CODIGO_FALHA_SHOPEE.tabelaMedidasCategoriaInvalida,
      null,
      'A Shopee não aceita a categoria 400055 para tabelas de medidas nesta loja — escolha outra categoria.',
    );
    expect(descreverFalhaShopee(err, OPTS)).toEqual({
      mensagem:
        'A Shopee não aceita a categoria 400055 para tabelas de medidas nesta loja — escolha outra categoria.',
      repetivel: false,
    });
  });

  it.each([CODIGO_FALHA_SHOPEE.reautenticar, CODIGO_FALHA_SHOPEE.contaSemShopId])(
    '%s asks for a reconnect, with no retry',
    (code) => {
      expect(descreverFalhaShopee(http(409, code), OPTS)).toEqual({
        mensagem: RECONECTAR,
        repetivel: false,
      });
    },
  );

  it('NEAR-MISS: the SAME 404 without a code (a backend that predates the route) is NOT a stale template', () => {
    const r = descreverFalhaShopee(
      http(404, null, null, 'A integração não respondeu (HTTP 404).'),
      OPTS,
    );
    expect(r).toEqual({ mensagem: 'A integração não respondeu (HTTP 404).', repetivel: false });
  });

  it('NEAR-MISS: a 409 with another code is not a reconnect', () => {
    expect(descreverFalhaShopee(http(409, 'SHOPEE_OUTRA_COISA', null, 'outra'), OPTS)).toEqual({
      mensagem: 'outra',
      repetivel: false,
    });
  });

  it('a 2xx in an unknown shape keeps its deploy sentence and is never repeatable', () => {
    const err = new ShopeeClientRespostaInvalidaError('faça o deploy', 200, ['tabela']);
    expect(descreverFalhaShopee(err, OPTS)).toEqual({
      mensagem: 'faça o deploy',
      repetivel: false,
    });
  });
});

describe('descreverFalhaShopee — keyed on `kind` for a Shopee 502', () => {
  it.each(['burst', 'daily'])(
    '⭐ M68: kind `%s` is the rate-limit sentence, not repeatable',
    (kind) => {
      expect(descreverFalhaShopee(http(502, 'SHOPEE_HTTP_ERROR', kind), OPTS)).toEqual({
        mensagem: LIMITE,
        repetivel: false,
      });
    },
  );

  it('NEAR-MISS: the same 502 with kind `transient` is the backend’s sentence AND repeatable by hand', () => {
    expect(
      descreverFalhaShopee(http(502, 'SHOPEE_HTTP_ERROR', 'transient', 'oscilou'), OPTS),
    ).toEqual({ mensagem: 'oscilou', repetivel: true });
  });

  it.each([
    ['other', 'other'],
    ['absent', null],
    ['a different case (no fold)', 'BURST'],
  ])('NEAR-MISS: kind %s on a 502 is neither a rate limit nor repeatable', (_n, kind) => {
    expect(descreverFalhaShopee(http(502, 'SHOPEE_HTTP_ERROR', kind, 'recusou'), OPTS)).toEqual({
      mensagem: 'recusou',
      repetivel: false,
    });
  });

  it('kind `reauth` asks for a reconnect whatever the code', () => {
    expect(descreverFalhaShopee(http(502, 'SHOPEE_HTTP_ERROR', 'reauth'), OPTS).mensagem).toBe(
      RECONECTAR,
    );
  });
});

describe('descreverFalhaShopee — the rest', () => {
  it.each([
    [503, true],
    [500, true],
    [504, true],
    [501, false],
    [400, false],
    [403, false],
  ])('an uncoded HTTP %i is repeatable: %s', (status, repetivel) => {
    expect(descreverFalhaShopee(http(status, null), OPTS).repetivel).toBe(repetivel);
  });

  // `apps/shopee` answers neither today (a rate limit is a 502 + `kind`); a
  // proxy or a future global arm (Q5 f) might — both are "try again later".
  it.each([408, 429])(
    'an uncoded HTTP %i (timeout / too many requests) is repeatable by hand',
    (status) => {
      expect(descreverFalhaShopee(http(status, null), OPTS).repetivel).toBe(true);
    },
  );

  it('a network failure says so and is repeatable; one WE aborted is not', () => {
    expect(descreverFalhaShopee(new ShopeeClientNetworkError('falhou'), OPTS)).toEqual({
      mensagem: 'Não foi possível contatar a integração com a Shopee.',
      repetivel: true,
    });
    expect(descreverFalhaShopee(abortada(), OPTS).repetivel).toBe(false);
  });

  it('an error that is not a Shopee client error gets the caller’s copy, not repeatable', () => {
    expect(descreverFalhaShopee(new TypeError('x'), OPTS)).toEqual({
      mensagem: 'Falha desconhecida.',
      repetivel: false,
    });
    expect(descreverFalhaShopee('nada', OPTS).mensagem).toBe('Falha desconhecida.');
  });

  it('codigoDaFalhaShopee reads the code off an HTTP error, `null` off anything else', () => {
    expect(codigoDaFalhaShopee(http(404, CODIGO_FALHA_SHOPEE.tabelaMedidasInexistente))).toBe(
      'SHOPEE_TABELA_MEDIDAS_INEXISTENTE',
    );
    expect(codigoDaFalhaShopee(new ShopeeClientNetworkError('x'))).toBeNull();
    expect(codigoDaFalhaShopee(new Error('x'))).toBeNull();
  });
});

describe('the real path — the body’s `kind` reaches the copy through the client', () => {
  it('⭐ M68: a 502 `{ code: SHOPEE_HTTP_ERROR, kind: burst }` off the wire is the rate-limit sentence', async () => {
    const c = createShopeeClient({
      baseUrl: 'http://localhost:3009',
      getAuthToken: async () => 'token',
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: 'Shopee: error_busy',
            code: 'SHOPEE_HTTP_ERROR',
            upstreamStatus: 200,
            shopeeCode: 'error_busy',
            kind: 'burst',
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        ),
    });

    const err: unknown = await c
      .tabelaMedidasLista({ integracaoId: 'int-1', categoryId: 400055 })
      .catch((e: unknown) => e);

    expect(descreverFalhaShopee(err, OPTS)).toEqual({ mensagem: LIMITE, repetivel: false });
    expect(shopeeQueryRetry(0, err)).toBe(false);
  });
});

describe('shopeeQueryRetry — reads only, and never a 502', () => {
  it.each(['transient', 'burst', 'daily', 'other', null])(
    '⭐ M65: a 502 with kind %s is NEVER retried automatically',
    (kind) => {
      expect(shopeeQueryRetry(0, http(502, 'SHOPEE_HTTP_ERROR', kind))).toBe(false);
    },
  );

  it('a 503 is retried while failureCount < 2, then the operator sees it', () => {
    expect(SHOPEE_QUERY_MAX_RETRIES).toBe(2);
    expect(shopeeQueryRetry(0, http(503, 'SHOPEE_NETWORK_ERROR'))).toBe(true);
    expect(shopeeQueryRetry(1, http(503, 'SHOPEE_NETWORK_ERROR'))).toBe(true);
    expect(shopeeQueryRetry(2, http(503, 'SHOPEE_NETWORK_ERROR'))).toBe(false);
  });

  it('a network failure is retried; one WE aborted is not', () => {
    expect(shopeeQueryRetry(0, new ShopeeClientNetworkError('falhou'))).toBe(true);
    expect(shopeeQueryRetry(1, new ShopeeClientNetworkError('falhou'))).toBe(true);
    expect(shopeeQueryRetry(2, new ShopeeClientNetworkError('falhou'))).toBe(false);
    expect(shopeeQueryRetry(0, abortada())).toBe(false);
  });

  it.each([
    ['a 500', http(500, null)],
    ['a 504', http(504, null)],
    ['a stale-template 404', http(404, CODIGO_FALHA_SHOPEE.tabelaMedidasInexistente)],
    ['a 2xx in an unknown shape', new ShopeeClientRespostaInvalidaError('x', 200, [])],
    ['a foreign error', new TypeError('x')],
  ])('deny by default: %s is not retried', (_n, err) => {
    expect(shopeeQueryRetry(0, err)).toBe(false);
  });
});
