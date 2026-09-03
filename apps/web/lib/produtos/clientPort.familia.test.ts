import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';

/**
 * Which produtos a save writes (#1398).
 *
 * ⚠️ The create/edit gate is the highest-consequence line in this PR. Minting on
 * an EDIT would fork a second child on every save of a produto that already has
 * variations — silently, and forever, since nothing later reconciles a child
 * set. So both directions are asserted, not just the create.
 */
const { newDocIdMock } = vi.hoisted(() => ({ newDocIdMock: vi.fn(() => 'child-novo') }));

vi.mock('./docId', () => ({ newDocId: newDocIdMock }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFunctions: () => ({}) }));

// Each handle answers with a ref that names the path it was asked for, so a test
// can assert WHICH documents a save touches.
const docRef = (path: string) => ({ __path: path });
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    docRef: (_db: unknown, _c: unknown, id: string) => docRef(`produtos/${id}`),
  },
}));
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: {
    docRef: (_db: unknown, c: { produtoId: string }, id: string) =>
      docRef(`produtos/${c.produtoId}/extraData/${id}`),
  },
}));
vi.mock('@/lib/data/estoqueProdutoCollection', () => ({
  estoqueProdutoCollection: {
    docRef: (_db: unknown, c: { produtoId: string }, id: string) =>
      docRef(`produtos/${c.produtoId}/estoques/${id}`),
  },
}));
vi.mock('@/lib/data/impostoProdutoCollection', () => ({
  impostoProdutoCollection: {
    docRef: (_db: unknown, c: { produtoId: string }, id: string) =>
      docRef(`produtos/${c.produtoId}/imposto/${id}`),
  },
}));

import { buildProdutoTransactionWrites } from './clientPort';

const db = {} as Firestore;
type Escrita = ReturnType<typeof buildProdutoTransactionWrites>[number];

const paths = (ws: readonly Escrita[]) =>
  ws.map((w) => `${w.type} ${(w.ref as unknown as { __path: string }).__path}`);

/** `TransactionWrite` is a union and `delete` carries no payload. */
const dados = (w: Escrita | undefined): Record<string, unknown> => {
  if (!w || w.type === 'delete') throw new Error('esperava uma escrita com dados');
  return w.data as Record<string, unknown>;
};

const values = { nome: 'Bandeja', sku: 'BAN-1', ehKit: false };

beforeEach(() => {
  newDocIdMock.mockClear();
});

describe('buildProdutoTransactionWrites — the sole member', () => {
  it('mints the child and points the parent at it on CREATE', () => {
    const ws = buildProdutoTransactionWrites(db, 'p1', values, 'criar');
    expect(paths(ws)).toEqual(['set produtos/child-novo', 'update produtos/p1']);
    expect(dados(ws[1])).toEqual({ filhoUnicoId: 'child-novo' });
  });

  // ⚠️ The gate. A produto being edited already has its family (or predates the
  // invariant and belongs to the migration, #1402); minting here would fork a
  // second child on every save.
  it('mints NOTHING on an edit', () => {
    expect(paths(buildProdutoTransactionWrites(db, 'p1', values, 'editar'))).toEqual([]);
    expect(newDocIdMock).not.toHaveBeenCalled();
  });

  // The default is the safe one: a caller that forgets the argument does not
  // silently start minting children.
  it('defaults to NOT minting', () => {
    expect(paths(buildProdutoTransactionWrites(db, 'p1', values))).toEqual([]);
  });

  it('mints exactly ONE child id per call', () => {
    buildProdutoTransactionWrites(db, 'p1', values, 'criar');
    expect(newDocIdMock).toHaveBeenCalledTimes(1);
  });

  it('carries the parent’s fields onto the child', () => {
    const ws = buildProdutoTransactionWrites(
      db,
      'p1',
      { ...values, ehKit: true, componentesKit: { a: { quantidade: 2 } } },
      'criar',
    );
    expect(dados(ws[0])).toMatchObject({
      nome: 'Bandeja',
      sku: 'BAN-1',
      paiId: 'p1',
      ehKit: true,
      componentesKitKeys: ['a'],
    });
  });

  // The subdocument writes must keep riding the same transaction — the sole
  // member is added to them, not substituted for them.
  it('still emits the extraData singleton alongside', () => {
    const ws = buildProdutoTransactionWrites(
      db,
      'p1',
      { ...values, extraData: { descricao: 'x' } },
      'criar',
    );
    expect(paths(ws)).toContain('set produtos/p1/extraData/singleton');
    expect(paths(ws)).toContain('set produtos/child-novo');
  });
});
