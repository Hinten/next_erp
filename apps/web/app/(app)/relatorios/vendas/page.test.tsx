import { fireEvent, getDefaultNormalizer, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADO_PEDIDO, INTEGRACAO_TIPO, type EstadoPedido } from '@delfrance/schemas';
import { porBucket, porEstado } from '@/lib/reports/aggregations';
import type { SalesReport } from '@/lib/reports/salesReport';
import { MantineTestProvider } from '@/lib/testing/mantine';
import VendasPorEstadoPage from './page';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  useIntegracoes: vi.fn(),
  canReadChannels: true,
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth/usePermission', () => ({
  usePermission: () => ({ allowed: mocks.canReadChannels, loading: false }),
}));
vi.mock('@/lib/data/useIntegracoes', () => ({ useIntegracoes: mocks.useIntegracoes }));
vi.mock('@mantine/charts', () => ({
  DonutChart: ({ chartLabel }: { chartLabel: string }) => <span>{chartLabel}</span>,
}));
vi.mock('@/lib/reports/salesReport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/salesReport')>()),
  loadSalesReport: mocks.load,
}));

const EMPTY: SalesReport = { total: 0, byBucket: [], byEstado: [] };

function orders(estado: EstadoPedido, count: number, price: number) {
  return Array.from({ length: count }, () => ({
    data: {
      estado,
      itens: {
        product: [{ precoDeVenda: price, quantidade: 1, descontoUnitario: 0 }],
      },
    },
  }));
}

function result(rows: ReturnType<typeof orders>): SalesReport {
  return { total: rows.length, byBucket: porBucket(rows), byEstado: porEstado(rows) };
}

function renderReport() {
  const client = new QueryClient();
  return render(
    <MantineTestProvider>
      <QueryClientProvider client={client}>
        <VendasPorEstadoPage />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
}

function consult() {
  fireEvent.click(screen.getByRole('button', { name: 'Consultar' }));
}

function selectOption(label: string, option: string) {
  const input = screen.getByRole('combobox', { name: label });
  fireEvent.click(input);
  fireEvent.click(screen.getByRole('option', { name: option }));
  expect(input.getAttribute('aria-expanded')).toBe('false');
}

function expectBucket(label: string, count: number, revenue: string) {
  const legend = screen.getByRole('list', { name: 'Resumo por estado' });
  const item = within(legend).getByText(label).closest('li');
  expect(item).not.toBeNull();
  expect(within(item!).getByText(`${count} pedido(s)`)).toBeTruthy();
  expect(within(item!).getByText(revenue)).toBeTruthy();
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-25T01:00:00Z'));
  mocks.canReadChannels = true;
  mocks.load.mockReset().mockResolvedValue(EMPTY);
  mocks.useIntegracoes.mockReset().mockReturnValue({
    status: 'success',
    rows: [{ id: 'store', data: { nome: 'Loja', tipo: INTEGRACAO_TIPO.balcao, ativo: false } }],
  });
});
afterEach(() => vi.restoreAllMocks());

describe('VendasPorEstadoPage bucket readability', () => {
  it.each([
    { open: 374, completed: 119 },
    { open: 373, completed: 120 },
  ])(
    'keeps every count with its bucket and state in a skewed 500-order report (%j)',
    async (counts) => {
      const selectedOrders = [
        ...orders(ESTADO_PEDIDO.iniciado, counts.open, 10),
        ...orders(ESTADO_PEDIDO.emAnalise, 2, 20),
        ...orders(ESTADO_PEDIDO.pago, counts.completed, 30),
        ...orders(ESTADO_PEDIDO.cancelado, 5, 40),
      ];
      mocks.load.mockResolvedValue(result(selectedOrders));
      renderReport();
      consult();

      expect(screen.getByRole('heading', { name: 'Vendas por estado' })).toBeTruthy();
      expect(selectedOrders).toHaveLength(500);
      await screen.findByRole('table');
      expect(screen.getByText('500 pedidos')).toBeTruthy();
      expectBucket('Em aberto', counts.open, counts.open === 374 ? 'R$ 3.740,00' : 'R$ 3.730,00');
      expectBucket('Em processo', 2, 'R$ 40,00');
      expectBucket(
        'Concluído',
        counts.completed,
        counts.completed === 119 ? 'R$ 3.570,00' : 'R$ 3.600,00',
      );
      expectBucket('Cancelado / Erro', 5, 'R$ 200,00');
      expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(4);

      const table = screen.getByRole('table');
      const rows = within(table).getAllByRole('row').slice(1);
      expect(
        rows.map((row) =>
          within(row)
            .getAllByRole('cell')
            .map((cell) => getDefaultNormalizer()(cell.textContent ?? '')),
        ),
      ).toEqual([
        [
          'Iniciado',
          'Em aberto',
          String(counts.open),
          counts.open === 374 ? 'R$ 3.740,00' : 'R$ 3.730,00',
        ],
        [
          'Pago',
          'Concluído',
          String(counts.completed),
          counts.completed === 119 ? 'R$ 3.570,00' : 'R$ 3.600,00',
        ],
        ['Cancelado', 'Cancelado / Erro', '5', 'R$ 200,00'],
        ['Em análise', 'Em processo', '2', 'R$ 40,00'],
      ]);
    },
  );

  it('retains zero buckets in the readable legend without inventing state rows', async () => {
    mocks.load.mockResolvedValue(result(orders(ESTADO_PEDIDO.pago, 1, 30)));
    renderReport();
    consult();
    await screen.findByRole('table');

    expectBucket('Em aberto', 0, 'R$ 0,00');
    expectBucket('Em processo', 0, 'R$ 0,00');
    expectBucket('Concluído', 1, 'R$ 30,00');
    expectBucket('Cancelado / Erro', 0, 'R$ 0,00');
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(
      within(rows[0]!)
        .getAllByRole('cell')
        .map((cell) => getDefaultNormalizer()(cell.textContent ?? '')),
    ).toEqual(['Pago', 'Concluído', '1', 'R$ 30,00']);
  });
});

describe('VendasPorEstadoPage query filters', () => {
  it('shows the São Paulo month to date and only fetches when consulted', async () => {
    renderReport();
    expect((screen.getByLabelText('Data inicial') as HTMLInputElement).value).toBe('2026-11-01');
    expect((screen.getByLabelText('Data final') as HTMLInputElement).value).toBe('2026-11-24');
    expect((screen.getByLabelText('Movimento') as HTMLSelectElement).value).toBe('saidas');
    expect(mocks.load).not.toHaveBeenCalled();

    consult();
    await screen.findByText('Nenhum pedido encontrado para os filtros selecionados.');
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      {},
      {
        startUs: Date.parse('2026-11-01T03:00:00Z') * 1000,
        endExclusiveUs: Date.parse('2026-11-25T03:00:00Z') * 1000,
        movement: 'saidas',
        estados: [],
        accountIds: [],
      },
    );
  });

  it('submits combined filters, hides outdated results, and refreshes on another click', async () => {
    mocks.load.mockResolvedValue(result(orders(ESTADO_PEDIDO.pago, 1, 30)));
    renderReport();
    consult();
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Data inicial'), { target: { value: '2026-11-04' } });
    fireEvent.change(screen.getByLabelText('Movimento'), { target: { value: 'entradas' } });
    selectOption('Estados do pedido', 'Pago');
    selectOption('Canais de venda', 'Loja (Balcão) — inativo');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/Os filtros foram alterados/)).toBeTruthy();
    expect(mocks.load).toHaveBeenCalledTimes(1);

    consult();
    await screen.findByRole('table');
    expect(mocks.load).toHaveBeenLastCalledWith(
      {},
      {
        startUs: Date.parse('2026-11-04T03:00:00Z') * 1000,
        endExclusiveUs: Date.parse('2026-11-25T03:00:00Z') * 1000,
        movement: 'entradas',
        estados: [ESTADO_PEDIDO.pago],
        accountIds: ['store'],
      },
    );
    consult();
    await screen.findByRole('table');
    expect(mocks.load).toHaveBeenCalledTimes(3);
  });

  it('prevents requests for reversed or missing dates', () => {
    renderReport();
    fireEvent.change(screen.getByLabelText('Data inicial'), { target: { value: '2026-11-25' } });
    expect(screen.getByText('Informe um período válido.')).toBeTruthy();
    consult();
    fireEvent.change(screen.getByLabelText('Data inicial'), { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Consultar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    consult();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('shows a query error and retries only on a new submission', async () => {
    mocks.load.mockRejectedValueOnce(new Error('Consulta indisponível'));
    renderReport();
    consult();
    await screen.findByText('Consulta indisponível');
    expect(mocks.load).toHaveBeenCalledTimes(1);
    consult();
    await screen.findByText('Nenhum pedido encontrado para os filtros selecionados.');
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it('allows report access without integration read permission', async () => {
    mocks.canReadChannels = false;
    renderReport();
    expect(screen.queryByLabelText('Canais de venda')).toBeNull();
    expect(mocks.useIntegracoes).not.toHaveBeenCalled();
    consult();
    await screen.findByText('Nenhum pedido encontrado para os filtros selecionados.');
  });

  it('keeps the report usable after an integration lookup error', async () => {
    const retry = vi.fn();
    mocks.useIntegracoes.mockReturnValue({
      status: 'error',
      rows: [],
      query: { isFetching: false, refetch: retry },
    });
    renderReport();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar os canais de venda.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar canais' }));
    expect(retry).toHaveBeenCalledOnce();
    consult();
    await screen.findByText('Nenhum pedido encontrado para os filtros selecionados.');
  });
});
