import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The page's own decisions only — the dialog, the panel and the cards have
 * their own suites. `TableView` is replaced by a probe that records the props
 * the page hands it: which actions exist, and whether the imports panel is
 * mounted.
 */
const h = vi.hoisted(() => ({
  permissoes: { read: true, write: true, delete: true },
  tableViewProps: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth', async () => {
  const { PERM } = await import('@delfrance/auth');
  return {
    usePermission: (bit: bigint) => ({
      allowed:
        bit === PERM.integracao.read
          ? h.permissoes.read
          : bit === PERM.integracao.write
            ? h.permissoes.write
            : h.permissoes.delete,
      loading: false,
    }),
  };
});
vi.mock('@/lib/loja-integrada/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loja-integrada/client')>();
  return {
    ...actual,
    useBackendLojaIntegrada: () => ({ client: lojaIntegradaClientFalso(), indisponivel: null }),
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

const { default: CanalLojaIntegradaPage } = await import('./page');

function renderPage() {
  const qc = new QueryClient();
  render(
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <CanalLojaIntegradaPage />
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

beforeEach(() => {
  h.permissoes = { read: true, write: true, delete: true };
  h.tableViewProps = null;
});

describe('/canais/loja-integrada', () => {
  it('a writer gets the import action in the rail, with the imports panel under it', () => {
    const { actionIds, painel, actionsPanel } = renderPage();
    expect(actionIds).toEqual(['loja-integrada-importar-produtos', 'delete']);
    expect(actionsPanel).toEqual({ width: 300 });
    expect(painel).toBeTypeOf('function');
  });

  it('⭐ a viewer without integracao.write gets NO import action — but still the panel, whose reads are .read routes', () => {
    h.permissoes = { read: true, write: false, delete: false };
    const { actionIds, painel } = renderPage();
    expect(actionIds).toEqual([]);
    expect(painel).toBeTypeOf('function');
  });

  it('NEAR MISS — with neither bit there is no panel either', () => {
    h.permissoes = { read: false, write: false, delete: true };
    const { actionIds, painel } = renderPage();
    expect(actionIds).toEqual(['delete']);
    expect(painel).toBeUndefined();
  });

  it('the delete stays gated on its own bit', () => {
    h.permissoes = { read: true, write: true, delete: false };
    expect(renderPage().actionIds).toEqual(['loja-integrada-importar-produtos']);
  });

  it('says what the screen does today: the token, the freight settings, and the import', () => {
    renderPage();
    expect(screen.getByText('O que esta tela faz hoje')).not.toBeNull();
    // The token check is told as it is: once, when it is saved.
    expect(
      screen.getByText(/o token é validado na Loja Integrada no momento em que é salvo/),
    ).not.toBeNull();
    expect(screen.getByText(/mapeamento do frete/)).not.toBeNull();
    const importacao = screen.getByText(/Importar produtos da loja/);
    expect(importacao.textContent).toMatch(
      /Em “Simular”, mostra o que seria feito sem gravar nada/,
    );
    expect(importacao.textContent).toMatch(/preço e estoque nunca são importados/);
    expect(importacao.textContent).toMatch(
      /a importação só funciona depois da migração para este sistema: até lá, iniciar uma importação responde que as chamadas à Loja Integrada estão desligadas\./,
    );
  });

  it('⭐ says that orders, stock and price are not running here — and no longer that the import is not wired', () => {
    renderPage();
    expect(
      screen.getByText(
        /Importar pedidos, enviar estoque e enviar preço não estão rodando neste canal/,
      ),
    ).not.toBeNull();
    expect(screen.getByText(/nada é sincronizado automaticamente/)).not.toBeNull();
    expect(screen.queryByText(/Importar produtos, importar pedidos/)).toBeNull();
    expect(screen.queryByText(/ainda não estão ligados neste canal/)).toBeNull();
  });
});
