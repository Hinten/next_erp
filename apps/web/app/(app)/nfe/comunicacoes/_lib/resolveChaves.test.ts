/**
 * `resolveChaves` — the nNF / pedido → chaves resolution behind the
 * /nfe/comunicacoes filter bar. The Firestore layer is mocked at the
 * `@delfrance/data` helper boundary: constraints become inspectable literals
 * and `getDocs` routes on the fake base refs built by the mocked collections.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getDocsMock } = vi.hoisted(() => ({ getDocsMock: vi.fn() }));

vi.mock('firebase/firestore', () => ({
  getDocs: getDocsMock,
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown, constraints: unknown[]) => ({ base, constraints }),
  groupQuery: (_db: unknown, groupId: string) => ({ kind: 'group', groupId }),
  whereEqual: (field: string, value: unknown) => ({ kind: 'eq', field, value }),
  limit: (n: number) => ({ kind: 'limit', n }),
}));

vi.mock('@/lib/data/nfeCollection', () => ({
  NFEV4_COLLECTION_GROUP: 'nfev4',
  nfeCollection: {
    converter: {},
    ref: (_db: unknown, ctx: Record<string, string>) => ({ kind: 'nfev4', ctx }),
  },
}));

vi.mock('@/lib/data/pedidoCollection', () => ({
  pedidoCollection: {
    ref: () => ({ kind: 'pedidos' }),
  },
}));

import type { Firestore } from 'firebase/firestore';
import { MAX_CHAVES, resolveChaves } from './resolveChaves';

const db = {} as Firestore;

interface FakeQuery {
  base: { kind: string; groupId?: string; ctx?: Record<string, string> };
  constraints: Array<{ kind: string; field?: string; value?: unknown; n?: number }>;
}

function snapOf(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    empty: docs.length === 0,
    docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
  };
}

const chave = (n: number) => String(n).repeat(44).slice(0, 44);

afterEach(() => {
  getDocsMock.mockReset();
});

describe('resolveChaves', () => {
  it('nnf: collection-group query on numeracao + filialId, deduped, null chaves dropped', async () => {
    getDocsMock.mockImplementationOnce((q: FakeQuery) => {
      expect(q.base).toEqual({ kind: 'group', groupId: 'nfev4' });
      expect(q.constraints).toContainEqual({ kind: 'eq', field: 'numeracao', value: 777 });
      expect(q.constraints).toContainEqual({ kind: 'eq', field: 'filialId', value: 'F-1' });
      expect(q.constraints).toContainEqual({ kind: 'limit', n: MAX_CHAVES + 1 });
      return Promise.resolve(
        snapOf([
          { id: 'a', data: { chave: chave(1) } },
          { id: 'b', data: { chave: chave(1) } }, // duplicate
          { id: 'c', data: { chave: null } }, // pre-emission doc — dropped
          { id: 'd', data: { chave: chave(2) } },
        ]),
      );
    });

    const out = await resolveChaves(db, 'F-1', { mode: 'nnf', term: '777' });
    expect(out).toEqual({ chaves: [chave(1), chave(2)], truncated: false });
    expect(getDocsMock).toHaveBeenCalledTimes(1);
  });

  it('nnf: flags truncation past MAX_CHAVES and caps the list', async () => {
    const docs = Array.from({ length: MAX_CHAVES + 1 }, (_, i) => ({
      id: `d${i}`,
      data: { chave: `${String(i).padStart(4, '0')}${'9'.repeat(40)}` },
    }));
    getDocsMock.mockResolvedValueOnce(snapOf(docs));

    const out = await resolveChaves(db, 'F-1', { mode: 'nnf', term: '777' });
    expect(out.truncated).toBe(true);
    expect(out.chaves).toHaveLength(MAX_CHAVES);
  });

  it('pedidoId: reads pedidos/{id}/nfev4', async () => {
    getDocsMock.mockImplementationOnce((q: FakeQuery) => {
      expect(q.base).toEqual({ kind: 'nfev4', ctx: { pedidoId: 'PED-1' } });
      return Promise.resolve(snapOf([{ id: 'a', data: { chave: chave(3) } }]));
    });

    const out = await resolveChaves(db, 'F-1', { mode: 'pedidoId', term: 'PED-1' });
    expect(out).toEqual({ chaves: [chave(3)], truncated: false });
  });

  it('pedidoNumero: two hops — pedidos by numero (string, no coercion) then per-pedido nfev4', async () => {
    getDocsMock.mockImplementation((q: FakeQuery) => {
      if (q.base.kind === 'pedidos') {
        expect(q.constraints).toContainEqual({ kind: 'eq', field: 'numero', value: '0042' });
        return Promise.resolve(
          snapOf([
            { id: 'PED-1', data: { numero: '0042' } },
            { id: 'PED-2', data: { numero: '0042' } },
          ]),
        );
      }
      expect(q.base.kind).toBe('nfev4');
      const pedidoId = q.base.ctx?.pedidoId;
      return Promise.resolve(
        pedidoId === 'PED-1'
          ? snapOf([{ id: 'a', data: { chave: chave(4) } }])
          : snapOf([
              { id: 'b', data: { chave: chave(5) } },
              { id: 'c', data: { chave: chave(4) } }, // dupe across pedidos
            ]),
      );
    });

    const out = await resolveChaves(db, 'F-1', { mode: 'pedidoNumero', term: '0042' });
    expect(out).toEqual({ chaves: [chave(4), chave(5)], truncated: false });
    expect(getDocsMock).toHaveBeenCalledTimes(3);
  });

  it('empty result: no matches → empty chave list, not truncated', async () => {
    getDocsMock.mockResolvedValueOnce(snapOf([]));
    const out = await resolveChaves(db, 'F-1', { mode: 'nnf', term: '999999' });
    expect(out).toEqual({ chaves: [], truncated: false });
  });
});
