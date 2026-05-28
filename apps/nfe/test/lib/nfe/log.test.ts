/**
 * Tests for the safe-logging helpers in `apps/nfe/lib/nfe/log.ts`.
 *
 * These pin the redaction contract so the routes' `safeLog('error', ...)`
 * calls and any future `safeErrorShape` / `redactSensitive` usage
 * can't regress into leaking `responseBody`, cert material, or the
 * cert env vars to stdout.
 */
import { describe, expect, it, vi } from 'vitest';

import { NFeTransportError } from '@delfrance/integrations-nfe';

import {
  redactSensitive,
  safeErrorShape,
  safeLog,
  SENSITIVE_KEYS,
} from '../../../lib/nfe/log';

describe('safeErrorShape', () => {
  it('extracts name + message from a plain Error', () => {
    expect(safeErrorShape(new Error('boom'))).toEqual({
      name: 'Error',
      message: 'boom',
    });
  });

  it('drops responseBody from NFeTransportError — never logs the raw SEFAZ reply', () => {
    const err = new NFeTransportError(
      'SOAP request failed',
      500,
      '<x>SECRET_PROT_SIGNATURE</x>',
    );
    const shape = safeErrorShape(err);
    expect(shape).toEqual({ name: 'NFeTransportError', message: 'SOAP request failed' });
    expect(JSON.stringify(shape)).not.toContain('SECRET_PROT_SIGNATURE');
  });

  it('preserves a `code` property when present', () => {
    const err = new Error('econnreset') as Error & { code: string };
    err.code = 'ECONNRESET';
    expect(safeErrorShape(err)).toEqual({
      name: 'Error',
      message: 'econnreset',
      code: 'ECONNRESET',
    });
  });

  it('does not throw on non-Error values', () => {
    expect(safeErrorShape({ foo: 'bar' })).toEqual({
      name: 'NonError',
      message: '[object Object]',
    });
    expect(safeErrorShape('plain string')).toEqual({
      name: 'NonError',
      message: 'plain string',
    });
    expect(safeErrorShape(null)).toEqual({ name: 'NonError', message: 'null' });
  });
});

describe('redactSensitive', () => {
  it('replaces sensitive top-level keys with [REDACTED]', () => {
    const out = redactSensitive({
      privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----',
      password: 'hunter2',
      cnpj: '12345678000199',
    });
    expect(out).toEqual({
      privateKeyPem: '[REDACTED]',
      password: '[REDACTED]',
      cnpj: '12345678000199',
    });
  });

  it('recurses into nested objects', () => {
    const out = redactSensitive({
      rt: { cert: { password: 'p', cnpj: 'c' } },
    });
    expect(out).toEqual({
      rt: { cert: { password: '[REDACTED]', cnpj: 'c' } },
    });
  });

  it('recurses into arrays', () => {
    const out = redactSensitive([{ password: 'a' }, { cnpj: 'b' }]);
    expect(out).toEqual([{ password: '[REDACTED]' }, { cnpj: 'b' }]);
  });

  it('passes primitives, null, undefined, Date, Buffer through unchanged', () => {
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive('x')).toBe('x');
    expect(redactSensitive(null)).toBe(null);
    expect(redactSensitive(undefined)).toBe(undefined);
    const d = new Date();
    expect(redactSensitive(d)).toBe(d);
    const buf = Buffer.from('hi');
    expect(redactSensitive(buf)).toBe(buf);
  });

  it('redacts env-var-style secret names', () => {
    const out = redactSensitive({
      NFE_CERT_BASE64: 'aaa',
      NFE_CERT_PASSWORD: 'bbb',
      FIREBASE_SERVICE_ACCOUNT: '{"private_key":"..."}',
      NFE_AMBIENTE: 'homologacao',
    });
    expect(out).toEqual({
      NFE_CERT_BASE64: '[REDACTED]',
      NFE_CERT_PASSWORD: '[REDACTED]',
      FIREBASE_SERVICE_ACCOUNT: '[REDACTED]',
      NFE_AMBIENTE: 'homologacao',
    });
  });

  it('SENSITIVE_KEYS covers the documented surface', () => {
    for (const key of [
      'privateKeyPem',
      'certificatePem',
      'certificateDerBase64',
      'pfxBuffer',
      'password',
      'signedXml',
      'nfeXml',
      'responseBody',
      'NFE_CERT_BASE64',
      'NFE_CERT_PASSWORD',
      'FIREBASE_SERVICE_ACCOUNT',
    ]) {
      expect(SENSITIVE_KEYS.has(key)).toBe(true);
    }
  });
});

describe('safeLog', () => {
  it('runs every argument through redactSensitive before calling console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      safeLog('log', '[label]', { password: 'p', cnpj: 'c' });
      expect(spy).toHaveBeenCalledWith('[label]', { password: '[REDACTED]', cnpj: 'c' });
    } finally {
      spy.mockRestore();
    }
  });
});
