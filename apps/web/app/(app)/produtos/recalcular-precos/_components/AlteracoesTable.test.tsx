import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { PrecoAlteracao } from '@/lib/produtos/bulkPreco/types';

// jsdom has no layout, so the real virtualizer measures 0 rows — mock the
// shared wrapper (same seam ScanLogPane/ExpectedPane's tests use) to render
// every row.
vi.mock('@/components/virtual-rows/useVirtualRows', () => ({
  useVirtualRows: (count: number) => ({
    rows: Array.from({ length: count }, (_, index) => ({ index, start: index * 44, size: 44 })),
    totalSize: count * 44,
  }),
}));

import { AlteracoesTable } from './AlteracoesTable';

function row(over: Partial<PrecoAlteracao> = {}): PrecoAlteracao {
  return {
    produtoId: 'p-1',
    sku: 'SKU-1',
    nome: 'Produto 1',
    custo: 10,
    precoAtual: 20,
    precoNovo: 25,
    erro: null,
    precos: {},
    ...over,
  };
}

function renderTable(rows: PrecoAlteracao[]) {
  return render(
    <MantineProvider>
      <AlteracoesTable rows={rows} />
    </MantineProvider>,
  );
}

describe('AlteracoesTable', () => {
  it('shows an empty message when there are no rows', () => {
    const { container } = renderTable([]);
    expect(container.textContent).toContain('Nenhum produto calculado');
  });

  it('renders sku, nome and formatted money columns', () => {
    const { container } = renderTable([row()]);
    const text = container.textContent ?? '';
    expect(text).toContain('SKU-1');
    expect(text).toContain('Produto 1');
    expect(text).toContain('R$');
  });

  it('renders the error message for a failed row and skips the diff', () => {
    const { container } = renderTable([
      row({
        produtoId: 'p-err',
        custo: null,
        precoNovo: null,
        erro: 'Produto sem custo SKU-1 - Produto 1',
      }),
    ]);
    expect(container.textContent).toContain('Produto sem custo SKU-1 - Produto 1');
  });

  it('falls back to a dash for a null sku', () => {
    const { container } = renderTable([row({ sku: null })]);
    expect(container.textContent).toContain('—');
  });
});
