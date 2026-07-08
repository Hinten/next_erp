import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineProduto } from '@delfrance/schemas';

const { getDocMock, getDocsMock } = vi.hoisted(() => ({
  getDocMock: vi.fn(),
  getDocsMock: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({ getDoc: getDocMock, getDocs: getDocsMock }));
// Mock the whole data package: defineCollection (so the collection modules load)
// + the query helpers used here, each returning an inspectable object.
vi.mock('@delfrance/data', () => ({
  defineCollection: () => ({
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ id }),
    ref: () => ({}),
    converter: {},
    resolvePath: () => '',
  }),
  buildQuery: (base: unknown, constraints: unknown) => ({ base, constraints }),
  whereEqual: (field: string, value: unknown) => ({ field, value }),
  whereDocIdIn: (ids: string[]) => ({ ids }),
  limit: (n: number) => ({ limit: n }),
  orderByField: (field: string, dir: string) => ({ orderBy: field, dir }),
  groupQuery: (_db: unknown, group: string) => ({ group }),
}));

import { collectComponentIds, findPedidoCandidates } from './loadPedidoCheckout';
import { outrosCheckoutsQuery } from './queries';

const db = {} as never;
const idSnap = (id: string, data: Record<string, unknown> | null) => ({
  id,
  exists: () => data !== null,
  data: () => data,
});
const docsSnap = (rows: Array<{ id: string; data: Record<string, unknown> }>) => ({
  docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
});

const ep = (id: string, kit?: Record<string, number>): EngineProduto => ({
  id,
  nome: id,
  sku: null,
  ehKit: kit !== undefined,
  componentesKit: kit
    ? Object.fromEntries(Object.entries(kit).map(([k, q]) => [k, { quantidade: q }]))
    : null,
  fotos: null,
});

describe('collectComponentIds', () => {
  it('collects unseen kit components, skipping already-fetched line produtos', () => {
    const wave1 = new Map<string, EngineProduto>([
      ['A', ep('A', { X: 1, Y: 2 })],
      ['X', ep('X')], // already a line item → skip
      ['B', ep('B')], // non-kit
    ]);
    expect(collectComponentIds(wave1).sort()).toEqual(['Y']);
  });

  it('returns [] with no kits', () => {
    expect(collectComponentIds(new Map([['A', ep('A')]]))).toEqual([]);
  });
});

describe('findPedidoCandidates', () => {
  beforeEach(() => {
    getDocMock.mockReset();
    getDocsMock.mockReset();
  });

  it('returns none for blank text', async () => {
    expect(await findPedidoCandidates(db, '   ')).toEqual({ kind: 'none' });
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('resolves a saída pedido by id + numero, deduped to one', async () => {
    getDocMock.mockResolvedValue(idSnap('ped-1', { ehSaida: true, numero: '100' }));
    getDocsMock.mockResolvedValue(
      docsSnap([{ id: 'ped-1', data: { numero: '100', ehSaida: true } }]),
    );
    expect(await findPedidoCandidates(db, 'ped-1')).toEqual({
      kind: 'one',
      candidate: { id: 'ped-1', numero: '100' },
    });
  });

  it('ignores an entrada pedido matched by id', async () => {
    getDocMock.mockResolvedValue(idSnap('ped-e', { ehSaida: false, numero: '9' }));
    getDocsMock.mockResolvedValue(docsSnap([]));
    expect(await findPedidoCandidates(db, 'ped-e')).toEqual({ kind: 'none' });
  });

  it('returns many when id and numero resolve to different pedidos', async () => {
    getDocMock.mockResolvedValue(idSnap('ped-1', { ehSaida: true, numero: 'X' }));
    getDocsMock.mockResolvedValue(
      docsSnap([{ id: 'ped-2', data: { numero: '55', ehSaida: true } }]),
    );
    const r = await findPedidoCandidates(db, '55');
    expect(r.kind).toBe('many');
    if (r.kind === 'many') expect(r.candidates.map((c) => c.id).sort()).toEqual(['ped-1', 'ped-2']);
  });

  it('skips the doc-id lookup when the text contains a slash', async () => {
    getDocsMock.mockResolvedValue(docsSnap([]));
    await findPedidoCandidates(db, 'a/b');
    expect(getDocMock).not.toHaveBeenCalled();
  });
});

describe('outrosCheckoutsQuery', () => {
  it('scopes to documents/usuarios/<uid>, newest first, capped at 50', () => {
    const q = outrosCheckoutsQuery(db, 'uid-9') as unknown as {
      constraints: Array<Record<string, unknown>>;
    };
    expect(q.constraints).toContainEqual({
      field: 'usuarioCheckoutFretePedidoOuterRef',
      value: 'documents/usuarios/uid-9',
    });
    expect(q.constraints).toContainEqual({ orderBy: 'timestamp', dir: 'desc' });
    expect(q.constraints).toContainEqual({ limit: 50 });
  });
});
