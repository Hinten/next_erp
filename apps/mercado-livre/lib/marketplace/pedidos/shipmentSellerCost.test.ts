import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { resolveShipmentSellerCost } from './shipmentSellerCost';

const NOSSO_SELLER = 81387353;

function api(getShipmentCosts: unknown): MercadoLivreApi {
  return { getShipmentCosts } as unknown as MercadoLivreApi;
}

/** ML's own documented example body (*Gerenciamento de Envios* → Costs), single seller. */
const CORPO_DOC = {
  gross_amount: 24.55,
  receiver: {
    user_id: 74425755,
    cost: 0,
    compensation: 0,
    save: 0,
    discounts: [{ rate: 1, type: 'loyal', promoted_amount: 4.07 }],
  },
  senders: [
    {
      user_id: NOSSO_SELLER,
      cost: 8.19,
      compensation: 0,
      save: 0,
      discounts: [{ rate: 0.6, type: 'mandatory', promoted_amount: 12.29 }],
    },
  ],
};

describe('resolveShipmentSellerCost', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it("reads OUR sender's cost out of ML's documented body", async () => {
    const spy = vi.fn(async () => CORPO_DOC);
    expect(await resolveShipmentSellerCost(api(spy), 47868202073, NOSSO_SELLER)).toBe(8.19);
    expect(spy).toHaveBeenCalledWith(47868202073);
  });

  it('MATCHES ON user_id, never senders[0]', async () => {
    // ⚠️ The assertion this file exists for. "um só envio poderá conter produtos
    // de diferentes vendedores" — and on the single-seller shipment every test
    // above still passes with `senders[0]`, so only a multi-seller body can tell
    // the two implementations apart. Getting it wrong books another seller's
    // freight cost onto our pedido, silently.
    const spy = vi.fn(async () => ({
      gross_amount: 40,
      senders: [
        { user_id: 999999, cost: 31.5 },
        { user_id: NOSSO_SELLER, cost: 8.19 },
      ],
    }));
    expect(await resolveShipmentSellerCost(api(spy), 1, NOSSO_SELLER)).toBe(8.19);
  });

  it('matches a user_id ML quoted as a string', async () => {
    const spy = vi.fn(async () => ({ senders: [{ user_id: String(NOSSO_SELLER), cost: 3.5 }] }));
    expect(await resolveShipmentSellerCost(api(spy), 1, NOSSO_SELLER)).toBe(3.5);
  });

  it('returns 0 for a fully subsidised shipment — a real cost, not a miss', async () => {
    // The mirror of the `lead_time.cost` trap: there a genuine 0 must not be READ
    // as the seller's cost, here a genuine 0 must not be DISCARDED as absent. A
    // truthiness test would return null and silently keep a stale stored value.
    const spy = vi.fn(async () => ({ senders: [{ user_id: NOSSO_SELLER, cost: 0 }] }));
    expect(await resolveShipmentSellerCost(api(spy), 1, NOSSO_SELLER)).toBe(0);
  });

  it('returns null when no sender row is ours', async () => {
    const spy = vi.fn(async () => ({ senders: [{ user_id: 999999, cost: 31.5 }] }));
    expect(await resolveShipmentSellerCost(api(spy), 1, NOSSO_SELLER)).toBeNull();
  });

  it('returns null when our row carries no numeric cost', async () => {
    const spy = vi.fn(async () => ({ senders: [{ user_id: NOSSO_SELLER, cost: null }] }));
    expect(await resolveShipmentSellerCost(api(spy), 1, NOSSO_SELLER)).toBeNull();
  });

  it('makes no call at all without a seller id', async () => {
    const spy = vi.fn(async () => CORPO_DOC);
    expect(await resolveShipmentSellerCost(api(spy), 1, null)).toBeNull();
    // `contaBag.sellerUserId ?? 0` is the idiom at both call sites, so 0 must be
    // treated as "no seller" rather than matched against a real user_id.
    expect(await resolveShipmentSellerCost(api(spy), 1, 0)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('degrades to null on an ML failure instead of poisoning the import', async () => {
    // Same tolerance `resolvePrazoDespacho` applies to a failed SLA read: one
    // field of an order import must not throw the whole thing into a Cloud Tasks
    // retry loop over a cost. The merge then preserves what is stored.
    const spy = vi.fn(async () => {
      throw new MercadoLivreHttpError('boom', 500, {});
    });
    expect(await resolveShipmentSellerCost(api(spy), 1, NOSSO_SELLER)).toBeNull();
  });

  it('RETHROWS anything that is not a MercadoLivreError', async () => {
    // A bug in this module is not a shape we decided to tolerate (root
    // `CLAUDE.md` rule 6).
    const boom = new TypeError('bug');
    await expect(
      resolveShipmentSellerCost(
        api(
          vi.fn(async () => {
            throw boom;
          }),
        ),
        1,
        NOSSO_SELLER,
      ),
    ).rejects.toBe(boom);
  });
});
