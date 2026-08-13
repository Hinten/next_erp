import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
} from '@delfrance/integrations-mercado-livre';

import { MercadoLivreConfigError, MercadoLivreContaNotConfiguredError } from './mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from './respond';

let error: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mercadoLivreErrorResponse — the status mapping', () => {
  it('maps each known error to its status', () => {
    expect(mercadoLivreErrorResponse(new MercadoLivreConfigError('sem credenciais')).status).toBe(
      500,
    );
    expect(
      mercadoLivreErrorResponse(new MercadoLivreContaNotConfiguredError('sem conta')).status,
    ).toBe(404);
    expect(
      mercadoLivreErrorResponse(new MercadoLivreReauthRequiredError('no_token', 'morto')).status,
    ).toBe(409);
    expect(mercadoLivreErrorResponse(new MercadoLivreValidationError('shape', [])).status).toBe(
      502,
    );
    expect(mercadoLivreErrorResponse(new MercadoLivreHttpError('nope', 404, {})).status).toBe(502);
    expect(mercadoLivreErrorResponse(new MercadoLivreNetworkError('offline')).status).toBe(503);
  });

  it('still answers with the reason in the body', async () => {
    const res = mercadoLivreErrorResponse(new MercadoLivreConfigError('sem credenciais'));
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'sem credenciais' });
  });
});

describe('the log line', () => {
  // ⚠️ The whole point. Before this, a missing MERCADO_LIVRE_CLIENT_SECRET
  // turned EVERY marketplace route into a `GET … 500` with no cause anywhere in
  // the server terminal — the reason existed only in a response body nobody was
  // watching. A silent 500 is indistinguishable from a crash.
  it('logs the reason for a server-side failure at error level', () => {
    mercadoLivreErrorResponse(
      new MercadoLivreConfigError(
        'MERCADO_LIVRE_CLIENT_ID / MERCADO_LIVRE_CLIENT_SECRET ausentes.',
      ),
    );
    expect(error).toHaveBeenCalledTimes(1);
    const [line] = error.mock.calls[0] as [string];
    expect(line).toContain('[mercado-livre/api]');
    expect(line).toContain('MercadoLivreConfigError');
    expect(line).toContain('HTTP 500');
    expect(line).toContain('MERCADO_LIVRE_CLIENT_SECRET');
  });

  it('passes the error object along so the stack survives on a 5xx', () => {
    const err = new MercadoLivreNetworkError('offline');
    mercadoLivreErrorResponse(err);
    expect(error.mock.calls[0]?.[1]).toBe(err);
  });

  it('keeps a caller-caused 4xx at warn level, not error', () => {
    // A dead grant is the operator's problem to fix by reconnecting, not an
    // incident — logging it as an error would train people to ignore errors.
    mercadoLivreErrorResponse(new MercadoLivreReauthRequiredError('refresh_failed', 'grant morto'));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0] as [string])[0]).toContain('HTTP 409');
  });

  it("includes ML's own upstream status and body, where ML explains itself", () => {
    mercadoLivreErrorResponse(
      new MercadoLivreHttpError('recusado', 400, { message: 'invalid_category_id' }),
    );
    const [line] = error.mock.calls[0] as [string];
    expect(line).toContain('upstream=400');
    expect(line).toContain('invalid_category_id');
  });

  it('includes the validation issues, which name the field that changed', () => {
    mercadoLivreErrorResponse(
      new MercadoLivreValidationError('shape', [{ path: ['path_from_root'] }]),
    );
    const [line] = error.mock.calls[0] as [string];
    expect(line).toContain('path_from_root');
  });

  it('truncates a huge body instead of flooding the log', () => {
    mercadoLivreErrorResponse(new MercadoLivreHttpError('grande', 500, { blob: 'x'.repeat(5000) }));
    const [line] = error.mock.calls[0] as [string];
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(1000);
  });

  it('survives a circular body rather than throwing inside the logger', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      mercadoLivreErrorResponse(new MercadoLivreHttpError('ciclo', 500, circular)),
    ).not.toThrow();
    expect((error.mock.calls[0] as [string])[0]).toContain('[unserializable]');
  });
});

describe('isMercadoLivreError', () => {
  it('rejects an unrelated error so the route rethrows it', () => {
    expect(isMercadoLivreError(new TypeError('bug nosso'))).toBe(false);
    expect(isMercadoLivreError(new MercadoLivreConfigError('x'))).toBe(true);
  });
});
