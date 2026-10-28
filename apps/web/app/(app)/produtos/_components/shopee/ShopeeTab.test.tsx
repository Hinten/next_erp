import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { SectionTabs } from '@delfrance/ui';
import type { Firestore } from 'firebase/firestore';

/**
 * T4a/b (reconcile §4, PR 6): the Shopee tab's activation gate — `AbaDeCanal`
 * around the lazily imported `ShopeeEditor`, in a NON-persistent section (the
 * tab stages nothing in the produto form and registers no flush, so the page
 * leaves it out of `PRODUTO_PERSISTENT_SECTIONS`).
 *
 * #1911 P10: the tab carries the editor's unsaved-draft flag (`onDirtyChange`)
 * to the page, and keys the editor by the produto id — a produto change
 * remounts it, so no draft of one produto survives into another's tab.
 */

const h = vi.hoisted(() => ({ editorRenders: vi.fn(), montagens: 0 }));

vi.mock('./ShopeeEditor', () => ({
  ShopeeEditor: (props: {
    produtoId: string;
    disabled?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
  }) => {
    h.editorRenders(props);
    // Counts MOUNTS: a lazy initialiser runs once per instance.
    useState(() => {
      h.montagens += 1;
      return null;
    });
    return (
      <div data-testid="shopee-editor-stub">
        editor {props.produtoId}
        <button type="button" onClick={() => props.onDirtyChange?.(true)}>
          sujar
        </button>
      </div>
    );
  },
}));

const { ShopeeTab } = await import('./ShopeeTab');

function renderTab(produtoId: string | null = 'prod-1') {
  return render(
    <MantineTestProvider>
      <ShopeeTab produtoId={produtoId} db={{} as Firestore} disabled />
    </MantineTestProvider>,
  );
}

/** The produto page's shape: the tab lives in a section that is NOT persistent, and starts closed. */
function renderInTabs() {
  return render(
    <MantineTestProvider>
      <SectionTabs
        sections={['Dados gerais', 'Shopee']}
        contents={{
          'Dados gerais': <div>dados</div>,
          Shopee: <ShopeeTab produtoId="prod-1" db={{} as Firestore} />,
        }}
      />
    </MantineTestProvider>,
  );
}

beforeEach(() => {
  h.editorRenders.mockClear();
  h.montagens = 0;
});

describe('ShopeeTab', () => {
  it('asks for a saved produto in create mode — no placeholder, no editor', () => {
    renderTab(null);
    expect(screen.getByText('Salve o produto para continuar.')).toBeDefined();
    expect(screen.queryByTestId('shopee-tab-placeholder')).toBeNull();
    expect(screen.queryByTestId('shopee-editor-stub')).toBeNull();
    expect(h.editorRenders).not.toHaveBeenCalled();
  });

  it('hands the produto and the read-only flag through to the editor', async () => {
    // Standalone (no SectionTabs ancestor) counts as visible: assert the
    // transition, never "not loaded yet".
    renderTab();
    await waitFor(() => {
      expect(screen.getByTestId('shopee-editor-stub')).toBeDefined();
    });
    expect(h.editorRenders).toHaveBeenCalledWith(
      expect.objectContaining({ produtoId: 'prod-1', disabled: true }),
    );
  });

  it('stays on the placeholder until its tab is opened, then keeps the editor after switching back', async () => {
    renderInTabs();
    // Nobody clicked the tab: the editor chunk must not be requested.
    expect(screen.getByTestId('shopee-tab-placeholder')).toBeDefined();
    expect(screen.queryByTestId('shopee-editor-stub')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Shopee' }));
    await waitFor(() => {
      expect(screen.getByTestId('shopee-editor-stub')).toBeDefined();
    });

    // …and going back to another tab does not close it again.
    fireEvent.click(screen.getByRole('tab', { name: 'Dados gerais' }));
    expect(screen.getByTestId('shopee-editor-stub')).toBeDefined();
    expect(screen.queryByTestId('shopee-tab-placeholder')).toBeNull();
  });

  it('carries the editor’s unsaved-draft flag to the page (#1911 P10)', async () => {
    const onDirtyChange = vi.fn();
    render(
      <MantineTestProvider>
        <ShopeeTab produtoId="prod-1" db={{} as Firestore} onDirtyChange={onDirtyChange} />
      </MantineTestProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'sujar' }));
    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it('keys the editor by the produto id: another produto REMOUNTS it — NEAR-MISS: a re-render of the same one does not', async () => {
    const tela = (produtoId: string, disabled: boolean) => (
      <MantineTestProvider>
        <ShopeeTab produtoId={produtoId} db={{} as Firestore} disabled={disabled} />
      </MantineTestProvider>
    );
    const { rerender } = render(tela('prod-1', false));
    await screen.findByText('editor prod-1');
    expect(h.montagens).toBe(1);

    rerender(tela('prod-1', true));
    expect(h.montagens).toBe(1);

    rerender(tela('prod-2', true));
    await screen.findByText('editor prod-2');
    expect(h.montagens).toBe(2);
  });
});
