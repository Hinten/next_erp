import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { varianteFakePath } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { VariationRow } from './VariationManager';
import type { KitVariacoesFlush } from './KitVariacoesManager';

const h = vi.hoisted(() => ({
  /** Every `saveChildrenComponentesKit` call, so a second save can be asserted absent. */
  saves: [] as Array<Array<{ id: string; componentesKit: unknown }>>,
  children: [] as Array<{ id: string; data: Record<string, unknown> }>,
  toasts: [] as string[],
  rows: [] as unknown[],
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({ __q: 'children' }),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: h.children, loading: false, error: undefined }),
}));

vi.mock('@delfrance/data/produto', () => ({
  saveChildrenComponentesKit: async (
    _port: unknown,
    rows: Array<{ id: string; componentesKit: unknown }>,
  ) => {
    h.saves.push(rows);
  },
}));

vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { ref: () => ({ __ref: 'produtos' }) },
}));

vi.mock('@/lib/produtos/clientPort', () => ({
  createClientProdutoPort: () => ({}),
  // Mirrors the real read: whatever children exist right now, ids only —
  // `resolveStagedKitVariacoes` addresses by id, never by combo.
  getVariationChildrenByParent: async () => ({
    p1: h.children.map((c) => ({ id: c.id, variacoesUid: [] })),
  }),
}));

// The per-row component editor is its own unit; here it only needs to be a
// handle for staging a map.
vi.mock('./KitManager', async () => {
  const { createElement } = await import('react');
  return {
    stripKitForSave: (v: unknown) => v,
    KitManager: ({ onChange }: { onChange: (next: unknown) => void }) =>
      createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'stage-kit',
          onClick: () => onChange({ 'comp-1': { quantidade: 1 } }),
        },
        'stage',
      ),
  };
});

vi.mock('@mantine/notifications', () => ({
  notifications: { show: (args: { message?: string }) => h.toasts.push(args.message ?? '') },
}));

const { KitVariacoesManager } = await import('./KitVariacoesManager');

const db = {} as unknown as Firestore;

function rows(): VariationRow[] {
  return h.rows.length > 0
    ? (h.rows as VariationRow[])
    : [
        {
          // Since the doc id is pre-minted at stage time, a row's key IS its doc id
          // on both sides of the save.
          key: 'c1',
          id: 'c1',
          nome: 'Camiseta P',
          sku: 'CAMP',
          variacoesUid: [varianteFakePath('gT', 'P')],
          deleteMark: false,
        },
      ];
}

function renderManager() {
  const flushRef: { current: KitVariacoesFlush | null } = { current: null };
  function Host() {
    const form = useForm({ defaultValues: { ehKit: true, componentesKit: {} } });
    return (
      <FormProvider {...form}>
        <KitVariacoesManager produtoId="p1" db={db} grupos={[]} rows={rows()} flushRef={flushRef} />
      </FormProvider>
    );
  }
  const utils = render(
    <MantineTestProvider>
      <Host />
    </MantineTestProvider>,
  );
  const rerender = () =>
    utils.rerender(
      <MantineTestProvider>
        <Host />
      </MantineTestProvider>,
    );
  return { flushRef, rerender };
}

beforeEach(() => {
  h.saves.length = 0;
  h.toasts.length = 0;
  h.children = [{ id: 'c1', data: { componentesKit: null } }];
  h.rows.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('KitVariacoesManager', () => {
  it('does not rewrite a child kit map on a later save once it has been flushed', async () => {
    const { flushRef } = renderManager();

    fireEvent.click(screen.getByTestId('stage-kit'));

    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toEqual([{ id: 'c1', componentesKit: { 'comp-1': { quantidade: 1 } } }]);

    // Nothing was staged since. A second produto save must not re-issue the
    // write: `componentesKit` is persisted as a FULL overwrite, so replaying a
    // session-stale map would clobber whatever another writer put there.
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
  });

  it('writes an absorbed row where the pairing says, not where its key points', async () => {
    // The #117 id reuse wrote row `c1`'s data onto `reused-1`. Only the pairing
    // records that; the row still names `c1`.
    h.children = [{ id: 'reused-1', data: { componentesKit: null } }];
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit'));

    await act(async () => {
      await flushRef.current!('p1', { c1: 'reused-1' });
    });

    expect(h.saves[0]).toEqual([
      { id: 'reused-1', componentesKit: { 'comp-1': { quantidade: 1 } } },
    ]);
    expect(h.toasts).toEqual([]);

    // And it must be RELEASED by its source key `c1`, not by the id it was
    // written to. Those differ exactly when the pairing redirects a row, so
    // releasing by id would strand the entry and re-clobber `reused-1` on every
    // later produto save.
    await act(async () => {
      await flushRef.current!('p1', { c1: 'reused-1' });
    });
    expect(h.saves).toHaveLength(1);
  });

  it('does not let a delete-marked variation kit outlive the id that gets reused (#1390)', async () => {
    // The operator stages components for variation X while it is still live,
    // THEN delete-marks it and adds `tmp1` with the same SKU — the #117 flow.
    // Save 1 absorbs `tmp1` onto X and writes its map there. X's own entry is a
    // deliberate drop, so it is not written — but if it is not RELEASED either,
    // save 2 resolves it by `row.id` and overwrites the map the operator just
    // generated, behind a green toast.
    h.rows = [
      { key: 'X', id: 'X', nome: 'Antiga', sku: 'ANTIGA', variacoesUid: [], deleteMark: false },
    ];
    h.children = [{ id: 'X', data: { componentesKit: null } }];
    const { flushRef, rerender } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit')); // staged['X']

    // Now X is delete-marked and the replacement row appears.
    h.rows = [
      { key: 'X', id: 'X', nome: 'Antiga', sku: 'ANTIGA', variacoesUid: [], deleteMark: true },
      { key: 'tmp1', id: null, nome: 'Nova', sku: 'ANTIGA', variacoesUid: [], deleteMark: false },
    ];
    await act(async () => rerender());
    fireEvent.click(screen.getByTestId('stage-kit')); // staged['tmp1']

    await act(async () => {
      await flushRef.current!('p1', { tmp1: 'X' });
    });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]!.map((w) => w.id)).toEqual(['X']);

    // Save 2: X lives again, carrying the NEW variation. Nothing may be rewritten.
    h.rows = [
      { key: 'X', id: 'X', nome: 'Nova', sku: 'ANTIGA', variacoesUid: [], deleteMark: false },
    ];
    await act(async () => rerender());
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
  });

  it('tells the operator and keeps the entry staged when nothing resolves', async () => {
    // The variation's document is not among the children and no pairing covers
    // it: the map is NOT written, so the save must not look like it was.
    h.children = [];
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit'));

    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toEqual([]);
    expect(h.toasts.join(' ')).toContain('Não foi possível salvar os componentes de: CAMP');

    // Still staged — the operator can retry once the variation is there.
    h.children = [{ id: 'c1', data: { componentesKit: null } }];
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toEqual([{ id: 'c1', componentesKit: { 'comp-1': { quantidade: 1 } } }]);
  });
});
