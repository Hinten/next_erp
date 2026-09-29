import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FirebaseError } from 'firebase/app';

import {
  CODIGO_ERRO_LINK,
  ESTADO_PEDIDO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  STATUS_LINK_PAGAMENTO,
  TIPO_PAGAMENTO_MP,
  criarLinksPagamentoBodySchema,
  type CriarLinksPagamentoBody,
  type CriarLinksPagamentoResposta,
} from '@delfrance/schemas';

import {
  MercadoPagoClientHttpError,
  MercadoPagoClientNetworkError,
  MercadoPagoClientRespostaInvalidaError,
  createMercadoPagoClient,
} from './client';

/**
 * This client had NO tests at all, which is part of why it kept two defects the
 * Mercado Livre sibling had already fixed:
 *
 *  1. `return parsed as T` — a 2xx of any shape was reported as a success.
 *  2. `parsed = { error: text }` on a non-JSON body, so a proxy's whole HTML
 *     document became `err.message` verbatim (fixed for ML in 3a4b7278).
 *
 * ⚠️ Defect 1 is worse here than it looks. `conta` is the ONLY method that
 * reads anything, and `connected` is the field the panel switches on — so a
 * body of the wrong shape gave `undefined`, which is falsy, and the screen told
 * the operator to reconnect an account that was perfectly connected.
 */

function client(fetchImpl: typeof globalThis.fetch) {
  return createMercadoPagoClient({
    baseUrl: 'http://localhost:3007',
    getAuthToken: async () => 'token',
    fetch: fetchImpl,
  });
}

function ok(body: string, contentType = 'application/json'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

const NEXT_404 = '<!DOCTYPE html><html><head><title>404</title></head><body>404</body></html>';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a 2xx whose body is not what we claimed', () => {
  it('⭐ throws instead of reporting a disconnected account for a wrong-shaped body', () => {
    // The whole reason this matters: `{}` cast to `MercadoPagoConta` reads
    // `connected === undefined`, and the panel renders "não conectada" for a
    // live account. The operator then reconnects it, spending an OAuth round
    // trip to fix nothing.
    const c = client(async () => ok('{}'));

    return expect(c.conta('m1')).rejects.toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
  });

  it('names the failing fields', async () => {
    const c = client(async () => ok('{}'));

    const err = (await c
      .conta('m1')
      .catch((e: unknown) => e)) as MercadoPagoClientRespostaInvalidaError;

    expect(err.campos).toEqual(['connected', 'me']);
  });

  it('⭐ throws on an EMPTY body instead of handing back null', async () => {
    const c = client(async () => ok(''));

    await expect(c.conta('m1')).rejects.toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
  });

  it('⭐ throws AND logs when a 2xx carries HTML', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok(NEXT_404, 'text/html'));

    await expect(c.conta('m1')).rejects.toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('is caught by callers narrowing to MercadoPagoClientHttpError', async () => {
    // ⚠️ Why it is a subclass. `ContaMercadoPagoPanel` narrows to this class and
    // rethrows anything else, into a `void`-ed click handler.
    const c = client(async () => ok('{}'));

    const err = await c.conta('m1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoPagoClientHttpError);
    expect((err as MercadoPagoClientHttpError).code).toBe('RESPOSTA_INVALIDA');
  });

  it('still passes a well-formed body through', async () => {
    // The control. Without it every assertion above is satisfied by a client
    // that simply never works.
    const c = client(async () => ok(JSON.stringify({ connected: true, me: null })));

    await expect(c.conta('m1')).resolves.toEqual({ connected: true, me: null });
  });

  it('accepts a QUOTED collector id — a forwarded MP number', async () => {
    // Same rule as the ML schemas: tolerant where the value originates at the
    // provider, because a quoted id must never cost the whole response (#1087).
    const c = client(async () =>
      ok(JSON.stringify({ connected: true, me: { id: '123456789', nickname: null, email: null } })),
    );

    expect((await c.conta('m1')).me?.id).toBe(123_456_789);
  });
});

describe('non-2xx bodies', () => {
  it('⭐ no longer puts a whole HTML page into err.message', async () => {
    // The defect ML fixed in 3a4b7278 and this client kept: `{ error: text }`
    // made the raw document the message, burying the real cause under markup.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => new Response(NEXT_404, { status: 502 }));

    const err = (await c.conta('m1').catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.message).not.toContain('<!DOCTYPE');
    expect(err.message).toContain('HTTP 502');
    // The body stays reachable for whoever is debugging.
    expect(String(spy.mock.calls[0]?.[1])).toContain('404');
  });

  it('a JSON body that is an ARRAY still produces the status message', async () => {
    // ⚠️ Deliberately NOT labelled "the array guard works": at this level it
    // cannot see that guard. Mutating `envelopeDeErro` to accept arrays leaves
    // this test green, because the per-field `typeof` checks already reduce an
    // array to an empty envelope and the caller falls back either way. The
    // guard's real effect — `null` rather than `{}` — is only observable in
    // `packages/core/src/wire/envelopeDeErro.test.ts`, which is where it is
    // asserted. What this pins is the behaviour the operator sees.
    const c = client(
      async () =>
        new Response('[1,2,3]', { status: 500, headers: { 'content-type': 'application/json' } }),
    );

    const err = (await c.conta('m1').catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.message).toContain('HTTP 500');
  });

  it('still prefers OUR envelope when the backend sent one', async () => {
    const c = client(
      async () =>
        new Response(
          JSON.stringify({ error: 'Conta não conectada.', code: 'MP_REAUTH_REQUIRED' }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const err = (await c.conta('m1').catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.message).toBe('Conta não conectada.');
    expect(err.code).toBe('MP_REAUTH_REQUIRED');
  });

  it('a genuine network failure is still a network error', async () => {
    const c = client(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(c.conta('m1')).rejects.toBeInstanceOf(MercadoPagoClientNetworkError);
  });
});

/* -------------------------------------------------------------------------- */
/*                 POST and the payment-link methods (#367)                    */
/* -------------------------------------------------------------------------- */

const LINK_A = 'a'.repeat(20);
const LINK_B = 'b'.repeat(20);

const BODY_CRIAR: CriarLinksPagamentoBody = {
  pedidoId: 'ped_1',
  metodoId: 'mp1',
  modo: MODO_LINK_PAGAMENTO.individual,
  valorCobradoEsperado: 100,
  expiraEm: '2026-10-02',
  tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto],
  parcelasMaximas: 6,
  quantidadeMaxima: null,
  preencherPagador: false,
  links: [
    { linkId: LINK_A, nomePagador: 'Maria', valor: 60 },
    { linkId: LINK_B, nomePagador: 'João', valor: 40 },
  ],
};

const RESPOSTA_CRIAR = {
  links: [
    {
      linkId: LINK_A,
      preferenceId: 'pref-a',
      link: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-a',
      valorCobrado: 60,
      nomePagador: 'Maria',
      dataExpiracao: 1_790_000_000_000,
      modo: MODO_LINK_PAGAMENTO.individual,
      quantidadeMaxima: null,
    },
  ],
  estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  reaproveitado: false,
} satisfies CriarLinksPagamentoResposta;

type FetchMock = Mock<typeof globalThis.fetch>;

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that answers every call with a FRESH response (a body reads only once). */
function fetchQueResponde(resposta: () => Response): FetchMock {
  return vi.fn<typeof globalThis.fetch>(async () => resposta());
}

function chamadaUnica(fetchMock: FetchMock): { url: unknown; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalledOnce();
  const chamada = fetchMock.mock.calls[0];
  if (!chamada) throw new Error('fetch não foi chamado');
  return { url: chamada[0], init: chamada[1] ?? {} };
}

describe('a POST carries its body — and a GET still does not', () => {
  it('the fixture is a body the real route accepts', () => {
    // The control for everything below: were the fixture something the route
    // answers 400 to, the assertions would describe a request nobody can make.
    expect(criarLinksPagamentoBodySchema.safeParse(BODY_CRIAR).success).toBe(true);
  });

  it('⭐ sends POST, the JSON content type, the bearer token and the EXACT body', async () => {
    const fetchMock = fetchQueResponde(() => json(RESPOSTA_CRIAR, 201));

    await client(fetchMock).criarLinks(BODY_CRIAR);

    const { url, init } = chamadaUnica(fetchMock);
    expect(url).toBe('http://localhost:3007/api/payments/mercado-pago/links/criar');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer token',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    // Byte for byte: the link ids the caller minted must reach the server
    // untouched, or a retried request would stop being a replay.
    expect(init.body).toBe(JSON.stringify(BODY_CRIAR));
  });

  it('⭐ a GET (conta) still sends NO body and NO Content-Type', async () => {
    // The near-miss for making the header unconditional: a GET that announces a
    // JSON payload it does not carry is a malformed request some proxies reject.
    const fetchMock = fetchQueResponde(() => json({ connected: true, me: null }));

    await client(fetchMock).conta('m1');

    const { url, init } = chamadaUnica(fetchMock);
    expect(url).toBe('http://localhost:3007/api/payments/mercado-pago/conta?metodoId=m1');
    expect(init.method).toBe('GET');
    expect(init).not.toHaveProperty('body');
    expect(init.headers).toEqual({ Authorization: 'Bearer token', Accept: 'application/json' });
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('oauthStart is still a bodiless GET', async () => {
    const fetchMock = fetchQueResponde(() => json({ authorizeUrl: 'https://auth.example/x' }));

    await client(fetchMock).oauthStart('m 1');

    const { url, init } = chamadaUnica(fetchMock);
    expect(url).toBe('http://localhost:3007/api/payments/mercado-pago/oauth/start?metodoId=m%201');
    expect(init.method).toBe('GET');
    expect(init).not.toHaveProperty('body');
  });

  it('cancelarLink POSTs { pedidoId, linkId } and reads the stored status back', async () => {
    const fetchMock = fetchQueResponde(() =>
      json({ linkId: LINK_A, status: STATUS_LINK_PAGAMENTO.cancelado }),
    );

    const resposta = await client(fetchMock).cancelarLink({ pedidoId: 'ped_1', linkId: LINK_A });

    const { url, init } = chamadaUnica(fetchMock);
    expect(url).toBe('http://localhost:3007/api/payments/mercado-pago/links/cancelar');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ pedidoId: 'ped_1', linkId: LINK_A }));
    expect(resposta).toEqual({ linkId: LINK_A, status: STATUS_LINK_PAGAMENTO.cancelado });
  });

  it('sincronizarLinks POSTs { pedidoId } and reads the reconciliation back', async () => {
    const sincronizado = {
      encontrados: 3,
      reconciliados: 2,
      ignorados: 1,
      falhas: [{ paymentId: '123', motivo: 'sem metadata' }],
      transicoes: [ESTADO_PEDIDO.pago],
      truncado: false,
    };
    const fetchMock = fetchQueResponde(() => json(sincronizado));

    const resposta = await client(fetchMock).sincronizarLinks({ pedidoId: 'ped_1' });

    const { url, init } = chamadaUnica(fetchMock);
    expect(url).toBe('http://localhost:3007/api/payments/mercado-pago/links/sincronizar');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ pedidoId: 'ped_1' }));
    expect(resposta).toEqual(sincronizado);
  });
});

describe('criarLinks — reading the answer', () => {
  it.each([
    ['201 — the batch was created', 201, false],
    ['200 — an idempotent replay of a batch that already exists', 200, true],
  ])('accepts %s', async (_nome, status, reaproveitado) => {
    const c = client(async () => json({ ...RESPOSTA_CRIAR, reaproveitado }, status));

    await expect(c.criarLinks(BODY_CRIAR)).resolves.toEqual({ ...RESPOSTA_CRIAR, reaproveitado });
  });

  it('accepts a null estado (the pedido was left where it was)', async () => {
    const c = client(async () => json({ ...RESPOSTA_CRIAR, estado: null }, 201));

    await expect(c.criarLinks(BODY_CRIAR)).resolves.toMatchObject({ estado: null });
  });

  it('a NEWER backend that adds a field does not break this tab', async () => {
    // Response schemas are tolerant on purpose: apps/web calls the DEPLOYED
    // backend, which may be ahead of the tab that is open.
    const c = client(async () => json({ ...RESPOSTA_CRIAR, camposDoFuturo: { x: 1 } }, 201));

    const resposta = await c.criarLinks(BODY_CRIAR);

    expect(resposta).toEqual(RESPOSTA_CRIAR);
    expect(resposta).not.toHaveProperty('camposDoFuturo');
  });

  it('⭐ a 2xx with the wrong shape is a RespostaInvalida that names the field', async () => {
    const c = client(async () => json({ links: 'nope', estado: null, reaproveitado: false }, 201));

    const err = (await c
      .criarLinks(BODY_CRIAR)
      .catch((e: unknown) => e)) as MercadoPagoClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
    expect(err.campos).toEqual(['links']);
    expect(err.status).toBe(201);
    expect(err.message).toContain('Campos inválidos: links');
  });

  it('collapses the row index of a nested wrong field', async () => {
    const c = client(async () =>
      json({ ...RESPOSTA_CRIAR, links: [{ ...RESPOSTA_CRIAR.links[0], link: 5 }] }, 201),
    );

    const err = (await c
      .criarLinks(BODY_CRIAR)
      .catch((e: unknown) => e)) as MercadoPagoClientRespostaInvalidaError;

    expect(err.campos).toEqual(['links[].link']);
  });

  it('a stale backend that omits a field of the answer is named, not defaulted', async () => {
    // `truncado` missing must NOT read as `false` — that would report a
    // complete synchronisation the backend never claimed.
    const c = client(async () =>
      json({ encontrados: 1, reconciliados: 1, ignorados: 0, falhas: [], transicoes: [] }),
    );

    const err = (await c
      .sincronizarLinks({ pedidoId: 'ped_1' })
      .catch((e: unknown) => e)) as MercadoPagoClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
    expect(err.campos).toEqual(['truncado']);
  });

  it('⭐ an HTML 2xx on a POST is the not-JSON variant, and is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok(NEXT_404, 'text/html'));

    const err = (await c
      .criarLinks(BODY_CRIAR)
      .catch((e: unknown) => e)) as MercadoPagoClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
    expect(err.campos).toEqual([]);
    expect(err.message).toContain('sem um corpo JSON');
    // Not version skew, so it must not tell the operator to deploy anything.
    expect(err.message).not.toContain('deploy');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('an EMPTY 2xx on a POST is the same variant — never a null handed back', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok(''));

    const err = (await c
      .criarLinks(BODY_CRIAR)
      .catch((e: unknown) => e)) as MercadoPagoClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
    expect(err.campos).toEqual([]);
    expect(spy.mock.calls[0]?.[1]).toBe('(corpo vazio)');
  });
});

describe('a refusal from a link route', () => {
  const corpoRecusa = {
    error: 'Os links somam mais do que o valor restante (incluindo links em aberto).',
    code: CODIGO_ERRO_LINK.naoElegivel,
    reason: MOTIVO_RECUSA_LINK.excedeRestante,
  };

  it('⭐ a 409 LINK_NAO_ELEGIVEL keeps its status, code AND reason', async () => {
    const c = client(async () => json(corpoRecusa, 409));

    const err = (await c
      .criarLinks(BODY_CRIAR)
      .catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err).toBeInstanceOf(MercadoPagoClientHttpError);
    expect(err).not.toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
    expect(err.status).toBe(409);
    expect(err.code).toBe(CODIGO_ERRO_LINK.naoElegivel);
    expect(err.reason).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
    expect(err.message).toBe(corpoRecusa.error);
  });

  it.each([
    ['no reason at all', { error: 'x', code: CODIGO_ERRO_LINK.naoElegivel }],
    ['a null reason', { error: 'x', code: CODIGO_ERRO_LINK.naoElegivel, reason: null }],
    ['a numeric reason', { error: 'x', code: CODIGO_ERRO_LINK.naoElegivel, reason: 42 }],
    ['an array reason', { error: 'x', code: CODIGO_ERRO_LINK.naoElegivel, reason: ['estado'] }],
    ['an array body that contains one', [{ reason: MOTIVO_RECUSA_LINK.excedeRestante }]],
  ])('the reason is null for %s', async (_nome, corpo) => {
    // Near-misses: `reason` is a label-table key downstream, so anything that is
    // not a string must come out as "no reason" rather than as a value.
    const c = client(async () => json(corpo, 409));

    const err = (await c
      .criarLinks(BODY_CRIAR)
      .catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.status).toBe(409);
    expect(err.reason).toBeNull();
  });

  it('an unknown reason survives as text — a backend newer than the tab', async () => {
    const c = client(async () => json({ ...corpoRecusa, reason: 'motivoDoFuturo' }, 409));

    const err = (await c
      .criarLinks(BODY_CRIAR)
      .catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.reason).toBe('motivoDoFuturo');
  });

  it('the HTML 404 of a backend without the route has no code and no reason', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => new Response(NEXT_404, { status: 404 }));

    const err = (await c
      .sincronizarLinks({ pedidoId: 'ped_1' })
      .catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.status).toBe(404);
    expect(err.code).toBeNull();
    expect(err.reason).toBeNull();
    expect(err.message).toContain('HTTP 404');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('existing call sites keep compiling: the reason is optional and defaults to null', () => {
    expect(new MercadoPagoClientHttpError('x', 500, null).reason).toBeNull();
    expect(new MercadoPagoClientRespostaInvalidaError('x', 200, []).reason).toBeNull();
  });

  it('⭐ an offline token refresh is a network error, and nothing is sent', async () => {
    // `user.getIdToken()` refreshes over the network: offline, it rejects BEFORE
    // any request exists. The tab keeps its minted ids only across a network
    // error, and a raw FirebaseError is none of this client's classes (the tab
    // would rethrow it as an unhandled rejection).
    const semRede = new FirebaseError(
      'auth/network-request-failed',
      'Firebase: Error (auth/network-request-failed).',
    );
    const fetchMock = fetchQueResponde(() => json(RESPOSTA_CRIAR, 201));
    const c = createMercadoPagoClient({
      baseUrl: 'http://localhost:3007',
      getAuthToken: () => Promise.reject(semRede),
      fetch: fetchMock,
    });

    const err = await c.criarLinks(BODY_CRIAR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoPagoClientNetworkError);
    expect((err as MercadoPagoClientNetworkError).cause).toBe(semRede);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a bug in the token getter still propagates as itself (near-miss)', async () => {
    // Only a FirebaseError is re-classified: anything else is a programming error
    // and must surface as one (root rule 6), not as "Sem conexão".
    const bug = new TypeError('user is undefined');
    const fetchMock = fetchQueResponde(() => json(RESPOSTA_CRIAR, 201));
    const c = createMercadoPagoClient({
      baseUrl: 'http://localhost:3007',
      getAuthToken: () => Promise.reject(bug),
      fetch: fetchMock,
    });

    const err = await c.criarLinks(BODY_CRIAR).catch((e: unknown) => e);

    expect(err).toBe(bug);
    expect(err).not.toBeInstanceOf(MercadoPagoClientNetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a network failure on a POST is a network error and is NOT retried', async () => {
    // A silent retry would re-POST a create. The caller decides, with its ids.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(client(fetchMock).criarLinks(BODY_CRIAR)).rejects.toBeInstanceOf(
      MercadoPagoClientNetworkError,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
