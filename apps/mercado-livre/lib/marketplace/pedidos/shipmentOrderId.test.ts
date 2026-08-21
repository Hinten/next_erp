import { describe, expect, it, vi } from 'vitest';
import type { MercadoLivreApi, MlShipment } from '@delfrance/integrations-mercado-livre';
import { resolveShipmentOrderId } from './shipmentOrderId';

const shipment = (over: Record<string, unknown> = {}): MlShipment =>
  ({ id: 777, status: 'shipped', ...over }) as unknown as MlShipment;

function api(getShipmentOrders: unknown): MercadoLivreApi {
  return { getShipmentOrders } as unknown as MercadoLivreApi;
}

describe('resolveShipmentOrderId', () => {
  it('uses the legacy field when ML still sends it, sparing a round-trip', () => {
    const spy = vi.fn(async () => []);
    return resolveShipmentOrderId(api(spy), shipment({ order_id: 42 })).then((id) => {
      expect(id).toBe(42);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('falls back to /shipments/{id}/orders once the field is gone', async () => {
    // The migrated body carries no `order_id` at all (#957).
    const spy = vi.fn(async () => [{ order_id: '2000014428837134', item_id: 'MLB1' }]);
    expect(await resolveShipmentOrderId(api(spy), shipment())).toBe(2000014428837134);
    expect(spy).toHaveBeenCalledWith(777);
  });

  it('skips rows with no order_id and takes the first usable one', async () => {
    const spy = vi.fn(async () => [{ order_id: null }, { order_id: 55 }, { order_id: 66 }]);
    expect(await resolveShipmentOrderId(api(spy), shipment())).toBe(55);
  });

  it('returns null when ML knows of no orders for the shipment', async () => {
    expect(await resolveShipmentOrderId(api(vi.fn(async () => [])), shipment())).toBeNull();
  });

  it('ignores a non-numeric legacy id rather than returning NaN', async () => {
    const spy = vi.fn(async () => [{ order_id: 7 }]);
    expect(await resolveShipmentOrderId(api(spy), shipment({ order_id: 'lixo' }))).toBe(7);
  });

  it('PROPAGATES an endpoint failure instead of reporting "no order"', async () => {
    // A transient failure recorded as `sem-order-id` would look like a permanent
    // "nothing to link" skip and the notification would never be retried.
    const boom = new Error('ML 500');
    await expect(
      resolveShipmentOrderId(
        api(
          vi.fn(async () => {
            throw boom;
          }),
        ),
        shipment(),
      ),
    ).rejects.toBe(boom);
  });
});
