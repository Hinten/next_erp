import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { SectionTabs } from '@delfrance/ui';
import type { Firestore } from 'firebase/firestore';

const h = vi.hoisted(() => ({ editorRenders: vi.fn() }));

vi.mock('./MercadoLivreEditor', () => ({
  MercadoLivreEditor: (props: { produtoId: string }) => {
    h.editorRenders(props.produtoId);
    return <div data-testid="ml-editor-stub">editor</div>;
  },
}));

const { MercadoLivreTab } = await import('./MercadoLivreTab');

function renderTab(produtoId: string | null = 'prod-1') {
  return render(
    <MantineTestProvider>
      <MercadoLivreTab produtoId={produtoId} db={{} as Firestore} />
    </MantineTestProvider>,
  );
}

/** The produto page's real shape: the tab lives in a section, and starts closed. */
function renderInTabs() {
  return render(
    <MantineTestProvider>
      <SectionTabs
        sections={['Dados gerais', 'Mercado Livre']}
        contents={{
          'Dados gerais': <div>dados</div>,
          'Mercado Livre': <MercadoLivreTab produtoId="prod-1" db={{} as Firestore} />,
        }}
        persistentSections={['Mercado Livre']}
      />
    </MantineTestProvider>,
  );
}

describe('MercadoLivreTab', () => {
  it('renders the placeholder first, then swaps in the editor once activated', async () => {
    // Standalone (no SectionTabs ancestor) counts as visible, so the latch
    // flips on the first effect flush — assert the transition, never
    // "not loaded yet".
    renderTab();
    await waitFor(() => {
      expect(screen.getByTestId('ml-editor-stub')).toBeDefined();
    });
    expect(screen.queryByTestId('ml-tab-placeholder')).toBeNull();
  });

  it('passes the produto through to the editor', async () => {
    renderTab();
    await waitFor(() => {
      expect(h.editorRenders).toHaveBeenCalledWith('prod-1');
    });
  });

  it('stays on the placeholder until its tab is opened', async () => {
    renderInTabs();
    // The panel is mounted (persistent section) but nobody clicked the tab, so
    // the editor chunk must not be requested.
    expect(screen.getByTestId('ml-tab-placeholder')).toBeDefined();
    expect(screen.queryByTestId('ml-editor-stub')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Mercado Livre' }));
    await waitFor(() => {
      expect(screen.getByTestId('ml-editor-stub')).toBeDefined();
    });

    // ...and going back to another tab does not close it again.
    fireEvent.click(screen.getByRole('tab', { name: 'Dados gerais' }));
    expect(screen.getByTestId('ml-editor-stub')).toBeDefined();
  });

  it('asks for a saved produto in create mode instead of hiding the tab', () => {
    renderTab(null);
    expect(screen.getByText('Salve o produto para continuar.')).toBeDefined();
    expect(screen.queryByTestId('ml-editor-stub')).toBeNull();
    expect(screen.queryByTestId('ml-tab-placeholder')).toBeNull();
  });
});
