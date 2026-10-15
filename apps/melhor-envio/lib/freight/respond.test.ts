import { describe, expect, it, vi } from 'vitest';
import {
  MelhorEnvioError,
  MelhorEnvioHttpError,
  MelhorEnvioLabelTerminalError,
  MelhorEnvioNetworkError,
  MelhorEnvioReauthRequiredError,
  MelhorEnvioSchemaError,
  MelhorEnvioTimeoutError,
  MelhorEnvioValidationError,
} from '@delfrance/integrations-freight-br';
import { FREIGHT_CODIGO_ME_TIMEOUT } from '@delfrance/integrations-freight-br/http-client';
import { ehTempoEsgotadoNoGateway } from '@delfrance/core/wire';

import { MelhorEnvioConfigError, MelhorEnvioContaNotConfiguredError } from './melhorEnvioErrors';
import { isMelhorEnvioError, melhorEnvioErrorResponse } from './respond';

async function responder(err: Parameters<typeof melhorEnvioErrorResponse>[0]) {
  const res = melhorEnvioErrorResponse(err);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('melhorEnvioErrorResponse', () => {
  it('a Melhor Envio timeout is a CODED 504 ME_TIMEOUT, carrying the step and its budget (#1679)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = new MelhorEnvioTimeoutError('lento', { operacao: 'checkout', timeoutMs: 60_000 });
    expect(isMelhorEnvioError(err)).toBe(true);
    const { status, body } = await responder(err);
    // The money-unknown path leaves a server-side trace, not only a 504.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[melhor-envio]'), {
      operacao: 'checkout',
      timeoutMs: 60_000,
    });
    warn.mockRestore();
    expect(status).toBe(504);
    expect(body).toEqual({
      error: 'lento',
      code: FREIGHT_CODIGO_ME_TIMEOUT,
      operacao: 'checkout',
      timeoutMs: 60_000,
    });
    // ⚠️ The browser must read this as OUR answer, never as the platform's
    // gateway giving up — that is what the code is for.
    expect(ehTempoEsgotadoNoGateway(status, body)).toBe(false);
  });

  it('near-miss: a plain network failure stays a 502 without a code', async () => {
    const { status, body } = await responder(new MelhorEnvioNetworkError('offline'));
    expect(status).toBe(502);
    expect(body).toEqual({ error: 'offline' });
  });

  it('the bare base error stays a 502 without a code', async () => {
    const { status, body } = await responder(new MelhorEnvioError('algo novo'));
    expect(status).toBe(502);
    expect(body).toEqual({ error: 'algo novo' });
  });

  it.each([
    [new MelhorEnvioConfigError('sem credenciais'), 500, undefined],
    [new MelhorEnvioContaNotConfiguredError('int-1'), 404, undefined],
    [new MelhorEnvioReauthRequiredError('no_token', 'x'), 409, 'ME_REAUTH'],
    [new MelhorEnvioLabelTerminalError('canceled', 'x'), 409, 'ME_LABEL_TERMINAL'],
    [new MelhorEnvioValidationError('x', {}, {}), 422, undefined],
    [new MelhorEnvioHttpError('x', 500, {}), 502, undefined],
    [new MelhorEnvioSchemaError('x', []), 502, undefined],
  ])('the existing arms are unchanged: %s → %i', async (err, status, code) => {
    const r = await responder(err);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
  });
});
