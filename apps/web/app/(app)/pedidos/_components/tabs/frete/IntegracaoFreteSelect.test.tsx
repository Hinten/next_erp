import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getDocs, type Firestore } from 'firebase/firestore';
import {
  INTEGRACAO_FRETE,
  INTEGRACAO_FRETE_LABELS,
  integracoesFreteSchema,
  isFreteMarketplaceOwned,
  type IntegracaoFrete,
} from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { IntegracaoFreteSelect, type IntegracaoFreteSelectProps } from './IntegracaoFreteSelect';

vi.mock('firebase/firestore', () => ({ getDocs: vi.fn() }));
vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown) => base,
  whereOp: () => ({}),
  orderByField: () => ({}),
  limit: () => ({}),
}));
vi.mock('@/lib/data/intFreteCollection', () => ({
  intFreteCollection: { ref: () => ({}) },
}));

interface Fixture {
  id: string;
  nome: string;
  tipo: IntegracaoFrete;
}

const motoboy: Fixture = { id: 'moto-1', nome: 'Local delivery', tipo: INTEGRACAO_FRETE.motoboy };
const shopee: Fixture = { id: 'shopee-1', nome: 'Shopee account', tipo: INTEGRACAO_FRETE.shopee };
const label = (row: Fixture) => `${row.nome} (${INTEGRACAO_FRETE_LABELS[row.tipo]})`;

function mockDocs(rows: Fixture[]) {
  // Only the Firestore snapshot boundary is mocked; no live database is used.
  vi.mocked(getDocs).mockResolvedValue({
    docs: rows.map(({ id, nome, tipo }) => ({ id, data: () => ({ nome, tipo, ativo: true }) })),
  } as unknown as Awaited<ReturnType<typeof getDocs>>);
}

function renderPicker(props: Partial<IntegracaoFreteSelectProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = vi.fn();
  render(
    <MantineTestProvider>
      <QueryClientProvider client={client}>
        <IntegracaoFreteSelect db={{} as Firestore} value={null} onChange={onChange} {...props} />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
  return { client, onChange };
}

const input = () => screen.getAllByLabelText<HTMLInputElement>('Integração de frete')[0]!;
const options = () => screen.getAllByRole('option').map((option) => option.textContent);
const waitForQuery = (client: QueryClient) =>
  waitFor(() => expect(client.getQueryState(['intFreteAtivosPicker'])?.status).toBe('success'));

beforeEach(() => {
  vi.mocked(getDocs).mockReset();
});

describe('IntegracaoFreteSelect', () => {
  it('offers motoboy but excludes Shopee from manual selection', async () => {
    mockDocs([motoboy, shopee]);
    renderPicker();
    fireEvent.click(input());
    await screen.findByRole('option', { name: label(motoboy) });

    expect(options()).toEqual([label(motoboy)]);
  });

  it('retains every non-marketplace tipo and excludes every marketplace-owned tipo', async () => {
    const rows = integracoesFreteSchema.options.map((tipo) => ({ id: tipo, nome: tipo, tipo }));
    mockDocs(rows);
    renderPicker();
    fireEvent.click(input());
    await screen.findByRole('option', {
      name: label(rows.find((row) => row.tipo === INTEGRACAO_FRETE.motoboy)!),
    });

    expect(options()).toEqual(rows.filter((row) => !isFreteMarketplaceOwned(row.tipo)).map(label));
  });

  it('displays a stored Shopee selection through currentFallback after the active list loads', async () => {
    mockDocs([motoboy, shopee]);
    renderPicker({ value: shopee.id, currentFallback: shopee });
    fireEvent.click(input());
    // A fetched option proves the list rendered, so an initial fallback label
    // alone cannot make this test pass before the filtered query data arrives.
    await screen.findByRole('option', { name: label(motoboy) });
    fireEvent.keyDown(input(), { key: 'Escape' });

    expect(input().value).toBe(label(shopee));
  });

  it('does not duplicate an existing non-marketplace selection when a fallback is supplied', async () => {
    mockDocs([motoboy]);
    const { client } = renderPicker({ value: motoboy.id, currentFallback: motoboy });
    await waitForQuery(client);
    fireEvent.click(input());
    await screen.findByRole('option', { name: label(motoboy) });

    expect(options()).toEqual([label(motoboy)]);
  });

  it('displays a stored selection absent from the active list through currentFallback', async () => {
    mockDocs([]);
    const { client } = renderPicker({ value: motoboy.id, currentFallback: motoboy });
    await waitForQuery(client);

    expect(input().value).toBe(label(motoboy));
  });

  it('passes the selected non-marketplace document ID to onChange', async () => {
    mockDocs([motoboy, shopee]);
    const { onChange } = renderPicker();
    fireEvent.click(input());
    fireEvent.click(await screen.findByRole('option', { name: label(motoboy) }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(motoboy.id);
  });
});
