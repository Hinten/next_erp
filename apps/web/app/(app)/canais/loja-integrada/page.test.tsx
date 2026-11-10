import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactNode } from 'react';
import {
  ACAO_ITEM_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  STATUS_IMPORTACAO_LI,
  TIPO_PRODUTO_LI,
} from '@delfrance/schemas';

import type { LojaIntegradaClient } from '@/lib/loja-integrada/client';
import { respostaImportacaoLiFalsa } from '@/lib/testing/importacaoLiFalsa';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { AlvoResultadoImportacaoLi } from './_components/CartaoImportacaoLi';

/**
 * The page's own decisions only — the dialog, the panel and the cards have
 * their own suites. `TableView` is replaced by a probe that records the props
 * the page hands it: which actions exist, and whether the imports panel is
 * mounted.
 */
const h = vi.hoisted(() => ({
  permissoes: { read: true, write: true, delete: true },
  tableViewProps: null as null | Record<string, unknown>,
  client: null as LojaIntegradaClient | null,
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
    useBackendLojaIntegrada: () => ({
      client: h.client ?? lojaIntegradaClientFalso(),
      indisponivel: null,
    }),
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
  h.client = null;
});

/** A finished Simular of one selectable row, as a card hands it to the page. */
const RESULTADO: AlvoResultadoImportacaoLi = {
  conta: { id: 'conta-falsa-1', nome: 'Conta A' },
  job: respostaImportacaoLiFalsa({
    jobId: 'job-simulacao-1',
    status: STATUS_IMPORTACAO_LI.concluido,
    modo: MODO_IMPORTACAO_LI.simular,
  }),
};

/**
 * Open the result view the way a card does: through the `onAbrirResultado` the
 * page hands the imports panel (the panel's element, read off the probe).
 */
function abrirResultado(painel: ((ctx: { collapsed: boolean }) => ReactNode) | undefined) {
  const elemento = painel?.({ collapsed: false });
  if (!isValidElement<{ onAbrirResultado?: (alvo: AlvoResultadoImportacaoLi) => void }>(elemento)) {
    throw new Error('o painel não é um elemento');
  }
  const abrir = elemento.props.onAbrirResultado;
  expect(abrir).toBeTypeOf('function');
  act(() => abrir?.(RESULTADO));
}

function clientComUmItem() {
  return lojaIntegradaClientFalso({
    itensImportacao: vi.fn(async () => ({
      itens: [
        {
          liId: 101,
          tipo: TIPO_PRODUTO_LI.normal,
          sku: 'SKU-FALSO-101',
          nome: null,
          filhos: 0,
          situacaoErp: SITUACAO_ERP_ITEM_LI.ausente,
          erpId: null,
          acao: ACAO_ITEM_IMPORTACAO_LI.criar,
          aplicada: false,
          camposPreenchidos: [],
          categoriasCriadas: [],
          pendencias: [],
          atualizadoEmMs: 1_790_000_000_000,
        },
      ],
      proximo: null,
    })),
  });
}

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

  it('⭐ a card’s "Ver resultado" opens the result view, where a writer may import a selection', async () => {
    h.client = clientComUmItem();
    const { painel } = renderPage();
    expect(screen.queryByText('Resultado da simulação — Conta A')).toBeNull();
    abrirResultado(painel);
    expect(screen.getByText('Resultado da simulação — Conta A')).not.toBeNull();
    expect(await screen.findByText('SKU-FALSO-101')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Importar selecionados/ })).not.toBeNull();
  });

  it('NEAR MISS — a viewer who may only read gets the same result, with no way to start', async () => {
    h.permissoes = { read: true, write: false, delete: false };
    h.client = clientComUmItem();
    const { painel } = renderPage();
    abrirResultado(painel);
    expect(await screen.findByText('SKU-FALSO-101')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Importar selecionados/ })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
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
