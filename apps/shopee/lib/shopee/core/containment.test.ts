import { describe, expect, it } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import { AppErrorCode } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';

import { grpc } from '../testing/fakeDb';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDeConfiguracaoDoFunctions,
  falhaDoApp,
  falhaDoFunctions,
  rejeicaoDoTransporte,
} from '../testing/falhaDeEnfileiramento';
import { ShopeeTasksDisabledError, ShopeeTasksTransientError } from '../shopeeTasks';
import { ShopeeCredencialInvalidaError } from './credentialStore';
import { ShopeeContaNotConfiguredError } from './shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from './tokenStore';
import { erroContidoPorConta, isGrpcCodedError } from './containment';

const PATH = '/api/v2/payment/get_escrow_list';

function apiError(code: string): ShopeeApiError {
  return new ShopeeApiError(`shopee recusou: ${code}`, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: PATH,
  });
}

describe('erroContidoPorConta', () => {
  it('1 — contém a família inteira que uma conta pode levantar sozinha', () => {
    const contidos: unknown[] = [
      apiError('order_not_found'),
      new ShopeeReauthRequiredError('grant morto', {
        code: 'error_auth',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 200,
        path: PATH,
      }),
      new ShopeeRateLimitError('estourou', {
        code: 'error_rate_limit',
        kind: 'burst',
        httpStatus: 200,
        path: PATH,
      }),
      new ShopeeNetworkError('ECONNRESET'),
      new ShopeeHttpError('502', { httpStatus: 502, path: PATH }),
      new ShopeeSchemaError('corpo inesperado', {
        campos: ['response.more'],
        httpStatus: 200,
        path: PATH,
      }),
      new ShopeeContaNotConfiguredError('sem integração'),
      new ShopeeContaSemShopIdError('sem shop_id'),
      new ShopeeSemCredencialError('sem credencial'),
      new ShopeeRefreshEmAndamentoError('lease ocupada', 1),
      new ShopeeCredencialInvalidaError('credencial parcial', ['access_token']),
      new ShopeeTasksDisabledError(),
      new ShopeeTasksTransientError('FirebaseFunctionsError', 'functions/unknown-error', 503),
      grpc(14, 'UNAVAILABLE'),
    ];

    for (const err of contidos) {
      expect(erroContidoPorConta(err), (err as Error).name).toBe(true);
    }
  });

  it('2 — ⚠️ NEAR-MISS: ShopeeConfigError RETHROWS, embora estenda ShopeeError', () => {
    // The single most important cell in this table. A missing partner id or key
    // is OUR misconfiguration (#778): containing it turns a broken deploy into N
    // identical `lastError` strings and a green tick. An `instanceof ShopeeError`
    // boundary — the obvious-looking simplification — would swallow exactly this
    // one, and every test above would stay green.
    const cfg = new ShopeeConfigError('SHOPEE_PARTNER_KEY ausente');
    expect(cfg).toBeInstanceOf(ShopeeError);
    expect(erroContidoPorConta(cfg)).toBe(false);
  });

  it('3 — o base ShopeeError cru também não é contido', () => {
    // The boundary names CLASSES, never the base: a future subclass is refused
    // until somebody adds it here deliberately.
    expect(erroContidoPorConta(new ShopeeError('genérico'))).toBe(false);
  });

  it('4 — um bug de código (TypeError, ou um Error qualquer) derruba o tick', () => {
    expect(erroContidoPorConta(new TypeError('x is not a function'))).toBe(false);
    expect(erroContidoPorConta(new Error('boom'))).toBe(false);
    expect(erroContidoPorConta('string')).toBe(false);
    expect(erroContidoPorConta(null)).toBe(false);
  });
});

/** The rejection itself — `rejeicaoDoTransporte` never resolves for these inputs. */
async function rejeicao(err: Error): Promise<unknown> {
  return rejeicaoDoTransporte(err).then(
    () => expect.unreachable('o transporte rejeitou; o enqueue também deveria'),
    (e: unknown) => e,
  );
}

describe('erroContidoPorConta — a falha REAL do enqueue no Cloud Tasks', () => {
  // ⚠️ The SDK's own classes and codes, never a numeric gRPC stand-in:
  // `TaskQueue.enqueue` is a REST client, and a `grpc(14)` here is what once
  // passed while the real `functions/unknown-error` killed the whole tick.
  it.each<[string, () => Error, string, number | null]>([
    [
      '503 (unknown-error)',
      () => falhaDoFunctions('unknown-error'),
      'functions/unknown-error',
      503,
    ],
    [
      '429 (unknown-error)',
      () => falhaDoFunctions('unknown-error', 429),
      'functions/unknown-error',
      429,
    ],
    [
      '500 (internal-error)',
      () => falhaDoFunctions('internal-error', 500),
      'functions/internal-error',
      500,
    ],
    ['409 aborted', () => falhaDoFunctions('aborted', 409), 'functions/aborted', 409],
    [
      'socket (network-error)',
      () => falhaDoApp(AppErrorCode.NETWORK_ERROR),
      'app/network-error',
      null,
    ],
    [
      'socket (network-timeout)',
      () => falhaDoApp(AppErrorCode.NETWORK_TIMEOUT),
      'app/network-timeout',
      null,
    ],
  ])('7 — %s é nomeada no enqueue e CONTIDA', async (_nome, falha, codigo, httpStatus) => {
    const sdk = falha();
    // The positive control: the real class carries the real STRING code, and
    // the boundary does NOT contain it raw — the naming is what contains it.
    expect(sdk).toHaveProperty('code', codigo);
    expect(erroContidoPorConta(sdk)).toBe(false);

    const nomeada = await rejeicao(sdk);

    expect(nomeada).toBeInstanceOf(ShopeeTasksTransientError);
    expect(nomeada).toMatchObject({ codigo, httpStatus });
    expect(erroContidoPorConta(nomeada)).toBe(true);
  });

  it('8 — a mensagem nomeada traz classe, código e status, NUNCA o corpo que o SDK cita', async () => {
    const sdk = falhaDoFunctions('unknown-error');
    expect(sdk.message).toContain(CORPO_DA_RESPOSTA_DO_TASKS);

    const nomeada = await rejeicao(sdk);

    // The sweeps write `err.message` to `lastError` and to their logs.
    expect((nomeada as Error).message).toBe(
      'enqueue no Cloud Tasks falhou de forma transitória (FirebaseFunctionsError functions/unknown-error, HTTP 503)',
    );
    expect(JSON.stringify(nomeada)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect((nomeada as Error).cause).toBeUndefined();
  });

  // ⚠️ The NEAR-MISSES: the same two classes carrying a deploy-shaped code. A
  // missing IAM grant or a queue absent from the region is OURS (#778) — each
  // must fail the tick, and must reach it as the very object the SDK threw.
  it.each<[string, () => Error]>([
    ['functions/permission-denied (falta o IAM)', () => falhaDoFunctions('permission-denied', 403)],
    ['functions/not-found (sem fila nessa região)', () => falhaDoFunctions('not-found', 404)],
    ['functions/invalid-argument', () => falhaDoFunctions('invalid-argument', 400)],
    ['functions/unauthenticated', () => falhaDoFunctions('unauthenticated', 401)],
    ['functions/failed-precondition', () => falhaDoFunctions('failed-precondition', 400)],
    ['app/invalid-credential', () => falhaDoApp(AppErrorCode.INVALID_CREDENTIAL)],
    ['app/internal-error', () => falhaDoApp(AppErrorCode.INTERNAL_ERROR)],
  ])('9 — ⚠️ NEAR-MISS: %s passa INTACTA e RELANÇA', async (_nome, falha) => {
    const sdk = falha();

    const rejeitado = await rejeicao(sdk);

    expect(rejeitado).toBe(sdk);
    expect(erroContidoPorConta(rejeitado)).toBe(false);
  });

  it('10 — ⚠️ NEAR-MISS: o MESMO código num Error comum (a forma, não a classe) RELANÇA', async () => {
    // The FULL shape — the code AND an HTTP response — so only the class check
    // can refuse it (the response guard alone would hide a shape-based mutant).
    const parecido = Object.assign(new Error('503'), {
      code: 'functions/unknown-error',
      httpResponse: { status: 503, headers: {} },
    });

    const rejeitado = await rejeicao(parecido);

    expect(rejeitado).toBe(parecido);
    expect(erroContidoPorConta(rejeitado)).toBe(false);
  });

  // ⚠️ The sharpest near-miss: the SAME class and the SAME `unknown-error` code
  // as the 503 in 7, thrown by the SDK BEFORE any request when it cannot
  // resolve the project or the service account. A config error is ours (#778);
  // only the absent `httpResponse` tells it apart, and containing it would
  // read as one outage per conta under a green tick.
  it.each(['projeto', 'conta-de-servico'] as const)(
    '11 — ⚠️ NEAR-MISS: unknown-error SEM resposta HTTP (config: %s) passa INTACTA e RELANÇA',
    async (qual) => {
      const sdk = falhaDeConfiguracaoDoFunctions(qual);
      // The positive control: it really is the transient code, on the real class.
      expect(sdk).toBeInstanceOf(FirebaseFunctionsError);
      expect(sdk.code).toBe('functions/unknown-error');
      expect(sdk.httpResponse).toBeUndefined();

      const rejeitado = await rejeicao(sdk);

      expect(rejeitado).toBe(sdk);
      expect(erroContidoPorConta(rejeitado)).toBe(false);
    },
  );
});

describe('isGrpcCodedError', () => {
  it('5 — aceita EXATAMENTE a faixa de status gRPC 1..16', () => {
    for (const code of [1, 5, 6, 9, 14, 16]) {
      expect(isGrpcCodedError(grpc(code, 'x')), String(code)).toBe(true);
    }
  });

  it('6 — ⚠️ NEAR-MISS: 0, 17, um não-inteiro e um `code` de string ficam de fora', () => {
    // `0` is gRPC OK and never rides an error; anything outside the range is a
    // coding-bug `Error` that merely happens to expose a numeric `code`, and
    // containing it would hide a real defect behind a per-conta `lastError`.
    expect(isGrpcCodedError(grpc(0, 'OK'))).toBe(false);
    expect(isGrpcCodedError(grpc(17, 'fora da faixa'))).toBe(false);
    expect(isGrpcCodedError(grpc(5.5, 'não-inteiro'))).toBe(false);
    expect(isGrpcCodedError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isGrpcCodedError(Object.assign(new Error('x'), {}))).toBe(false);
  });
});
