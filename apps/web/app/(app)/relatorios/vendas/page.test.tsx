import { getDefaultNormalizer, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADO_PEDIDO, type ItemDoPedido, type Pedido } from '@delfrance/schemas';
import type { PedidoLite } from '@/lib/reports/aggregations';
import { MantineTestProvider } from '@/lib/testing/mantine';
import VendasPorEstadoPage from './page';

const h = vi.hoisted(() => ({ data: [] as PedidoLite[] }));

vi.mock('../_components/useRecentPedidos', () => ({
  useRecentPedidos: () => ({ data: h.data, loading: false, error: null }),
}));

function orders(estado: Pedido['estado'], count: number, price: number): PedidoLite[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${estado}-${index}`,
    // Only the state and item totals are consumed by this report's aggregations.
    data: {
      estado,
      itens: {
        product: [{ precoDeVenda: price, quantidade: 1, descontoUnitario: 0 } as ItemDoPedido],
      },
    } as unknown as Pedido,
  }));
}

function renderReport() {
  return render(
    <MantineTestProvider>
      <VendasPorEstadoPage />
    </MantineTestProvider>,
  );
}

function expectBucket(label: string, count: number, revenue: string) {
  const legend = screen.getByRole('list', { name: 'Resumo por estado' });
  const item = within(legend).getByText(label).closest('li');
  expect(item).not.toBeNull();
  expect(within(item!).getByText(`${count} pedido(s)`)).toBeTruthy();
  expect(within(item!).getByText(revenue)).toBeTruthy();
}

beforeEach(() => {
  h.data = [];
});

describe('VendasPorEstadoPage bucket readability', () => {
  it.each([
    { open: 374, completed: 119 },
    { open: 373, completed: 120 },
  ])('keeps every count with its bucket and state in a skewed 500-order report (%j)', (counts) => {
    h.data = [
      ...orders(ESTADO_PEDIDO.iniciado, counts.open, 10),
      ...orders(ESTADO_PEDIDO.emAnalise, 2, 20),
      ...orders(ESTADO_PEDIDO.pago, counts.completed, 30),
      ...orders(ESTADO_PEDIDO.cancelado, 5, 40),
    ];
    renderReport();

    expect(screen.getByRole('heading', { name: 'Vendas por estado' })).toBeTruthy();
    expect(h.data).toHaveLength(500);
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
  });

  it('retains zero buckets in the readable legend without inventing state rows', () => {
    h.data = orders(ESTADO_PEDIDO.pago, 1, 30);
    renderReport();

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
