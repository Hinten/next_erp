import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';
import type { ColumnFilterValue } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { IntegracaoRow } from '@/lib/data/useIntegracoes';
import { IntegracoesColumnFilter, MAX_INTEGRACOES_FILTRO } from './IntegracoesColumnFilter';

function row(id: string, over: Partial<Integracao> = {}): IntegracaoRow {
  return {
    id,
    data: {
      nome: id,
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      cor: null,
      ativo: true,
      ...over,
    } as Integracao,
  };
}

const INTEGRACOES: IntegracaoRow[] = [
  row('i1', { nome: 'Loja Principal' }),
  row('i2', { nome: 'Loja Outlet', tipo: INTEGRACAO_TIPO.shopee }),
  row('i3', { nome: 'Loja Antiga', ativo: false }),
];

function renderFilter(value?: ColumnFilterValue) {
  const onChange = vi.fn<(next: ColumnFilterValue | undefined) => void>();
  const { container } = render(
    <MantineTestProvider>
      <IntegracoesColumnFilter integracoes={INTEGRACOES} value={value} onChange={onChange} />
    </MantineTestProvider>,
  );
  return { onChange, container };
}

/** Mantine's MultiSelect search field is a `combobox`, not a `textbox`. */
function openDropdown() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Canais de venda' }));
}

/** Open the combobox and click one option by its visible label. */
function pick(label: string) {
  openDropdown();
  fireEvent.click(screen.getByText(label));
}

describe('IntegracoesColumnFilter', () => {
  it('emits array-contains-any with the picked id', () => {
    const { onChange } = renderFilter();
    pick('Loja Principal (Mercado Livre)');
    expect(onChange).toHaveBeenCalledWith({ op: 'array-contains-any', value: ['i1'] });
  });

  it('accumulates a second pick into the SAME candidate list', () => {
    // The whole point of the multi-select: two channels must OR together, not
    // replace one another (which is what the legacy single dropdown did).
    const { onChange } = renderFilter({ op: 'array-contains-any', value: ['i1'] });
    pick('Loja Outlet (Shopee)');
    expect(onChange).toHaveBeenCalledWith({ op: 'array-contains-any', value: ['i1', 'i2'] });
  });

  it('emits undefined — not an empty list — when the last pick is removed', () => {
    // An empty candidate list is a throw in `buildPipeline`; dropping the
    // filter is what "nothing selected" means.
    const { onChange, container } = renderFilter({ op: 'array-contains-any', value: ['i1'] });
    // Mantine's pill remove button carries no accessible name, so it is reached
    // by class — the same way the pills themselves are identified.
    const remove = container.querySelector('.mantine-Pill-remove');
    expect(remove).not.toBeNull();
    fireEvent.click(remove as Element);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('clears the filter from the Limpar button', () => {
    const { onChange } = renderFilter({ op: 'array-contains-any', value: ['i1', 'i2'] });
    fireEvent.click(screen.getByText('Limpar'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('labels each option with its tipo and flags a deactivated conta', () => {
    // A produto can still carry a deactivated conta, so it stays selectable —
    // but the operator has to be able to tell why it is not in the channel list.
    renderFilter();
    openDropdown();
    expect(screen.getByText('Loja Antiga (Mercado Livre) — inativo')).toBeTruthy();
  });

  it('caps the selection at Firestore disjunction limit', () => {
    expect(MAX_INTEGRACOES_FILTRO).toBe(30);
  });
});
