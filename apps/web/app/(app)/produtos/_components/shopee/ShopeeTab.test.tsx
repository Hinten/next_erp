import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { SectionTabs } from '@delfrance/ui';
import type { Firestore } from 'firebase/firestore';

/**
 * T4a/b (reconcile §4, PR 6): the Shopee tab's activation gate — `AbaDeCanal`
 * around the lazily imported `ShopeeEditor`, in a NON-persistent section (the
 * tab holds no drafts and registers no flush, so the page leaves it out of
 * `PRODUTO_PERSISTENT_SECTIONS`).
 */

const h = vi.hoisted(() => ({ editorRenders: vi.fn() }));

vi.mock('./ShopeeEditor', () => ({
  ShopeeEditor: (props: { produtoId: string; disabled?: boolean }) => {
    h.editorRenders(props);
    return <div data-testid="shopee-editor-stub">editor</div>;
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
});
