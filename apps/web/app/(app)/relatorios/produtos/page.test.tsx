import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { ESTADO_PEDIDO, INTEGRACAO_TIPO } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import { orderReportDateRange } from '@/lib/reports/orderReportFilters';
import ProductSalesPage from './page';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  integrations: vi.fn(),
  canReadChannels: true,
}));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({
    allowed: bit === PERM.integracao.read && mocks.canReadChannels,
    loading: false,
  }),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => 'report-db' }));
vi.mock('@/lib/data/useIntegracoes', () => ({ useIntegracoes: mocks.integrations }));
vi.mock('@/lib/reports/productSales', () => ({ loadProductSalesReport: mocks.load }));
vi.mock('@mantine/charts', () => ({
  BarChart: ({ data }: { data: unknown }) => (
    <div data-testid="sales-chart">{JSON.stringify(data)}</div>
  ),
}));
vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantine/core')>()),
  MultiSelect: ({
    data,
    error,
    label,
    onChange,
    value,
  }: {
    data: { value: string; label: string }[];
    error?: string;
    label: string;
    onChange: (values: string[]) => void;
    value: string[];
  }) => (
    <label>
      {label}
      <select
        aria-label={label}
        multiple
        value={value}
        onChange={(event) =>
          onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
        }
      >
        {data.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <span>{error}</span>}
    </label>
  ),
}));

const sample = {
  rows: [
    { produtoUid: 'shirt', label: 'Camisa', quantidade: 20, pedidos: 2, receita: 40 },
    { produtoUid: 'hat', label: 'Boné', quantidade: 8, pedidos: 3, receita: 80 },
    { produtoUid: 'jacket', label: 'Casaco', quantidade: 2, pedidos: 1, receita: 200 },
  ],
  invalidLines: 0,
};

let client: QueryClient;

function mount() {
  client = new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
  render(
    <MantineTestProvider>
      <QueryClientProvider client={client}>
        <ProductSalesPage />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
}

function dates(start: string, end: string) {
  fireEvent.change(screen.getByLabelText('Data inicial'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('Data final'), { target: { value: end } });
}

function choose(label: string, values: string[]) {
  const select = screen.getByLabelText<HTMLSelectElement>(label);
  for (const option of select.options) option.selected = values.includes(option.value);
  fireEvent.change(select);
}

function generate() {
  fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
}

function productNames() {
  const table = screen.getByRole('table', { name: 'Vendas por produto' });
  return within(table)
    .getAllByRole('link')
    .map((link) => link.textContent);
}

beforeEach(() => {
  mocks.canReadChannels = true;
  mocks.load.mockReset().mockResolvedValue(sample);
  mocks.integrations.mockReset().mockReturnValue({
    status: 'success',
    rows: [
      { id: 'account', data: { nome: 'Loja antiga', tipo: INTEGRACAO_TIPO.balcao, ativo: false } },
    ],
  });
});

afterEach(() => {
  cleanup();
  client?.clear();
});

describe('product sales query controls', () => {
  it('submits the selected filters and waits for a new submission when they change', async () => {
    mount();
    expect(screen.getByRole('option', { name: /Loja antiga.*inativo/ })).toBeTruthy();
    dates('2026-05-01', '2026-05-31');
    choose('Estados do pedido', [ESTADO_PEDIDO.finalizado]);
    choose('Canais de venda', ['account']);
    fireEvent.change(screen.getByLabelText('Movimento'), { target: { value: 'entrada' } });
    expect(mocks.load).not.toHaveBeenCalled();

    generate();
    const table = await screen.findByRole('table', { name: 'Vendas por produto' });
    expect(within(table).getByRole('columnheader', { name: 'Valor dos itens' })).toBeTruthy();
    expect(mocks.load).toHaveBeenCalledWith('report-db', {
      ...orderReportDateRange('2026-05-01', '2026-05-31'),
      estados: [ESTADO_PEDIDO.finalizado],
      accountIds: ['account'],
      ehSaida: false,
    });

    dates('2026-05-01', '2026-06-02');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/Os filtros foram alterados/)).toBeTruthy();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    generate();
    await screen.findByRole('table');
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it('updates the chart and table ranking and Top with the loaded result', async () => {
    mount();
    generate();
    await screen.findByRole('table');
    expect(productNames()).toEqual(['Camisa', 'Boné', 'Casaco']);
    fireEvent.change(screen.getByLabelText('Ordenar por'), { target: { value: 'pedidos' } });
    expect(productNames()).toEqual(['Boné', 'Camisa', 'Casaco']);
    fireEvent.change(screen.getByLabelText('Ordenar por'), { target: { value: 'receita' } });
    expect(productNames()).toEqual(['Casaco', 'Boné', 'Camisa']);
    fireEvent.change(screen.getByLabelText('Top'), { target: { value: '1' } });
    expect(productNames()).toEqual(['Casaco']);
    expect(screen.getByTestId('sales-chart').textContent).toBe(
      '[{"produto":"Casaco","Receita":200}]',
    );
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid dates and a cleared status selection before reading orders', async () => {
    mount();
    dates('2026-03-02', '2026-03-01');
    choose('Estados do pedido', []);
    generate();
    await screen.findByText('Informe um período válido.');
    await screen.findByText('Selecione ao menos um estado.');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('can retry a failed query and distinguishes an empty result', async () => {
    mocks.load.mockRejectedValueOnce(new Error('Consulta indisponível'));
    mocks.load.mockResolvedValueOnce({ rows: [], invalidLines: 0 });
    mount();
    generate();
    await screen.findByText('Consulta indisponível');
    expect(mocks.load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('Nenhum produto encontrado com os filtros selecionados.');
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it('queries all channels without accessing the integration collection when permission is absent', async () => {
    mocks.canReadChannels = false;
    mount();
    expect(screen.queryByLabelText('Canais de venda')).toBeNull();
    generate();
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    expect(mocks.load).toHaveBeenCalledWith(
      'report-db',
      expect.objectContaining({ accountIds: [] }),
    );
    expect(mocks.integrations).not.toHaveBeenCalled();
  });
});
