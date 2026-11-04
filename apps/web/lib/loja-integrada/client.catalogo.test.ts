import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODIGO_ERRO_LI, type RespostaGradeLi, type RespostaGradesLi } from '@delfrance/schemas';

/**
 * The two catalogue reads of the browser client (master plan step 10): the
 * store's grade list and one grade's options, for the variation linker.
 *
 * Pinned, each with its near miss:
 *  - the WIRE: GET on the conta's `grades` route, the percent-encoded ids, and
 *    `?atualizar=1` exactly when the operator asked for a fresh read;
 *  - every answer is READ against the shared contract (`catalogoLojaIntegrada.ts`
 *    in `@delfrance/schemas`): nothing is cast, and a key a newer backend adds
 *    is stripped, never refused;
 *  - a 404 WITHOUT the envelope (a backend older than these routes) stays an
 *    HTTP error with no code, which the linker reads as "not offered yet";
 *  - each read is bounded by its own deadline, and the caller's abort comes
 *    back as the abort itself.
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
  PRAZO_CATALOGO_LI_MS,
  PRAZO_GRADE_LI_MS,
  createLojaIntegradaClient,
} = await import('./client');

const BASE = 'https://li.backend.invalid';
const CONTA = `${BASE}/api/marketplace/loja-integrada/conta`;

interface Chamada {
  readonly url: string;
  readonly init: RequestInit;
}

function cliente(responder: (c: Chamada) => Promise<Response> | Response) {
  const chamadas: Chamada[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const chamada = { url: String(input), init: init ?? {} };
    chamadas.push(chamada);
    return responder(chamada);
  });
  const c = createLojaIntegradaClient({
    baseUrl: `${BASE}/`,
    getAuthToken: async () => 'id-token-firebase',
    fetch: fetchImpl,
  });
  return { c, chamadas };
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const GRADES: RespostaGradesLi = {
  grades: [
    { id: 8946, nome: 'Tamanho', nomeVisivel: 'Tamanho' },
    { id: 8950, nome: 'Cor', nomeVisivel: null },
  ],
  lidaEmMs: 1_790_000_000_000,
};

const GRADE: RespostaGradeLi = {
  grade: { id: 8946, nome: 'Tamanho', nomeVisivel: 'Tamanho' },
  opcoes: [
    { id: 37097, nome: 'P' },
    { id: 37098, nome: 'M' },
  ],
  lidaEmMs: 1_790_000_000_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the wire of the catalogue reads', () => {
  it('grades → GET …/conta/<id>/grades, the ID token as Bearer, no body, no query', async () => {
    const { c, chamadas } = cliente(() => json(200, GRADES));

    await expect(c.grades('conta-1')).resolves.toEqual(GRADES);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe(`${CONTA}/conta-1/grades`);
    expect(chamadas[0]!.init.method).toBe('GET');
    expect(chamadas[0]!.init.body).toBeUndefined();
    expect(chamadas[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer id-token-firebase',
      Accept: 'application/json',
    });
  });

  it('"Atualizar" asks for a fresh read with EXACTLY ?atualizar=1', async () => {
    const { c, chamadas } = cliente(() => json(200, GRADES));

    await c.grades('conta-1', { atualizar: true });
    // NEAR-MISS: `atualizar: false` is a plain read, never `?atualizar=0`.
    await c.grades('conta-1', { atualizar: false });

    expect(chamadas[0]!.url).toBe(`${CONTA}/conta-1/grades?atualizar=1`);
    expect(chamadas[1]!.url).toBe(`${CONTA}/conta-1/grades`);
  });

  it('grade → GET …/conta/<id>/grades/<gradeId>, both ids percent-encoded', async () => {
    const { c, chamadas } = cliente(() => json(200, GRADE));

    await expect(c.grade('a/b c', 8946)).resolves.toEqual(GRADE);
    await c.grade('conta-1', 8946, { atualizar: true });

    expect(chamadas[0]!.url).toBe(`${CONTA}/a%2Fb%20c/grades/8946`);
    expect(chamadas[1]!.url).toBe(`${CONTA}/conta-1/grades/8946?atualizar=1`);
  });
});

describe('every 2xx is read against the shared contract', () => {
  it('a list missing `lidaEmMs` is RESPOSTA_INVALIDA, naming the field', async () => {
    const { c } = cliente(() => json(200, { grades: GRADES.grades }));

    const err = await c.grades('conta-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect((err as InstanceType<typeof LojaIntegradaClientHttpError>).campos).toEqual(['lidaEmMs']);
  });

  it('an option whose id is not a positive integer is RESPOSTA_INVALIDA — never a link target', async () => {
    const { c } = cliente(() => json(200, { ...GRADE, opcoes: [{ id: 0, nome: 'P' }] }));

    await expect(c.grade('conta-1', 8946)).rejects.toBeInstanceOf(
      LojaIntegradaClientRespostaInvalidaError,
    );
  });

  it('the near miss: a key a newer backend adds is stripped, never refused', async () => {
    const { c } = cliente(() =>
      json(200, { ...GRADES, paginas: 2, grades: [{ ...GRADES.grades[0], extra: true }] }),
    );

    await expect(c.grades('conta-1')).resolves.toEqual({
      grades: [GRADES.grades[0]],
      lidaEmMs: GRADES.lidaEmMs,
    });
  });
});

describe('a refusal keeps its code', () => {
  it('the switch off (503 LI_CHAMADAS_DESLIGADAS) reaches the caller as that code', async () => {
    const { c } = cliente(() =>
      json(503, {
        error: 'Chamadas à Loja Integrada desligadas.',
        code: CODIGO_ERRO_LI.chamadasDesligadas,
      }),
    );

    const err = (await c.grades('conta-1').catch((e: unknown) => e)) as InstanceType<
      typeof LojaIntegradaClientHttpError
    >;

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect(err.status).toBe(503);
    expect(err.code).toBe(CODIGO_ERRO_LI.chamadasDesligadas);
  });

  it('⭐ a 404 WITHOUT an envelope (a backend older than these routes) has NO code', async () => {
    const { c } = cliente(
      () =>
        new Response('<!DOCTYPE html><html>404</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const err = (await c.grades('conta-1').catch((e: unknown) => e)) as InstanceType<
      typeof LojaIntegradaClientHttpError
    >;

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect(err).not.toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect(err.status).toBe(404);
    expect(err.code).toBeNull();
  });

  it('the near miss: a grade the store no longer has (409 LI_GRADE_AUSENTE_NA_LOJA) keeps its code', async () => {
    const { c } = cliente(() =>
      json(409, { error: 'Grade ausente.', code: CODIGO_ERRO_LI.gradeAusenteNaLoja }),
    );

    const err = (await c.grade('conta-1', 8946).catch((e: unknown) => e)) as InstanceType<
      typeof LojaIntegradaClientHttpError
    >;

    expect(err.code).toBe(CODIGO_ERRO_LI.gradeAusenteNaLoja);
  });
});

/**
 * A fetch that never answers on its own: it rejects with the signal's abort the
 * moment its signal aborts. Without a signal it would hang forever — so a call
 * that sent none fails the test by timing out, never by passing.
 */
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

function clienteCom(fetchImpl: typeof globalThis.fetch) {
  return createLojaIntegradaClient({
    baseUrl: BASE,
    getAuthToken: async () => 'id-token-firebase',
    fetch: fetchImpl,
  });
}

describe('the deadlines and the caller signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grades gives up at PRAZO_CATALOGO_LI_MS (260 s: the route’s worst case plus slack)', async () => {
    expect(PRAZO_CATALOGO_LI_MS).toBe(260_000);
    const chamadas: Chamada[] = [];
    const c = clienteCom(fetchQueSoAborta(chamadas));

    const resultado = c.grades('conta-1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PRAZO_CATALOGO_LI_MS - 1);
    expect(chamadas[0]!.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await resultado;
    expect(chamadas[0]!.init.signal?.aborted).toBe(true);
    expect(err).toBeInstanceOf(LojaIntegradaClientTempoEsgotadoError);
    expect(err).toBeInstanceOf(LojaIntegradaClientNetworkError);
  });

  it('grade gives up at its own, shorter PRAZO_GRADE_LI_MS (one paced call)', async () => {
    expect(PRAZO_GRADE_LI_MS).toBe(60_000);
    expect(PRAZO_GRADE_LI_MS).toBeLessThan(PRAZO_CATALOGO_LI_MS);
    const chamadas: Chamada[] = [];
    const c = clienteCom(fetchQueSoAborta(chamadas));

    const resultado = c.grade('conta-1', 8946).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PRAZO_GRADE_LI_MS - 1);
    expect(chamadas[0]!.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultado).resolves.toBeInstanceOf(LojaIntegradaClientTempoEsgotadoError);
  });

  it("the CALLER's abort (a query cancelled) comes back as the abort itself, never relabelled", async () => {
    const chamadas: Chamada[] = [];
    const c = clienteCom(fetchQueSoAborta(chamadas));
    const controle = new AbortController();

    const resultado = c.grades('conta-1', { sinal: controle.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    controle.abort();

    const err = await resultado;
    expect(chamadas[0]!.init.signal?.aborted).toBe(true);
    expect(err).toBeInstanceOf(DOMException);
    expect(err).not.toBeInstanceOf(LojaIntegradaClientNetworkError);
  });

  it('an answer in time clears the deadline — no timer outlives the call', async () => {
    const { c } = cliente((ch) => json(200, ch.url.includes('/grades/') ? GRADE : GRADES));

    await c.grades('conta-1');
    await c.grade('conta-1', 8946);

    expect(vi.getTimerCount()).toBe(0);
  });
});
