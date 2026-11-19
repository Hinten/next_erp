import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  CODIGO_ERRO_LI,
  INTEGRACAO_TIPO,
  MAX_PRODUTOS_ENVIO_ESTOQUE_LI,
  MODO_ESTOQUE_LI,
  RESULTADO_ENVIO_ESTOQUE_LI,
  type LinhaEnvioEstoqueLi,
  type RespostaEnvioEstoqueLi,
} from '@delfrance/schemas';

import type { LojaIntegradaClient } from '@/lib/loja-integrada/client';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

import type { StockPushInput } from '../types';

/**
 * The Loja Integrada stock provider (master plan step 12). Pinned, each with its
 * near miss:
 *  - a queued child stays `enfileirado` — NEVER `enviado`: the route sent nothing;
 *  - the body forwards the conta and the selection, never `reenviarComErro`;
 *  - a child row is the CHILD, named by its own name, else by the id selected;
 *  - the selection is sliced to the route's body cap, so no `ZodError` breaks
 *    the run's other contas — and once a slice MAY have queued anything, no
 *    other slice of the run is sent (the backend's bound is per request);
 *  - the answer is validated by the CLIENT against the shared contract, and a
 *    2xx it refuses (an older or newer backend) is a `falha` row saying the
 *    outcome is unknown — RespostaInvalida is narrowed before its parent class;
 *  - the backend switched off, or a slice over the children bound, is
 *    `nao-tentado`; a cancel is no rows; an unknown error is rethrown.
 *
 * ⚠️ No request leaves this file: the client is either the fake (every method
 * rejects unless supplied) or the real one over an injected fetch and an
 * `.invalid` host. Global `fetch` throws if anything reaches it.
 */

vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: null }) }));

const {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
  createLojaIntegradaClient,
} = await import('@/lib/loja-integrada/client');
const {
  FATIA_ENVIO_ESTOQUE_LI,
  MENSAGEM_SEM_CLIENTE_LI,
  MENSAGEM_UM_LOTE_POR_ENVIO_LI,
  MOTIVO_UM_LOTE_POR_ENVIO_LI,
  SUFIXO_RESULTADO_INCERTO_LI,
  lojaIntegradaStockProvider,
} = await import('./lojaIntegrada');

type EnviarEstoque = LojaIntegradaClient['enviarEstoque'];

const fetchGlobal = vi.fn(() => {
  throw new Error('global fetch must never be reached by these tests');
});
beforeEach(() => {
  vi.stubGlobal('fetch', fetchGlobal);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchGlobal.mockClear();
});

function input(
  client: LojaIntegradaClient | null,
  over: Partial<StockPushInput> = {},
): StockPushInput {
  return {
    integracao: {
      id: 'conta-li-1',
      nome: 'Loja LI',
      tipo: INTEGRACAO_TIPO.lojaIntegrada,
      ativo: true,
    },
    produtoIds: ['pai-1'],
    nomePorProdutoId: new Map([['pai-1', 'Camiseta']]),
    reenviarComErro: false,
    deps: { mercadoLivre: null, shopee: null, lojaIntegrada: client },
    ...over,
  };
}

const comEnvio = (enviarEstoque: EnviarEstoque) => lojaIntegradaClientFalso({ enviarEstoque });

const resposta = (over: Partial<RespostaEnvioEstoqueLi> = {}): RespostaEnvioEstoqueLi => ({
  contaId: 'conta-li-1',
  modo: MODO_ESTOQUE_LI.dryRun,
  solicitados: 1,
  listings: [],
  produtosSemEnvio: [],
  ...over,
});

const listing = (over: Partial<LinhaEnvioEstoqueLi> = {}): LinhaEnvioEstoqueLi => ({
  produtoId: 'filho-1',
  solicitadoId: 'pai-1',
  produtoNome: 'Camiseta Azul P',
  idLi: '182904918',
  resultado: RESULTADO_ENVIO_ESTOQUE_LI.enfileirado,
  motivo: null,
  mensagem:
    'Na fila: em alguns minutos a fila de estoque relê o ERP e a loja e decide se envia. Este backend está com o estoque em modo de teste.',
  ...over,
});

describe('lojaIntegradaStockProvider — the answer', () => {
  it('⭐ a queued child stays ENFILEIRADO — never enviado — and is the CHILD, with its store id', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(
      resposta({
        listings: [listing(), listing({ produtoId: 'filho-2', idLi: '182904919' })],
      }),
    );
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque)));

    expect(res.pausadoAte).toBeNull();
    expect(res.rows.map((r) => [r.produtoId, r.anuncioId, r.outcome, r.key])).toEqual([
      ['filho-1', '182904918', 'enfileirado', 'filho-1:conta-li-1:182904918'],
      ['filho-2', '182904919', 'enfileirado', 'filho-2:conta-li-1:182904919'],
    ]);
    expect(res.rows.every((r) => r.outcome !== 'enviado')).toBe(true);
    // The backend's sentence passes through verbatim; no quantity was sent.
    expect(res.rows[0]).toMatchObject({
      integracaoId: 'conta-li-1',
      integracaoNome: 'Loja LI',
      mensagem:
        'Na fila: em alguns minutos a fila de estoque relê o ERP e a loja e decide se envia. Este backend está com o estoque em modo de teste.',
      quantidade: null,
      linkDocId: null,
    });
    expect(fetchGlobal).not.toHaveBeenCalled();
  });

  it('forwards exactly the conta, the distinct selection and the signal — never reenviarComErro', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(resposta());
    const controle = new AbortController();
    await lojaIntegradaStockProvider.enviarEstoque(
      input(comEnvio(enviarEstoque), {
        produtoIds: ['p1', 'p2', 'p1'],
        reenviarComErro: true,
        signal: controle.signal,
      }),
    );
    expect(enviarEstoque).toHaveBeenCalledTimes(1);
    expect(enviarEstoque.mock.calls[0]).toStrictEqual([
      { contaId: 'conta-li-1', produtoIds: ['p1', 'p2'] },
      { sinal: controle.signal },
    ]);
  });

  it('a skipped child and a selected id with no child row are both PULADO rows', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(
      resposta({
        solicitados: 2,
        listings: [
          listing({
            resultado: RESULTADO_ENVIO_ESTOQUE_LI.pulado,
            motivo: 'paridade',
            mensagem: 'Envio de estoque desligado para este anúncio.',
          }),
        ],
        produtosSemEnvio: [
          {
            produtoId: 'p2',
            produtoNome: null,
            motivo: 'sem-vinculo',
            mensagem: 'O produto não tem anúncio nesta conta.',
          },
        ],
      }),
    );
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(comEnvio(enviarEstoque), {
        produtoIds: ['pai-1', 'p2'],
        nomePorProdutoId: new Map([
          ['pai-1', 'Camiseta'],
          ['p2', 'Boné'],
        ]),
      }),
    );
    expect(res.rows.map((r) => [r.produtoId, r.produtoNome, r.outcome, r.motivo])).toEqual([
      ['filho-1', 'Camiseta Azul P', 'pulado', 'paridade'],
      // The backend sent no name: the selection's own label fills in.
      ['p2', 'Boné', 'pulado', 'sem-vinculo'],
    ]);
  });

  it('a falha row from the backend stays falha (the queue did not confirm)', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(
      resposta({
        listings: [
          listing({
            resultado: RESULTADO_ENVIO_ESTOQUE_LI.falha,
            motivo: 'fila-indisponivel',
            mensagem: 'Não confirmado pela fila; repetir no mesmo minuto não duplica.',
          }),
        ],
      }),
    );
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque)));
    expect(res.rows.map((r) => [r.outcome, r.motivo])).toEqual([['falha', 'fila-indisponivel']]);
  });

  it('names a child row by the SELECTED id when the backend read no name — near miss: its own name wins', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(
      resposta({
        listings: [
          listing({ produtoId: 'filho-1', produtoNome: null }),
          listing({ produtoId: 'filho-2', produtoNome: 'Camiseta Azul M', idLi: '182904919' }),
        ],
      }),
    );
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque)));
    expect(res.rows.map((r) => [r.produtoId, r.produtoNome])).toEqual([
      ['filho-1', 'Camiseta'],
      ['filho-2', 'Camiseta Azul M'],
    ]);
  });

  it('keys every row through makeRowKeyer — a repeated (produto, store id) never collides', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(
      resposta({
        listings: [
          listing({
            idLi: null,
            resultado: RESULTADO_ENVIO_ESTOQUE_LI.pulado,
            motivo: 'vinculo-ambiguo',
          }),
          listing({
            idLi: null,
            resultado: RESULTADO_ENVIO_ESTOQUE_LI.pulado,
            motivo: 'vinculo-ambiguo',
          }),
        ],
      }),
    );
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque)));
    expect(res.rows.map((r) => r.key)).toEqual(['filho-1:conta-li-1:-', 'filho-1:conta-li-1:-#1']);
  });
});

describe('lojaIntegradaStockProvider — the selection is sliced to the body cap', () => {
  const ids201 = () =>
    Array.from({ length: MAX_PRODUTOS_ENVIO_ESTOQUE_LI + 1 }, (_, i) => `p${String(i)}`);

  it(`a selection of ${String(MAX_PRODUTOS_ENVIO_ESTOQUE_LI + 1)} distinct ids whose first slice queues nothing is TWO requests, in order, and no ZodError`, async () => {
    expect(FATIA_ENVIO_ESTOQUE_LI).toBe(MAX_PRODUTOS_ENVIO_ESTOQUE_LI);
    const ids = ids201();
    // Only skips: nothing was queued, so the next slice may go.
    const enviarEstoque = vi.fn<EnviarEstoque>(async (corpo) =>
      resposta({
        solicitados: corpo.produtoIds.length,
        listings: corpo.produtoIds.map((id) =>
          listing({
            produtoId: id,
            solicitadoId: id,
            idLi: null,
            resultado: RESULTADO_ENVIO_ESTOQUE_LI.pulado,
            motivo: 'paridade',
          }),
        ),
      }),
    );
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(comEnvio(enviarEstoque), { produtoIds: ids }),
    );
    expect(enviarEstoque.mock.calls.map(([c]) => c.produtoIds.length)).toEqual([
      MAX_PRODUTOS_ENVIO_ESTOQUE_LI,
      1,
    ]);
    expect(enviarEstoque.mock.calls.flatMap(([c]) => c.produtoIds)).toEqual(ids);
    expect(res.rows).toHaveLength(ids.length);
  });

  it.each([
    ['a row enfileirado', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado],
    ['a falha row (it may have landed)', RESULTADO_ENVIO_ESTOQUE_LI.falha],
  ])(
    '⭐ once a slice answered %s, NO other slice of the run is sent: every later id is nao-tentado (the bound is per request)',
    async (_caso, resultado) => {
      const ids = ids201();
      const enviarEstoque = vi
        .fn<EnviarEstoque>()
        .mockResolvedValue(
          resposta({ listings: [listing({ produtoId: 'p0', solicitadoId: 'p0', resultado })] }),
        );
      const res = await lojaIntegradaStockProvider.enviarEstoque(
        input(comEnvio(enviarEstoque), { produtoIds: ids }),
      );
      expect(enviarEstoque).toHaveBeenCalledTimes(1);
      expect(res.rows.at(-1)).toMatchObject({
        produtoId: `p${String(MAX_PRODUTOS_ENVIO_ESTOQUE_LI)}`,
        outcome: 'nao-tentado',
        motivo: MOTIVO_UM_LOTE_POR_ENVIO_LI,
        mensagem: MENSAGEM_UM_LOTE_POR_ENVIO_LI,
      });
    },
  );

  it('⭐ a slice whose outcome is UNKNOWN (a 5xx) stops the run too: it may have queued', async () => {
    const ids = ids201();
    const enviarEstoque = vi
      .fn<EnviarEstoque>()
      .mockRejectedValue(
        new LojaIntegradaClientHttpError('O backend falhou (HTTP 500).', 500, null),
      );
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(comEnvio(enviarEstoque), { produtoIds: ids }),
    );
    expect(enviarEstoque).toHaveBeenCalledTimes(1);
    expect(res.rows).toHaveLength(ids.length);
    expect(res.rows.slice(0, -1).every((r) => r.outcome === 'falha')).toBe(true);
    expect(res.rows.at(-1)).toMatchObject({
      outcome: 'nao-tentado',
      motivo: MOTIVO_UM_LOTE_POR_ENVIO_LI,
    });
  });

  it('NEAR MISS — through the REAL client, 201 ids reach the strict route as two valid bodies', async () => {
    const corpos: unknown[] = [];
    const client = createLojaIntegradaClient({
      baseUrl: 'https://li.backend.invalid',
      getAuthToken: async () => 'id-token-firebase',
      fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        corpos.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(resposta()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    const ids = Array.from(
      { length: MAX_PRODUTOS_ENVIO_ESTOQUE_LI + 1 },
      (_, i) => `p${String(i)}`,
    );
    await expect(
      lojaIntegradaStockProvider.enviarEstoque(input(client, { produtoIds: ids })),
    ).resolves.toBeDefined();
    expect(corpos).toHaveLength(2);
    expect(fetchGlobal).not.toHaveBeenCalled();
  });

  it('NEAR MISS — a slice REFUSED before queuing anything does not stop the next one, and only ITS ids carry the verdict', async () => {
    const ids = Array.from(
      { length: MAX_PRODUTOS_ENVIO_ESTOQUE_LI + 1 },
      (_, i) => `p${String(i)}`,
    );
    const enviarEstoque = vi
      .fn<EnviarEstoque>()
      .mockRejectedValueOnce(
        new LojaIntegradaClientHttpError(
          'Selecione no máximo 30 variações vinculadas desta conta para enviar o estoque.',
          400,
          CODIGO_ERRO_LI.selecaoExcedeLimite,
        ),
      )
      .mockResolvedValueOnce(
        resposta({ listings: [listing({ produtoId: 'p200', solicitadoId: 'p200' })] }),
      );
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(comEnvio(enviarEstoque), { produtoIds: ids }),
    );
    expect(enviarEstoque).toHaveBeenCalledTimes(2);
    expect(res.rows).toHaveLength(MAX_PRODUTOS_ENVIO_ESTOQUE_LI + 1);
    expect(res.rows.slice(0, -1).every((r) => r.outcome === 'nao-tentado')).toBe(true);
    expect(res.rows.at(-1)).toMatchObject({ produtoId: 'p200', outcome: 'enfileirado' });
  });

  it('a body the shared schema refuses is a falha row per id — the ZodError never escapes', async () => {
    // A conta id outside the backend's grammar: the REAL client parses the body
    // before it asks for a token, and throws ZodError with no request.
    const fetchImpl = vi.fn();
    const client = createLojaIntegradaClient({
      baseUrl: 'https://li.backend.invalid',
      getAuthToken: async () => 'id-token-firebase',
      fetch: fetchImpl,
    });
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(client, {
        integracao: {
          id: 'conta.com.ponto',
          nome: 'Loja LI',
          tipo: INTEGRACAO_TIPO.lojaIntegrada,
          ativo: true,
        },
        produtoIds: ['p1', 'p2'],
      }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.rows.map((r) => [r.produtoId, r.outcome, r.motivo])).toEqual([
      ['p1', 'falha', 'selecao-invalida'],
      ['p2', 'falha', 'selecao-invalida'],
    ]);
  });
});

describe('lojaIntegradaStockProvider — a malformed or old backend answer is a failure, never a cast', () => {
  function clienteQueResponde(status: number, corpo: unknown) {
    return createLojaIntegradaClient({
      baseUrl: 'https://li.backend.invalid',
      getAuthToken: async () => 'id-token-firebase',
      fetch: vi.fn(
        async () =>
          new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    });
  }

  it('⭐ an answer whose row says "enviado" (outside the closed enum) is a falha row saying the outcome is UNKNOWN', async () => {
    const client = clienteQueResponde(200, {
      ...resposta(),
      listings: [{ ...listing(), resultado: 'enviado' }],
    });
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(client, { produtoIds: ['pai-1', 'p2'] }),
    );
    expect(res.rows.map((r) => [r.produtoId, r.outcome, r.motivo])).toEqual([
      ['pai-1', 'falha', 'resposta-invalida'],
      ['p2', 'falha', 'resposta-invalida'],
    ]);
    expect(res.rows[0]!.mensagem.endsWith(SUFIXO_RESULTADO_INCERTO_LI)).toBe(true);
    expect(res.rows.some((r) => r.outcome === 'enviado' || r.outcome === 'enfileirado')).toBe(
      false,
    );
  });

  it('an OLDER backend shape (the other channels’ envelope, no `resultado`) is a falha row too', async () => {
    const client = clienteQueResponde(200, {
      canal: 'loja-integrada',
      integracaoId: 'conta-li-1',
      listings: [{ produtoId: 'pai-1', outcome: 'enviado', mensagem: 'ok' }],
      produtosSemEnvio: [],
      pausadoAte: null,
    });
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(client));
    expect(res.rows.map((r) => [r.outcome, r.motivo])).toEqual([['falha', 'resposta-invalida']]);
  });

  it('NEAR MISS — an unknown MOTIVO a newer backend adds still parses: the row stands', async () => {
    const client = clienteQueResponde(200, {
      ...resposta(),
      listings: [
        {
          ...listing(),
          resultado: RESULTADO_ENVIO_ESTOQUE_LI.pulado,
          motivo: 'motivo-de-um-passo-futuro',
        },
      ],
      campoNovo: true,
    });
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(client));
    expect(res.rows.map((r) => [r.produtoId, r.outcome, r.motivo])).toEqual([
      ['filho-1', 'pulado', 'motivo-de-um-passo-futuro'],
    ]);
  });

  it('⭐ RespostaInvalida is narrowed BEFORE its parent: a plain 4xx HttpError carries no "unknown outcome" suffix', async () => {
    const invalida = vi
      .fn<EnviarEstoque>()
      .mockRejectedValue(new LojaIntegradaClientRespostaInvalidaError('formato', 200, ['x']));
    const http4xx = vi
      .fn<EnviarEstoque>()
      .mockRejectedValue(
        new LojaIntegradaClientHttpError(
          'A conta da Loja Integrada não tem depósito configurado. Nada foi enfileirado.',
          409,
          CODIGO_ERRO_LI.contaSemDeposito,
        ),
      );
    const a = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(invalida)));
    const b = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(http4xx)));
    expect(a.rows[0]).toMatchObject({ outcome: 'falha', motivo: 'resposta-invalida' });
    expect(a.rows[0]!.mensagem).toBe(`formato${SUFIXO_RESULTADO_INCERTO_LI}`);
    expect(b.rows[0]).toMatchObject({
      outcome: 'falha',
      motivo: CODIGO_ERRO_LI.contaSemDeposito,
      mensagem: 'A conta da Loja Integrada não tem depósito configurado. Nada foi enfileirado.',
    });
  });
});

describe('lojaIntegradaStockProvider — conta-level answers', () => {
  it.each([
    [CODIGO_ERRO_LI.chamadasDesligadas, 503],
    [CODIGO_ERRO_LI.estoqueDesligado, 503],
    [CODIGO_ERRO_LI.tarefasDesligadas, 503],
    [CODIGO_ERRO_LI.selecaoExcedeLimite, 400],
  ])(
    '%s is one NAO-TENTADO row per requested id, with the backend sentence',
    async (code, status) => {
      const enviarEstoque = vi
        .fn<EnviarEstoque>()
        .mockRejectedValue(new LojaIntegradaClientHttpError('Frase do backend.', status, code));
      const res = await lojaIntegradaStockProvider.enviarEstoque(
        input(comEnvio(enviarEstoque), { produtoIds: ['p1', 'p2'] }),
      );
      expect(res.rows.map((r) => [r.produtoId, r.outcome, r.motivo, r.mensagem])).toEqual([
        ['p1', 'nao-tentado', code, 'Frase do backend.'],
        ['p2', 'nao-tentado', code, 'Frase do backend.'],
      ]);
    },
  );

  it('NEAR MISS — a 500 with no envelope is a FALHA that may have queued, never nao-tentado', async () => {
    const enviarEstoque = vi
      .fn<EnviarEstoque>()
      .mockRejectedValue(
        new LojaIntegradaClientHttpError('O backend falhou (HTTP 500).', 500, null),
      );
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque)));
    expect(res.rows[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'erro-http',
      mensagem: `O backend falhou (HTTP 500).${SUFIXO_RESULTADO_INCERTO_LI}`,
    });
  });

  it('the deadline is a falha "tempo-esgotado" that may have queued — narrowed before the network error', async () => {
    const enviarEstoque = vi
      .fn<EnviarEstoque>()
      .mockRejectedValue(new LojaIntegradaClientTempoEsgotadoError());
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque)));
    expect(res.rows[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'tempo-esgotado',
      mensagem: `O backend da Loja Integrada não respondeu a tempo.${SUFIXO_RESULTADO_INCERTO_LI}`,
    });
  });

  it('a network failure with nobody cancelling is a falha "rede" row', async () => {
    const enviarEstoque = vi
      .fn<EnviarEstoque>()
      .mockRejectedValue(new LojaIntegradaClientNetworkError(new TypeError('Failed to fetch')));
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque)));
    expect(res.rows.map((r) => [r.outcome, r.motivo])).toEqual([['falha', 'rede']]);
  });

  it('a cancel mid-flight is NO rows — the run reports it', async () => {
    const controle = new AbortController();
    const enviarEstoque = vi.fn<EnviarEstoque>().mockImplementation(() => {
      controle.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(comEnvio(enviarEstoque), { signal: controle.signal }),
    );
    expect(res).toEqual({ rows: [], pausadoAte: null });
  });

  it('a cancel between slices keeps the slice already answered and sends no more', async () => {
    const controle = new AbortController();
    const ids = Array.from(
      { length: MAX_PRODUTOS_ENVIO_ESTOQUE_LI + 1 },
      (_, i) => `p${String(i)}`,
    );
    const enviarEstoque = vi.fn<EnviarEstoque>().mockImplementation(async () => {
      controle.abort();
      return resposta({ listings: [listing({ produtoId: 'p0', solicitadoId: 'p0' })] });
    });
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(comEnvio(enviarEstoque), { produtoIds: ids, signal: controle.signal }),
    );
    expect(enviarEstoque).toHaveBeenCalledTimes(1);
    expect(res.rows.map((r) => [r.produtoId, r.outcome])).toEqual([['p0', 'enfileirado']]);
  });

  it('NEAR MISS — a bare AbortError while nobody cancelled is rethrown, not swallowed', async () => {
    const enviarEstoque = vi
      .fn<EnviarEstoque>()
      .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    await expect(
      lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque))),
    ).rejects.toBeInstanceOf(DOMException);
  });

  it('rethrows an unknown error instead of swallowing it (repo rule 6)', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockRejectedValue(new TypeError('boom'));
    await expect(
      lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque))),
    ).rejects.toThrow(TypeError);
  });

  it('a ZodError is the one schema class it narrows — never a generic catch of its parent', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockRejectedValue(new ZodError([]));
    const res = await lojaIntegradaStockProvider.enviarEstoque(input(comEnvio(enviarEstoque)));
    expect(res.rows.map((r) => r.motivo)).toEqual(['selecao-invalida']);
  });

  it('no client (logged out, or the backend unusable from this page) is one falha row per id, zero calls', async () => {
    const res = await lojaIntegradaStockProvider.enviarEstoque(
      input(null, { produtoIds: ['p1', 'p2', 'p1'] }),
    );
    expect(res.rows.map((r) => [r.produtoId, r.outcome, r.motivo, r.mensagem])).toEqual([
      ['p1', 'falha', 'sem-cliente', MENSAGEM_SEM_CLIENTE_LI],
      ['p2', 'falha', 'sem-cliente', MENSAGEM_SEM_CLIENTE_LI],
    ]);
    expect(fetchGlobal).not.toHaveBeenCalled();
  });
});
