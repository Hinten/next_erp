import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CODIGO_RASCUNHO_SHOPEE, MOTIVO_RASCUNHO_INVALIDO_SHOPEE } from '@delfrance/schemas';

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
  motivoRascunhoInvalido,
  shopeeQueryRetry,
} from './erros';
import { DETALHES_ERRO_SHOPEE_VAZIOS, type DetalhesErroShopee } from './wire';

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

describe('CODIGO_FALHA_SHOPEE — the step-21 vocabulary (#1529)', () => {
  // The ONE place these strings are spelled on the web side. Each is the string
  // `apps/shopee` emits (its `lib/shopee/**` constants and the route literals);
  // a typo here would make every branch on it silently dead, so the table pins
  // the spelling rather than trusting it.
  it.each([
    ['contaPausada', 'SHOPEE_CONTA_PAUSADA'],
    ['selecaoExcedeLimite', 'SHOPEE_SELECAO_EXCEDE_LIMITE'],
    ['contaSemDeposito', 'SHOPEE_CONTA_SEM_DEPOSITO'],
    ['contaSemTabelaNormal', 'SHOPEE_CONTA_SEM_TABELA_NORMAL'],
    ['precoContaRecusada', 'SHOPEE_PRECO_CONTA_RECUSADA'],
    ['publicacaoBloqueada', 'SHOPEE_PUBLISH_BLOCKED'],
    ['publicacaoRecusada', 'SHOPEE_PUBLISH_REJECTED'],
    ['anuncioNaoEncontrado', 'SHOPEE_ANUNCIO_NAO_ENCONTRADO'],
    ['anuncioNaoPublicado', 'SHOPEE_ANUNCIO_NAO_PUBLICADO'],
    ['anuncioSemVinculo', 'SHOPEE_ANUNCIO_SEM_VINCULO'],
    ['importacaoEmAndamento', 'SHOPEE_MASS_IMPORT_RUNNING'],
    ['importacaoNaoEmAndamento', 'SHOPEE_MASS_IMPORT_NOT_RUNNING'],
    ['importacaoNaoEnfileirada', 'SHOPEE_MASS_IMPORT_ENQUEUE_FAILED'],
    ['envioPrecoEmAndamento', 'SHOPEE_PRICE_SYNC_RUNNING'],
    ['envioPrecoNaoEmAndamento', 'SHOPEE_PRICE_SYNC_NOT_RUNNING'],
    ['envioPrecoNaoEnfileirado', 'SHOPEE_PRICE_SYNC_ENQUEUE_FAILED'],
  ] as const)('%s is `%s`', (chave, codigo) => {
    expect(CODIGO_FALHA_SHOPEE[chave]).toBe(codigo);
  });

  it('no two keys share a string — a branch on one can never match another', () => {
    const valores = Object.values(CODIGO_FALHA_SHOPEE);
    expect(new Set(valores).size).toBe(valores.length);
  });

  it('the new codes get no copy of their own here — the backend’s sentence, not repeatable', () => {
    // Their callers word their own copy; this module's behaviour is unchanged.
    expect(
      descreverFalhaShopee(
        http(409, CODIGO_FALHA_SHOPEE.contaPausada, null, 'Conta pausada até amanhã.'),
        OPTS,
      ),
    ).toEqual({ mensagem: 'Conta pausada até amanhã.', repetivel: false });
  });
});

/* ---------------------------------------------------------------------------
 * #1911 — the listing drafts' codes and the invalid-produto motivo
 * ------------------------------------------------------------------------- */

/** Each web key and the `CODIGO_RASCUNHO_SHOPEE` key its value is spelled through. */
const CODIGOS_DO_RASCUNHO = [
  ['publicacaoEmAndamento', 'publicacaoEmAndamento'],
  ['rascunhoJaPublicado', 'jaPublicado'],
  ['publicacaoExpirada', 'publicacaoExpirada'],
  ['rascunhoContencao', 'contencao'],
  ['rascunhoCriacaoIncerta', 'criacaoIncerta'],
  ['rascunhoContaJaTemAnuncio', 'contaJaTemAnuncio'],
  ['rascunhoConflito', 'conflito'],
  ['rascunhoIdEmUso', 'idEmUso'],
  ['rascunhoCategoriaTravada', 'categoriaTravada'],
  ['rascunhoProdutoInvalido', 'produtoInvalido'],
  ['rascunhoInexistente', 'inexistente'],
] as const satisfies readonly (readonly [
  keyof typeof CODIGO_FALHA_SHOPEE,
  keyof typeof CODIGO_RASCUNHO_SHOPEE,
])[];

/** `erros.ts` as TEXT — the only way to see HOW a value is spelled. */
const FONTE_DE_ERROS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'erros.ts'),
  'utf8',
);

/** The three quote characters a TypeScript string literal can open with. */
const ASPAS = ["'", '"', '`'] as const;

/** The values of `CODIGO_RASCUNHO_SHOPEE` that `fonte` spells between quotes. */
function valoresDoRascunhoEntreAspas(fonte: string): string[] {
  return Object.values(CODIGO_RASCUNHO_SHOPEE).filter((valor) =>
    ASPAS.some((aspa) => fonte.includes(`${aspa}${valor}${aspa}`)),
  );
}

describe('CODIGO_FALHA_SHOPEE — the #1911 vocabulary, spelled through the shared constant', () => {
  it.each(CODIGOS_DO_RASCUNHO)(
    '%s is CODIGO_RASCUNHO_SHOPEE.%s — the string the routes answer with',
    (chave, doRascunho) => {
      expect(CODIGO_FALHA_SHOPEE[chave]).toBe(CODIGO_RASCUNHO_SHOPEE[doRascunho]);
    },
  );

  it('the table covers the WHOLE shared constant — a code the routes gain is a code this list gains', () => {
    expect(CODIGOS_DO_RASCUNHO.map(([, doRascunho]) => doRascunho).sort()).toEqual(
      Object.keys(CODIGO_RASCUNHO_SHOPEE).sort(),
    );
  });

  it('⭐ pela CONSTANTE: `erros.ts` spells every #1911 value through `CODIGO_RASCUNHO_SHOPEE.` — none of the eleven between quotes', () => {
    // A retyped literal of the SAME string passes every value test above; only
    // the source text can tell the two spellings apart. The first raw-text pin
    // under `apps/web/lib/shopee` (the `apps/shopee` pattern:
    // `anuncios/errosPublicacao.test.ts`, "pela CONSTANTE").
    // Whitespace-tolerant, so a formatter wrapping the line cannot red it.
    const semConstante = CODIGOS_DO_RASCUNHO.filter(
      ([chave, doRascunho]) =>
        !new RegExp(`\\b${chave}:\\s*CODIGO_RASCUNHO_SHOPEE\\.${doRascunho}\\b`).test(
          FONTE_DE_ERROS,
        ),
    );
    expect(semConstante, 'chaves #1911 sem a grafia da constante').toEqual([]);
    expect(valoresDoRascunhoEntreAspas(FONTE_DE_ERROS), 'códigos #1911 entre aspas').toEqual([]);
  });

  it.each(ASPAS)('the pin SEES a value quoted with %s — the scanner is not vacuous', (aspa) => {
    const adulterada = FONTE_DE_ERROS.replace(
      'rascunhoConflito: CODIGO_RASCUNHO_SHOPEE.conflito,',
      `rascunhoConflito: ${aspa}${CODIGO_RASCUNHO_SHOPEE.conflito}${aspa},`,
    );
    expect(adulterada).not.toBe(FONTE_DE_ERROS);
    expect(valoresDoRascunhoEntreAspas(adulterada)).toEqual([CODIGO_RASCUNHO_SHOPEE.conflito]);
  });

  it('NEAR-MISS: the quoted `SHOPEE_PUBLISH_*` literals stay ALLOWED — the pin names eleven exact values, never a prefix', () => {
    for (const literal of [
      CODIGO_FALHA_SHOPEE.publicacaoBloqueada,
      CODIGO_FALHA_SHOPEE.publicacaoRecusada,
      CODIGO_FALHA_SHOPEE.anuncioNaoEncontrado,
    ]) {
      expect(FONTE_DE_ERROS).toContain(`'${literal}'`);
    }
    expect(Object.values(CODIGO_RASCUNHO_SHOPEE)).toHaveLength(11);
    expect(valoresDoRascunhoEntreAspas(FONTE_DE_ERROS)).toEqual([]);
  });

  it('the #1911 codes get no copy here — the backend’s sentence, not repeatable (this module unchanged)', () => {
    expect(
      descreverFalhaShopee(
        http(
          409,
          CODIGO_FALHA_SHOPEE.rascunhoConflito,
          null,
          'O rascunho mudou desde que foi aberto.',
        ),
        OPTS,
      ),
    ).toEqual({ mensagem: 'O rascunho mudou desde que foi aberto.', repetivel: false });
  });

  it('⭐ a CODELESS 400 (a malformed body) reads `null` ⟷ the coded 409 reads its key', () => {
    expect(codigoDaFalhaShopee(http(400, null, null, 'item_name deve ser um texto.'))).toBeNull();
    expect(codigoDaFalhaShopee(http(409, CODIGO_FALHA_SHOPEE.rascunhoConflito))).toBe(
      CODIGO_RASCUNHO_SHOPEE.conflito,
    );
  });
});

/** An HTTP error carrying `detalhes`, as the client builds one from an error body. */
function comDetalhes(
  status: number,
  code: string | null,
  detalhes: Partial<DetalhesErroShopee>,
): ShopeeClientHttpError {
  return new ShopeeClientHttpError('msg', status, code, null, null, {
    ...DETALHES_ERRO_SHOPEE_VAZIOS,
    ...detalhes,
  });
}

/** A client whose every call answers `corpo` with `status`. */
function clienteQueResponde(corpo: unknown, status: number) {
  return createShopeeClient({
    baseUrl: 'http://localhost:3009',
    getAuthToken: async () => 'token',
    fetch: async () =>
      new Response(JSON.stringify(corpo), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  });
}

describe('motivoRascunhoInvalido — the 422’s motivo, narrowed at the READ', () => {
  it.each([MOTIVO_RASCUNHO_INVALIDO_SHOPEE.filho, MOTIVO_RASCUNHO_INVALIDO_SHOPEE.kitVirtual])(
    '⭐ `%s` under rascunhoProdutoInvalido narrows to itself',
    (motivo) => {
      const err = comDetalhes(422, CODIGO_FALHA_SHOPEE.rascunhoProdutoInvalido, { motivo });
      expect(motivoRascunhoInvalido(err)).toBe(motivo);
    },
  );

  it('NEAR-MISS: the SAME slug under another code is not this answer — `null`', () => {
    const err = comDetalhes(422, CODIGO_FALHA_SHOPEE.publicacaoBloqueada, {
      motivo: MOTIVO_RASCUNHO_INVALIDO_SHOPEE.filho,
    });
    expect(motivoRascunhoInvalido(err)).toBeNull();
  });

  it.each([
    ['a motivo this build does not know', 'motivo-novo'],
    ['no motivo at all', null],
  ])(
    'NEAR-MISS: %s under the right code reads `null` — the caller falls back to `error`',
    (_n, motivo) => {
      const err = comDetalhes(422, CODIGO_FALHA_SHOPEE.rascunhoProdutoInvalido, { motivo });
      expect(motivoRascunhoInvalido(err)).toBeNull();
    },
  );

  it('a failure that is not an HTTP error reads `null`', () => {
    expect(motivoRascunhoInvalido(new ShopeeClientNetworkError('x'))).toBeNull();
    expect(motivoRascunhoInvalido(new TypeError('x'))).toBeNull();
  });

  it('⭐ the real path: the 422 body’s `motivo` reaches the narrowing through the client', async () => {
    const c = clienteQueResponde(
      {
        error: 'o produto prod-1 é kit virtual: publique-o como kit nativo.',
        code: CODIGO_RASCUNHO_SHOPEE.produtoInvalido,
        linkDocId: 'AbCdEfGhIjKlMnOpQrSt',
        motivo: MOTIVO_RASCUNHO_INVALIDO_SHOPEE.kitVirtual,
      },
      422,
    );

    const err: unknown = await c
      .criarRascunho({
        integracaoId: 'int-1',
        produtoId: 'prod-1',
        linkDocId: 'AbCdEfGhIjKlMnOpQrSt',
        conteudo: {
          item_name: 'Camiseta',
          description: null,
          category_id: null,
          marca: null,
          attributes: null,
        },
      })
      .catch((e: unknown) => e);

    expect(codigoDaFalhaShopee(err)).toBe(CODIGO_FALHA_SHOPEE.rascunhoProdutoInvalido);
    expect(motivoRascunhoInvalido(err)).toBe(MOTIVO_RASCUNHO_INVALIDO_SHOPEE.kitVirtual);
  });

  it('⚠️ NEAR-MISS (the retype mutant): a PRICE 422’s free `motivo` stays VERBATIM on `detalhes` — the wire never narrows it', async () => {
    const c = clienteQueResponde(
      {
        error: 'A conta não aceita envio de preço.',
        code: CODIGO_FALHA_SHOPEE.precoContaRecusada,
        motivo: 'regiao-nao-suportada',
      },
      422,
    );

    const err = (await c
      .enviarPrecos({ integracaoId: 'int-1', produtoIds: ['prod-1'] })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.detalhes.motivo).toBe('regiao-nao-suportada');
    expect(motivoRascunhoInvalido(err)).toBeNull();
  });
});
