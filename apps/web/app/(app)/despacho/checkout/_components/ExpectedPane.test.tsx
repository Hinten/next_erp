import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import type { EngineProduto, ExpectedItem } from '@delfrance/schemas';

vi.mock('./useVirtualRows', () => ({
  useVirtualRows: (count: number) => ({
    rows: Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 })),
    totalSize: count * 76,
  }),
}));

import { ExpectedPane, flattenExpected } from './ExpectedPane';

function nonKit(pos: number, concluido: boolean): ExpectedItem {
  return {
    key: `exp-${pos}`,
    pos,
    produtoUid: `p${pos}`,
    nomeDeVenda: `Item ${pos}`,
    sku: `SKU-${pos}`,
    quantidade: 1,
    ehKit: false,
    componentes: null,
    launched: concluido ? 1 : 0,
    concluido,
    error: null,
  };
}

function kit(pos: number): ExpectedItem {
  return {
    key: `exp-${pos}`,
    pos,
    produtoUid: `k${pos}`,
    nomeDeVenda: `Kit ${pos}`,
    sku: `KIT-${pos}`,
    quantidade: 1,
    ehKit: true,
    componentes: [
      { produtoId: 'c1', requiredPerKit: 1, requiredTotal: 1, launchedDirect: 0 },
      { produtoId: 'c2', requiredPerKit: 2, requiredTotal: 2, launchedDirect: 0 },
    ],
    launched: 0,
    concluido: false,
    error: null,
  };
}

describe('flattenExpected', () => {
  it('drops concluded items', () => {
    const rows = flattenExpected([nonKit(0, true), nonKit(1, false)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item.pos).toBe(1);
  });

  it('flattens a kit into a parent row + one row per component', () => {
    const rows = flattenExpected([kit(0)]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
    expect(rows[1]).toMatchObject({ depth: 1, component: { produtoId: 'c1' } });
    expect(rows[2]).toMatchObject({ depth: 1, component: { produtoId: 'c2' } });
  });
});

describe('ExpectedPane', () => {
  const produto = (id: string): EngineProduto => ({
    id,
    nome: `Produto ${id}`,
    sku: `SKU-${id}`,
    ehKit: false,
    componentesKit: null,
    fotos: null,
  });

  function renderPane(expected: ExpectedItem[]) {
    const produtos = new Map<string, EngineProduto>([
      ['c1', produto('c1')],
      ['c2', produto('c2')],
    ]);
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider>
          <ExpectedPane db={{} as Firestore} expected={expected} produtos={produtos} />
        </MantineProvider>
      </QueryClientProvider>,
    );
  }

  it('renders kit component rows and hides completed items', () => {
    const { container } = renderPane([nonKit(0, true), kit(1)]);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Item 0'); // completed → hidden
    expect(text).toContain('Kit 1');
    expect(text).toContain('Produto c1'); // component row
    expect(text).toContain('Produto c2');
  });

  it('shows the all-done message when nothing remains', () => {
    const { container } = renderPane([nonKit(0, true)]);
    expect(container.textContent).toContain('Todos os produtos já foram lançados');
  });
});
