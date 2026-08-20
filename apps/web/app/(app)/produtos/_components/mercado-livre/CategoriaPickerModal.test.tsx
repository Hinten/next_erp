import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({ categorias: vi.fn(), sugerirCategorias: vi.fn() }));

// `importOriginal` so the real error classes survive `instanceof` — the retry
// predicate and the copy mapper both narrow on them.
vi.mock('@/lib/mercado-livre/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mercado-livre/client')>();
  return {
    ...actual,
    useMercadoLivreClient: () => ({
      categorias: h.categorias,
      sugerirCategorias: h.sugerirCategorias,
    }),
  };
});

const { MercadoLivreClientHttpError, MercadoLivreClientNetworkError } =
  await import('@/lib/mercado-livre/client');
const { CategoriaPickerModal } = await import('./CategoriaPickerModal');

// `node: null` is the root level, so the cascade reads its rows off `roots`.
const ROOT = { roots: [{ id: 'MLB1234', name: 'Camisetas' }], node: null };

const networkError = () =>
  new MercadoLivreClientNetworkError('failed to fetch', new TypeError('fetch failed'));

function show() {
  const qc = new QueryClient({
    // The queries carry their own `retry` predicate, which a client default
    // cannot override — `retryDelay` is the knob that collapses the backoff.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  render(
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <CategoriaPickerModal
          opened
          onClose={vi.fn()}
          integracaoId="conta-1"
          initialCategoryId={null}
          produtoNome="Camiseta preta"
          onSelect={vi.fn()}
        />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
}

describe('CategoriaPickerModal — failed cascade load', () => {
  it('recovers in place instead of forcing a Cancelar and re-open', async () => {
    h.sugerirCategorias.mockResolvedValue({ sugestoes: [] });
    h.categorias
      // Has to outlast the automatic retries to reach the alert at all.
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(ROOT);
    show();

    await waitFor(() => {
      expect(screen.getByText(/Não foi possível contatar o Mercado Livre/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/ }));

    await waitFor(() => {
      expect(screen.getByText('Camisetas')).toBeTruthy();
    });
    expect(screen.queryByText(/Não foi possível contatar o Mercado Livre/)).toBeNull();
  });

  it('offers no retry when the account is not connected', async () => {
    h.sugerirCategorias.mockResolvedValue({ sugestoes: [] });
    h.categorias.mockRejectedValue(
      new MercadoLivreClientHttpError('unauthorized', 409, 'ML_REAUTH_REQUIRED'),
    );
    show();

    await waitFor(() => {
      expect(screen.getByText(/reconecte em Canais de venda/)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /Tentar novamente/ })).toBeNull();
  });
});
