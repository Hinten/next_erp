import { describe, expect, it } from 'vitest';

import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonDocumentoEasyShipError,
  AmazonDocumentoFeedError,
  AmazonError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
  type CodigoErroLwa,
  type ContextoRequisicaoAmazon,
  ehTransitoriaDocumentoFeed,
  lerCodigoErroLwa,
  lerLimiteTaxa,
  type MotivoConfigAmazon,
  type MotivoDocumentoEasyShip,
  type MotivoDocumentoFeed,
} from '../src/errors';

const ctx: ContextoRequisicaoAmazon = {
  destino: 'sp-api',
  operacao: 'getOrder',
  metodo: 'GET',
  caminho: '/orders/2026-01-01/orders/171-0000000-0000000',
  correlationId: 'corr-1',
  requestIdAmazon: 'req-1',
  refCredencial: 'ref-1',
};

const ctxLwa: ContextoRequisicaoAmazon = {
  ...ctx,
  destino: 'lwa',
  operacao: 'trocarRefreshToken',
  metodo: 'POST',
  caminho: '/auth/o2/token',
};

describe('lerLimiteTaxa', () => {
  it.each<[string, string | null | undefined, number | null]>([
    ['"0.0167"', '0.0167', 0.0167],
    ['"5"', '5', 5],
    ['" 2.0 "', ' 2.0 ', 2],
    ['"2.0"', '2.0', 2],
    // Near-misses: each one a value a lax parse would turn into a rate.
    ['empty', '', null],
    ['absent (null)', null, null],
    ['absent (undefined)', undefined, null],
    ['"abc"', 'abc', null],
    ['"1,5" (a decimal comma)', '1,5', null],
    ['"0"', '0', null],
    ['"-1"', '-1', null],
    ['"1e3"', '1e3', null],
    ['"0x1F"', '0x1F', null],
    ['"Infinity"', 'Infinity', null],
  ])('%s → %s', (_caso, valor, esperado) => {
    expect(lerLimiteTaxa(valor)).toBe(esperado);
  });
});

describe('lerCodigoErroLwa', () => {
  it.each<[unknown, CodigoErroLwa | null]>([
    ['invalid_request', 'invalid_request'],
    ['invalid_client', 'invalid_client'],
    ['invalid_grant', 'invalid_grant'],
    ['unauthorized_client', 'unauthorized_client'],
    ['unsupported_grant_type', 'unsupported_grant_type'],
    ['invalid_scope', 'invalid_scope'],
    ['access_denied', 'access_denied'],
    ['temporarily_unavailable', 'temporarily_unavailable'],
    ['server_error', 'server_error'],
    // The LWA documentation's own CamelCase spelling.
    ['ServerError', 'server_error'],
    // Near-misses: a case fold or a stray space is NOT the code.
    ['INVALID_GRANT', 'outro'],
    ['invalid_grant ', 'outro'],
    ['InvalidGrant', 'outro'],
    // Prototype keys must not read as codes.
    ['toString', 'outro'],
    ['__proto__', 'outro'],
    ['', 'outro'],
    // No string at all.
    [undefined, null],
    [null, null],
    [400, null],
    [{ error: 'invalid_grant' }, null],
  ])('%j → %s', (valor, esperado) => {
    expect(lerCodigoErroLwa(valor)).toBe(esperado);
  });
});

describe('the class hierarchy', () => {
  const casos: [AmazonError, string][] = [
    [new AmazonConfigError('token', { operacao: 'op', refCredencial: null }), 'AmazonConfigError'],
    [new AmazonHttpError({ ...ctx, status: 400 }), 'AmazonHttpError'],
    [new AmazonAuthError({ ...ctx, status: 403, codigoLwa: null }), 'AmazonAuthError'],
    [new AmazonNotFoundError({ ...ctx, status: 404 }), 'AmazonNotFoundError'],
    [new AmazonThrottleError({ ...ctx, status: 429, limiteTaxa: null }), 'AmazonThrottleError'],
    [
      new AmazonSchemaError({ ...ctx, status: 200, motivo: 'formato', campos: ['payload'] }),
      'AmazonSchemaError',
    ],
    [new AmazonNetworkError(ctx, new TypeError('x')), 'AmazonNetworkError'],
    [new AmazonTimeoutError({ ...ctx, prazoMs: 20_000 }, null), 'AmazonTimeoutError'],
    [new AmazonDocumentoEasyShipError('zip-invalido'), 'AmazonDocumentoEasyShipError'],
    [new AmazonDocumentoFeedError('gzip-invalido'), 'AmazonDocumentoFeedError'],
  ];

  it('roots every class at AmazonError and sets a distinct name', () => {
    for (const [err, name] of casos) {
      expect(err).toBeInstanceOf(AmazonError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
    }
    expect(new Set(casos.map(([e]) => e.name)).size).toBe(casos.length);
  });

  it('auth, not-found and throttle ARE AmazonHttpError', () => {
    expect(new AmazonAuthError({ ...ctx, status: 401, codigoLwa: null })).toBeInstanceOf(
      AmazonHttpError,
    );
    expect(new AmazonNotFoundError({ ...ctx, status: 404 })).toBeInstanceOf(AmazonHttpError);
    expect(new AmazonThrottleError({ ...ctx, status: 429, limiteTaxa: 1 })).toBeInstanceOf(
      AmazonHttpError,
    );
  });

  it('keeps the 2xx and transport classes OUT of the AmazonHttpError branch', () => {
    expect(
      new AmazonSchemaError({ ...ctx, status: 200, motivo: 'vazio', campos: [] }),
    ).not.toBeInstanceOf(AmazonHttpError);
    expect(new AmazonNetworkError(ctx, null)).not.toBeInstanceOf(AmazonHttpError);
    expect(new AmazonTimeoutError({ ...ctx, prazoMs: 1 }, null)).toBeInstanceOf(AmazonNetworkError);
    expect(
      new AmazonConfigError('ref', { operacao: 'op', refCredencial: null }),
    ).not.toBeInstanceOf(AmazonHttpError);
    // The document class is neither: no SP-API status, no transport context.
    const documento = new AmazonDocumentoEasyShipError('http', { status: 500 });
    expect(documento).not.toBeInstanceOf(AmazonHttpError);
    expect(documento).not.toBeInstanceOf(AmazonNetworkError);
    expect(documento.refCredencial).toBeNull();
    // Nor is the feed document class, and the two document classes are apart.
    const feed = new AmazonDocumentoFeedError('http', { status: 500 });
    expect(feed).not.toBeInstanceOf(AmazonHttpError);
    expect(feed).not.toBeInstanceOf(AmazonNetworkError);
    expect(feed).not.toBeInstanceOf(AmazonDocumentoEasyShipError);
    expect(documento).not.toBeInstanceOf(AmazonDocumentoFeedError);
    expect(feed.refCredencial).toBeNull();
  });

  it('reads `transitorio` from the status — 5xx and 429 only', () => {
    const tabela: [number, boolean][] = [
      [301, false],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
      [409, false],
      [413, false],
      [415, false],
      [422, false],
      [429, true],
      [500, true],
      [503, true],
      [599, true],
    ];
    for (const [status, transitorio] of tabela) {
      expect(new AmazonHttpError({ ...ctx, status }).transitorio, `HTTP ${String(status)}`).toBe(
        transitorio,
      );
    }
    expect(new AmazonThrottleError({ ...ctx, status: 429, limiteTaxa: null }).transitorio).toBe(
      true,
    );
    expect(new AmazonAuthError({ ...ctx, status: 403, codigoLwa: null }).transitorio).toBe(false);
  });

  it('carries the request context — request id included — on every HTTP and transport error', () => {
    const { refCredencial, ...semRef } = ctx;
    expect(new AmazonHttpError({ ...ctx, status: 502 })).toMatchObject({ ...semRef, status: 502 });
    expect(new AmazonHttpError({ ...ctx, status: 502 }).refCredencial).toBe(refCredencial);
    const rede = new AmazonNetworkError(ctx, new TypeError('x'));
    expect(rede).toMatchObject(ctx);
    expect(rede.cause).toBeInstanceOf(TypeError);
    expect(new AmazonTimeoutError({ ...ctx, prazoMs: 20_000 }, null)).toMatchObject({
      ...ctx,
      prazoMs: 20_000,
    });
    expect(
      new AmazonSchemaError({ ...ctx, status: 200, motivo: 'vazio', campos: [] }),
    ).toMatchObject(ctx);
  });

  it('an auth error carries its destination and LWA code', () => {
    const err = new AmazonAuthError({ ...ctxLwa, status: 400, codigoLwa: 'invalid_grant' });
    expect(err).toMatchObject({ destino: 'lwa', codigoLwa: 'invalid_grant', metodo: 'POST' });
    expect(err.message).toContain('invalid_grant');
    expect(err.message).toContain('LWA');
  });

  it('names the operation, method and path in every message — and no cause text', () => {
    const rede = new AmazonNetworkError(ctx, new TypeError('MARCADOR-DA-CAUSA'));
    for (const err of [
      rede,
      new AmazonHttpError({ ...ctx, status: 400 }),
      new AmazonThrottleError({ ...ctx, status: 429, limiteTaxa: null }),
      new AmazonNotFoundError({ ...ctx, status: 404 }),
      new AmazonSchemaError({ ...ctx, status: 200, motivo: 'nao-json', campos: [] }),
    ]) {
      expect(err.message).toContain('getOrder');
      expect(err.message).toContain(`GET ${ctx.caminho}`);
    }
    expect(rede.message).not.toContain('MARCADOR-DA-CAUSA');
    expect(new AmazonTimeoutError({ ...ctx, prazoMs: 20_000 }, null).message).toContain('20 s');
    expect(new AmazonHttpError({ ...ctxLwa, status: 400 }).message).toContain(
      'POST /auth/o2/token',
    );
  });

  it('a config error carries its motivo, names the operation, and echoes no value', () => {
    const motivos: MotivoConfigAmazon[] = [
      'token',
      'ref',
      'caminho',
      'token-na-url',
      'user-agent',
      'credencial-lwa',
      'redirect-uri',
      'application-id',
      'state',
      'token-no-corpo',
      'pedido',
      'md5',
      'base64',
      'sku',
      'quantidade',
      'feed',
    ];
    const mensagens = new Set<string>();
    for (const motivo of motivos) {
      const err = new AmazonConfigError(motivo, { operacao: 'op', refCredencial: null });
      expect(err.motivo).toBe(motivo);
      expect(err.refCredencial).toBeNull();
      expect(err.message).toContain('op');
      expect(err.message).toContain('Nada foi enviado');
      mensagens.add(err.message);
    }
    // ★ Each motivo has its OWN sentence.
    expect(mensagens.size).toBe(motivos.length);
  });

  it('★ the step-14 motivos echo no value: no digit run, no digest, no body', () => {
    for (const motivo of ['token-no-corpo', 'pedido', 'md5', 'base64'] as const) {
      const { message } = new AmazonConfigError(motivo, {
        operacao: 'submitInvoice',
        refCredencial: null,
      });
      expect(message, motivo).not.toMatch(/\d{3,}/);
      expect(message, motivo).not.toMatch(/[A-Za-z0-9+/]{16,}={0,2}/);
    }
    expect(new AmazonConfigError('md5', { operacao: 'x', refCredencial: null }).message).toContain(
      'base64',
    );
  });

  it('an HTTP error carries its codes as given, frozen and NON-enumerable; none by default (LWA)', () => {
    const err = new AmazonHttpError({ ...ctx, status: 400, codigosErro: ['EntityNotFound'] });
    expect(err.codigosErro).toEqual(['EntityNotFound']);
    expect(Object.isFrozen(err.codigosErro)).toBe(true);
    expect(err.message).not.toContain('EntityNotFound');
    // Readable in process, absent from every serialization of the error.
    expect(Object.keys(err)).not.toContain('codigosErro');
    expect(JSON.stringify(err)).not.toContain('EntityNotFound');
    expect({ ...err }).not.toHaveProperty('codigosErro');
    expect(new AmazonHttpError({ ...ctxLwa, status: 400 }).codigosErro).toEqual([]);
    expect(
      new AmazonAuthError({ ...ctx, status: 403, codigoLwa: null, codigosErro: ['Forbidden'] })
        .codigosErro,
    ).toEqual(['Forbidden']);
    expect(new AmazonNotFoundError({ ...ctx, status: 404 }).codigosErro).toEqual([]);
    expect(
      new AmazonThrottleError({
        ...ctx,
        status: 429,
        limiteTaxa: null,
        codigosErro: ['RateLimited'],
      }).codigosErro,
    ).toEqual(['RateLimited']);
  });

  it('a schema error names field PATHS in its message', () => {
    const err = new AmazonSchemaError({
      ...ctx,
      status: 200,
      motivo: 'formato',
      campos: ['payload[].marketplace.id', 'errors'],
    });
    expect(err.message).toContain('payload[].marketplace.id');
    expect(err.message).toContain('errors');
  });
});

describe('AmazonDocumentoEasyShipError', () => {
  const MOTIVOS: readonly MotivoDocumentoEasyShip[] = [
    'url-invalida',
    'expirado',
    'http',
    'grande-demais',
    'nao-zip',
    'rede',
    'prazo',
    'zip-invalido',
    'entradas-demais',
    'sem-zpl',
    'zpl-multiplo',
    'zpl-grande-demais',
    'zpl-invalido',
  ];

  it('★ a fixed, distinct pt-BR message per motivo, built here: no URL, no host, no cause', () => {
    const mensagens = MOTIVOS.map((m) => new AmazonDocumentoEasyShipError(m).message);
    expect(new Set(mensagens).size).toBe(MOTIVOS.length);
    for (const [i, msg] of mensagens.entries()) {
      expect(msg, MOTIVOS[i]).toMatch(/^Etiqueta Easy Ship: /);
      expect(msg).not.toMatch(/https?:|amazonaws|\?|X-Amz/);
    }
    for (const m of MOTIVOS) {
      const err = new AmazonDocumentoEasyShipError(m);
      expect(err.motivo).toBe(m);
      expect(err.cause).toBeUndefined();
      expect(err.status).toBeNull();
    }
  });

  it('carries the status it was given, and names it in the message', () => {
    const err = new AmazonDocumentoEasyShipError('expirado', { status: 403 });
    expect(err).toMatchObject({ motivo: 'expirado', status: 403, refCredencial: null });
    expect(err.message).toContain('HTTP 403');
    expect(new AmazonDocumentoEasyShipError('http', { status: 500 }).message).toContain('HTTP 500');
  });
});

describe('AmazonDocumentoFeedError', () => {
  const MOTIVOS: readonly MotivoDocumentoFeed[] = [
    'url-invalida',
    'recusado',
    'expirado',
    'http',
    'grande-demais',
    'rede',
    'prazo',
    'gzip-invalido',
    'json-invalido',
    'relatorio-invalido',
  ];

  it('★ a fixed, distinct pt-BR message per motivo, built here: no URL, no host, no cause', () => {
    const mensagens = MOTIVOS.map((m) => new AmazonDocumentoFeedError(m).message);
    expect(new Set(mensagens).size).toBe(MOTIVOS.length);
    for (const [i, msg] of mensagens.entries()) {
      expect(msg, MOTIVOS[i]).toMatch(/^Documento do feed: /);
      expect(msg).not.toMatch(/https?:|amazonaws|cloudfront|\?|X-Amz/);
    }
    for (const m of MOTIVOS) {
      const err = new AmazonDocumentoFeedError(m);
      expect(err).toBeInstanceOf(AmazonError);
      expect(err.name).toBe('AmazonDocumentoFeedError');
      expect(err.motivo).toBe(m);
      expect(err.cause).toBeUndefined();
      expect(err.status).toBeNull();
      expect(err.codigoS3).toBeNull();
      expect(err.refCredencial).toBeNull();
    }
  });

  it('carries the status and the closed S3 code it was given, the status named in the message', () => {
    const err = new AmazonDocumentoFeedError('recusado', {
      status: 403,
      codigoS3: 'SignatureDoesNotMatch',
    });
    expect(err).toMatchObject({
      motivo: 'recusado',
      status: 403,
      codigoS3: 'SignatureDoesNotMatch',
    });
    expect(err.message).toContain('HTTP 403');
    expect(err.message).not.toContain('SignatureDoesNotMatch');
    expect(new AmazonDocumentoFeedError('expirado', { status: 403 }).message).toContain('HTTP 403');
    expect(new AmazonDocumentoFeedError('http', { status: 502 }).message).toContain('HTTP 502');
  });

  it.each<[MotivoDocumentoFeed, number | undefined, boolean]>([
    ['rede', undefined, true],
    ['prazo', undefined, true],
    ['expirado', 403, true],
    ['http', 500, true],
    ['http', 503, true],
    ['http', 599, true],
    // Near-misses: every other motivo, and a non-5xx `http`, is deterministic.
    ['http', 400, false],
    ['http', 404, false],
    ['http', 429, false],
    ['http', 600, false],
    ['http', undefined, false],
    ['recusado', 403, false],
    ['url-invalida', undefined, false],
    ['grande-demais', undefined, false],
    ['gzip-invalido', undefined, false],
    ['json-invalido', undefined, false],
    ['relatorio-invalido', undefined, false],
  ])('★ ehTransitoriaDocumentoFeed: %s (HTTP %s) → %s', (motivo, status, transitoria) => {
    const err = new AmazonDocumentoFeedError(motivo, status === undefined ? {} : { status });
    expect(ehTransitoriaDocumentoFeed(err)).toBe(transitoria);
  });
});
