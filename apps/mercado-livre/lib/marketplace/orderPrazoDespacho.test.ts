import { describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  type MercadoLivreApi,
  type MlSellerShippingSchedule,
  type MlShipment,
} from '@delfrance/integrations-mercado-livre';

import {
  MlLogisticTypeInvalidoError,
  MlPrazoDespachoNotFoundError,
  resolvePrazoDespacho,
} from './orderPrazoDespacho';

/* ------------------------------- fixtures -------------------------------- */

// 2026-07-20 is a Monday (2026-01-01 is a Thursday; day-count confirms it),
// picked as the `estimated_handling_limit` anchor so the worked examples below
// can be hand-derived without guessing a weekday.
const HANDLING_LIMIT = '2026-07-20T00:00:00.000-03:00'; // Monday, local midnight -03:00 == 2026-07-20T03:00:00Z
const DELIVERY_LIMIT = '2026-07-22T00:00:00.000-03:00'; // only the trailing "-03:00" is read (see file docstring)

function shipment(over: Partial<MlShipment> = {}): MlShipment {
  return {
    id: 555,
    logistic_type: 'drop_off',
    shipping_option: {
      estimated_handling_limit: { date: HANDLING_LIMIT },
      estimated_delivery_limit: { date: DELIVERY_LIMIT },
    },
    ...over,
  };
}

function schedule(days: MlSellerShippingSchedule['schedule']): MlSellerShippingSchedule {
  return { schedule: days };
}

function makeApi(
  overrides: {
    getShipmentSla?: MercadoLivreApi['getShipmentSla'];
    getSellerShippingSchedule?: MercadoLivreApi['getSellerShippingSchedule'];
  } = {},
) {
  const mocks = {
    getShipmentSla:
      overrides.getShipmentSla ??
      vi.fn(async () => {
        throw new MercadoLivreHttpError('sla not found', 404, null);
      }),
    getSellerShippingSchedule:
      overrides.getSellerShippingSchedule ??
      vi.fn(async () => schedule({ monday: { work: true, detail: [{ cutoff: '18:00' }] } })),
  };
  return { api: mocks as unknown as MercadoLivreApi, mocks };
}

describe('resolvePrazoDespacho', () => {
  it('returns the SLA expected_date directly when the SLA call succeeds, without touching the schedule endpoint', async () => {
    const { api, mocks } = makeApi({
      getShipmentSla: vi.fn(async () => ({ expected_date: '2026-07-21T12:00:00.000-03:00' })),
    });

    const result = await resolvePrazoDespacho({
      api,
      shipment: shipment(),
      sellerId: 999,
      fallbackUs: null,
    });

    expect(result).toBe(Date.parse('2026-07-21T12:00:00.000-03:00') * 1000);
    expect(mocks.getSellerShippingSchedule).not.toHaveBeenCalled();
  });

  it('falls through to the schedule computation when the SLA call fails (worked example: same-day cutoff)', async () => {
    const { api } = makeApi({
      getShipmentSla: vi.fn(async () => {
        throw new MercadoLivreHttpError('sla not found', 404, null);
      }),
      getSellerShippingSchedule: vi.fn(async (sellerId, logisticType) => {
        expect(sellerId).toBe(999);
        expect(logisticType).toBe('drop_off');
        return schedule({ monday: { work: true, detail: [{ cutoff: '18:00' }] } });
      }),
    });

    const result = await resolvePrazoDespacho({
      api,
      shipment: shipment(),
      sellerId: 999,
      fallbackUs: null,
    });

    // Hand-derived: local midnight (-03:00) of 2026-07-20 == 2026-07-20T03:00:00Z,
    // + the Monday cutoff (18:00) == 2026-07-20T21:00:00Z, which is after the
    // 03:00Z anchor so it is returned directly (no forward search needed).
    expect(result).toBe(Date.UTC(2026, 6, 20, 21, 0, 0, 0) * 1000);
  });

  it("borrows the next working day's cutoff TIME but keeps the anchor DATE (legacy getNextDay quirk, no offset applied)", async () => {
    const { api } = makeApi({
      getSellerShippingSchedule: vi.fn(async () =>
        schedule({
          monday: { work: false, detail: [] },
          tuesday: { work: true, detail: [{ cutoff: '09:00' }] },
        }),
      ),
    });

    const result = await resolvePrazoDespacho({
      api,
      shipment: shipment(),
      sellerId: 999,
      fallbackUs: null,
    });

    // Same local-midnight anchor (2026-07-20T03:00:00Z) + Tuesday's 09:00
    // cutoff == 2026-07-20T12:00:00Z — note the DATE stays the 20th (Monday),
    // not the 21st (Tuesday), because `getNextDay` calls `parseDespacho`
    // without an `offset`.
    expect(result).toBe(Date.UTC(2026, 6, 20, 12, 0, 0, 0) * 1000);
  });

  it('returns the caller-supplied fallback when the SLA call fails, without hitting the schedule endpoint', async () => {
    const { api, mocks } = makeApi({
      getShipmentSla: vi.fn(async () => {
        throw new MercadoLivreNetworkError('fetch failed');
      }),
    });

    const result = await resolvePrazoDespacho({
      api,
      shipment: shipment(),
      sellerId: 999,
      fallbackUs: 1_753_000_000_000_000,
    });

    expect(result).toBe(1_753_000_000_000_000);
    expect(mocks.getSellerShippingSchedule).not.toHaveBeenCalled();
  });

  it('returns null when the SLA fails, there is no fallback, and estimated_handling_limit is absent', async () => {
    const { api, mocks } = makeApi({
      getShipmentSla: vi.fn(async () => {
        throw new MercadoLivreHttpError('sla not found', 404, null);
      }),
    });

    const result = await resolvePrazoDespacho({
      api,
      shipment: shipment({ shipping_option: { estimated_handling_limit: null } }),
      sellerId: 999,
      fallbackUs: null,
    });

    expect(result).toBeNull();
    expect(mocks.getSellerShippingSchedule).not.toHaveBeenCalled();
  });

  it('treats a null/unparseable SLA expected_date the same as an SLA failure (falls through)', async () => {
    const { api } = makeApi({
      getShipmentSla: vi.fn(async () => ({ expected_date: null })),
    });

    const result = await resolvePrazoDespacho({
      api,
      shipment: shipment(),
      sellerId: 999,
      fallbackUs: 42_000_000,
    });

    expect(result).toBe(42_000_000);
  });

  it('rethrows an error the ML package did not raise instead of swallowing it (no generic catch)', async () => {
    const { api } = makeApi({
      getShipmentSla: vi.fn(async () => {
        throw new TypeError('unexpected');
      }),
    });

    await expect(
      resolvePrazoDespacho({ api, shipment: shipment(), sellerId: 999, fallbackUs: null }),
    ).rejects.toThrow(TypeError);
  });

  it('lets a schedule-endpoint failure propagate uncaught (legacy does not wrap that call)', async () => {
    const boom = new MercadoLivreHttpError('rate limited', 429, null);
    const { api } = makeApi({
      getSellerShippingSchedule: vi.fn(async () => {
        throw boom;
      }),
    });

    await expect(
      resolvePrazoDespacho({ api, shipment: shipment(), sellerId: 999, fallbackUs: null }),
    ).rejects.toBe(boom);
  });

  it('throws MlLogisticTypeInvalidoError for an unrecognized logistic_type before calling the schedule endpoint', async () => {
    const { api, mocks } = makeApi();

    await expect(
      resolvePrazoDespacho({
        api,
        shipment: shipment({ logistic_type: 'teleport' }),
        sellerId: 999,
        fallbackUs: null,
      }),
    ).rejects.toBeInstanceOf(MlLogisticTypeInvalidoError);
    expect(mocks.getSellerShippingSchedule).not.toHaveBeenCalled();
  });

  it('throws MlPrazoDespachoNotFoundError when every day in the 14-step forward search is closed', async () => {
    const { api } = makeApi({
      getSellerShippingSchedule: vi.fn(async () =>
        schedule({
          monday: { work: false, detail: [] },
          tuesday: { work: false, detail: [] },
          wednesday: { work: false, detail: [] },
          thursday: { work: false, detail: [] },
          friday: { work: false, detail: [] },
          saturday: { work: false, detail: [] },
          sunday: { work: false, detail: [] },
        }),
      ),
    });

    await expect(
      resolvePrazoDespacho({ api, shipment: shipment(), sellerId: 999, fallbackUs: null }),
    ).rejects.toBeInstanceOf(MlPrazoDespachoNotFoundError);
  });

  it('sanity: MercadoLivreHttpError/NetworkError used above are MercadoLivreError instances (the tolerated bucket)', () => {
    expect(new MercadoLivreHttpError('x', 404, null)).toBeInstanceOf(MercadoLivreError);
    expect(new MercadoLivreNetworkError('x')).toBeInstanceOf(MercadoLivreError);
  });
});
