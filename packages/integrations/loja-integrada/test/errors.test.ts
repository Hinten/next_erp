import { describe, expect, it } from 'vitest';

import {
  type ContextoRequisicaoLi,
  type EscopoLimiteLi,
  extrairEscopoLimite,
  lerRetryAfter,
  LiAuthError,
  LiConfigError,
  LiError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
} from '../src/errors';
import {
  corpo429Aplicacao,
  corpo429Html,
  corpo429Ip,
  corpo429Loja,
  corpo429SemCodigo,
  corpo429SoUuid,
} from './_fixtures/especificacao';

const ctx: ContextoRequisicaoLi = {
  operacao: 'listarCategorias',
  caminho: '/v1/categoria/',
  correlationId: 'corr-1',
  refCredencial: 'ref-1',
};

describe('extrairEscopoLimite — the 429 scope table', () => {
  it.each<[string, string, EscopoLimiteLi]>([
    ['contains 633', corpo429Loja, 'loja'],
    ['contains 533', corpo429Aplicacao, 'aplicacao'],
    ['contains 133', corpo429Ip, 'ip'],
    ['no code', corpo429SemCodigo, 'desconhecido'],
    ['HTML', corpo429Html, 'desconhecido'],
    ['empty', '', 'desconhecido'],
    ['a UUID-like id with codes inside hex groups, and no code', corpo429SoUuid, 'desconhecido'],
  ])('%s → %s', (_caso, corpo, escopo) => {
    expect(extrairEscopoLimite(corpo).escopo).toBe(escopo);
  });

  it('reports the single code and every distinct code found', () => {
    expect(extrairEscopoLimite(corpo429Loja)).toEqual({
      escopo: 'loja',
      codigo: 633,
      codigosEncontrados: [633],
    });
    expect(extrairEscopoLimite('{"a": 533, "b": 133}')).toEqual({
      escopo: 'desconhecido',
      codigo: null,
      codigosEncontrados: [533, 133],
    });
  });

  describe('near-miss: code match', () => {
    it.each(['codigo: 633', 'erro 633.', '"code":"633"', '(633)'])('matches %j', (texto) => {
      expect(extrairEscopoLimite(texto).escopo).toBe('loja');
    });

    it.each(['1633', '6330', '5330', '"id": 133000', 'a633f', '633f', 'x133', 'B533'])(
      'stays distinct: %j',
      (texto) => {
        expect(extrairEscopoLimite(texto)).toEqual({
          escopo: 'desconhecido',
          codigo: null,
          codigosEncontrados: [],
        });
      },
    );
  });

  describe('near-miss: uniqueness', () => {
    it('the same code twice gives that scope', () => {
      expect(extrairEscopoLimite('633 ... 633').escopo).toBe('loja');
      expect(extrairEscopoLimite('133 e 133').escopo).toBe('ip');
    });

    it('two distinct codes give desconhecido', () => {
      expect(extrairEscopoLimite('633 ... 533').escopo).toBe('desconhecido');
      expect(extrairEscopoLimite('133 633').escopo).toBe('desconhecido');
    });
  });
});

describe('lerRetryAfter', () => {
  it.each<[string, string | null | undefined, number | null]>([
    ['"30"', '30', 30],
    ['" 30 "', ' 30 ', 30],
    ['"0"', '0', 0],
    ['"-1"', '-1', null],
    ['"1.5"', '1.5', null],
    ['an HTTP-date', 'Wed, 21 Oct 2026 07:28:00 GMT', null],
    ['absent (null)', null, null],
    ['absent (undefined)', undefined, null],
    ['20 digits', '12345678901234567890', null],
    ['empty', '', null],
    ['"+30"', '+30', null],
  ])('%s → %s', (_caso, valor, esperado) => {
    expect(lerRetryAfter(valor)).toBe(esperado);
  });
});

describe('the class hierarchy', () => {
  it('roots every class at LiError and sets a distinct name', () => {
    const casos: [LiError, string][] = [
      [new LiConfigError('token', { operacao: 'op', refCredencial: null }), 'LiConfigError'],
      [new LiHttpError({ ...ctx, status: 400 }), 'LiHttpError'],
      [new LiAuthError({ ...ctx, status: 401 }), 'LiAuthError'],
      [new LiNotFoundError({ ...ctx, status: 404 }), 'LiNotFoundError'],
      [
        new LiThrottleError({
          ...ctx,
          status: 429,
          escopo: 'loja',
          codigosEncontrados: [633],
          retryAfterS: 5,
        }),
        'LiThrottleError',
      ],
      [
        new LiSchemaError({ ...ctx, status: 200, motivo: 'formato', campos: ['meta'] }),
        'LiSchemaError',
      ],
      [
        new LiPaginacaoError({ ...ctx, motivo: 'offset-nao-avanca', paginas: 2 }),
        'LiPaginacaoError',
      ],
      [new LiNetworkError(ctx, new TypeError('x')), 'LiNetworkError'],
      [new LiTimeoutError({ ...ctx, prazoMs: 20_000 }, null), 'LiTimeoutError'],
    ];
    for (const [err, name] of casos) {
      expect(err).toBeInstanceOf(LiError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
    }
  });

  it('keeps the 2xx and transport classes OUT of the LiHttpError branch', () => {
    // An `instanceof LiHttpError` arm must never swallow a malformed 2xx or a
    // dead network: the validator maps all three, but to different sentences.
    expect(
      new LiSchemaError({ ...ctx, status: 200, motivo: 'vazio', campos: [] }),
    ).not.toBeInstanceOf(LiHttpError);
    expect(new LiNetworkError(ctx, null)).not.toBeInstanceOf(LiHttpError);
    expect(new LiTimeoutError({ ...ctx, prazoMs: 1 }, null)).toBeInstanceOf(LiNetworkError);
  });

  it('reads `transitorio` from the status — 5xx and 429 only', () => {
    const casos: [number, boolean][] = [
      [301, false],
      [400, false],
      [404, false],
      [409, false],
      [418, false],
      [429, true],
      [500, true],
      [503, true],
      [520, true],
      [599, true],
    ];
    for (const [status, transitorio] of casos) {
      expect(new LiHttpError({ ...ctx, status }).transitorio, `HTTP ${String(status)}`).toBe(
        transitorio,
      );
    }
    expect(
      new LiThrottleError({
        ...ctx,
        status: 429,
        escopo: 'desconhecido',
        codigosEncontrados: [],
        retryAfterS: null,
      }).transitorio,
    ).toBe(true);
  });

  it('carries the request context on every HTTP and transport error', () => {
    const http = new LiHttpError({ ...ctx, status: 502 });
    expect(http).toMatchObject({ ...ctx, status: 502 });
    const rede = new LiNetworkError(ctx, new TypeError('x'));
    expect(rede).toMatchObject(ctx);
    expect(rede.cause).toBeInstanceOf(TypeError);
    const tempo = new LiTimeoutError({ ...ctx, prazoMs: 20_000 }, null);
    expect(tempo).toMatchObject({ ...ctx, prazoMs: 20_000 });
  });

  it('names the operation and the path in every message — and no cause text', () => {
    const rede = new LiNetworkError(ctx, new TypeError('MARCADOR-DA-CAUSA'));
    expect(rede.message).toContain('listarCategorias');
    expect(rede.message).toContain('/v1/categoria/');
    expect(rede.message).not.toContain('MARCADOR-DA-CAUSA');
    expect(new LiTimeoutError({ ...ctx, prazoMs: 20_000 }, null).message).toContain('20 s');
  });

  it('a config error carries its motivo and names the operation', () => {
    for (const motivo of ['token', 'ref', 'caminho', 'token-na-url', 'maxPaginas'] as const) {
      const err = new LiConfigError(motivo, { operacao: 'op', refCredencial: null });
      expect(err.motivo).toBe(motivo);
      expect(err.refCredencial).toBeNull();
      expect(err.message).toContain('op');
    }
  });

  it('a schema error names field PATHS in its message', () => {
    const err = new LiSchemaError({
      ...ctx,
      status: 200,
      motivo: 'formato',
      campos: ['objects[].id', 'meta.limit'],
    });
    expect(err.message).toContain('objects[].id');
    expect(err.message).toContain('meta.limit');
  });
});

describe('the verb in every message — `metodo` is optional and defaults to GET', () => {
  /** Every class whose message names `<verb> <path>`, built from one context. */
  function todas(c: ContextoRequisicaoLi): LiError[] {
    return [
      new LiHttpError({ ...c, status: 400 }),
      new LiAuthError({ ...c, status: 403 }),
      new LiNotFoundError({ ...c, status: 404 }),
      new LiThrottleError({
        ...c,
        status: 429,
        escopo: 'loja',
        codigosEncontrados: [633],
        retryAfterS: null,
      }),
      new LiSchemaError({ ...c, status: 200, motivo: 'vazio', campos: [] }),
      new LiSchemaError({ ...c, status: 200, motivo: 'nao-json', campos: [] }),
      new LiSchemaError({ ...c, status: 200, motivo: 'formato', campos: ['id'] }),
      new LiPaginacaoError({ ...c, motivo: 'offset-nao-avanca', paginas: 2 }),
      new LiPaginacaoError({ ...c, motivo: 'limite-de-paginas', paginas: 2 }),
      new LiNetworkError(c, new TypeError('x')),
      new LiTimeoutError({ ...c, prazoMs: 20_000 }, null),
    ];
  }

  it('a context WITHOUT metodo prints GET — every hand-built context keeps its old message', () => {
    for (const err of todas(ctx)) {
      expect(err.message, err.name).toContain('(GET /v1/categoria/)');
      expect(err.message, err.name).not.toContain('PUT');
    }
  });

  it('metodo GET prints exactly the same message as no metodo', () => {
    const semMetodo = todas(ctx).map((e) => e.message);
    const comGet = todas({ ...ctx, metodo: 'GET' }).map((e) => e.message);
    expect(comGet).toEqual(semMetodo);
  });

  it('near-miss: metodo PUT prints PUT, never GET', () => {
    const put: ContextoRequisicaoLi = {
      ...ctx,
      metodo: 'PUT',
      operacao: 'atualizarObjetoEnvio',
      caminho: '/v1/pedido_envio/69291055',
    };
    for (const err of todas(put)) {
      expect(err.message, err.name).toContain('(PUT /v1/pedido_envio/69291055)');
      expect(err.message, err.name).not.toContain('GET');
    }
  });

  it('the write refusals carry their motivo and name the operation, never a value', () => {
    for (const motivo of ['token-no-corpo', 'codigo-nao-permitido', 'corpo'] as const) {
      const err = new LiConfigError(motivo, { operacao: 'op', refCredencial: 'ref-1' });
      expect(err.motivo).toBe(motivo);
      expect(err.refCredencial).toBe('ref-1');
      expect(err.message).toContain('op');
      expect(err.message).toContain('Nada foi enviado');
    }
  });
});
