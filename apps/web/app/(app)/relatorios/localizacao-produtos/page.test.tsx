import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { ProductLocationRow } from '@/lib/reports/productLocation';
import { ProductLocationReportScreen, type ProductLocationLoader } from './page';

const h = vi.hoisted(() => ({ db: {} }));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => h.db }));
vi.mock('@/components/pickers/DepositoPicker', () => ({
  DepositoPicker: ({
    onChange,
    disabled,
    error,
  }: {
    onChange: (value: unknown) => void;
    disabled?: boolean;
    error?: string;
  }) => (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('documents/depositos/dep-1')}
      >
        Selecionar depósito Central
      </button>
      {error ? <span>{error}</span> : null}
    </div>
  ),
}));

function renderReport(loadReport: ProductLocationLoader) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <MantineTestProvider>
      <QueryClientProvider client={queryClient}>
        <ProductLocationReportScreen loadReport={loadReport} />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => vi.clearAllMocks());

describe('ProductLocationReportScreen', () => {
  it('requires a depósito before running', () => {
    const loader = vi.fn<ProductLocationLoader>();
    renderReport(loader);

    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));

    expect(screen.getByText('Selecione um depósito antes de gerar o relatório.')).toBeTruthy();
    expect(loader).not.toHaveBeenCalled();
  });

  it('shows progress while loading and the required empty state afterwards', async () => {
    const pending = deferred<ProductLocationRow[]>();
    const loader = vi.fn<ProductLocationLoader>(() => pending.promise);
    renderReport(loader);

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar depósito Central' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));

    expect(screen.getByRole('progressbar', { name: 'Progresso do relatório' })).toBeTruthy();
    expect(screen.getByText('Consultando estoques… 0 de 2')).toBeTruthy();

    await act(async () => pending.resolve([]));

    await waitFor(() =>
      expect(screen.getByText('Nenhum estoque com localização encontrado')).toBeTruthy(),
    );
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('renders the six report columns and availability result', async () => {
    const loader = vi.fn<ProductLocationLoader>(async () => [
      {
        key: 'produtos/p1/estoques/e1',
        produtoId: 'p1',
        sku: 'CAM-1',
        produto: 'Camiseta',
        localizacao: 'A-10',
        total: 10,
        reservado: 2,
        disponivel: 8,
      },
    ]);
    renderReport(loader);

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar depósito Central' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));

    await waitFor(() => expect(screen.getByRole('link', { name: 'Camiseta' })).toBeTruthy());
    for (const heading of ['SKU', 'Produto', 'Localização', 'Total', 'Reservado', 'Disponível']) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeTruthy();
    }
    expect(screen.getByRole('row', { name: /CAM-1 Camiseta A-10 10 2 8/ })).toBeTruthy();
  });
});
