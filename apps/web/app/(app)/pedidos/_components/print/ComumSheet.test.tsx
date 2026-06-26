import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { KIT_MODEL, OVERDUE_DISPATCH_MODEL } from '@/lib/pedido-print/fixtures';

import { ComumSheet } from './ComumSheet';

// jsbarcode manipulates an <svg> via DOM APIs jsdom doesn't fully implement;
// the barcode is a visual-only side effect, so stub it to a no-op.
vi.mock('jsbarcode', () => ({ default: vi.fn() }));

describe('ComumSheet', () => {
  it('renders the warehouse sheet with vendedor, masked cliente CPF and stock columns', () => {
    const { container } = render(<ComumSheet model={KIT_MODEL} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Pedido 100247');
    expect(text).toContain('Vendedor(a): João Vendedor');
    expect(text).toContain('***********-00'); // CPF masked (last 3 chars only)
    expect(text).not.toContain('123.456.789-00'); // never the raw doc
    expect(text).toContain('Estoque'); // table header
    expect(text).toContain('Localização'); // table header
    expect(text).toMatch(/\bitens?\b/); // footer item count
  });

  it('expands a kit into its component sub-rows', () => {
    const { container } = render(<ComumSheet model={KIT_MODEL} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Kit Verão Completo'); // kit parent
    expect(text).toContain('Componente 1'); // expanded component
    expect(text).toContain('Componente 3');
  });

  it('stamps the overdue dispatch marker', () => {
    const { container } = render(<ComumSheet model={OVERDUE_DISPATCH_MODEL} />);
    expect(container.textContent ?? '').toContain('! Prazo de despacho');
  });
});
