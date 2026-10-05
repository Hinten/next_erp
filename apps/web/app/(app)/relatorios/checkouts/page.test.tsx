import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { CheckoutReport } from '@/lib/reports/aggregations';
import CheckoutsPage from './page';

const mocks = vi.hoisted(() => ({ load: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/reports/checkouts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/checkouts')>()),
  loadCheckoutReport: mocks.load,
}));
vi.mock('@/lib/reports/checkoutsCsv', () => ({ downloadCheckoutsCsv: mocks.download }));
vi.mock('@mantine/charts', () => ({
  BarChart: ({ data }: { data: unknown }) => <div data-testid="chart">{JSON.stringify(data)}</div>,
}));
// Calendar internals have their own library tests; expose controlled dates to
// exercise the page's query transitions with the real TanStack Query lifecycle.
vi.mock('@mantine/dates', () => ({
  DatePickerInput: ({
    value,
    onChange,
  }: {
    value: [string | null, string | null];
    onChange: (value: [string | null, string | null]) => void;
  }) => (
    <>
      <input
        aria-label="Início"
        value={value[0] ?? ''}
        onChange={(event) => onChange([event.target.value || null, value[1]])}
      />
      <input
        aria-label="Fim"
        value={value[1] ?? ''}
        onChange={(event) => onChange([value[0], event.target.value || null])}
      />
    </>
  ),
}));

const report: CheckoutReport = {
  total: 5,
  rows: [
    { userId: 'a', label: 'Ana', count: 3 },
    { userId: null, label: 'Outros usuários', count: 2 },
  ],
};
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    <MantineTestProvider>
      <QueryClientProvider client={client}>
        <CheckoutsPage />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe('checkout report page', () => {
  it('shows loading, then total/chart/table and exports the displayed report', async () => {
    let resolve!: (value: CheckoutReport) => void;
    mocks.load.mockReturnValue(
      new Promise<CheckoutReport>((done) => {
        resolve = done;
      }),
    );
    mount();
    expect(screen.getByRole('status', { name: 'Carregando checkouts' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Exportar CSV' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByText('Nenhum checkout encontrado no período.')).toBeNull();
    await act(async () => {
      resolve(report);
    });
    await screen.findByRole('heading', { name: 'Checkouts por Usuário' });
    expect(screen.getByText('Total de checkouts')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByTestId('chart').textContent).toContain('"Checkouts":3');
    fireEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(mocks.download).toHaveBeenCalledWith(
      report,
      (screen.getByLabelText('Início') as HTMLInputElement).value,
      (screen.getByLabelText('Fim') as HTMLInputElement).value,
    );
  });

  it('renders zero and the empty state without a chart, table or export', async () => {
    mocks.load.mockResolvedValue({ total: 0, rows: [] });
    mount();
    await screen.findByText('Nenhum checkout encontrado no período.');
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Exportar CSV' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows errors without a misleading empty state, and refresh retries the report', async () => {
    mocks.load
      .mockRejectedValueOnce(new TypeError('Consulta indisponível'))
      .mockResolvedValueOnce(report);
    mount();
    await screen.findByText('Consulta indisponível');
    expect(screen.queryByText('Nenhum checkout encontrado no período.')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Exportar CSV' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await screen.findByRole('table');
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it('hides old results and disables export during refresh, then displays the new total', async () => {
    let resolve!: (value: CheckoutReport) => void;
    mocks.load.mockResolvedValueOnce(report).mockImplementationOnce(
      () =>
        new Promise<CheckoutReport>((done) => {
          resolve = done;
        }),
    );
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await screen.findByRole('status');
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Exportar CSV' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      resolve({ total: 0, rows: [] });
    });
    await screen.findByText('Nenhum checkout encontrado no período.');
  });

  it('does not query an incomplete range or let an older request replace the newly selected dates', async () => {
    let resolveOld!: (value: CheckoutReport) => void;
    mocks.load
      .mockImplementationOnce(
        () =>
          new Promise<CheckoutReport>((done) => {
            resolveOld = done;
          }),
      )
      .mockResolvedValue({ total: 0, rows: [] });
    mount();
    fireEvent.change(screen.getByLabelText('Fim'), { target: { value: '' } });
    expect(screen.getByText('Selecione as datas de início e fim para consultar.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Atualizar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(mocks.load).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Início'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Fim'), { target: { value: '2026-01-02' } });
    await screen.findByText('Nenhum checkout encontrado no período.');
    await act(async () => {
      resolveOld(report);
    });
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(screen.getByText('0')).toBeTruthy();
    expect(mocks.load).toHaveBeenLastCalledWith(
      {},
      {
        startMs: new Date(2026, 0, 1).getTime(),
        endExclusiveMs: new Date(2026, 0, 3).getTime(),
      },
    );
  });
});
