import { beforeEach, describe, expect, it, vi } from 'vitest';

import { comprarEtiqueta } from '../../src/melhor-envio/comprarEtiqueta';
import type {
  ComprarEtiquetaApi,
  ComprarEtiquetaStep,
} from '../../src/melhor-envio/comprarEtiqueta';
import { MelhorEnvioLabelTerminalError } from '../../src/melhor-envio/errors';
import type { Order } from '../../src/melhor-envio/types';

/** A fake order; pass the lifecycle timestamps the test cares about. */
function order(partial: Partial<Order> = {}): Order {
  return { id: 'label-1', tracking: 'ME123BR', ...partial };
}

/** Shared call-order log so we can assert the anti-loss anchor ordering. */
let log: string[];

function makeApi(over: Partial<ComprarEtiquetaApi> = {}): ComprarEtiquetaApi {
  return {
    addToCart: vi.fn(async () => {
      log.push('addToCart');
      return { id: 'new-label' };
    }),
    getOrder: vi.fn(async () => {
      log.push('getOrder');
      return order();
    }),
    checkout: vi.fn(async () => {
      log.push('checkout');
      return {};
    }),
    generate: vi.fn(async () => {
      log.push('generate');
      return {};
    }),
    print: vi.fn(async () => {
      log.push('print');
      return { url: 'https://sandbox.melhorenvio.com.br/imprimir/abc' };
    }),
    ...over,
  };
}

function deps(api: ComprarEtiquetaApi, printLabelId: string | null) {
  const persistPrintLabelId = vi.fn(async (_id: string) => {
    log.push('persist');
  });
  const steps: ComprarEtiquetaStep[] = [];
  return {
    api,
    printLabelId,
    persistPrintLabelId,
    buildCartPayload: vi.fn(() => ({ service: 3 })),
    onProgress: (s: ComprarEtiquetaStep) => steps.push(s),
    steps,
  };
}

beforeEach(() => {
  log = [];
});

describe('comprarEtiqueta', () => {
  it('fresh buy: cart → persist (before checkout) → checkout → generate → print', async () => {
    const api = makeApi();
    const d = deps(api, null);

    const result = await comprarEtiqueta(d);

    expect(d.buildCartPayload).toHaveBeenCalledTimes(1);
    expect(d.persistPrintLabelId).toHaveBeenCalledWith('new-label');
    expect(result.printLabelId).toBe('new-label');
    expect(result.printUrl).toBe('https://sandbox.melhorenvio.com.br/imprimir/abc');
    expect(result.tracking).toBe('ME123BR');

    // Anti-loss anchor: persistence happens BEFORE checkout spends balance.
    expect(log.indexOf('persist')).toBeLessThan(log.indexOf('checkout'));
    expect(log).toEqual(['addToCart', 'persist', 'checkout', 'generate', 'print', 'getOrder']);
  });

  it('resume after paid: skips cart + checkout, still generates and prints', async () => {
    const api = makeApi({
      getOrder: vi
        .fn()
        // initial fetch: already paid, not generated
        .mockResolvedValueOnce(order({ paid_at: '2026-06-17 10:00:00', generated_at: null }))
        // finalize fetch
        .mockResolvedValueOnce(order({ tracking: 'ME999BR' })),
    });
    const d = deps(api, 'existing-label');

    const result = await comprarEtiqueta(d);

    expect(api.addToCart).not.toHaveBeenCalled();
    expect(d.persistPrintLabelId).not.toHaveBeenCalled();
    expect(api.checkout).not.toHaveBeenCalled();
    expect(api.generate).toHaveBeenCalledWith(['existing-label']);
    expect(result.printLabelId).toBe('existing-label');
    expect(result.tracking).toBe('ME999BR');
  });

  it('resume after generated: skips both checkout and generate', async () => {
    const api = makeApi({
      getOrder: vi
        .fn()
        .mockResolvedValueOnce(
          order({ paid_at: '2026-06-17 10:00:00', generated_at: '2026-06-17 10:05:00' }),
        )
        .mockResolvedValueOnce(order()),
    });
    const d = deps(api, 'existing-label');

    await comprarEtiqueta(d);

    expect(api.checkout).not.toHaveBeenCalled();
    expect(api.generate).not.toHaveBeenCalled();
    expect(api.print).toHaveBeenCalledWith(['existing-label']);
  });

  it('throws a terminal error for a canceled label and does not re-buy', async () => {
    const api = makeApi({
      getOrder: vi.fn(async () => order({ canceled_at: '2026-06-17 09:00:00' })),
    });
    const promise = comprarEtiqueta(deps(api, 'existing-label'));

    await expect(promise).rejects.toBeInstanceOf(MelhorEnvioLabelTerminalError);
    await expect(promise).rejects.toHaveProperty('reason', 'canceled');
    expect(api.checkout).not.toHaveBeenCalled();
    expect(api.addToCart).not.toHaveBeenCalled();
  });

  it('throws a terminal error for a suspended label', async () => {
    const api = makeApi({
      getOrder: vi.fn(async () => order({ suspended_at: '2026-06-17 09:00:00' })),
    });
    const d = deps(api, 'existing-label');

    await expect(comprarEtiqueta(d)).rejects.toMatchObject({ reason: 'suspended' });
  });
});
