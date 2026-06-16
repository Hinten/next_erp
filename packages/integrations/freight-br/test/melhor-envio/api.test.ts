import { describe, expect, it } from 'vitest';

import { mockFetch } from '../_helpers/mockFetch';
import { createMelhorEnvioApi } from '../../src/melhor-envio/api';
import { buildCalculatePayload } from '../../src/melhor-envio/calculate';
import { isErroredOption } from '../../src/melhor-envio/types';
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

describe('buildCalculatePayload', () => {
  it('uses a single `package` for one volume and applies defaults', () => {
    const payload = buildCalculatePayload({
      fromPostalCode: '01001000',
      toPostalCode: '20040002',
      volumes: [{ width: 11, height: 2, length: 16, weight: 0.3 }],
    });
    expect(payload.from.postal_code).toBe('01001000');
    expect(payload.to.postal_code).toBe('20040002');
    expect(payload.package).toEqual({ width: 11, height: 2, length: 16, weight: 0.3 });
    expect(payload.volumes).toBeUndefined();
  });

  it('uses a `volumes` array for multiple volumes', () => {
    const payload = buildCalculatePayload({
      fromPostalCode: '01001000',
      toPostalCode: '20040002',
      volumes: [{ weight: 1 }, { weight: 2 }],
    });
    expect(payload.package).toBeUndefined();
    expect(payload.volumes).toHaveLength(2);
    // defaults applied to missing dims
    expect(payload.volumes![0]).toEqual({ width: 20, height: 20, length: 20, weight: 1 });
  });

  it('includes insurance_value only when > 0', () => {
    const withInsurance = buildCalculatePayload({
      fromPostalCode: 'a',
      toPostalCode: 'b',
      volumes: [{ weight: 1 }],
      insuranceValue: 150,
    });
    expect(withInsurance.options?.insurance_value).toBe(150);

    const withoutInsurance = buildCalculatePayload({
      fromPostalCode: 'a',
      toPostalCode: 'b',
      volumes: [{ weight: 1 }],
      insuranceValue: 0,
    });
    expect(withoutInsurance.options?.insurance_value).toBeUndefined();
  });

  it('falls back to a single default volume when none are given', () => {
    const payload = buildCalculatePayload({ fromPostalCode: 'a', toPostalCode: 'b', volumes: [] });
    expect(payload.package).toEqual({ width: 20, height: 20, length: 20, weight: 1 });
  });
});

describe('createMelhorEnvioApi.calculate', () => {
  it('POSTs the request with auth + User-Agent and parses quotable + errored options', async () => {
    const responseBody = [
      {
        id: 1,
        name: 'PAC',
        price: '37.79',
        custom_price: '35.70',
        discount: '2.09',
        currency: 'R$',
        delivery_time: 9,
        delivery_range: { min: 8, max: 9 },
        company: { id: 1, name: 'Correios', picture: 'https://x/correios.png' },
      },
      // errored entry — no price/company, just an `error` (the legacy crash case)
      { id: 2, name: 'SEDEX', error: 'Serviço indisponível para a rota informada.' },
    ];
    const fetchMock = mockFetch(() => new Response(JSON.stringify(responseBody), { status: 200 }));

    const payload = buildCalculatePayload({
      fromPostalCode: '01001000',
      toPostalCode: '20040002',
      volumes: [{ width: 11, height: 2, length: 16, weight: 0.3 }],
    });
    const out = await api(fetchMock).calculate(payload);

    expect(out).toHaveLength(2);
    expect(out[0]!.price).toBe('37.79');
    expect(out[0]!.company?.name).toBe('Correios');
    expect(isErroredOption(out[0]!)).toBe(false);
    expect(isErroredOption(out[1]!)).toBe(true);
    expect(out[1]!.error).toContain('indisponível');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://sandbox.melhorenvio.com.br/api/v2/me/shipment/calculate');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-abc');
    expect(headers['User-Agent']).toContain('@delfrance/erp-next');
    expect(headers['Content-Type']).toBe('application/json');
    const sent = JSON.parse(init?.body as string);
    expect(sent.package).toEqual({ width: 11, height: 2, length: 16, weight: 0.3 });
  });

  it('maps a 422 to MelhorEnvioValidationError with the errors map', async () => {
    const body = {
      message: 'The given data was invalid.',
      errors: { 'to.postal_code': ['O campo to.postal code é obrigatório.'] },
    };
    const fetchMock = mockFetch(() => new Response(JSON.stringify(body), { status: 422 }));
    const err = await api(fetchMock)
      .calculate(
        buildCalculatePayload({ fromPostalCode: 'a', toPostalCode: '', volumes: [{ weight: 1 }] }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MelhorEnvioValidationError);
    expect((err as MelhorEnvioValidationError).errors['to.postal_code']).toBeDefined();
  });
});

describe('createMelhorEnvioApi account', () => {
  it('parses /me (GET, no body) and /me/balance', async () => {
    const meBody = {
      id: 'uuid',
      firstname: 'Magno',
      lastname: 'X',
      email: 'x@me.com',
      document: '123',
    };
    const meFetch = mockFetch(() => new Response(JSON.stringify(meBody), { status: 200 }));
    const me = await api(meFetch).getMe();
    expect(me.firstname).toBe('Magno');
    const meInit = meFetch.mock.calls[0]![1];
    expect(meInit?.method).toBe('GET');
    expect(meInit?.body).toBeUndefined();

    const balFetch = mockFetch(
      () => new Response(JSON.stringify({ balance: 42.5 }), { status: 200 }),
    );
    const bal = await api(balFetch).getBalance();
    expect(bal.balance).toBe(42.5);
  });
});
