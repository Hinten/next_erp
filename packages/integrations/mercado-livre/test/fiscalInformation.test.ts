import { describe, expect, it, vi } from 'vitest';

import { type MercadoLivreApiConfig, createMercadoLivreApi } from '../src/api';
import { MercadoLivreHttpError } from '../src/errors';
import type { MlFiscalInformationBody } from '../src/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchMock = ReturnType<typeof vi.fn>;

function cfg(fetchMock: FetchMock): MercadoLivreApiConfig {
  return {
    getAccessToken: async () => 'live-token',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    retryDelayMs: () => 0,
  };
}

function chamada(fetchMock: FetchMock, i = 0) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return {
    url,
    method: init.method,
    body: init.body == null ? undefined : (JSON.parse(String(init.body)) as unknown),
    headers: init.headers as Record<string, string>,
  };
}

const CORPO: MlFiscalInformationBody = {
  sku: 'CAM-P-AZ',
  title: 'Camiseta azul P',
  type: 'single',
  register_type: 'final',
  measurement_unit: 'UN',
  tax_information: {
    ncm: '61091000',
    origin_type: 'manufacturer',
    origin_detail: '0',
    csosn: '102',
    gross_weight: 0.21,
  },
};

describe('items/fiscal_information — the Faturador fiscal SKU (#745)', () => {
  it('createFiscalInformation POSTs the body verbatim, Bearer-authenticated', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ...CORPO, seller_id: '359450559', can_resale: false }, 201),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const res = await api.createFiscalInformation(CORPO);

    const c = chamada(fetchMock);
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://api.mercadolibre.com/items/fiscal_information');
    expect(c.body).toEqual(CORPO);
    expect(c.headers.Authorization).toBe('Bearer live-token');
    expect(res.sku).toBe('CAM-P-AZ');
    // Tolerant: the resale block ML added later rides through.
    expect((res as Record<string, unknown>).can_resale).toBe(false);
  });

  it('updateFiscalInformation PUTs to the ENCODED sku — a `/` in a SKU cannot re-route the call', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ sku: 'KIT/2 #A' }));
    const api = createMercadoLivreApi(cfg(fetchMock));
    const { sku: _sku, ...semSku } = CORPO;

    await api.updateFiscalInformation('KIT/2 #A', semSku);

    const c = chamada(fetchMock);
    expect(c.method).toBe('PUT');
    expect(c.url).toBe('https://api.mercadolibre.com/items/fiscal_information/KIT%2F2%20%23A');
    expect(c.body).toEqual(semSku);
  });

  it('an unknown SKU surfaces as MercadoLivreHttpError carrying the status and ML body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { message: 'Sku not found by sku: X and caller.id: 1', error_code: '404 NOT_FOUND' },
        404,
      ),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const { sku: _sku, ...semSku } = CORPO;

    const err = await api.updateFiscalInformation('X', semSku).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreHttpError);
    expect((err as MercadoLivreHttpError).status).toBe(404);
  });

  describe('linkFiscalInformationItem', () => {
    it('with a variation id sends `variation_id`', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ sku: 'S', item_id: 'MLB1', variation_id: 42, status: 'active' }, 201),
      );
      const api = createMercadoLivreApi(cfg(fetchMock));

      const res = await api.linkFiscalInformationItem({
        sku: 'S',
        itemId: 'MLB1',
        variationId: 42,
      });

      const c = chamada(fetchMock);
      expect(c.method).toBe('POST');
      expect(c.url).toBe('https://api.mercadolibre.com/items/fiscal_information/items');
      expect(c.body).toEqual({ sku: 'S', item_id: 'MLB1', variation_id: 42 });
      expect(res.status).toBe('active');
    });

    it('without one OMITS the key (the documented no-variation shape) and reads ML’s `""` back', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ sku: 'S', item_id: 'MLB1', variation_id: '', status: 'active' }, 201),
      );
      const api = createMercadoLivreApi(cfg(fetchMock));

      const res = await api.linkFiscalInformationItem({
        sku: 'S',
        itemId: 'MLB1',
        variationId: null,
      });

      expect(chamada(fetchMock).body).toEqual({ sku: 'S', item_id: 'MLB1' });
      expect(res.variation_id).toBe('');
    });
  });

  describe('getCanInvoice', () => {
    it('item-level GET', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ item_id: 'MLB1', seller_id: '9', variation_id: '', status: true }),
      );
      const api = createMercadoLivreApi(cfg(fetchMock));

      const res = await api.getCanInvoice('MLB1');

      const c = chamada(fetchMock);
      expect(c.method).toBe('GET');
      expect(c.url).toBe('https://api.mercadolibre.com/can_invoice/items/MLB1');
      expect(res.status).toBe(true);
    });

    it('variation-level GET (the docs’ template is missing a slash — this one is not)', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ item_id: 'MLB1', variation_id: '94754627308', status: false }),
      );
      const api = createMercadoLivreApi(cfg(fetchMock));

      const res = await api.getCanInvoice('MLB1', 94754627308);

      expect(chamada(fetchMock).url).toBe(
        'https://api.mercadolibre.com/can_invoice/items/MLB1/variations/94754627308',
      );
      expect(res.status).toBe(false);
    });
  });
});
