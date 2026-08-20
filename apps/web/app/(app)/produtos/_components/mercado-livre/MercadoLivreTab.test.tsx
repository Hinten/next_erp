import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { Firestore } from 'firebase/firestore';

const h = vi.hoisted(() => ({ editorRenders: vi.fn() }));

vi.mock('./MercadoLivreEditor', () => ({
  MercadoLivreEditor: (props: { produtoId: string }) => {
    h.editorRenders(props.produtoId);
    return <div data-testid="ml-editor-stub">editor</div>;
  },
}));

const { MercadoLivreTab } = await import('./MercadoLivreTab');

function renderTab() {
  return render(
    <MantineTestProvider>
      <MercadoLivreTab produtoId="prod-1" db={{} as Firestore} />
    </MantineTestProvider>,
  );
}

describe('MercadoLivreTab', () => {
  it('renders the placeholder first, then swaps in the editor once activated', async () => {
    // The gate is an effect, so the FIRST render (before effects flush) shows
    // the placeholder. Under `env="test"` Mantine disables <Activity>, so the
    // effect runs immediately — assert the transition, never "not loaded yet".
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
});
