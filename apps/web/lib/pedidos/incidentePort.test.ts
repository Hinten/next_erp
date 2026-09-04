import { describe, expect, it, vi } from 'vitest';

const { docRef, runTransaction } = vi.hoisted(() => ({
  docRef: vi.fn(() => ({ __ref: 'incidente' })),
  runTransaction: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({ runTransaction }));
vi.mock('@/lib/data/incidenteCollection', () => ({ incidenteCollection: { docRef } }));

const { createClientIncidentePort } = await import('./incidentePort');

/** Drive the transaction callback with a fake `tx` over a given stored doc. */
async function run(port: ReturnType<typeof createClientIncidentePort>, stored: unknown) {
  const tx = {
    get: vi.fn(async () => ({ exists: () => stored !== null, data: () => stored })),
    update: vi.fn(),
  };
  runTransaction.mockImplementation(async (_db: unknown, fn: (t: unknown) => Promise<void>) => {
    await fn(tx);
  });
  return tx;
}

const db = {} as never;

describe('createClientIncidentePort', () => {
  it('supplies MICROSECONDS — `incidente.ultimaModificacao` is microsSinceEpoch', () => {
    // ⚠️ The Mercado Livre port this one is modelled on uses `Date.now()`,
    // because the ML link stamps are ms. Copying that here would give a
    // comparison three orders of magnitude off (root `CLAUDE.md` rule 7).
    const port = createClientIncidentePort(db, 'ped-1', 'inc-1');
    const before = Date.now() * 1000;
    const now = port.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now() * 1000);
  });

  it('hands patchFor the tx-fresh doc and writes the patch with tx.update', async () => {
    const port = createClientIncidentePort(db, 'ped-1', 'inc-1');
    const tx = await run(port, { motivoDoIncidente: 'armazenado' });

    const seen: unknown[] = [];
    await port.update((current) => {
      seen.push(current);
      return { comentarios: 'novo' };
    });

    expect(seen).toEqual([{ motivoDoIncidente: 'armazenado' }]);
    expect(tx.update).toHaveBeenCalledWith({ __ref: 'incidente' }, { comentarios: 'novo' });
    expect(docRef).toHaveBeenCalledWith(db, { pedidoId: 'ped-1' }, 'inc-1');
  });

  it('passes null for a deleted doc and writes nothing for an empty patch', async () => {
    const port = createClientIncidentePort(db, 'ped-1', 'inc-1');
    const tx = await run(port, null);

    const seen: unknown[] = [];
    await port.update((current) => {
      seen.push(current);
      return {};
    });

    expect(seen).toEqual([null]);
    expect(tx.update).not.toHaveBeenCalled();
  });
});
