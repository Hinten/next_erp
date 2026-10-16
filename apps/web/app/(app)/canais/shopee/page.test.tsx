import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

/**
 * The page's own decisions only — the cards, the panel and the dialogs have
 * their own suites. `TableView` is replaced by a probe that records the props
 * the page hands it: which actions exist, and whether the jobs panel is mounted.
 */
const h = vi.hoisted(() => ({
  permissoes: { write: true, delete: true },
  /** `undefined` ⇒ the real caps row. */
  implementado: undefined as boolean | undefined,
  tableViewProps: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth', async () => {
  const { PERM } = await import('@delfrance/auth');
  return {
    usePermission: (bit: bigint) => ({
      allowed: bit === PERM.integracao.write ? h.permissoes.write : h.permissoes.delete,
      loading: false,
    }),
  };
});
vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => shopeeClientFalso() };
});
vi.mock('./_components/ShopeeCallbackToast', () => ({ ShopeeCallbackToast: () => null }));
vi.mock('@delfrance/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/schemas')>();
  return {
    ...actual,
    marketplaceCapsFor: (tipo: Parameters<typeof actual.marketplaceCapsFor>[0]) => {
      const caps = actual.marketplaceCapsFor(tipo);
      return h.implementado === undefined ? caps : { ...caps, implementado: h.implementado };
    },
  };
});
vi.mock('@delfrance/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/ui')>();
  return {
    ...actual,
    TableView: (props: Record<string, unknown>) => {
      h.tableViewProps = props;
      return <div data-testid="table-view" />;
    },
  };
});

const { default: CanalShopeePage } = await import('./page');

function renderPage() {
  const qc = new QueryClient();
  render(
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <CanalShopeePage />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
  const props = h.tableViewProps!;
  return {
    actionIds: (props.actions as Array<{ id: string }>).map((a) => a.id),
    painel: props.renderActionsPanelExtra as
      | ((ctx: { collapsed: boolean }) => ReactNode)
      | undefined,
    actionsPanel: props.actionsPanel,
  };
}

const FRASE_PRODUTOS =
  /Enviar estoque, enviar preços e pausar ou reativar anúncios pela lista de produtos ainda não atendem a Shopee\./;

beforeEach(() => {
  h.permissoes = { write: true, delete: true };
  h.implementado = undefined;
  h.tableViewProps = null;
});

describe('/canais/shopee', () => {
  it('a writer gets both job actions in the rail, with the jobs panel under them', () => {
    const { actionIds, painel, actionsPanel } = renderPage();
    expect(actionIds).toEqual(['shopee-importar-todos', 'shopee-atualizar-precos', 'delete']);
    expect(actionsPanel).toEqual({ width: 300 });
    expect(painel).toBeTypeOf('function');
  });

  it('⭐ a viewer without integracao.write gets neither the actions NOR the panel — its reads are .write routes', () => {
    h.permissoes = { write: false, delete: true };
    const { actionIds, painel } = renderPage();
    expect(actionIds).toEqual(['delete']);
    expect(painel).toBeUndefined();
  });

  it('the delete stays gated on its own bit', () => {
    h.permissoes = { write: true, delete: false };
    expect(renderPage().actionIds).toEqual(['shopee-importar-todos', 'shopee-atualizar-precos']);
  });

  it('says what the screen does, with no deployment claim', () => {
    renderPage();
    expect(
      screen.getByText(
        /inicia duas tarefas longas: importar todos os anúncios e atualizar os preços/,
      ),
    ).not.toBeNull();
    expect(screen.queryByText(/ainda não estão ligados neste canal/)).toBeNull();
  });

  it('names the /produtos actions as not serving Shopee for exactly as long as the caps row says so', () => {
    h.implementado = false;
    renderPage();
    expect(screen.getByText(FRASE_PRODUTOS)).not.toBeNull();
  });

  it('drops that sentence by itself once the channel flips (#1530)', () => {
    h.implementado = true;
    renderPage();
    expect(screen.queryByText(FRASE_PRODUTOS)).toBeNull();
  });
});
