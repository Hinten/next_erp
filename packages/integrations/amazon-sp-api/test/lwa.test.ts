import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChamadaAmazon } from '../src/client';
import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
  type CodigoErroLwa,
} from '../src/errors';
import {
  type OpcoesTrocaCodigo,
  type OpcoesTrocaRefreshToken,
  trocarCodigoAutorizacao,
  trocarRefreshToken,
  URL_TOKEN_LWA,
} from '../src/lwa';
import { PRAZO_AMAZON_MS } from '../src/prazos';
import {
  lwaCodigoDesconhecido,
  lwaInvalidClient,
  lwaInvalidGrant,
  lwaInvalidRequest,
  lwaServerError,
  lwaUnauthorizedClient,
  MARCADOR_DESCRICAO,
  paginaHtmlDeProxy,
  tokenRefresh200,
  tokenRefreshSemEco200,
} from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  CODIGO_AUTORIZACAO,
  falha,
  fetchQueNuncaResponde,
  json,
  mockFetch,
  observar,
  REFRESH_TOKEN,
  requisicao,
  SEGREDOS,
  texto,
  textosDoErro,
  USER_AGENT,
  verificarFormaDasRequisicoes,
} from './_helpers/mockFetch';

afterEach(verificarFormaDasRequisicoes);

const REDIRECT_URI = 'https://erp.example/api/oauth/amazon/callback';
const CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8';

function refresh(
  fetch: typeof globalThis.fetch,
  extra: Partial<OpcoesTrocaRefreshToken> = {},
): { p: ReturnType<typeof trocarRefreshToken>; eventos: ChamadaAmazon[] } {
  const eventos: ChamadaAmazon[] = [];
  const p = trocarRefreshToken({
    aplicacao: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    refreshToken: REFRESH_TOKEN,
    ref: 'ref-conta-1',
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => 'corr-lwa',
    agora: () => 5_000,
    onChamada: (e) => eventos.push(e),
    ...extra,
  });
  return { p, eventos };
}

function codigo(
  fetch: typeof globalThis.fetch,
  extra: Partial<OpcoesTrocaCodigo> = {},
): { p: ReturnType<typeof trocarCodigoAutorizacao>; eventos: ChamadaAmazon[] } {
  const eventos: ChamadaAmazon[] = [];
  const p = trocarCodigoAutorizacao({
    aplicacao: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    codigo: CODIGO_AUTORIZACAO,
    redirectUri: REDIRECT_URI,
    ref: 'ref-conta-1',
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => 'corr-lwa',
    agora: () => 5_000,
    onChamada: (e) => eventos.push(e),
    ...extra,
  });
  return { p, eventos };
}

/** Assert no secret, no body marker and no description appears anywhere on `err`. */
function semSegredos(err: unknown, eventos: readonly ChamadaAmazon[]): void {
  for (const t of [...textosDoErro(err), ...eventos.map((e) => JSON.stringify(e))]) {
    for (const s of SEGREDOS) expect(t).not.toContain(s);
    // The form encoding of a secret too (`|` → `%7C`).
    for (const s of SEGREDOS) expect(t).not.toContain(encodeURIComponent(s));
    expect(t).not.toContain(MARCADOR_DESCRICAO);
    expect(t).not.toContain('MARCADOR-HTML');
  }
}

describe('trocarRefreshToken — the happy path', () => {
  it('sends exactly ONE form POST to the LWA endpoint with exactly the four fields', async () => {
    const f = mockFetch(() => json(tokenRefresh200));
    const { p } = refresh(f);
    await p;
    expect(f).toHaveBeenCalledTimes(1);
    const { url, init, headers, formulario } = requisicao(f);
    expect(url.href).toBe(URL_TOKEN_LWA);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(typeof init.body).toBe('string');
    expect(headers.get('content-type')).toBe(CONTENT_TYPE);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toBe(USER_AGENT);
    expect([...headers.keys()].sort()).toEqual(['accept', 'content-type', 'user-agent']);
    expect([...formulario.keys()].sort()).toEqual([
      'client_id',
      'client_secret',
      'grant_type',
      'refresh_token',
    ]);
    expect(Object.fromEntries(formulario)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    // The `|` is form-encoded on the wire.
    expect(String(init.body)).toContain('%7C');
    expect(url.search).toBe('');
  });

  it('maps the response, with obtidoEmMs taken at the START of the request', async () => {
    let t = 5_000;
    const f = mockFetch(() => json(tokenRefresh200, 200, { 'x-amzn-RequestId': 'req-lwa' }));
    const { p } = refresh(f, {
      agora: () => {
        const v = t;
        t += 250;
        return v;
      },
    });
    expect(await p).toEqual({
      accessToken: ACCESS_TOKEN,
      tipoToken: 'bearer',
      expiraEmS: 3600,
      obtidoEmMs: 5_000,
      correlationId: 'corr-lwa',
      requestIdAmazon: 'req-lwa',
      refCredencial: 'ref-conta-1',
    });
  });

  it('a response without the echoed refresh_token is fine; the echo is never returned', async () => {
    const r1 = await refresh(mockFetch(() => json(tokenRefreshSemEco200))).p;
    const r2 = await refresh(mockFetch(() => json(tokenRefresh200))).p;
    expect(r1.accessToken).toBe(ACCESS_TOKEN);
    expect(Object.keys(r2)).not.toContain('refreshToken');
  });

  it('a quoted expires_in ("3600") reads as 3600', async () => {
    const r = await refresh(mockFetch(() => json({ ...tokenRefresh200, expires_in: '3600' }))).p;
    expect(r.expiraEmS).toBe(3600);
  });

  it('expires_in is read, never assumed', async () => {
    const r = await refresh(mockFetch(() => json({ ...tokenRefresh200, expires_in: 1800 }))).p;
    expect(r.expiraEmS).toBe(1800);
  });
});

describe('trocarCodigoAutorizacao — the happy path', () => {
  it('sends grant_type=authorization_code, code, redirect_uri, client_id and client_secret', async () => {
    const f = mockFetch(() => json(tokenRefresh200));
    const r = await codigo(f).p;
    expect(f).toHaveBeenCalledTimes(1);
    const { formulario, headers } = requisicao(f);
    expect(Object.fromEntries(formulario)).toEqual({
      grant_type: 'authorization_code',
      code: CODIGO_AUTORIZACAO,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(headers.get('content-type')).toBe(CONTENT_TYPE);
    expect(r).toMatchObject({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiraEmS: 3600,
      refCredencial: 'ref-conta-1',
    });
  });

  it('a 200 WITHOUT refresh_token → AmazonSchemaError naming refresh_token', async () => {
    const { p, eventos } = codigo(mockFetch(() => json(tokenRefreshSemEco200)));
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonSchemaError);
    expect(err).toMatchObject({ motivo: 'formato', campos: ['refresh_token'], destino: 'lwa' });
    expect(eventos.map((e) => e.resultado)).toEqual(['schema']);
    semSegredos(err, eventos);
  });

  it('a 200 whose refresh_token has a line break → AmazonSchemaError naming refresh_token', async () => {
    const { p } = codigo(
      mockFetch(() => json({ ...tokenRefresh200, refresh_token: `${REFRESH_TOKEN}\n` })),
    );
    const err = await falha(p);
    expect(err).toMatchObject({ motivo: 'formato', campos: ['refresh_token'] });
  });
});

describe('error mapping', () => {
  it('invalid_grant 400 → AmazonAuthError, destino lwa, codigoLwa invalid_grant, the ref', async () => {
    const { p, eventos } = refresh(mockFetch(() => json(lwaInvalidGrant, 400)));
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonAuthError);
    expect(err).toMatchObject({
      status: 400,
      destino: 'lwa',
      codigoLwa: 'invalid_grant',
      refCredencial: 'ref-conta-1',
      transitorio: false,
      operacao: 'trocarRefreshToken',
      metodo: 'POST',
      caminho: '/auth/o2/token',
    });
    expect(eventos.map((e) => e.resultado)).toEqual(['auth']);
    semSegredos(err, eventos);
  });

  it('invalid_grant on the code exchange (code expired or spent) → AmazonAuthError too', async () => {
    const { p } = codigo(mockFetch(() => json(lwaInvalidGrant, 400)));
    const err = await falha(p);
    expect(err).toMatchObject({ codigoLwa: 'invalid_grant', operacao: 'trocarCodigoAutorizacao' });
  });

  it('near-miss: invalid_request 400 is a plain AmazonHttpError, NOT an auth error', async () => {
    const { p, eventos } = refresh(mockFetch(() => json(lwaInvalidRequest, 400)));
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(err).not.toBeInstanceOf(AmazonAuthError);
    expect((err as AmazonHttpError).transitorio).toBe(false);
    expect(eventos[0]).toMatchObject({ resultado: 'http', codigoLwa: 'invalid_request' });
  });

  it('invalid_client 401 (our client secret refused) → AmazonAuthError, codigoLwa invalid_client', async () => {
    const { p } = refresh(mockFetch(() => json(lwaInvalidClient, 401)));
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonAuthError);
    expect((err as AmazonAuthError).codigoLwa).toBe('invalid_client');
  });

  it.each<[string, unknown, number, CodigoErroLwa]>([
    ['invalid_client on a 400', lwaInvalidClient, 400, 'invalid_client'],
    ['unauthorized_client on a 400', lwaUnauthorizedClient, 400, 'unauthorized_client'],
    ['invalid_grant on a 401', lwaInvalidGrant, 401, 'invalid_grant'],
  ])(
    '%s → AmazonAuthError (classified by the code, not the status)',
    async (_c, corpo, status, cod) => {
      const err = await falha(refresh(mockFetch(() => json(corpo, status))).p);
      expect(err).toBeInstanceOf(AmazonAuthError);
      expect((err as AmazonAuthError).codigoLwa).toBe(cod);
    },
  );

  it('a 403 with no JSON body is still auth, with codigoLwa null', async () => {
    const err = await falha(refresh(mockFetch(() => texto(paginaHtmlDeProxy, 403))).p);
    expect(err).toBeInstanceOf(AmazonAuthError);
    expect((err as AmazonAuthError).codigoLwa).toBeNull();
  });

  // The 401 arm on its own: neither body carries a credential code, so only the
  // STATUS can make these auth — the parking signal step 2 depends on.
  it.each<[string, () => Response, CodigoErroLwa | null]>([
    ['no JSON body', () => texto(paginaHtmlDeProxy, 401), null],
    [
      'a non-credential code (invalid_request)',
      () => json(lwaInvalidRequest, 401),
      'invalid_request',
    ],
  ])('a 401 with %s is still auth, whatever its body says', async (_c, resposta, cod) => {
    const { p, eventos } = refresh(mockFetch(resposta));
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonAuthError);
    expect(err).toMatchObject({ status: 401, destino: 'lwa', codigoLwa: cod });
    expect(eventos.map((e) => e.resultado)).toEqual(['auth']);
    semSegredos(err, eventos);
  });

  it('an unknown error string → codigoLwa "outro", a plain AmazonHttpError', async () => {
    const { p, eventos } = refresh(mockFetch(() => json(lwaCodigoDesconhecido, 400)));
    const err = await falha(p);
    expect(err).not.toBeInstanceOf(AmazonAuthError);
    expect(eventos[0]?.codigoLwa).toBe('outro');
  });

  it('a non-JSON 400 → codigoLwa null, a plain AmazonHttpError, the page dropped', async () => {
    const { p, eventos } = refresh(mockFetch(() => texto(paginaHtmlDeProxy, 400)));
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(err).not.toBeInstanceOf(AmazonAuthError);
    expect(eventos[0]?.codigoLwa).toBeNull();
    semSegredos(err, eventos);
  });

  it('429 → AmazonThrottleError, transient', async () => {
    const { p, eventos } = refresh(mockFetch(() => texto('', 429)));
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonThrottleError);
    expect((err as AmazonThrottleError).transitorio).toBe(true);
    expect((err as AmazonThrottleError).limiteTaxa).toBeNull();
    expect(eventos.map((e) => e.resultado)).toEqual(['limite']);
  });

  it.each([500, 503])(
    'ServerError %i → a transient AmazonHttpError, never auth',
    async (status) => {
      const { p, eventos } = refresh(mockFetch(() => json(lwaServerError, status)));
      const err = await falha(p);
      expect(err).toBeInstanceOf(AmazonHttpError);
      expect(err).not.toBeInstanceOf(AmazonAuthError);
      expect((err as AmazonHttpError).transitorio).toBe(true);
      expect(eventos[0]?.codigoLwa).toBe('server_error');
    },
  );

  it('near-miss: a 5xx whose body says invalid_grant is still transient, never auth', async () => {
    const err = await falha(refresh(mockFetch(() => json(lwaInvalidGrant, 502))).p);
    expect(err).not.toBeInstanceOf(AmazonAuthError);
    expect((err as AmazonHttpError).transitorio).toBe(true);
  });

  it('404 → AmazonNotFoundError', async () => {
    const err = await falha(refresh(mockFetch(() => texto('', 404))).p);
    expect(err).toBeInstanceOf(AmazonNotFoundError);
  });

  it.each([301, 302, 307])(
    'a %i is NOT followed: non-transient AmazonHttpError',
    async (status) => {
      const f = mockFetch(() =>
        texto('', status, { location: 'https://outro-host.example/token' }),
      );
      const err = await falha(refresh(f).p);
      expect(err).toBeInstanceOf(AmazonHttpError);
      expect(err).not.toBeInstanceOf(AmazonAuthError);
      expect((err as AmazonHttpError).transitorio).toBe(false);
      expect(f).toHaveBeenCalledTimes(1);
    },
  );

  it("a 200 that is a proxy's HTML → AmazonSchemaError('nao-json')", async () => {
    const { p, eventos } = refresh(mockFetch(() => texto(paginaHtmlDeProxy, 200)));
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonSchemaError);
    expect((err as AmazonSchemaError).motivo).toBe('nao-json');
    semSegredos(err, eventos);
  });

  it.each([
    ['a space', `${ACCESS_TOKEN} x`],
    ['a line break', `${ACCESS_TOKEN}\n`],
    ['a NUL', `${ACCESS_TOKEN}\u0000`],
    ['é', `${ACCESS_TOKEN}é`],
  ])(
    'a 200 whose access_token holds %s → AmazonSchemaError naming access_token',
    async (_caso, accessToken) => {
      const { p, eventos } = refresh(
        mockFetch(() => json({ ...tokenRefresh200, access_token: accessToken })),
      );
      const err = await falha(p);
      expect(err).toBeInstanceOf(AmazonSchemaError);
      expect(err).toMatchObject({ motivo: 'formato', campos: ['access_token'] });
      semSegredos(err, eventos);
    },
  );

  it.each([
    ['zero', 0],
    ['negative', -5],
  ])(
    'a 200 whose expires_in is %s → AmazonSchemaError naming expires_in',
    async (_c, expires_in) => {
      const err = await falha(refresh(mockFetch(() => json({ ...tokenRefresh200, expires_in }))).p);
      expect(err).toMatchObject({ motivo: 'formato', campos: ['expires_in'] });
    },
  );

  it('a 200 with no access_token → AmazonSchemaError naming the path, not the value', async () => {
    const { access_token: _omitido, ...semToken } = tokenRefresh200;
    const err = await falha(refresh(mockFetch(() => json(semToken))).p);
    expect(err).toMatchObject({ motivo: 'formato', campos: ['access_token'] });
  });
});

describe('transport failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out at the LWA budget, emitting once', async () => {
    const { p, eventos } = refresh(fetchQueNuncaResponde());
    const { estado, pronto } = observar(p);
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.lwa - 1);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(AmazonTimeoutError);
    expect((estado.valor as AmazonTimeoutError).prazoMs).toBe(PRAZO_AMAZON_MS.lwa);
    expect(eventos.map((e) => e.resultado)).toEqual(['tempo-esgotado']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a TypeError → AmazonNetworkError, the cause kept whole, its text out of the message', async () => {
    // A transport TypeError cannot quote an LWA secret: those travel only in the
    // form body, which no TypeError quotes (`transporte.ts`). So the cause rides
    // as-is, and only its text is kept out of OUR message.
    const causa = new TypeError('MARCADOR-DA-CAUSA fetch failed');
    const { p, eventos } = refresh(
      mockFetch(() => {
        throw causa;
      }),
    );
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonNetworkError);
    expect((err as AmazonNetworkError).cause).toBe(causa);
    expect((err as Error).message).not.toContain('MARCADOR-DA-CAUSA');
    expect(eventos.map((e) => e.resultado)).toEqual(['rede']);
    semSegredos(err, eventos);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller abort is rethrown as-is', async () => {
    const controller = new AbortController();
    const { p } = refresh(fetchQueNuncaResponde(), { sinal: controller.signal });
    const { estado, pronto } = observar(p);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await pronto;
    expect(estado.valor).toBe(controller.signal.reason);
    expect(estado.valor).not.toBeInstanceOf(AmazonError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('config errors — nothing is sent', () => {
  const ruins = [
    ['empty', ''],
    ['a newline', `${CLIENT_SECRET}\n`],
    ['a space', 'sec TESTE'],
    ['é', `${CLIENT_SECRET}é`],
    ['a NUL', `${CLIENT_SECRET}\u0000`],
  ] as const;

  it.each(ruins)('a client secret with %s → AmazonConfigError("credencial-lwa")', async (_c, s) => {
    const f = mockFetch(() => json(tokenRefresh200));
    const { p, eventos } = refresh(f, { aplicacao: { clientId: CLIENT_ID, clientSecret: s } });
    const err = await falha(p);
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect((err as AmazonConfigError).motivo).toBe('credencial-lwa');
    expect((err as AmazonConfigError).refCredencial).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
    semSegredos(err, eventos);
  });

  it.each(ruins)('a refresh token with %s → AmazonConfigError("credencial-lwa")', async (_c, s) => {
    const f = mockFetch(() => json(tokenRefresh200));
    const err = await falha(refresh(f, { refreshToken: s }).p);
    expect((err as AmazonConfigError).motivo).toBe('credencial-lwa');
    expect(f).not.toHaveBeenCalled();
  });

  it.each(ruins)('a code with %s → AmazonConfigError("credencial-lwa")', async (_c, s) => {
    const f = mockFetch(() => json(tokenRefresh200));
    const err = await falha(codigo(f, { codigo: s }).p);
    expect((err as AmazonConfigError).motivo).toBe('credencial-lwa');
    expect(f).not.toHaveBeenCalled();
  });

  it('an empty client id → AmazonConfigError("credencial-lwa")', async () => {
    const f = mockFetch(() => json(tokenRefresh200));
    const err = await falha(
      refresh(f, { aplicacao: { clientId: '', clientSecret: CLIENT_SECRET } }).p,
    );
    expect((err as AmazonConfigError).motivo).toBe('credencial-lwa');
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['http', 'http://erp.example/callback'],
    ['a fragment', `${REDIRECT_URI}#x`],
    ['an empty fragment', `${REDIRECT_URI}#`],
    ['userinfo', 'https://user:pass@erp.example/callback'],
    // Each half of the userinfo check on its own.
    ['a username only', 'https://user@erp.example/callback'],
    ['a password only', 'https://:pass@erp.example/callback'],
    ['relative', '/api/oauth/amazon/callback'],
    ['a space', 'https://erp.example/call back'],
    ['empty', ''],
  ])('a redirect_uri with %s → AmazonConfigError("redirect-uri")', async (_c, redirectUri) => {
    const f = mockFetch(() => json(tokenRefresh200));
    const err = await falha(codigo(f, { redirectUri }).p);
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect((err as AmazonConfigError).motivo).toBe('redirect-uri');
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['too long', 'r'.repeat(65)],
    ['containing the client secret', `x${CLIENT_SECRET}`],
    ['containing the refresh token', `x${REFRESH_TOKEN}`],
  ])('a ref %s → AmazonConfigError("ref"), never echoed', async (_c, ref) => {
    const f = mockFetch(() => json(tokenRefresh200));
    const { p, eventos } = refresh(f, { ref });
    const err = await falha(p);
    expect((err as AmazonConfigError).motivo).toBe('ref');
    expect((err as AmazonConfigError).refCredencial).toBeNull();
    semSegredos(err, eventos);
    expect(f).not.toHaveBeenCalled();
  });

  it('a ref containing the code → AmazonConfigError("ref")', async () => {
    const f = mockFetch(() => json(tokenRefresh200));
    const err = await falha(codigo(f, { ref: `x${CODIGO_AUTORIZACAO}` }).p);
    expect((err as AmazonConfigError).motivo).toBe('ref');
  });

  it.each([
    ['empty', ''],
    ['a trailing space', `${USER_AGENT} `],
    ['a control char', `${USER_AGENT}\u0001`],
    ['501 characters', 'A'.repeat(501)],
    ['containing the client secret', `App/1.0 (${CLIENT_SECRET})`],
  ])('a user-agent %s → AmazonConfigError("user-agent")', async (_c, userAgent) => {
    const f = mockFetch(() => json(tokenRefresh200));
    const { p, eventos } = refresh(f, { userAgent });
    const err = await falha(p);
    expect((err as AmazonConfigError).motivo).toBe('user-agent');
    semSegredos(err, eventos);
    expect(f).not.toHaveBeenCalled();
  });

  // Every secret of the exchange, not only the client secret: the grant's own
  // credential would otherwise go out in a request header.
  it.each([
    ['the refresh token', refresh, `App/1.0 (${REFRESH_TOKEN})`],
    ['the authorization code', codigo, `App/1.0 (${CODIGO_AUTORIZACAO})`],
  ] as const)(
    'a user-agent containing %s → AmazonConfigError("user-agent")',
    async (_c, troca, userAgent) => {
      const f = mockFetch(() => json(tokenRefresh200));
      const { p, eventos } = troca(f, { userAgent });
      const err = await falha(p);
      expect(err).toBeInstanceOf(AmazonConfigError);
      expect((err as AmazonConfigError).motivo).toBe('user-agent');
      semSegredos(err, eventos);
      expect(f).not.toHaveBeenCalled();
      expect(eventos).toEqual([]);
    },
  );
});

describe('secrets never leave the form body', () => {
  const falhas: [string, () => Response][] = [
    ['invalid_grant 400', () => json(lwaInvalidGrant, 400)],
    ['invalid_client 401', () => json(lwaInvalidClient, 401)],
    ['invalid_request 400', () => json(lwaInvalidRequest, 400)],
    ['ServerError 500', () => json(lwaServerError, 500)],
    ['429', () => texto(MARCADOR_DESCRICAO, 429)],
    ['404', () => texto(MARCADOR_DESCRICAO, 404)],
    ['HTML 200', () => texto(paginaHtmlDeProxy, 200)],
    [
      'a body echoing every secret',
      () =>
        texto(
          JSON.stringify({ error: 'invalid_grant', eco: SEGREDOS, d: MARCADOR_DESCRICAO }),
          400,
        ),
    ],
    [
      'a 200 with a bad access token',
      () => json({ ...tokenRefresh200, access_token: `${ACCESS_TOKEN} x` }),
    ],
  ];

  it.each(falhas)(
    '%s: nothing on the error or the event, for both exchanges',
    async (_c, resposta) => {
      for (const troca of [refresh, codigo]) {
        const { p, eventos } = troca(mockFetch(resposta));
        const err = await falha(p);
        expect(err).toBeInstanceOf(AmazonError);
        semSegredos(err, eventos);
        expect(eventos).toHaveLength(1);
      }
    },
  );

  it('the observer gets corpo null on success AND failure, exactly once per POST', async () => {
    const ok = refresh(mockFetch(() => json(tokenRefresh200)));
    await ok.p;
    const ruim = refresh(mockFetch(() => json(lwaInvalidGrant, 400)));
    await falha(ruim.p);
    for (const eventos of [ok.eventos, ruim.eventos]) {
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.corpo).toBeNull();
      expect(JSON.stringify(eventos[0])).not.toContain(ACCESS_TOKEN);
    }
  });

  it('the event has the documented shape', async () => {
    const { p, eventos } = refresh(
      mockFetch(() => json(lwaInvalidGrant, 400, { 'x-amzn-RequestId': 'req-lwa' })),
    );
    await falha(p);
    expect(eventos).toEqual([
      {
        destino: 'lwa',
        operacao: 'trocarRefreshToken',
        metodo: 'POST',
        caminho: '/auth/o2/token',
        query: [],
        correlationId: 'corr-lwa',
        requestIdAmazon: 'req-lwa',
        refCredencial: 'ref-conta-1',
        status: 400,
        latenciaMs: 0,
        resultado: 'auth',
        limiteTaxa: null,
        codigosErro: [],
        codigoLwa: 'invalid_grant',
        corpo: null,
      } satisfies ChamadaAmazon,
    ]);
  });

  it('a successful result carries no secret but the tokens it was asked for', async () => {
    const r = await codigo(mockFetch(() => json(tokenRefresh200))).p;
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(CLIENT_SECRET);
    expect(texto).not.toContain(CODIGO_AUTORIZACAO);
  });
});

describe('the default fetch', () => {
  it('is resolved at call time from globalThis', async () => {
    const f = mockFetch(() => json(tokenRefresh200));
    vi.stubGlobal('fetch', f);
    try {
      await trocarRefreshToken({
        aplicacao: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        refreshToken: REFRESH_TOKEN,
        ref: 'r',
        userAgent: USER_AGENT,
      });
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
