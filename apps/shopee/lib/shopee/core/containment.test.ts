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

import { grpc } from '../testing/fakeDb';
import { ShopeeTasksDisabledError } from '../shopeeTasks';
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
