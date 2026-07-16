import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { FirebaseError } from 'firebase/app';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import type { Mensagem } from '@delfrance/schemas';

// Mutable snapshot state the mocked live-window hook returns; each `setLive`
// installs a NEW array reference so the hook's `[liveRows]` effects re-run.
const { snapState, getDocsMock } = vi.hoisted(() => ({
  snapState: {
    current: { data: undefined, loading: true, error: undefined } as SnapshotState<
      SnapshotRow<Mensagem>[]
    >,
  },
  getDocsMock: vi.fn(),
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/conversaCollection', () => ({
  mensagemCollection: { ref: () => ({ __ref: true }) },
}));
vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({ __q: true }),
  orderByField: () => ({ __c: 'orderBy' }),
  limit: () => ({ __c: 'limit' }),
  paginate: () => [{ __c: 'paginate' }],
}));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshotWithDocs: () => snapState.current,
}));
vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return { ...actual, getDocs: getDocsMock };
});

import { mensagemKey, useMensagensWindow } from './useMensagensWindow';

// A live-window row (desc order in the array; newest first) with a fake `snap`.
function liveRow(id: string, ts: number): SnapshotRow<Mensagem> {
  return {
    id,
    path: `chat/c1/mensagem/${id}`,
    data: { timestamp: ts } as Mensagem,
    snap: {} as never,
  };
}

// A one-shot page doc (as `getDocs` returns them; desc order).
function pageDoc(id: string, ts: number) {
  return { id, data: () => ({ timestamp: ts }) as Mensagem };
}

function setLive(rows: SnapshotRow<Mensagem>[]) {
  snapState.current = { data: rows, loading: false, error: undefined };
}

function ids(messages: { _id?: string; _docId?: string }[]): string[] {
  return messages.map((m) => mensagemKey(m as never));
}

afterEach(() => {
  snapState.current = { data: undefined, loading: true, error: undefined };
  getDocsMock.mockReset();
});

describe('useMensagensWindow — vanishing middle message fold', () => {
  it('folds a dropped-tail live row into older history (no message lost)', async () => {
    // Live window (desc): newest → oldest.
    setLive([liveRow('m3', 3), liveRow('m2', 2), liveRow('m1', 1)]);
    const { result, rerender } = renderHook(() => useMensagensWindow('c1'));

    // Load one older page (m0) so history contiguity is established.
    getDocsMock.mockResolvedValueOnce({ empty: false, docs: [pageDoc('m0', 0)] });
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(ids(result.current.messages)).toEqual(['m0', 'm1', 'm2', 'm3']);

    // A new message (m4) arrives → the window advances and m1 drops off the tail.
    setLive([liveRow('m4', 4), liveRow('m3', 3), liveRow('m2', 2)]);
    act(() => rerender());

    // m1 is folded into `older` instead of vanishing between older and live.
    expect(ids(result.current.messages)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('does NOT fold when no older page is loaded (window tail is the floor)', () => {
    setLive([liveRow('m3', 3), liveRow('m2', 2), liveRow('m1', 1)]);
    const { result, rerender } = renderHook(() => useMensagensWindow('c1'));
    expect(ids(result.current.messages)).toEqual(['m1', 'm2', 'm3']);

    // Advance the window with no older page loaded — m1 simply leaves the window.
    setLive([liveRow('m4', 4), liveRow('m3', 3), liveRow('m2', 2)]);
    act(() => rerender());
    expect(ids(result.current.messages)).toEqual(['m2', 'm3', 'm4']);
  });
});

describe('useMensagensWindow — loadOlder error handling', () => {
  it('captures a FirebaseError as olderError and resets loadingOlder', async () => {
    setLive([liveRow('m1', 1)]);
    getDocsMock.mockRejectedValueOnce(new FirebaseError('unavailable', 'Sem conexão'));
    const { result } = renderHook(() => useMensagensWindow('c1'));

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(result.current.olderError).toBeInstanceOf(FirebaseError);
    expect(result.current.loadingOlder).toBe(false);
  });

  it('rethrows a non-FirebaseError (no silent swallow)', async () => {
    setLive([liveRow('m1', 1)]);
    getDocsMock.mockRejectedValueOnce(new TypeError('boom'));
    const { result } = renderHook(() => useMensagensWindow('c1'));

    let caught: unknown;
    await act(async () => {
      caught = await result.current.loadOlder().catch((e: unknown) => e);
    });

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe('boom');
    expect(result.current.olderError).toBeUndefined();
    expect(result.current.loadingOlder).toBe(false);
  });
});
