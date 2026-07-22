import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';

// `vi.mock` is hoisted, so anything its factory closes over must come from
// `vi.hoisted`.
const { firestoreMock } = vi.hoisted(() => {
  const txMock = { set: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const runTransactionMock = vi.fn(
    async (_db: unknown, fn: (tx: typeof txMock) => Promise<void>) => {
      await fn(txMock);
    },
  );
  const docMock = vi.fn(() => ({ id: 'NEW_ID' }));
  const collectionMock = vi.fn(() => ({ withConverter: () => 'COLL_REF' }));
  return {
    firestoreMock: { txMock, runTransactionMock, docMock, collectionMock },
  };
});

vi.mock('firebase/firestore', () => ({
  runTransaction: firestoreMock.runTransactionMock,
  doc: firestoreMock.docMock,
  collection: firestoreMock.collectionMock,
}));

import { NothingChangedError, saveRecord, type TransactionWrite } from './saveRecord';

const schema = z.object({
  nome: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  telefone: z.string().nullable().optional(),
});

function fakeCollection(): CollectionHandle<typeof schema> {
  return {
    resolvePath: () => 'clientes',
    ref: () => 'COLLECTION_REF' as never,
    docRef: () => ({ id: 'EXISTING_ID' }) as never,
    converter: {} as never,
    merge: () => Promise.resolve(),
  };
}

beforeEach(() => {
  firestoreMock.txMock.set.mockReset();
  firestoreMock.txMock.update.mockReset();
  firestoreMock.txMock.delete.mockReset();
  firestoreMock.runTransactionMock.mockClear();
  firestoreMock.docMock.mockClear();
  firestoreMock.collectionMock.mockClear();
});

describe('saveRecord', () => {
  it('throws NothingChangedError in update mode when dirtyFields is empty', async () => {
    await expect(
      saveRecord({
        db: {} as never,
        collection: fakeCollection(),
        pathContext: {},
        recordId: 'EXISTING_ID',
        values: { nome: 'x' },
        dirtyFields: {},
        currentUserUid: 'u1',
      }),
    ).rejects.toBeInstanceOf(NothingChangedError);
    expect(firestoreMock.runTransactionMock).not.toHaveBeenCalled();
  });

  it('on update, sends only the patch of dirty fields to tx.update', async () => {
    const result = await saveRecord({
      db: {} as never,
      collection: fakeCollection(),
      pathContext: {},
      recordId: 'EXISTING_ID',
      values: { nome: 'novo nome', email: 'old@x', telefone: '11' },
      dirtyFields: { nome: true },
      currentUserUid: 'u1',
    });
    expect(firestoreMock.runTransactionMock).toHaveBeenCalledOnce();
    expect(firestoreMock.txMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'EXISTING_ID' }),
      { nome: 'novo nome' },
    );
    expect(firestoreMock.txMock.set).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'EXISTING_ID', patch: { nome: 'novo nome' } });
  });

  it('preserves explicit null in the patch (NullClearButton path)', async () => {
    await saveRecord({
      db: {} as never,
      collection: fakeCollection(),
      pathContext: {},
      recordId: 'EXISTING_ID',
      values: { email: null },
      dirtyFields: { email: true },
      currentUserUid: 'u1',
    });
    expect(firestoreMock.txMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'EXISTING_ID' }),
      { email: null },
    );
  });

  it('on create, calls tx.set with the full doc and a fresh ref', async () => {
    const result = await saveRecord({
      db: {} as never,
      collection: fakeCollection(),
      pathContext: {},
      values: { nome: 'novo', email: null },
      dirtyFields: { nome: true, email: true },
      currentUserUid: 'u1',
    });
    expect(firestoreMock.txMock.set).toHaveBeenCalledOnce();
    expect(firestoreMock.txMock.set.mock.calls[0]![1]).toEqual({ nome: 'novo', email: null });
    expect(result.id).toBe('NEW_ID');
    expect(firestoreMock.txMock.update).not.toHaveBeenCalled();
  });
});

describe('saveRecord — siblingWrites (atomic same-transaction writes)', () => {
  const sibling: TransactionWrite = {
    type: 'set',
    ref: { id: 'sibling' } as never,
    data: { x: 1 },
  };

  it('on create, writes the main doc AND the siblings in the same transaction', async () => {
    const result = await saveRecord({
      db: {} as never,
      collection: fakeCollection(),
      pathContext: {},
      values: { nome: 'novo' },
      dirtyFields: { nome: true },
      currentUserUid: 'u1',
      siblingWrites: (id) => [{ ...sibling, data: { x: id } }],
    });
    // One set for the main doc, one for the sibling — keyed by the minted id.
    expect(firestoreMock.txMock.set).toHaveBeenCalledTimes(2);
    expect(firestoreMock.txMock.set).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sibling' }),
      { x: 'NEW_ID' },
    );
    expect(result.id).toBe('NEW_ID');
  });

  it('an update touching ONLY a sibling commits the sibling but skips the main-doc write', async () => {
    // Empty dirtyFields ⇒ empty produto patch; `ultimaModificacao` present in
    // values would (pre-fix) get stamped onto the patch and resurrect the main
    // write — assert it does NOT (Copilot review #203).
    await saveRecord({
      db: {} as never,
      collection: fakeCollection(),
      pathContext: {},
      recordId: 'EXISTING_ID',
      values: { nome: 'unchanged', ultimaModificacao: null } as never,
      dirtyFields: {},
      currentUserUid: 'u1',
      stampUnit: 'ms',
      siblingWrites: () => [sibling],
    });
    expect(firestoreMock.txMock.set).toHaveBeenCalledTimes(1); // only the sibling
    expect(firestoreMock.txMock.update).not.toHaveBeenCalled(); // main doc untouched
  });

  it('still throws NothingChangedError when the patch is empty AND there are no siblings', async () => {
    await expect(
      saveRecord({
        db: {} as never,
        collection: fakeCollection(),
        pathContext: {},
        recordId: 'EXISTING_ID',
        values: { nome: 'x' },
        dirtyFields: {},
        currentUserUid: 'u1',
        siblingWrites: () => [],
      }),
    ).rejects.toBeInstanceOf(NothingChangedError);
  });

  it('runs a delete sibling via tx.delete (e.g. a cleared imposto)', async () => {
    await saveRecord({
      db: {} as never,
      collection: fakeCollection(),
      pathContext: {},
      recordId: 'EXISTING_ID',
      values: { nome: 'novo nome' },
      dirtyFields: { nome: true },
      currentUserUid: 'u1',
      siblingWrites: () => [{ type: 'delete', ref: { id: 'gone' } as never }],
    });
    expect(firestoreMock.txMock.delete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gone' }),
    );
    expect(firestoreMock.txMock.update).toHaveBeenCalledOnce(); // main doc patch
  });
});
