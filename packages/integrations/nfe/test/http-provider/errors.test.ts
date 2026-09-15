/**
 * `isRetryableNFeHttpError` — the browser-safe transient classifier (#90).
 * Only network / 5xx / runtime-not-ready (503) qualify; every deterministic
 * error returns false (retrying would replay the same failure).
 */
import { describe, expect, it } from 'vitest';

import {
  isRetryableNFeHttpError,
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeCertificateError,
  NFeDanfeUnavailableError,
  NFeInutilizacaoAbortedError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
  NFeXsdValidationFailedError,
} from '../../src/http-provider';

describe('isRetryableNFeHttpError', () => {
  it('returns true for transient failures', () => {
    expect(isRetryableNFeHttpError(new NFeNetworkError('conn reset'))).toBe(true);
    expect(isRetryableNFeHttpError(new NFeServerError('boom', 500, null))).toBe(true);
    expect(isRetryableNFeHttpError(new NFeRuntimeNotReadyError('cert load failed', null))).toBe(
      true,
    );
  });

  it('returns false for deterministic failures', () => {
    const deterministic = [
      new NFeBadRequestError('bad', null),
      new NFeAuthError('no token', 401, null),
      new NFePedidoNotFoundError('PED-1', null),
      new NFeBlockedError('PED-1', null),
      new NFeInutilizacaoAbortedError('aborted', null),
      new NFeRejectedError('204', 'duplicidade', null),
      new NFeDanfeUnavailableError('not renderable', null),
      new NFeCertificateError('cert invalido', 422, null, 'CERT_INVALIDO'),
      new NFeXsdValidationFailedError('xsd', 500, null),
    ];
    for (const err of deterministic) {
      expect(isRetryableNFeHttpError(err)).toBe(false);
    }
  });

  it('returns false for an XSD failure even though it carries a 5xx status (#1602)', () => {
    // Near-miss of the transient case: the SAME 500, a different class. The XSD
    // failure is deterministic, and a retried Consulta Cadastro re-POSTs to SEFAZ.
    expect(isRetryableNFeHttpError(new NFeXsdValidationFailedError('xsd', 500, null))).toBe(false);
    expect(isRetryableNFeHttpError(new NFeServerError('xsd', 500, null))).toBe(true);
    expect(new NFeXsdValidationFailedError('xsd', 500, null)).not.toBeInstanceOf(NFeServerError);
  });

  it('returns false for non-NFe throwables', () => {
    expect(isRetryableNFeHttpError(new Error('generic'))).toBe(false);
    expect(isRetryableNFeHttpError('string')).toBe(false);
    expect(isRetryableNFeHttpError(null)).toBe(false);
    expect(isRetryableNFeHttpError(undefined)).toBe(false);
  });
});
