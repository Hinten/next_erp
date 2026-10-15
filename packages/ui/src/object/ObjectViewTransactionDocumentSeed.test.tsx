import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentReference } from 'firebase/firestore';

const h = vi.hoisted(() => ({ listeners: new Map<string, (snap: unknown) => void>() }));
vi.mock('firebase/firestore', async (original) => ({
  ...(await original<typeof import('firebase/firestore')>()),
  onSnapshot: (ref: { path: string }, _options: unknown, callback: (snap: unknown) => void) => {
    h.listeners.set(ref.path, callback);
    return () => h.listeners.delete(ref.path);
  },
}));
import {
  createTransactionDocuments,
  ObjectViewTransactionDocumentsProvider,
  useObjectViewTransactionDocumentSeed,
} from './ObjectViewTransactionDocuments';

const A = 'produtos/p1/imposto/a';
const B = 'produtos/p1/imposto/b';
const ref = (path: string) =>
  ({ path, id: path.split('/').at(-1) }) as DocumentReference<Record<string, unknown>>;
function emit(path: string, data: Record<string, unknown> | undefined) {
  h.listeners.get(path)?.({
    ref: { path },
    id: path.split('/').at(-1),
    data: () => data,
    metadata: { fromCache: false, hasPendingWrites: false },
  });
}

describe('server document seed identity', () => {
  it.each([undefined, { cfop: '5102' }])(
    'does not seed another operation with the previous ref’s snapshot (%j)',
    async (oldData) => {
      const documents = createTransactionDocuments();
      const onSeed = vi.fn();
      const first = ref(A);
      const second = ref(B);
      function Seed({ target }: { target: DocumentReference<Record<string, unknown>> }) {
        useObjectViewTransactionDocumentSeed(target, onSeed);
        return null;
      }
      const tree = (target: DocumentReference<Record<string, unknown>>) => (
        <ObjectViewTransactionDocumentsProvider value={documents}>
          <Seed target={target} />
        </ObjectViewTransactionDocumentsProvider>
      );
      const view = render(tree(first));
      await act(async () => {
        emit(A, oldData);
      });
      expect(documents.getBaseline(A)).toEqual(oldData ?? null);
      await act(async () => {
        view.rerender(tree(second));
      });
      expect(documents.getBaseline(B)).toBeUndefined();
      expect(onSeed).toHaveBeenCalledTimes(1);
      await act(async () => {
        emit(B, { cfop: '6102' });
      });
      expect(documents.getBaseline(B)).toEqual({ cfop: '6102' });
      expect(onSeed).toHaveBeenCalledTimes(2);
    },
  );
});
