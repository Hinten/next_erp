import { describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import type { PrecosMap } from '@delfrance/schemas';

import { applyPrecoAlteracoes, type ProdutoPrecosSnapshot } from './applyPrecoAlteracoes';
import type { ApplyProgress } from './types';

const db = {} as unknown as Firestore;

function snap(precos: PrecosMap): ProdutoPrecosSnapshot {
  return { precos };
}

describe('applyPrecoAlteracoes', () => {
  it('re-reads each chunk fresh and writes at most chunkSize rows concurrently', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ produtoId: `p${i}`, novoValor: 100 }));
    const fetchFresh = vi.fn(async (_db: Firestore, ids: readonly string[]) => {
      const m = new Map<string, ProdutoPrecosSnapshot>();
      for (const id of ids) m.set(id, snap(null));
      return m;
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const write = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
    });

    const outcomes = await applyPrecoAlteracoes(db, {
      targetListaId: 'lista1',
      rows,
      fetchFresh,
      write,
      chunkSize: 5,
    });

    expect(outcomes).toHaveLength(12);
    expect(fetchFresh).toHaveBeenCalledTimes(3); // 5 + 5 + 2
    expect(fetchFresh.mock.calls[0]![1]).toEqual(rows.slice(0, 5).map((r) => r.produtoId));
    expect(maxInFlight).toBeGreaterThan(1); // actually concurrent, not serial
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it('reports "Produto não encontrado" when the fresh re-read is missing a doc', async () => {
    const fetchFresh = vi.fn(async () => new Map<string, ProdutoPrecosSnapshot>());
    const write = vi.fn(async () => {});

    const outcomes = await applyPrecoAlteracoes(db, {
      targetListaId: 'lista1',
      rows: [{ produtoId: 'ghost', novoValor: 10 }],
      fetchFresh,
      write,
    });

    expect(outcomes).toEqual([
      { produtoId: 'ghost', status: 'erro', erro: 'Produto não encontrado' },
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it('skips a row ("pulado") when the gate rejects it, without writing', async () => {
    const fetchFresh = vi.fn(
      async () => new Map<string, ProdutoPrecosSnapshot>([['p1', snap({ lista1: { valor: 5 } })]]),
    );
    const write = vi.fn(async () => {});
    const gate = vi.fn(() => false);

    const outcomes = await applyPrecoAlteracoes(db, {
      targetListaId: 'lista1',
      rows: [{ produtoId: 'p1', novoValor: 10 }],
      fetchFresh,
      write,
      gate,
    });

    expect(outcomes).toEqual([{ produtoId: 'p1', status: 'pulado', erro: null }]);
    expect(gate).toHaveBeenCalledWith(5, 10);
    expect(write).not.toHaveBeenCalled();
  });

  it('reports "semAlteracao" (no write) when the fresh price already equals the target', async () => {
    const fetchFresh = vi.fn(
      async () => new Map<string, ProdutoPrecosSnapshot>([['p1', snap({ lista1: { valor: 10 } })]]),
    );
    const write = vi.fn(async () => {});

    const outcomes = await applyPrecoAlteracoes(db, {
      targetListaId: 'lista1',
      rows: [{ produtoId: 'p1', novoValor: 10 }],
      fetchFresh,
      write,
    });

    expect(outcomes).toEqual([{ produtoId: 'p1', status: 'semAlteracao', erro: null }]);
    expect(write).not.toHaveBeenCalled();
  });

  it('contains a narrowed FirebaseError to its own row — the rest of the run still proceeds', async () => {
    const fetchFresh = vi.fn(
      async () =>
        new Map<string, ProdutoPrecosSnapshot>([
          ['bad', snap(null)],
          ['good', snap(null)],
        ]),
    );
    const write = vi.fn(async (_db: Firestore, produtoId: string) => {
      if (produtoId === 'bad') throw new FirebaseError('permission-denied', 'Sem permissão');
    });

    const outcomes = await applyPrecoAlteracoes(db, {
      targetListaId: 'lista1',
      rows: [
        { produtoId: 'bad', novoValor: 10 },
        { produtoId: 'good', novoValor: 10 },
      ],
      fetchFresh,
      write,
      chunkSize: 5,
    });

    expect(outcomes).toContainEqual({
      produtoId: 'bad',
      status: 'erro',
      erro: 'permission-denied: Sem permissão',
    });
    expect(outcomes).toContainEqual({ produtoId: 'good', status: 'aplicado', erro: null });
  });

  it('rethrows an un-narrowed error instead of containing it', async () => {
    const fetchFresh = vi.fn(
      async () => new Map<string, ProdutoPrecosSnapshot>([['p1', snap(null)]]),
    );
    const write = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      applyPrecoAlteracoes(db, {
        targetListaId: 'lista1',
        rows: [{ produtoId: 'p1', novoValor: 10 }],
        fetchFresh,
        write,
      }),
    ).rejects.toThrow('boom');
  });

  it('stops issuing further chunks once aborted between chunks, returning the partial result', async () => {
    const controller = new AbortController();
    const rows = Array.from({ length: 10 }, (_, i) => ({ produtoId: `p${i}`, novoValor: 10 }));
    const fetchFresh = vi.fn(async (_db: Firestore, ids: readonly string[]) => {
      const m = new Map<string, ProdutoPrecosSnapshot>();
      for (const id of ids) m.set(id, snap(null));
      return m;
    });
    const write = vi.fn(async () => {});

    const outcomes = await applyPrecoAlteracoes(db, {
      targetListaId: 'lista1',
      rows,
      fetchFresh,
      write,
      chunkSize: 5,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    expect(fetchFresh).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(5);
  });

  it('reports progress monotonically (done/sucesso/erro), ending at the totals', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ produtoId: `p${i}`, novoValor: 10 }));
    const fetchFresh = vi.fn(async (_db: Firestore, ids: readonly string[]) => {
      const m = new Map<string, ProdutoPrecosSnapshot>();
      for (const id of ids) m.set(id, snap(null));
      return m;
    });
    const write = vi.fn(async (_db: Firestore, produtoId: string) => {
      if (produtoId === 'p3') throw new FirebaseError('unavailable', 'Sem conexão');
    });

    const progressCalls: ApplyProgress[] = [];
    const outcomes = await applyPrecoAlteracoes(db, {
      targetListaId: 'lista1',
      rows,
      fetchFresh,
      write,
      chunkSize: 3,
      onProgress: (p) => progressCalls.push({ ...p }),
    });

    expect(outcomes).toHaveLength(7);
    expect(progressCalls).toHaveLength(3); // chunks of 3 + 3 + 1
    for (let i = 1; i < progressCalls.length; i += 1) {
      expect(progressCalls[i]!.done).toBeGreaterThanOrEqual(progressCalls[i - 1]!.done);
      expect(progressCalls[i]!.sucesso).toBeGreaterThanOrEqual(progressCalls[i - 1]!.sucesso);
      expect(progressCalls[i]!.erro).toBeGreaterThanOrEqual(progressCalls[i - 1]!.erro);
    }
    const last = progressCalls[progressCalls.length - 1]!;
    expect(last).toEqual({ done: 7, total: 7, sucesso: 6, erro: 1 });
  });
});
