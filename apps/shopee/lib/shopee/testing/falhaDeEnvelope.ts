import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import {
  SHOPEE_SURFACE,
  shopeeErrorFromEnvelope,
  type ShopeeApiError,
} from '@delfrance/integrations-shopee';

export const FRASE_DO_ENVELOPE = 'Provider sentence for the redaction regression';

export function falhaDeEnvelope(path: string, code: string, httpStatus = 200): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error: code, message: FRASE_DO_ENVELOPE, warning: null, request_id: null },
    { path, httpStatus, surface: SHOPEE_SURFACE.business },
  );
}

export async function verificarEnvelopeRedigido(
  res: Response,
  err: ShopeeApiError,
  status: 409 | 502,
): Promise<void> {
  expect(res.status).toBe(status);
  const body: unknown = await res.json();
  expect(body).toMatchObject({
    code: status === 409 ? 'SHOPEE_REAUTH_REQUIRED' : 'SHOPEE_HTTP_ERROR',
    shopeeCode: err.code,
  });
  expect(JSON.stringify(body)).not.toContain(FRASE_DO_ENVELOPE);

  const sink = status === 409 ? console.warn : console.error;
  const calls = vi.mocked(sink).mock.calls;
  expect(calls).toContainEqual([
    expect.stringContaining(`[shopee/api] ${err.name} -> HTTP ${String(status)}`),
  ]);
  expect(inspect(calls, { depth: null })).not.toContain(FRASE_DO_ENVELOPE);
}
