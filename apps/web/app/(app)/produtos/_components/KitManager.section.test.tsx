import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import { SectionTabs } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The Kit section is persistent (`KitVariacoesManager` owns a flush the edit
 * page calls in `onAfterSave`), so `KitManager` mounts at page load rather than
 * when the tab is opened. Its eager work must NOT follow it there — these pin
 * the latch that keeps it behind "the tab has been opened at least once".
 *
 * ⚠️ `env="test"` skips the `<Activity>` wrapper but still provides
 * `SectionActiveContext` in both branches (`SectionTabs.tsx:141`), which is what
 * the latch reads — so `MantineTestProvider` is fine here and the test is not
 * vacuous. The known-bad control is the inactive case: without the latch the
 * reads fire on mount.
 */
const h = vi.hoisted(() => ({
  reads: [] as string[],
  setValues: [] as Array<{ field: string; dirty: boolean }>,
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    getDocFromServer: async (ref: { id: string }) => {
      h.reads.push(ref.id);
      return { data: () => ({ custo: 10, pesoBrutoKg: 1, pesoLiquidoKg: 1 }) };
    },
  };
});

vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
}));

vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    ref: () => ({ __ref: 'produtos' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ id }),
  },
}));

vi.mock('@/components/collection-select/CollectionSelect', () => ({
  CollectionSelect: () => null,
}));

vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

vi.mock('react-hook-form', () => ({
  useFormContext: () => ({
    watch: () => true,
    getValues: () => null,
    setValue: (field: string, _v: unknown, opts?: { shouldDirty?: boolean }) => {
      h.setValues.push({ field, dirty: opts?.shouldDirty === true });
    },
  }),
}));

const { KitManager } = await import('./KitManager');

const db = {} as unknown as Firestore;

function renderInTabs() {
  return render(
    <MantineTestProvider>
      <SectionTabs
        sections={['Outra', 'Kit']}
        contents={{
          Outra: <div>outra</div>,
          Kit: (
            <KitManager
              produtoId="p1"
              db={db}
              value={{ 'comp-1': { quantidade: 1, limitarEstoque: true, timestamp: null } }}
              onChange={() => undefined}
              ehKit
            />
          ),
        }}
      />
    </MantineTestProvider>,
  );
}

beforeEach(() => {
  h.reads.length = 0;
  h.setValues.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('KitManager inside a persistent section (#1374)', () => {
  it('reads nothing and dirties nothing while its tab has never been opened', () => {
    renderInTabs();

    // Known-bad control: without the latch, mounting is enough to fire the
    // per-component `getDocFromServer` fan-out and the `shouldDirty` form sync,
    // which arms the unsaved-changes guard before the operator touches anything.
    expect(h.reads).toEqual([]);
    expect(h.setValues.filter((s) => s.dirty)).toEqual([]);
  });

  it('does its reads once the tab is opened', async () => {
    renderInTabs();
    fireEvent.click(screen.getByRole('tab', { name: 'Kit' }));

    await vi.waitFor(() => {
      expect(h.reads).toContain('comp-1');
    });
  });
});
