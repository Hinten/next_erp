import { describe, expect, it } from 'vitest';
import { CODIGO_ERRO_LINK } from '@delfrance/schemas';
import {
  MercadoPagoError,
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoRequestError,
  MercadoPagoValidationError,
} from '@delfrance/integrations-mercado-pago';

import { MercadoPagoConfigError, MercadoPagoContaNotConfiguredError } from './mercadoPago';
import { isMercadoPagoError, mercadoPagoErrorResponse } from './respond';

async function resposta(err: Parameters<typeof mercadoPagoErrorResponse>[0]) {
  const res = mercadoPagoErrorResponse(err);
  return { status: res.status, corpo: (await res.json()) as Record<string, unknown> };
}

describe('mercadoPagoErrorResponse', () => {
  // #367: the web client tells "this metodo is not a connected Mercado Pago account"
  // (a real answer) from the code-less 404 of a backend that predates the link routes.
  it('an unconfigured account → 404 carrying MP_CONTA_NAO_CONFIGURADA', async () => {
    const r = await resposta(new MercadoPagoContaNotConfiguredError('metodo sem conta'));
    expect(r.status).toBe(404);
    expect(r.corpo).toEqual({
      error: 'metodo sem conta',
      code: CODIGO_ERRO_LINK.contaNaoConfigurada,
    });
  });

  it('the code is exactly the one the shared contract names (a client compares it)', async () => {
    expect(CODIGO_ERRO_LINK.contaNaoConfigurada).toBe('MP_CONTA_NAO_CONFIGURADA');
    const r = await resposta(new MercadoPagoContaNotConfiguredError('x'));
    expect(r.corpo.code).toBe('MP_CONTA_NAO_CONFIGURADA');
  });

  // The near-misses: the ONE 404 that gained a code must not have spread it to the
  // other mappings, each of which already carries (or deliberately lacks) its own.
  it('a server misconfiguration stays a code-less 500', async () => {
    const r = await resposta(new MercadoPagoConfigError('MERCADO_PAGO_CLIENT_ID ausente'));
    expect(r.status).toBe(500);
    expect(r.corpo).toEqual({ error: 'MERCADO_PAGO_CLIENT_ID ausente' });
  });

  it('a dead grant → 409 MP_REAUTH_REQUIRED', async () => {
    const r = await resposta(new MercadoPagoReauthRequiredError('no_token', 'desconectada'));
    expect(r).toEqual({
      status: 409,
      corpo: { error: 'desconectada', code: 'MP_REAUTH_REQUIRED' },
    });
  });

  it('an unexpected response shape → 502 MP_BAD_RESPONSE', async () => {
    const r = await resposta(new MercadoPagoValidationError('campo mudou', []));
    expect(r).toEqual({ status: 502, corpo: { error: 'campo mudou', code: 'MP_BAD_RESPONSE' } });
  });

  it('an upstream HTTP failure → 502 MP_HTTP_ERROR with the upstream status', async () => {
    const r = await resposta(new MercadoPagoHttpError('MP 400: x', 400, {}));
    expect(r).toEqual({
      status: 502,
      corpo: { error: 'MP 400: x', code: 'MP_HTTP_ERROR', upstreamStatus: 400 },
    });
  });

  it('a network failure → 503 MP_NETWORK_ERROR', async () => {
    const r = await resposta(new MercadoPagoNetworkError('sem rede'));
    expect(r).toEqual({ status: 503, corpo: { error: 'sem rede', code: 'MP_NETWORK_ERROR' } });
  });

  // Our OWN outbound body failed its strict schema: a bug on this side, so a generic
  // 500 — never a 4xx that would tell the operator to fix something they cannot.
  it('an outbound body rejected by its strict schema → 500 MP_ERROR', async () => {
    const r = await resposta(
      new MercadoPagoRequestError('corpo inválido: items.0.unit_price', ['items.0.unit_price']),
    );
    expect(r).toEqual({
      status: 500,
      corpo: { error: 'corpo inválido: items.0.unit_price', code: 'MP_ERROR' },
    });
  });

  it('any other MercadoPagoError subclass → 500 MP_ERROR', async () => {
    const r = await resposta(new MercadoPagoError('genérico'));
    expect(r).toEqual({ status: 500, corpo: { error: 'genérico', code: 'MP_ERROR' } });
  });
});

describe('isMercadoPagoError', () => {
  it('accepts the package errors and the two context errors', () => {
    expect(isMercadoPagoError(new MercadoPagoHttpError('x', 500, {}))).toBe(true);
    expect(isMercadoPagoError(new MercadoPagoRequestError('x'))).toBe(true);
    expect(isMercadoPagoError(new MercadoPagoConfigError('x'))).toBe(true);
    expect(isMercadoPagoError(new MercadoPagoContaNotConfiguredError('x'))).toBe(true);
  });

  it('rejects everything else, so a route rethrows it (rule 6)', () => {
    expect(isMercadoPagoError(new TypeError('x'))).toBe(false);
    expect(isMercadoPagoError(new Error('x'))).toBe(false);
    expect(isMercadoPagoError(Object.assign(new Error('x'), { code: 4 }))).toBe(false);
    expect(isMercadoPagoError('MP_ERROR')).toBe(false);
    expect(isMercadoPagoError(null)).toBe(false);
  });
});
