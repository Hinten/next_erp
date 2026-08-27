import { describe, expect, it } from 'vitest';

import { mockFetch } from '../_helpers/mockFetch';
import { createMelhorEnvioApi } from '../../src/melhor-envio/api';
import { buildCalculatePayload } from '../../src/melhor-envio/calculate';
import { isErroredOption } from '../../src/melhor-envio/types';
import {
  MelhorEnvioError,
  MelhorEnvioSchemaError,
  MelhorEnvioValidationError,
} from '../../src/melhor-envio/errors';
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

describe('createMelhorEnvioApi.listAgencies', () => {
  it('GETs with the company + location filters in the query string', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify([{ id: 195 }]), { status: 200 }));
    const out = await api(fetchMock).listAgencies({
      company: 2,
      country: 'BR',
      state: 'RS',
      city: 'Caxias do Sul',
    });
    expect(out).toEqual([{ id: 195 }]);
    const u = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(u.pathname).toBe('/api/v2/me/shipment/agencies');
    expect(u.searchParams.get('country')).toBe('BR');
    expect(u.searchParams.get('state')).toBe('RS');
    expect(u.searchParams.get('city')).toBe('Caxias do Sul');
    expect(u.searchParams.get('company')).toBe('2');
  });

  it('omits city for a state-wide list (the picker fallback)', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify([]), { status: 200 }));
    await api(fetchMock).listAgencies({ company: 2, country: 'BR', state: 'RS' });
    const u = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(u.searchParams.has('city')).toBe(false);
    expect(u.searchParams.get('state')).toBe('RS');
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

/**
 * ⚠️ The API client called `schema.parse(parsed)` on the success path while its
 * own sibling `oauth.ts` had already been fixed to `safeParse` — with a comment
 * saying why, and a dedicated `MelhorEnvioSchemaError` created for it whose doc
 * block describes this exact failure. A raw `ZodError` is not a
 * `MelhorEnvioError`, so `isMelhorEnvioError(err)` rejected it, every route
 * guard fell through, and a malformed 200 from ME surfaced as an unhandled 500
 * naming nothing.
 *
 * ⚠️ Note which endpoints these use, and why. `meSchema` and `balanceSchema` are
 * fully tolerant — every field `.optional().nullable()`, the object
 * `.passthrough()` — so `{}` is a perfectly VALID `/me`. That tolerance is
 * correct for a provider payload we barely read, and it means the only way to
 * fail those is a field of the wrong TYPE. `printResponseSchema` is the
 * contrast: its `url` is required, because the buy flow cannot do anything
 * without it.
 */
describe('a malformed 200 from Melhor Envio', () => {
  function respondendo(body: unknown) {
    return api(
      mockFetch(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  }

  it('⭐ throws a MelhorEnvioError the route guards recognise', async () => {
    // `print` needs `url`; a 200 without it cannot be acted on.
    const err = await respondendo({})
      .print(['1'])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MelhorEnvioSchemaError);
    // ⚠️ THE decisive assertion, and why `instanceof MelhorEnvioError` rather
    // than the guard itself: `isMelhorEnvioError` lives in apps/melhor-envio and
    // is not importable from this package, but the only thing it asks of this
    // error is exactly this. A bare `ZodError` fails it — which was the bug.
    expect(err).toBeInstanceOf(MelhorEnvioError);
  });

  it('names the failing field without echoing the body', async () => {
    // ⚠️ A ME 200 body holds account data, and this message reaches the browser.
    // Field PATHS only — the same rule the class doc states for `issues`, and
    // the reason that class deliberately carries no `body`.
    const err = (await respondendo({ id: 123, firstname: 'Fulano da Silva' })
      .getMe()
      .catch((e: unknown) => e)) as MelhorEnvioSchemaError;

    expect(err).toBeInstanceOf(MelhorEnvioSchemaError);
    expect(err.message).toContain('id');
    expect(err.message).not.toContain('Fulano');
    expect(err.message).not.toContain('123');
  });

  it('leaves the deliberate tolerance alone', async () => {
    // The control that matters most here. `/me` is `.passthrough()` with every
    // field optional, so an unfamiliar payload is VALID by design — this fix
    // must not quietly turn that into a rejection.
    await expect(respondendo({ campo: 'que nunca vimos' }).getMe()).resolves.toMatchObject({
      campo: 'que nunca vimos',
    });
  });

  it('still returns a well-formed body', async () => {
    await expect(respondendo({ url: 'https://me/label.pdf' }).print(['1'])).resolves.toMatchObject({
      url: 'https://me/label.pdf',
    });
  });

  it('⭐ collapses array indices — a 20-option quote names the column ONCE', async () => {
    // ⚠️ `calculate` and `listAgencies` return ARRAYS, and the local
    // `new Set(issues.map(i => i.path.join('.')))` this replaced de-duplicated
    // AFTER the index was baked into the path. One null `name` across twenty
    // options produced `0.name, 1.name, … 19.name` in a message
    // `melhorEnvioErrorResponse` hands to the browser. `camposInvalidos` says
    // `[].name`, and caps the list.
    const vinte = Array.from({ length: 20 }, (_v, i) => ({ id: i + 1, name: null }));

    const err = (await respondendo(vinte)
      .calculate({ from: { postal_code: '01001000' }, to: { postal_code: '20040002' } } as never)
      .catch((e: unknown) => e)) as MelhorEnvioSchemaError;

    expect(err).toBeInstanceOf(MelhorEnvioSchemaError);
    expect(err.message).toContain('[].name');
    expect(err.message).not.toContain('19.name');
  });
});
