import { describe, expect, it } from 'vitest';

import { mockFetch } from '../_helpers/mockFetch';
import { createMelhorEnvioApi } from '../../src/melhor-envio/api';
import { MelhorEnvioValidationError } from '../../src/melhor-envio/errors';
import { melhorEnvioBaseUrl } from '../../src/melhor-envio/oauth';

function api(fetchImpl: typeof globalThis.fetch) {
  return createMelhorEnvioApi({
    baseUrl: melhorEnvioBaseUrl(true),
    getAccessToken: async () => 'token-abc',
    userAgent: '@delfrance/erp-next (contato@example.com)',
    fetchImpl,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createMelhorEnvioApi — etiqueta methods', () => {
  it('addToCart POSTs to /me/cart and returns the created label id', async () => {
    const f = mockFetch(() => json({ id: 'label-1', protocol: 'ORD-1', status: 'pending' }, 201));
    const item = await api(f).addToCart({ service: 3, to: { postal_code: '20040002' } });

    expect(item.id).toBe('label-1');
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`${melhorEnvioBaseUrl(true)}/api/v2/me/cart`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ service: 3, to: { postal_code: '20040002' } });
  });

  it('addToCart maps a 422 to MelhorEnvioValidationError', async () => {
    const f = mockFetch(() =>
      json({ message: 'Dados inválidos', errors: { service: ['obrigatório'] } }, 422),
    );
    await expect(api(f).addToCart({ service: 0 })).rejects.toBeInstanceOf(
      MelhorEnvioValidationError,
    );
  });

  it('getOrder GETs /me/orders/{id} (url-encoded) and parses the lifecycle flags', async () => {
    const f = mockFetch(() =>
      json({
        id: 'lbl 1',
        status: 'paid',
        tracking: 'ME123BR',
        paid_at: '2026-06-17 10:00:00',
        generated_at: null,
        canceled_at: null,
        suspended_at: null,
      }),
    );
    const order = await api(f).getOrder('lbl 1');

    expect(order.tracking).toBe('ME123BR');
    expect(order.paid_at).toBe('2026-06-17 10:00:00');
    expect(order.generated_at).toBeNull();
    const [url] = f.mock.calls[0]!;
    expect(String(url)).toBe(`${melhorEnvioBaseUrl(true)}/api/v2/me/orders/lbl%201`);
  });

  it('checkout POSTs { orders: [...] } to /shipment/checkout', async () => {
    const f = mockFetch(() => json({ purchase: { id: 'p1' } }));
    await api(f).checkout(['label-1']);

    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`${melhorEnvioBaseUrl(true)}/api/v2/me/shipment/checkout`);
    expect(JSON.parse(String(init?.body))).toEqual({ orders: ['label-1'] });
  });

  it('generate POSTs { orders: [...] } to /shipment/generate', async () => {
    const f = mockFetch(() => json({ 'label-1': { status: 'generated' } }));
    await api(f).generate(['label-1']);

    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`${melhorEnvioBaseUrl(true)}/api/v2/me/shipment/generate`);
    expect(JSON.parse(String(init?.body))).toEqual({ orders: ['label-1'] });
  });

  it('print returns the label URL', async () => {
    const f = mockFetch(() => json({ url: 'https://sandbox.melhorenvio.com.br/imprimir/abc' }));
    const printed = await api(f).print(['label-1']);

    expect(printed.url).toBe('https://sandbox.melhorenvio.com.br/imprimir/abc');
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`${melhorEnvioBaseUrl(true)}/api/v2/me/shipment/print`);
    expect(JSON.parse(String(init?.body))).toEqual({ orders: ['label-1'] });
  });

  it('tracking POSTs { orders: [...] } to /shipment/tracking', async () => {
    const f = mockFetch(() => json({ 'label-1': { status: 'posted' } }));
    await api(f).tracking(['label-1']);

    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`${melhorEnvioBaseUrl(true)}/api/v2/me/shipment/tracking`);
    expect(JSON.parse(String(init?.body))).toEqual({ orders: ['label-1'] });
  });
});
