import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';

const h = vi.hoisted(() => ({
  getDocsFromServer: vi.fn(),
  ref: vi.fn(() => ({ __coll: 'produtos' })),
}));

// ⚠️ Only the SERVER reader is mocked, deliberately: a switch to the
// cache-tolerant `getDocs` would blow up here rather than silently mint a SKU
// that already exists (the whole point of the fail-closed probe).
vi.mock('firebase/firestore', () => ({ getDocsFromServer: h.getDocsFromServer }));
vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown, constraints: unknown[]) => ({ base, constraints }),
  limit: (n: number) => ({ limit: n }),
  whereEqual: (field: string, value: unknown) => ({ field, value }),
}));
vi.mock('@/lib/data/produtoCollection', () => ({ produtoCollection: { ref: h.ref } }));

import { gerarSkuUnico } from './skuUnico';

const db = {} as Firestore;
const livre = { empty: true };
const ocupado = { empty: false };

/** Deterministic candidates: 0.5 → '499999999', 0.1 → '99999999'. */
function candidatos(...valores: number[]) {
  let i = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => valores[i++] ?? 0.5);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('gerarSkuUnico', () => {
  it('returns the first candidate no produto holds', async () => {
    candidatos(0.5);
    h.getDocsFromServer.mockResolvedValueOnce(livre);

    await expect(gerarSkuUnico(db)).resolves.toBe('499999999');
    expect(h.getDocsFromServer).toHaveBeenCalledTimes(1);
  });

  it('retries past a candidate that is already taken', async () => {
    candidatos(0.5, 0.1);
    h.getDocsFromServer.mockResolvedValueOnce(ocupado).mockResolvedValueOnce(livre);

    await expect(gerarSkuUnico(db)).resolves.toBe('99999999');
    expect(h.getDocsFromServer).toHaveBeenCalledTimes(2);
  });

  it('gives up after 10 probes rather than returning a taken SKU', async () => {
    candidatos();
    h.getDocsFromServer.mockResolvedValue(ocupado);

    await expect(gerarSkuUnico(db)).resolves.toBe(null);
    expect(h.getDocsFromServer).toHaveBeenCalledTimes(10);
  });

  // ⚠️ The batch case: values minted earlier in the same operation are not in
  // Firestore yet, so a probe cannot see them — without this filter two
  // siblings of a duplicated family could be handed the same SKU and BOTH
  // probes would pass.
  it('skips a value already minted in this operation, without probing it', async () => {
    candidatos(0.5, 0.1);
    h.getDocsFromServer.mockResolvedValueOnce(livre);

    await expect(gerarSkuUnico(db, new Set(['499999999']))).resolves.toBe('99999999');
    expect(h.getDocsFromServer).toHaveBeenCalledTimes(1);
  });

  // Fail-closed: a caller that cannot verify uniqueness must not act as if it had.
  it('propagates a probe failure instead of returning a candidate', async () => {
    candidatos(0.5);
    h.getDocsFromServer.mockRejectedValueOnce(new FirebaseError('unavailable', 'offline'));

    await expect(gerarSkuUnico(db)).rejects.toThrow(FirebaseError);
  });
});
