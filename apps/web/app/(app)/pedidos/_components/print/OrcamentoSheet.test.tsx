import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { FEW_ITEMS_MODEL, NO_PHOTO_MODEL } from '@/lib/pedido-print/fixtures';

import { OrcamentoSheet } from './OrcamentoSheet';

describe('OrcamentoSheet', () => {
  it('renders header, filial, items and total', () => {
    const { container } = render(<OrcamentoSheet model={FEW_ITEMS_MODEL} />);
    const text = container.textContent ?? '';
    expect(text).toContain('100245'); // numero
    expect(text).toContain('Veste France'); // filial
    expect(text).toContain('Produto de exemplo 1'); // item
    expect(text).toContain('Total'); // total label
    expect(text).toContain('R$'); // money rendered
    expect(text).toMatch(/válido até/i); // validity pitch
    expect(text).toMatch(/Previsão de entrega/i); // delivery estimate in the entrega card
  });

  it('masks the customer CPF (shows only the last 3 chars)', () => {
    const { container } = render(<OrcamentoSheet model={FEW_ITEMS_MODEL} />);
    const text = container.textContent ?? '';
    expect(text).toContain('***********-00'); // obscured
    expect(text).not.toContain('123.456.789-00'); // never the raw doc
  });

  it('shows the Desc. column only when an item has a discount', () => {
    // FEW_ITEMS_MODEL has one discounted item → hasDesconto true.
    const withDesc = render(<OrcamentoSheet model={FEW_ITEMS_MODEL} />);
    expect(withDesc.container.textContent ?? '').toContain('Desc.');

    // NO_PHOTO_MODEL has no discounts → no Desc. column.
    const noDesc = render(<OrcamentoSheet model={NO_PHOTO_MODEL} />);
    expect(noDesc.container.textContent ?? '').not.toContain('Desc.');
  });

  it('renders a "sem foto" placeholder when a product has no photo', () => {
    const { container } = render(<OrcamentoSheet model={NO_PHOTO_MODEL} />);
    expect(container.textContent ?? '').toContain('sem foto');
  });
});
