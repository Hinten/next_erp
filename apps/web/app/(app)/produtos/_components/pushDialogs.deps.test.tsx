import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { PushAlvo } from '@/lib/marketplace/push/types';

/**
 * The three /produtos push dialogs hand the run EVERY channel client the page holds (master plan
 * step 12): `PushDeps` makes each field required, but a dialog that passed a literal `null` (or
 * dropped the hook) would still compile and give a LOGGED-IN operator that channel's "not logged
 * in" rows. Each client hook returns a distinct sentinel here, and the run each dialog calls is a
 * recording mock: nothing reaches Firestore or a backend.
 */

const h = vi.hoisted(() => ({
  ml: { canal: 'mercado-livre' },
  shopee: { canal: 'shopee' },
  li: { canal: 'loja-integrada' },
  db: { firestore: 'falso' },
  estoque: vi.fn(),
  preco: vi.fn(),
  status: vi.fn(),
}));

vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => h.db }));
vi.mock('@/lib/data/useIntegracoes', () => ({
  useIntegracoes: () => ({ byId: new Map(), status: 'success' }),
}));
vi.mock('@/lib/marketplace/caps/AvisoCanaisNaoSuportados', () => ({
  AvisoCanaisNaoSuportados: () => null,
}));
vi.mock('@/lib/mercado-livre/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mercado-livre/client')>()),
  useMercadoLivreClient: () => h.ml,
}));
vi.mock('@/lib/shopee/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shopee/client')>()),
  useShopeeClient: () => h.shopee,
}));
vi.mock('@/lib/loja-integrada/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loja-integrada/client')>()),
  useLojaIntegradaClient: () => h.li,
}));
vi.mock('@/lib/marketplace/estoque/enviarEstoqueRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketplace/estoque/enviarEstoqueRun')>()),
  enviarEstoqueParaMarketplaces: h.estoque,
}));
vi.mock('@/lib/marketplace/preco/enviarPrecoRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketplace/preco/enviarPrecoRun')>()),
  enviarPrecoParaMarketplaces: h.preco,
}));
vi.mock('@/lib/marketplace/anuncioStatus/pausarAnunciosRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketplace/anuncioStatus/pausarAnunciosRun')>()),
  definirStatusParaMarketplaces: h.status,
}));

const { EnviarEstoqueDialog } = await import('./EnviarEstoqueDialog');
const { EnviarPrecoDialog } = await import('./EnviarPrecoDialog');
const { PausarAnunciosDialog } = await import('./PausarAnunciosDialog');

const ALVOS: readonly PushAlvo[] = [
  { produtoId: 'p1', produtoNome: 'Camiseta', integracoesComProduto: ['c1'] },
];

describe('the /produtos push dialogs hand the run every channel client', () => {
  it.each([
    [
      'Enviar estoque',
      h.estoque,
      <EnviarEstoqueDialog key="e" opened alvos={ALVOS} onClose={() => undefined} />,
    ],
    [
      'Enviar preços',
      h.preco,
      <EnviarPrecoDialog key="p" opened alvos={ALVOS} onClose={() => undefined} />,
    ],
    [
      'Pausar anúncios',
      h.status,
      <PausarAnunciosDialog key="s" opened alvos={ALVOS} onClose={() => undefined} />,
    ],
  ] as const)(
    '%s: deps carry the Mercado Livre, Shopee AND Loja Integrada clients — never a null',
    async (botao, run: ReturnType<typeof vi.fn>, dialogo: ReactElement) => {
      run.mockReset();
      run.mockResolvedValue({ rows: [], cancelado: false });
      render(<MantineTestProvider>{dialogo}</MantineTestProvider>);

      fireEvent.click(screen.getByRole('button', { name: botao }));

      await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      const [, , runDeps] = run.mock.calls[0] ?? [];
      expect((runDeps as { deps: unknown }).deps).toStrictEqual({
        mercadoLivre: h.ml,
        shopee: h.shopee,
        lojaIntegrada: h.li,
      });
      expect((runDeps as { db: unknown }).db).toBe(h.db);
    },
  );
});
