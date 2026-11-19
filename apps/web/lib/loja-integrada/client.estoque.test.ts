import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  CODIGO_ERRO_LI,
  MAX_PRODUTOS_ENVIO_ESTOQUE_LI,
  MODO_ESTOQUE_LI,
  RESULTADO_ENVIO_ESTOQUE_LI,
  type RespostaEnvioEstoqueLi,
} from '@delfrance/schemas';

/**
 * The manual stock push call of the browser client (master plan step 12).
 *
 * Pinned, each with its near miss:
 *  - the WIRE: `POST …/enviar-estoque`, the ID token as Bearer, the body rebuilt
 *    BY NAME (`{ contaId, produtoIds }` and nothing else — no
 *    `reenviarComErro`) and parsed through the shared strict schema before the
 *    token is asked for;
 *  - the answer is READ against the shared contract: a row outside the closed
 *    `resultado` enum (`enviado` included) is RESPOSTA_INVALIDA, an unknown
 *    motivo or key is not;
 *  - a 404 WITHOUT the envelope (a backend older than the route) has no code;
 *    the refusals carry theirs;
 *  - the call gives up at its deadline, and the caller's abort comes back as
 *    the abort itself.
 *
 * ⚠️ No request leaves this file: every client gets an injected fetch, and the
 * base URL is an `.invalid` host.
 */

vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: null }) }));

const {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
  PRAZO_ENVIO_ESTOQUE_LI_MS,
  corpoEnvioEstoqueLi,
  createLojaIntegradaClient,
} = await import('./client');

type HttpError = InstanceType<typeof LojaIntegradaClientHttpError>;

const BASE = 'https://li.backend.invalid';
const ROTA = `${BASE}/api/marketplace/loja-integrada/enviar-estoque`;

interface Chamada {
  readonly url: string;
  readonly init: RequestInit;
}

function cliente(responder: (c: Chamada) => Promise<Response> | Response) {
  const chamadas: Chamada[] = [];
  const getAuthToken = vi.fn(async () => 'id-token-firebase');
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const chamada = { url: String(input), init: init ?? {} };
    chamadas.push(chamada);
    return responder(chamada);
  });
  const c = createLojaIntegradaClient({ baseUrl: `${BASE}/`, getAuthToken, fetch: fetchImpl });
  return { c, chamadas, getAuthToken };
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const RESPOSTA: RespostaEnvioEstoqueLi = {
  contaId: 'conta-1',
  modo: MODO_ESTOQUE_LI.dryRun,
  solicitados: 1,
  listings: [
    {
      produtoId: 'filho-1',
      solicitadoId: 'pai-1',
      produtoNome: 'Produto de teste',
      idLi: '182904918',
      resultado: RESULTADO_ENVIO_ESTOQUE_LI.enfileirado,
      motivo: null,
      mensagem: 'Na fila em modo de teste: o envio é só simulado, nada é gravado na loja.',
    },
  ],
  produtosSemEnvio: [],
};

describe('enviarEstoque — the wire', () => {
  it('POST …/enviar-estoque with EXACTLY {contaId, produtoIds}, the ID token as Bearer', async () => {
    const { c, chamadas } = cliente(() => json(200, RESPOSTA));

    const res = await c.enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] });

    expect(res).toEqual(RESPOSTA);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe(ROTA);
    expect(chamadas[0]!.init.method).toBe('POST');
    const headers = chamadas[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer id-token-firebase');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(chamadas[0]!.init.body))).toStrictEqual({
      contaId: 'conta-1',
      produtoIds: ['pai-1'],
    });
  });

  it('the body is rebuilt BY NAME: a key the caller object carries never reaches the strict route', async () => {
    const { c, chamadas } = cliente(() => json(200, RESPOSTA));
    const comExtra = {
      contaId: 'conta-1',
      produtoIds: ['pai-1'],
      reenviarComErro: true,
    } as unknown as Parameters<typeof c.enviarEstoque>[0];

    await c.enviarEstoque(comExtra);

    expect(Object.keys(JSON.parse(String(chamadas[0]!.init.body)) as object).sort()).toEqual([
      'contaId',
      'produtoIds',
    ]);
  });

  it.each([
    ['no id', { contaId: 'conta-1', produtoIds: [] }],
    [
      `${String(MAX_PRODUTOS_ENVIO_ESTOQUE_LI + 1)} ids`,
      {
        contaId: 'conta-1',
        produtoIds: Array.from(
          { length: MAX_PRODUTOS_ENVIO_ESTOQUE_LI + 1 },
          (_, i) => `p${String(i)}`,
        ),
      },
    ],
    ['an id with a slash', { contaId: 'conta-1', produtoIds: ['a/b'] }],
    ['a dotted conta id', { contaId: 'conta.1', produtoIds: ['p1'] }],
  ])('%s throws ZodError with NO request and no token asked for', async (_nome, corpo) => {
    const { c, chamadas, getAuthToken } = cliente(() => json(200, RESPOSTA));

    await expect(c.enviarEstoque(corpo)).rejects.toBeInstanceOf(ZodError);

    expect(chamadas).toHaveLength(0);
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  it(`NEAR MISS — exactly ${String(MAX_PRODUTOS_ENVIO_ESTOQUE_LI)} ids is a valid body`, () => {
    const produtoIds = Array.from(
      { length: MAX_PRODUTOS_ENVIO_ESTOQUE_LI },
      (_, i) => `p${String(i)}`,
    );
    expect(corpoEnvioEstoqueLi({ contaId: 'conta-1', produtoIds }).produtoIds).toHaveLength(
      MAX_PRODUTOS_ENVIO_ESTOQUE_LI,
    );
  });
});

describe('enviarEstoque — every 2xx is read against the shared contract', () => {
  it('⭐ a row that says "enviado" is RESPOSTA_INVALIDA, never a cast', async () => {
    const { c } = cliente(() =>
      json(200, { ...RESPOSTA, listings: [{ ...RESPOSTA.listings[0], resultado: 'enviado' }] }),
    );

    const err = await c
      .enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect((err as HttpError).campos).toEqual(['listings[].resultado']);
  });

  it('an answer missing the valve it read (`modo`) is RESPOSTA_INVALIDA', async () => {
    const { modo: _modo, ...semModo } = RESPOSTA;
    const { c } = cliente(() => json(200, semModo));

    await expect(
      c.enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] }),
    ).rejects.toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
  });

  it('NEAR MISS — an unknown motivo and a new key a newer backend adds still PARSE', async () => {
    const { c } = cliente(() =>
      json(200, {
        ...RESPOSTA,
        campoNovo: 1,
        listings: [
          {
            ...RESPOSTA.listings[0],
            resultado: RESULTADO_ENVIO_ESTOQUE_LI.pulado,
            motivo: 'motivo-futuro',
          },
        ],
      }),
    );

    const res = await c.enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] });

    expect(res.listings[0]).toMatchObject({
      resultado: RESULTADO_ENVIO_ESTOQUE_LI.pulado,
      motivo: 'motivo-futuro',
    });
    expect(res).not.toHaveProperty('campoNovo');
  });
});

describe('enviarEstoque — the refusals', () => {
  it('a 404 WITHOUT the envelope (a backend older than the route) is an HTTP error with NO code', async () => {
    const { c } = cliente(() => new Response('', { status: 404 }));

    const err = await c
      .enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect(err).not.toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).code).toBeNull();
  });

  it.each([
    [503, CODIGO_ERRO_LI.estoqueDesligado],
    [503, CODIGO_ERRO_LI.chamadasDesligadas],
    [503, CODIGO_ERRO_LI.tarefasDesligadas],
    [409, CODIGO_ERRO_LI.contaSemDeposito],
  ])('a %i %s reaches the caller as that code', async (status, code) => {
    const { c } = cliente(() =>
      json(status, { error: 'Frase do backend. Nada foi enfileirado.', code }),
    );

    const err = await c
      .enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect((err as HttpError).code).toBe(code);
    expect((err as HttpError).message).toBe('Frase do backend. Nada foi enfileirado.');
  });

  it('the bound refusal (400 LI_SELECAO_EXCEDE_LIMITE) parses with its limite and solicitados', async () => {
    const { c } = cliente(() =>
      json(400, {
        error: 'Selecione no máximo 30 variações vinculadas desta conta.',
        code: CODIGO_ERRO_LI.selecaoExcedeLimite,
        limite: 30,
        solicitados: 31,
      }),
    );

    const err = await c
      .enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] })
      .catch((e: unknown) => e);

    expect((err as HttpError).code).toBe(CODIGO_ERRO_LI.selecaoExcedeLimite);
    expect((err as HttpError).status).toBe(400);
  });
});

function fetchQueSoAborta(chamadas: Chamada[]) {
  return vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        chamadas.push({ url: String(input), init: init ?? {} });
        const sinal = init?.signal;
        if (!sinal) return;
        if (sinal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        sinal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
  );
}

describe('enviarEstoque — the deadline and the caller signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function clienteQueSoAborta() {
    const chamadas: Chamada[] = [];
    const c = createLojaIntegradaClient({
      baseUrl: BASE,
      getAuthToken: async () => 'id-token-firebase',
      fetch: fetchQueSoAborta(chamadas),
    });
    return { c, chamadas };
  }

  it('gives up at PRAZO_ENVIO_ESTOQUE_LI_MS (60 s: no Loja Integrada call) — a TempoEsgotado, which IS a network error', async () => {
    expect(PRAZO_ENVIO_ESTOQUE_LI_MS).toBe(60_000);
    const { c, chamadas } = clienteQueSoAborta();

    const resultado = c
      .enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PRAZO_ENVIO_ESTOQUE_LI_MS - 1);
    expect(chamadas[0]!.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await resultado;
    expect(chamadas[0]!.init.signal?.aborted).toBe(true);
    expect(err).toBeInstanceOf(LojaIntegradaClientTempoEsgotadoError);
    expect(err).toBeInstanceOf(LojaIntegradaClientNetworkError);
  });

  it("the CALLER's abort (Cancelar) stops the fetch and comes back as the abort itself", async () => {
    const { c, chamadas } = clienteQueSoAborta();
    const controle = new AbortController();

    const resultado = c
      .enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] }, { sinal: controle.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    controle.abort();

    const err = await resultado;
    expect(chamadas[0]!.init.signal?.aborted).toBe(true);
    expect(err).toBeInstanceOf(DOMException);
    expect(err).not.toBeInstanceOf(LojaIntegradaClientNetworkError);
  });

  it('an answer in time clears the deadline — no timer outlives the call', async () => {
    const { c } = cliente(() => json(200, RESPOSTA));

    await c.enviarEstoque({ contaId: 'conta-1', produtoIds: ['pai-1'] });

    expect(vi.getTimerCount()).toBe(0);
  });
});
