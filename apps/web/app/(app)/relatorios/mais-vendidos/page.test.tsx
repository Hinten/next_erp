import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import { PERM } from '@delfrance/auth';
import { ESTADO_PEDIDO, INTEGRACAO_TIPO } from '@delfrance/schemas';
import type { TopProductsResult } from '@/lib/reports/topProductsSession';
import BestSellingProductsPage from './page';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  integrations: vi.fn(),
  permission: vi.fn(),
  uid: 'operator',
  permissions: '12345',
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: mocks.uid }, loading: false }),
  useTenant: () => ({ claims: { permissions: mocks.permissions }, loading: false }),
  RequirePerm: ({ children, bit }: { children: import('react').ReactNode; bit: bigint }) =>
    mocks.permission(bit) ? children : <div>Sem permissão</div>,
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseApp: () => ({ options: { projectId: 'demo-erp' } }),
  getFirebaseFirestore: () => ({}),
  isUsingFirebaseEmulator: () => true,
}));
vi.mock('@/lib/data/useIntegracoes', () => ({ useIntegracoes: mocks.integrations }));
vi.mock('@/lib/reports/topProductsSession', () => ({
  topProductsRunner: { run: mocks.run },
  topProductsCacheKey: (_scope: unknown, filters: unknown) => JSON.stringify(filters),
}));
vi.mock('@mantine/charts', () => ({
  PieChart: ({ data, 'aria-label': label }: { data: unknown; 'aria-label': string }) => (
    <div role="img" aria-label={label}>
      {JSON.stringify(data)}
    </div>
  ),
}));
// Test the page's selection/query boundaries; the library owns dropdown behavior.
vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantine/core')>()),
  MultiSelect: ({
    label,
    data,
    value,
    onChange,
    disabled,
    error,
  }: {
    label: string;
    data: { value: string; label: string }[];
    value: string[];
    onChange: (values: string[]) => void;
    disabled?: boolean;
    error?: string;
  }) => (
    <label>
      {label}
      <select
        aria-label={label}
        multiple
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(Array.from(event.target.selectedOptions, (option) => option.value))
        }
      >
        {data.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
      {error && <span>{error}</span>}
    </label>
  ),
}));

function report(quantity = 12, fromCache = false): TopProductsResult {
  const generatedAt = Date.now();
  return {
    report: {
      rows: [
        {
          produtoId: 'parent',
          quantidade: quantity,
          variations: [{ produtoId: 'blue', quantidade: quantity }],
        },
      ],
      totalQuantidade: quantity,
      diagnostics: [],
    },
    rows: [
      {
        produtoId: 'parent',
        quantidade: quantity,
        nome: 'Camisa',
        sku: 'SHIRT',
        photoUrl: null,
        variations: [
          {
            produtoId: 'blue',
            quantidade: quantity,
            nome: 'Camisa azul',
            sku: 'SHIRT-BLUE',
            photoUrl: null,
          },
        ],
      },
    ],
    generatedAt,
    expiresAt: generatedAt + 6 * 60 * 60 * 1000,
    fromCache,
  };
}

const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
  clients.push(client);
  const tree = () => (
    <MantineTestProvider>
      <QueryClientProvider client={client}>
        <BestSellingProductsPage />
      </QueryClientProvider>
    </MantineTestProvider>
  );
  const view = render(tree());
  return { ...view, redraw: () => view.rerender(tree()) };
}
function dates(start = '2026-01-01', end = '2026-01-31') {
  fireEvent.change(screen.getByLabelText('Data inicial'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('Data final'), { target: { value: end } });
}
function select(label: string, values: string[]) {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLSelectElement)) throw new TypeError('Expected a select.');
  for (const option of element.options) option.selected = values.includes(option.value);
  fireEvent.change(element);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.uid = 'operator';
  mocks.permissions = '12345';
  mocks.permission.mockReturnValue(true);
  mocks.integrations.mockReturnValue({
    status: 'success',
    rows: [
      {
        id: 'account',
        data: { nome: 'Loja antiga', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: false },
      },
    ],
    query: {},
  });
  mocks.run.mockResolvedValue(report());
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
});

describe('best-selling products page', () => {
  it('only submits explicit valid filters with the agreed defaults', async () => {
    mount();
    expect(mocks.run).not.toHaveBeenCalled();
    dates();
    expect(mocks.run).not.toHaveBeenCalled();
    select('Canais de venda', ['account']);
    expect(screen.getByRole('option', { name: /Loja antiga.*inativo/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
    await screen.findByRole('table', { name: 'Produtos mais vendidos' });
    expect(mocks.run).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        userId: 'operator',
        permissions: '12345',
        project: 'demo-erp',
      }),
      {
        startUs: new Date(2026, 0, 1).getTime() * 1000,
        endExclusiveUs: new Date(2026, 1, 1).getTime() * 1000,
        estados: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado],
        accountIds: ['account'],
        ehSaida: true,
      },
      10,
      false,
    );
    expect(screen.getByRole('img', { name: 'Participação por produto pai' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Variações de Camisa' })).toBeTruthy();
    expect(mocks.permission).toHaveBeenCalledWith(
      PERM.pedido.read | PERM.produto.read | PERM.integracao.read,
    );
  });

  it('blocks incomplete ranges and empty states without sending a request', () => {
    mount();
    dates('2026-01-31', '2026-01-01');
    expect(screen.getByText('Informe um período válido.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gerar relatório' }).hasAttribute('disabled')).toBe(
      true,
    );
    dates();
    select('Estados do pedido', []);
    expect(screen.getByText('Selecione ao menos um estado.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('shows loading, renders cached status, and explicitly bypasses cache on refresh', async () => {
    let resolve!: (value: TopProductsResult) => void;
    mocks.run.mockReturnValueOnce(
      new Promise<TopProductsResult>((done) => {
        resolve = done;
      }),
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
    expect(screen.getByRole('status', { name: 'Carregando produtos mais vendidos' })).toBeTruthy();
    await act(async () => {
      resolve(report(12, true));
    });
    await screen.findByRole('table', { name: 'Produtos mais vendidos' });
    expect(screen.getByText(/Dados em cache/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar dados' }));
    await screen.findByText(/Dados atualizados/);
    expect(mocks.run.mock.calls[1]?.[4]).toBe(true);
  });

  it('does not label a query error or unavailable channel lookup as an empty report', async () => {
    mocks.run.mockRejectedValueOnce(new TypeError('Consulta indisponível'));
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
    await screen.findByText('Consulta indisponível');
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Nenhuma venda encontrada/)).toBeNull();
    mocks.integrations.mockReturnValue({
      status: 'error',
      rows: [],
      query: { error: new TypeError('Canais indisponíveis'), refetch: vi.fn() },
    });
    view.redraw();
    expect(screen.getByText('Canais indisponíveis')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gerar relatório' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('shows empty and incomplete data states without fabricating chart rows', async () => {
    const empty = report();
    empty.report = {
      rows: [],
      totalQuantidade: 0,
      diagnostics: [
        {
          kind: 'invalid-kit',
          produtoId: 'kit',
          quantidade: 2,
          message: 'Composição inválida.',
        },
      ],
    };
    empty.rows = [];
    mocks.run.mockResolvedValue(empty);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
    await screen.findByText(/Nenhuma venda encontrada/);
    expect(screen.getByText(/Composição inválida/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('ignores a stale completion after a different period is submitted', async () => {
    let resolve!: (value: TopProductsResult) => void;
    mocks.run
      .mockReturnValueOnce(
        new Promise<TopProductsResult>((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValue(report(3));
    mount();
    dates('2026-01-01', '2026-01-02');
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
    dates('2026-02-01', '2026-02-02');
    // Editing filters does not query. A new submission is allowed even while
    // the previous filter set is in flight, and has a distinct query identity.
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
    const table = await screen.findByRole('table', { name: 'Produtos mais vendidos' });
    expect(within(table).getByTestId('top-product-parent').getAttribute('data-quantity')).toBe('3');
    await act(async () => {
      resolve(report(99));
    });
    expect(within(table).getByTestId('top-product-parent').getAttribute('data-quantity')).toBe('3');
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it('hides expired and previous-user reports instead of reusing their in-memory result', async () => {
    const expired = report();
    expired.expiresAt = Date.now() - 1;
    mocks.run.mockResolvedValueOnce(expired);
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));
    await screen.findByText(/As seis horas de validade terminaram/);
    expect(screen.queryByRole('table')).toBeNull();
    mocks.uid = 'another-operator';
    view.redraw();
    expect(screen.getByText('Selecione os filtros e clique em Gerar relatório.')).toBeTruthy();
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('gates the report and cache access on the required current permissions', () => {
    mocks.permission.mockReturnValue(false);
    mount();
    expect(screen.getByText('Sem permissão')).toBeTruthy();
    expect(mocks.integrations).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
