import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { FirebaseError } from 'firebase/app';
import type { Query, QuerySnapshot } from 'firebase/firestore';
import { conversaSchema, type Conversa } from '@delfrance/schemas';
import { CONVERSA_PAGE_SIZE } from '@/lib/chat/conversaConstraints';

const { onSnapshotMock, getDocsMock } = vi.hoisted(() => ({
  onSnapshotMock: vi.fn(),
  getDocsMock: vi.fn(),
}));

vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return { ...actual, onSnapshot: onSnapshotMock, getDocs: getDocsMock };
});
vi.mock('@delfrance/data', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data')>();
  // Synthetic snapshot docs are not SDK cursor instances; paging delivery is
  // controlled by getDocs below. Keep the real filter/query builders.
  return { ...actual, paginate: () => [] };
});
vi.mock('@/lib/firebase/client', async () => {
  const { initializeApp } = await import('firebase/app');
  const { getFirestore } = await import('firebase/firestore');
  // Real query builders and snapshot hook; only network delivery is controlled.
  const db = getFirestore(initializeApp({ projectId: 'demo-chat-empty' }), 'default');
  return { getFirebaseFirestore: () => db };
});

import { useConversaQuery, type UseConversaQueryInput } from './useConversaQuery';

interface Listener {
  next: (snapshot: QuerySnapshot<Conversa>) => void;
  error: (error: FirebaseError) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}
let listeners: Listener[];

beforeEach(() => {
  listeners = [];
  getDocsMock.mockReset();
  onSnapshotMock.mockReset();
  onSnapshotMock.mockImplementation(
    (
      _query: Query<Conversa>,
      _options: unknown,
      next: Listener['next'],
      error: Listener['error'],
    ) => {
      const unsubscribe = vi.fn();
      listeners.push({ next, error, unsubscribe });
      return unsubscribe;
    },
  );
});
afterEach(cleanup);

const todas: UseConversaQueryInput = {
  tab: 'todas',
  ordem: 'ultima',
  uid: 'operator',
  clienteOuterRef: null,
};
const emptyCliente = { ...todas, clienteOuterRef: 'documents/clientes/no-conversations' };

function snapshot(ids: string[]): QuerySnapshot<Conversa> {
  // Only the SDK snapshot surface read by mapSnapshotRows/useSnapshotWithDocs.
  return {
    docs: ids.map((id) => ({
      id,
      ref: { path: `chat/${id}` },
      data: () => conversaSchema.parse({ nome: id }),
    })),
    metadata: { fromCache: false, hasPendingWrites: false },
  } as unknown as QuerySnapshot<Conversa>;
}

function emit(ids: string[]) {
  act(() => listeners.at(-1)!.next(snapshot(ids)));
}

function deferredPage() {
  let resolve!: (value: QuerySnapshot<Conversa>) => void;
  let reject!: (error: FirebaseError) => void;
  const promise = new Promise<QuerySnapshot<Conversa>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  getDocsMock.mockReturnValueOnce(promise);
  return { resolve, reject };
}

const fullPage = Array.from({ length: CONVERSA_PAGE_SIZE }, (_, i) => `conversa-${i}`);

describe('cliente filter empty-result transitions', () => {
  it('clears previous rows while loading and completes on an empty snapshot', () => {
    const { result, rerender } = renderHook(useConversaQuery, { initialProps: todas });
    emit(['existing-conversation']);
    expect(result.current.rows.map((r) => r.id)).toEqual(['existing-conversation']);
    expect(result.current.loading).toBe(false);

    rerender(emptyCliente);
    expect(listeners[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(result.current.loading).toBe(true);
    expect(result.current.rows).toEqual([]);

    // Firestore stays subscribed: no stream completion is needed to stop loading.
    emit([]);
    expect(result.current).toMatchObject({
      rows: [],
      loading: false,
      loadingMore: false,
      hasMore: false,
      error: undefined,
    });

    rerender(todas);
    emit(['existing-conversation']);
    expect(result.current.rows.map((r) => r.id)).toEqual(['existing-conversation']);
    expect(result.current.loading).toBe(false);
  });

  it('clears an already-loaded paginated tail when the cliente has no conversations', async () => {
    const { result, rerender } = renderHook(useConversaQuery, { initialProps: todas });
    emit(fullPage);
    getDocsMock.mockResolvedValueOnce(snapshot(['older-conversation']));
    await act(async () => result.current.loadMore());
    expect(result.current.rows.at(-1)?.id).toBe('older-conversation');

    rerender(emptyCliente);
    emit([]);
    expect(result.current).toMatchObject({ rows: [], loading: false, hasMore: false });
  });

  it('clears the previous live query error while loading but still reports current failures', () => {
    const { result, rerender } = renderHook(useConversaQuery, { initialProps: todas });
    const previousError = new FirebaseError('permission-denied', 'Previous query denied');
    act(() => listeners.at(-1)!.error(previousError));
    expect(result.current.error).toBe(previousError);
    expect(result.current.loading).toBe(false);

    rerender(emptyCliente);
    expect(result.current).toMatchObject({ rows: [], loading: true, error: undefined });
    emit([]);
    expect(result.current).toMatchObject({ rows: [], loading: false, error: undefined });

    const currentError = new FirebaseError('unavailable', 'Current query failed');
    act(() => listeners.at(-1)!.error(currentError));
    expect(result.current.error).toBe(currentError);
    expect(result.current.loading).toBe(false);
  });

  it('keeps the empty result when a previous query page arrives after selecting the cliente', async () => {
    const { result, rerender } = renderHook(useConversaQuery, { initialProps: todas });
    emit(fullPage);
    const oldPage = deferredPage();
    act(() => result.current.loadMore());
    expect(getDocsMock).toHaveBeenCalledOnce();
    expect(result.current.loadingMore).toBe(true);

    rerender(emptyCliente);
    emit([]);
    expect(result.current.rows).toEqual([]);
    await act(async () => oldPage.resolve(snapshot(['stale-conversation'])));

    expect(result.current).toMatchObject({
      rows: [],
      loading: false,
      loadingMore: false,
      hasMore: false,
      error: undefined,
    });
  });

  it('does not show a previous query page error over the empty cliente result', async () => {
    const { result, rerender } = renderHook(useConversaQuery, { initialProps: todas });
    emit(fullPage);
    const oldPage = deferredPage();
    act(() => result.current.loadMore());
    expect(getDocsMock).toHaveBeenCalledOnce();

    rerender(emptyCliente);
    emit([]);
    await act(async () => oldPage.reject(new FirebaseError('unavailable', 'Old page failed')));

    expect(result.current).toMatchObject({ rows: [], loading: false, error: undefined });
  });

  it('keeps a new page loading after clearing the cliente when an old page finishes', async () => {
    const { result, rerender } = renderHook(useConversaQuery, { initialProps: todas });
    emit(fullPage);
    const oldPage = deferredPage();
    act(() => result.current.loadMore());

    rerender(emptyCliente);
    emit([]);
    rerender(todas);
    emit(fullPage);
    const currentPage = deferredPage();
    act(() => result.current.loadMore());
    expect(getDocsMock).toHaveBeenCalledTimes(2);

    // The query text is the same again, but this is a new subscription lifetime.
    await act(async () => oldPage.resolve(snapshot(['stale-conversation'])));
    expect(result.current.loadingMore).toBe(true);
    expect(result.current.rows.map((r) => r.id)).toEqual(fullPage);
    expect(result.current.hasMore).toBe(true);

    await act(async () => currentPage.resolve(snapshot(['current-conversation'])));
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.rows.map((r) => r.id)).toEqual([...fullPage, 'current-conversation']);
  });
});
