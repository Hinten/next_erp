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
  getVariationChildrenByParent: async () => ({
    p1: [{ id: 'c1', variacoesUid: [varianteFakePath('gT', 'P')] }],
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

vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

const { KitVariacoesManager } = await import('./KitVariacoesManager');

const db = {} as unknown as Firestore;

function rows(): VariationRow[] {
  return [
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
  render(
    <MantineTestProvider>
      <Host />
    </MantineTestProvider>,
  );
  return { flushRef };
}

beforeEach(() => {
  h.saves.length = 0;
  h.children = [{ id: 'c1', data: { componentesKit: null } }];
});

afterEach(() => {
  cleanup();
});

describe('KitVariacoesManager', () => {
  it('does not rewrite a child kit map on a later save once it has been flushed', async () => {
    const { flushRef } = renderManager();

    fireEvent.click(screen.getByTestId('stage-kit'));

    await act(async () => {
      await flushRef.current!('p1');
    });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toEqual([{ id: 'c1', componentesKit: { 'comp-1': { quantidade: 1 } } }]);

    // Nothing was staged since. A second produto save must not re-issue the
    // write: `componentesKit` is persisted as a FULL overwrite, so replaying a
    // session-stale map would clobber whatever another writer put there.
    await act(async () => {
      await flushRef.current!('p1');
    });
    expect(h.saves).toHaveLength(1);
  });
});
