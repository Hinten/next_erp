import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { ScanLogEntry } from '@delfrance/schemas';

// jsdom has no layout, so the real virtualizer measures 0 rows — mock the thin
// wrapper to render every row.
vi.mock('@/components/virtual-rows/useVirtualRows', () => ({
  useVirtualRows: (count: number) => ({
    rows: Array.from({ length: count }, (_, index) => ({ index, start: index * 64, size: 64 })),
    totalSize: count * 64,
  }),
}));

import { ScanLogPane } from './ScanLogPane';

function entry(
  uid: string,
  nome: string,
  timestampMs: number,
  over: Partial<ScanLogEntry> = {},
): ScanLogEntry {
  return {
    uid,
    produtoId: `p-${uid}`,
    produtoNome: nome,
    produtoSku: null,
    quantidade: 1,
    kind: 'unit',
    targetKey: 'exp-0',
    componentProdutoId: null,
    error: null,
    timestampMs,
    excluidoMs: null,
    ...over,
  };
}

function renderPane(log: ScanLogEntry[]) {
  return render(
    <MantineTestProvider>
      <ScanLogPane log={log} onDelete={() => undefined} />
    </MantineTestProvider>,
  );
}

describe('ScanLogPane', () => {
  it('renders the newest scan at the top', () => {
    const { container } = renderPane([
      entry('a', 'primeiro', 1000),
      entry('b', 'segundo', 2000),
      entry('c', 'terceiro', 3000),
    ]);
    const text = container.textContent ?? '';
    // Newest (terceiro) must appear before oldest (primeiro) in the DOM.
    expect(text.indexOf('terceiro')).toBeLessThan(text.indexOf('primeiro'));
    expect(text.indexOf('segundo')).toBeGreaterThan(text.indexOf('terceiro'));
  });

  it('shows an empty message when nothing has been scanned', () => {
    const { container } = renderPane([]);
    expect(container.textContent).toContain('Nenhum produto lançado');
  });

  it('marks a soft-deleted row and hides its delete button', () => {
    const { container } = renderPane([entry('a', 'excluído', 1000, { excluidoMs: 5000 })]);
    // No active delete button for a deleted row.
    expect(container.querySelector('[aria-label="Excluir lançamento"]')).toBeNull();
  });
});
