import { describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  type MercadoLivreApi,
  type MlPayment,
  type MlSellerShippingSchedule,
  type MlShipment,
} from '@delfrance/integrations-mercado-livre';
import type { HorarioDeCorte } from '@delfrance/schemas';

import {
  MlLogisticTypeInvalidoError,
  MlPrazoDespachoNotFoundError,
  latestApprovedPaymentMs,
  resolvePrazoDespacho,
  selectPrazoDespachoAgainstFresh,
  type ResolvePrazoDespachoArgs,
} from './orderPrazoDespacho';

const HANDLING_LIMIT = '2026-07-20T00:00:00.000-03:00';
const DELIVERY_LIMIT = '2026-07-22T00:00:00.000-03:00';

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

function withoutHandling(): MlShipment {
  return shipment({ shipping_option: { estimated_handling_limit: null } });
}

function schedule(days: MlSellerShippingSchedule['schedule']): MlSellerShippingSchedule {
  return { schedule: days };
}

function horario(
  diaDaSemana: HorarioDeCorte['diaDaSemana'],
  horaDeCorte: number,
  minutosDeCorte: number,
  horaPostagem: number,
  minutosPostagem = 0,
): HorarioDeCorte {
  return {
    diaDaSemana,
    horaDeCorte,
    minutosDeCorte,
    prazoDePostagem: 0,
    horaPostagem,
    minutosPostagem,
  };
}

function payment(over: Partial<MlPayment> = {}): MlPayment {
  return { id: 1, status: 'approved', date_approved: '2026-07-20T13:59:00-03:00', ...over };
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

function args(
  api: MercadoLivreApi,
  over: Partial<ResolvePrazoDespachoArgs> = {},
): ResolvePrazoDespachoArgs {
  return {
    api,
    shipment: shipment(),
    sellerId: 999,
    loadStoredPrazoUs: vi.fn(async () => null),
    loadHorarioDeCorte: vi.fn(async () => null),
    loadPayments: vi.fn(async () => []),
    ...over,
  };
}

describe('resolvePrazoDespacho', () => {
  it('returns a valid SLA without executing any loader or schedule call', async () => {
    const { api, mocks } = makeApi({
      getShipmentSla: vi.fn(async () => ({ expected_date: '2026-07-21T12:00:00.000-03:00' })),
    });
    const input = args(api);

    await expect(resolvePrazoDespacho(input)).resolves.toEqual({
      prazoDespachoUs: Date.parse('2026-07-21T12:00:00.000-03:00') * 1000,
      fonte: 'sla',
    });
    expect(input.loadStoredPrazoUs).not.toHaveBeenCalled();
    expect(input.loadHorarioDeCorte).not.toHaveBeenCalled();
    expect(input.loadPayments).not.toHaveBeenCalled();
    expect(mocks.getSellerShippingSchedule).not.toHaveBeenCalled();
  });

  it('returns the stored deadline after SLA failure without loading schedules or payments', async () => {
    const { api, mocks } = makeApi();
    const input = args(api, { loadStoredPrazoUs: vi.fn(async () => 1_753_000_000_000_000) });

    await expect(resolvePrazoDespacho(input)).resolves.toEqual({
      prazoDespachoUs: 1_753_000_000_000_000,
      fonte: 'armazenado',
    });
    expect(mocks.getSellerShippingSchedule).not.toHaveBeenCalled();
    expect(input.loadHorarioDeCorte).not.toHaveBeenCalled();
    expect(input.loadPayments).not.toHaveBeenCalled();
  });

  it('keeps estimated_handling_limit ahead of the operational fallback', async () => {
    const { api } = makeApi();
    const input = args(api);

    await expect(resolvePrazoDespacho(input)).resolves.toEqual({
      prazoDespachoUs: Date.UTC(2026, 6, 20, 21) * 1000,
      fonte: 'estimated-handling',
    });
    expect(input.loadHorarioDeCorte).not.toHaveBeenCalled();
    expect(input.loadPayments).not.toHaveBeenCalled();
  });

  it.each([
    ['before cutoff', '2026-07-20T13:59:00-03:00'],
    ['at the inclusive cutoff minute', '2026-07-20T14:00:00-03:00'],
  ])('uses same-day posting for payment %s', async (_label, approvedAt) => {
    const { api } = makeApi();
    const result = await resolvePrazoDespacho(
      args(api, {
        shipment: withoutHandling(),
        loadHorarioDeCorte: vi.fn(async () => [horario(1, 14, 0, 18)]),
        loadPayments: vi.fn(async () => [payment({ date_approved: approvedAt })]),
      }),
    );

    expect(result).toEqual({
      prazoDespachoUs: Date.parse('2026-07-20T18:00:00-03:00') * 1000,
      fonte: 'pagamento-corte',
    });
  });

  it('advances one configured day when payment is one minute after cutoff', async () => {
    const { api } = makeApi();
    const result = await resolvePrazoDespacho(
      args(api, {
        shipment: withoutHandling(),
        loadHorarioDeCorte: vi.fn(async () => [horario(1, 14, 0, 18), horario(2, 14, 0, 18)]),
        loadPayments: vi.fn(async () => [payment({ date_approved: '2026-07-20T14:01:00-03:00' })]),
      }),
    );

    expect(result.prazoDespachoUs).toBe(Date.parse('2026-07-21T18:00:00-03:00') * 1000);
  });

  it('uses the São Paulo civil Sunday even when the instant is already Monday in UTC', async () => {
    const { api } = makeApi();
    const result = await resolvePrazoDespacho(
      args(api, {
        shipment: withoutHandling(),
        loadHorarioDeCorte: vi.fn(async () => [horario(7, 23, 0, 23, 30)]),
        loadPayments: vi.fn(async () => [payment({ date_approved: '2026-07-20T01:30:00.000Z' })]),
      }),
    );

    expect(result.prazoDespachoUs).toBe(Date.parse('2026-07-19T23:30:00-03:00') * 1000);
  });

  it('chooses the latest valid approved payment and ignores other statuses and invalid dates', () => {
    expect(
      latestApprovedPaymentMs([
        payment({ id: 1, status: 'pending', date_approved: '2026-07-20T14:00:00Z' }),
        payment({ id: 2, date_approved: 'not-a-date' }),
        payment({ id: 3, date_approved: '2026-07-20T12:00:00Z' }),
        payment({ id: 4, date_approved: null }),
        payment({ id: 5, date_approved: '2026-07-20T13:00:00Z' }),
      ]),
    ).toBe(Date.parse('2026-07-20T13:00:00Z'));
  });

  it('does not load payments without a valid operator schedule', async () => {
    const { api } = makeApi();
    const input = args(api, { shipment: withoutHandling() });

    await expect(resolvePrazoDespacho(input)).resolves.toEqual({
      prazoDespachoUs: null,
      fonte: 'indisponivel',
    });
    expect(input.loadPayments).not.toHaveBeenCalled();
  });

  it('returns unavailable when no approved payment has a valid approval date', async () => {
    const { api } = makeApi();
    await expect(
      resolvePrazoDespacho(
        args(api, {
          shipment: withoutHandling(),
          loadHorarioDeCorte: vi.fn(async () => [horario(1, 14, 0, 18)]),
          loadPayments: vi.fn(async () => [
            payment({ status: 'rejected' }),
            payment({ id: 2, date_approved: null }),
          ]),
        }),
      ),
    ).resolves.toEqual({ prazoDespachoUs: null, fonte: 'indisponivel' });
  });

  it('propagates a seller-schedule endpoint failure without falling back to operator time', async () => {
    const boom = new MercadoLivreHttpError('rate limited', 429, null);
    const { api } = makeApi({
      getSellerShippingSchedule: vi.fn(async () => {
        throw boom;
      }),
    });
    const input = args(api, { loadHorarioDeCorte: vi.fn(async () => [horario(1, 14, 0, 18)]) });

    await expect(resolvePrazoDespacho(input)).rejects.toBe(boom);
    expect(input.loadHorarioDeCorte).not.toHaveBeenCalled();
  });

  it('rethrows a non-MercadoLivreError from SLA', async () => {
    const { api } = makeApi({
      getShipmentSla: vi.fn(async () => {
        throw new TypeError('unexpected');
      }),
    });
    await expect(resolvePrazoDespacho(args(api))).rejects.toThrow(TypeError);
  });

  it('throws for an invalid logistic type before the seller schedule request', async () => {
    const { api, mocks } = makeApi();
    await expect(
      resolvePrazoDespacho(args(api, { shipment: shipment({ logistic_type: 'teleport' }) })),
    ).rejects.toBeInstanceOf(MlLogisticTypeInvalidoError);
    expect(mocks.getSellerShippingSchedule).not.toHaveBeenCalled();
  });

  it('throws when every day in the 14-step seller schedule search is closed', async () => {
    const closed = { work: false, detail: [] };
    const { api } = makeApi({
      getSellerShippingSchedule: vi.fn(async () =>
        schedule({
          monday: closed,
          tuesday: closed,
          wednesday: closed,
          thursday: closed,
          friday: closed,
          saturday: closed,
          sunday: closed,
        }),
      ),
    });
    await expect(resolvePrazoDespacho(args(api))).rejects.toBeInstanceOf(
      MlPrazoDespachoNotFoundError,
    );
  });

  it('recognizes HTTP and network errors as the tolerated SLA family', () => {
    expect(new MercadoLivreHttpError('x', 404, null)).toBeInstanceOf(MercadoLivreError);
    expect(new MercadoLivreNetworkError('x')).toBeInstanceOf(MercadoLivreError);
  });
});

describe('selectPrazoDespachoAgainstFresh', () => {
  const resolvedUs = Date.parse('2026-07-20T18:00:00-03:00') * 1000;
  const storedUs = Date.parse('2026-07-21T18:00:00-03:00') * 1000;

  it('keeps the transaction-fresh stored deadline over a lower-precedence source', () => {
    expect(
      selectPrazoDespachoAgainstFresh(
        { prazoDespachoUs: resolvedUs, fonte: 'pagamento-corte' },
        storedUs,
      ),
    ).toBe(storedUs);
  });

  it('keeps SLA authoritative over the transaction-fresh stored deadline', () => {
    expect(
      selectPrazoDespachoAgainstFresh({ prazoDespachoUs: resolvedUs, fonte: 'sla' }, storedUs),
    ).toBe(resolvedUs);
  });
});
