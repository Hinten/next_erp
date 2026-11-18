import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { MemoryFirestore } from '@delfrance/data/testing';
import { AfterSaveBlockedError } from '@delfrance/ui';
import { commitChildKitEdits } from './kitChildren';

const h = vi.hoisted(() => ({ memory: undefined as MemoryFirestore | undefined }));
const db = {} as Firestore;

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, callback: Parameters<MemoryFirestore['runTransaction']>[0]) =>
    h.memory!.runTransaction((tx) =>
      callback({
        ...tx,
        get: async (ref) => ({
          ...(await tx.get(ref)),
          ref,
          id: ref.path.split('/').at(-1),
        }),
      }),
    ),
}));

vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    docRef: (_db: unknown, _context: unknown, id: string) => h.memory!.doc(`produtos/${id}`),
  },
}));

vi.mock('./clientPort', () => ({
  getVariationChildrenByParent: async () => ({
    p1: ['c1', 'c2', 'moved'].map((id) => ({ id })),
  }),
}));

const entry = { quantidade: 2, limitarEstoque: true, timestamp: null };
const oldRecipe = { old: entry };
const replacement = { replacement: entry };

function seed(id: string, data: Record<string, unknown>) {
  h.memory!.seed('produtos', id, data);
}

function saved(id: string) {
  return h.memory!.docs('produtos').get(id);
}

beforeEach(() => {
  h.memory = new MemoryFirestore();
  seed('p1', { ehKit: true, ehKitVirtual: true, componentesKit: replacement });
  for (const id of ['c1', 'c2']) {
    seed(id, {
      paiId: 'p1',
      ehKit: true,
      ehKitVirtual: true,
      componentesKit: oldRecipe,
      componentesKitKeys: ['old'],
    });
  }
});

describe('commitChildKitEdits', () => {
  it('clears both children of a non-kit and skips a candidate that moved families', async () => {
    seed('p1', { ehKit: false, ehKitVirtual: false });
    seed('moved', { paiId: 'other-parent', ehKit: true, componentesKit: oldRecipe });
    await commitChildKitEdits(db, 'p1', {
      status: { oldEhKit: true, oldEhKitVirtual: true, ehKit: false, ehKitVirtual: false },
    });
    for (const id of ['c1', 'c2']) {
      expect(saved(id)).toMatchObject({
        ehKit: false,
        ehKitVirtual: false,
        componentesKit: null,
        componentesKitKeys: null,
      });
    }
    expect(saved('moved')).toMatchObject({ ehKit: true, componentesKit: oldRecipe });
  });

  it('blocks recipe saves if the parent stopped being a kit', async () => {
    seed('p1', { ehKit: false, ehKitVirtual: false });
    await expect(
      commitChildKitEdits(db, 'p1', {
        recipes: [{ id: 'c1', baseline: oldRecipe, componentesKit: replacement }],
        mirrorSoleMember: false,
      }),
    ).rejects.toBeInstanceOf(AfterSaveBlockedError);
    expect(saved('c1')?.componentesKit).toEqual(oldRecipe);
  });

  it('rejects all recipe writes when a child recipe changed since the draft began', async () => {
    const concurrent = { old: { ...entry, quantidade: 3 } };
    const memory = h.memory!;
    memory.occ.beforeCommit = async () => {
      memory.occ.beforeCommit = null;
      await memory.runTransaction((tx) => {
        tx.update(memory.doc('produtos/c2'), { componentesKit: concurrent });
        return Promise.resolve();
      });
    };
    await expect(
      commitChildKitEdits(db, 'p1', {
        recipes: [
          { id: 'c1', baseline: oldRecipe, componentesKit: replacement },
          { id: 'c2', baseline: oldRecipe, componentesKit: null },
        ],
        mirrorSoleMember: false,
      }),
    ).rejects.toBeInstanceOf(AfterSaveBlockedError);
    expect(saved('c1')?.componentesKit).toEqual(oldRecipe);
    expect(saved('c2')?.componentesKit).toEqual(concurrent);
    expect(memory.occ.txLog).toContainEqual(
      expect.objectContaining({ phase: 'abort', conflictPath: 'produtos/c2' }),
    );
  });

  it('saves a variation-only edit even when the baseline map has a different key order', async () => {
    const baseline = { a: entry, b: entry };
    seed('c1', { ...saved('c1'), componentesKit: { b: entry, a: entry } });
    await commitChildKitEdits(db, 'p1', {
      recipes: [{ id: 'c1', baseline, componentesKit: oldRecipe }],
      mirrorSoleMember: false,
    });
    expect(saved('c1')).toMatchObject({ componentesKit: oldRecipe, componentesKitKeys: ['old'] });
    expect(saved('c2')?.componentesKit).toEqual(oldRecipe);
    expect(saved('p1')?.componentesKit).toEqual(replacement);
  });

  it('mirrors the rebuilt parent recipe onto the sole sellable member on reset', async () => {
    seed('p1', { ...saved('p1'), filhoUnicoId: 'c1' });
    await commitChildKitEdits(db, 'p1', {
      recipes: [{ id: 'c1', baseline: oldRecipe, componentesKit: null }],
      mirrorSoleMember: true,
    });
    expect(saved('c1')).toMatchObject({
      ehKit: true,
      ehKitVirtual: true,
      componentesKit: replacement,
      componentesKitKeys: ['replacement'],
    });
  });
});
