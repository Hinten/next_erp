import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  duplicarProduto: vi.fn(async () => 'novo-id'),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push }),
}));
vi.mock('@/lib/produtos/duplicar', () => ({ duplicarProduto: h.duplicarProduto }));

import { useDuplicarProdutoAction } from './useDuplicarProdutoAction';

const { push, duplicarProduto } = h;

const db = {} as Firestore;

describe('useDuplicarProdutoAction', () => {
  it('exposes a single-selection Duplicar action', () => {
    const { result } = renderHook(() => useDuplicarProdutoAction(db));
    expect(result.current.action.id).toBe('duplicar-produto');
    expect(result.current.action.label).toBe('Duplicar');
    expect(result.current.action.requiresSelection).toBe(true);
    expect(result.current.action.maxSelection).toBe(1);
  });

  it('duplicates the selected produto and navigates to the clone editor', async () => {
    const { result } = renderHook(() => useDuplicarProdutoAction(db));
    await result.current.action.run([{ id: 'p1', data: {} }] as never);

    expect(duplicarProduto).toHaveBeenCalledWith(db, 'p1');
    expect(push).toHaveBeenCalledWith('/produtos/novo-id/editar');
  });

  it('no-ops when run with no rows', async () => {
    duplicarProduto.mockClear();
    push.mockClear();
    const { result } = renderHook(() => useDuplicarProdutoAction(db));
    await result.current.action.run([]);

    expect(duplicarProduto).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('lets a rejection propagate to the shared action runner instead of swallowing it', async () => {
    duplicarProduto.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useDuplicarProdutoAction(db));

    await expect(result.current.action.run([{ id: 'p1', data: {} }] as never)).rejects.toThrow(
      'boom',
    );
    expect(push).not.toHaveBeenCalled();
  });
});
