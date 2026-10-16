import { describe, expect, it } from 'vitest';

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
  type ContextoRequisicaoAmazon,
  lerCodigoErroLwa,
  lerLimiteTaxa,
  type MotivoConfigAmazon,
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
    ];
    for (const motivo of motivos) {
      const err = new AmazonConfigError(motivo, { operacao: 'op', refCredencial: null });
      expect(err.motivo).toBe(motivo);
      expect(err.refCredencial).toBeNull();
      expect(err.message).toContain('op');
      expect(err.message).toContain('Nada foi enviado');
    }
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
