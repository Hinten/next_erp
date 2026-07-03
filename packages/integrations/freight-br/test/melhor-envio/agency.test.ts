import { describe, expect, it, vi } from 'vitest';

import { createMelhorEnvioApi } from '../../src/melhor-envio/api';
import {
  companyForService,
  ensureCartAgency,
  pickAgency,
  type AgencyResolverApi,
} from '../../src/melhor-envio/agency';
import { melhorEnvioBaseUrl } from '../../src/melhor-envio/oauth';
import type { Agency, ShipmentService } from '../../src/melhor-envio/types';

const JADLOG_SERVICES: ShipmentService[] = [
  { id: 1, name: 'PAC', company: { id: 1, name: 'Correios' } },
  { id: 3, name: '.Package', company: { id: 2, name: 'Jadlog' } },
];

function resolver(over: Partial<AgencyResolverApi> = {}): AgencyResolverApi {
  return {
    listServices: vi.fn(async () => JADLOG_SERVICES),
    listAgencies: vi.fn(async () => [{ id: 195 }, { id: 196 }] as Agency[]),
    ...over,
  };
}

describe('pickAgency', () => {
  it('returns the first (nearest) agency, or null when empty', () => {
    expect(pickAgency([{ id: 195 }, { id: 196 }] as Agency[])?.id).toBe(195);
    expect(pickAgency([])).toBeNull();
  });
});

describe('companyForService', () => {
  it('resolves the carrier id behind a service, or null when unknown', async () => {
    const api = resolver();
    expect(await companyForService(api, 3)).toBe(2);
    expect(await companyForService(api, 99)).toBeNull();
  });
});

describe('ensureCartAgency', () => {
  const jadlogCart = { service: 3, from: { state_abbr: 'RS', city: 'Caxias do Sul' } };

  it('injects the nearest agency for a drop-off carrier (Jadlog)', async () => {
    const api = resolver();
    const out = (await ensureCartAgency(api, jadlogCart)) as typeof jadlogCart & {
      agency?: number;
    };
    expect(out.agency).toBe(195);
    expect(api.listAgencies).toHaveBeenCalledWith({
      company: 2,
      country: 'BR',
      state: 'RS',
      city: 'Caxias do Sul',
    });
  });

  it('leaves the cart untouched when the caller already chose an agency', async () => {
    const api = resolver();
    const cart = { ...jadlogCart, agency: 999 };
    const out = await ensureCartAgency(api, cart);
    expect(out).toBe(cart);
    expect(api.listServices).not.toHaveBeenCalled();
  });

  it('does not inject when the carrier has no agencies (Correios)', async () => {
    const api = resolver({ listAgencies: vi.fn(async () => []) });
    const out = (await ensureCartAgency(api, {
      service: 1,
      from: { state_abbr: 'SP', city: 'São Paulo' },
    })) as {
      agency?: number;
    };
    expect(out.agency).toBeUndefined();
  });

  it('skips when the sender location is missing', async () => {
    const api = resolver();
    const out = await ensureCartAgency(api, { service: 3, from: { state_abbr: 'RS', city: '' } });
    expect((out as { agency?: number }).agency).toBeUndefined();
    expect(api.listServices).not.toHaveBeenCalled();
  });

  it('skips when the carrier behind the service is unknown', async () => {
    const api = resolver();
    const out = await ensureCartAgency(api, {
      service: 99,
      from: { state_abbr: 'RS', city: 'Caxias do Sul' },
    });
    expect((out as { agency?: number }).agency).toBeUndefined();
    expect(api.listAgencies).not.toHaveBeenCalled();
  });
});

describe('createMelhorEnvioApi.addToCart auto-agency', () => {
  function routedFetch() {
    return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/shipment/services')) {
        return new Response(JSON.stringify(JADLOG_SERVICES), { status: 200 });
      }
      if (url.includes('/shipment/agencies')) {
        return new Response(JSON.stringify([{ id: 195 }]), { status: 200 });
      }
      if (url.includes('/me/cart')) {
        return new Response(JSON.stringify({ id: 'order-1', status: 'pending' }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it('resolves + injects the agency into the cart POST for a drop-off carrier', async () => {
    const fetchMock = routedFetch();
    const api = createMelhorEnvioApi({
      baseUrl: melhorEnvioBaseUrl(true),
      getAccessToken: async () => 'token-abc',
      userAgent: '@delfrance/erp-next (contato@example.com)',
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    const out = await api.addToCart({
      service: 3,
      from: { state_abbr: 'RS', city: 'Caxias do Sul' },
    } as Parameters<typeof api.addToCart>[0]);
    expect(out.id).toBe('order-1');

    const cartCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/me/cart'));
    expect(cartCall).toBeDefined();
    const body = JSON.parse((cartCall![1] as RequestInit).body as string);
    expect(body.agency).toBe(195);

    const agenciesCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/shipment/agencies'),
    );
    expect(String(agenciesCall![0])).toContain('company=2');
    expect(String(agenciesCall![0])).toContain('state=RS');
  });
});
