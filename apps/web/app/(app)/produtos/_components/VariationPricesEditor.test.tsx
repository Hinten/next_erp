import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListaComId } from './PrecoCustoManager';
import type { VariationRow } from './VariationManager';
import { VariationPricesEditor, VariationPricesField } from './VariationPricesEditor';
import { MantineTestProvider } from '@/lib/testing/mantine';

const listas = [
  { id: 'varejo', data: { nome: 'Varejo', ativo: true } },
  { id: 'legado', data: { nome: 'Preço legado', ativo: false } },
  { id: 'sem-preco', data: { nome: 'Sem preço', ativo: false } },
] as ListaComId[];

const rows: VariationRow[] = [
  {
    key: 'c1',
    id: 'c1',
    nome: 'Camiseta P',
    sku: 'CAM-P',
    variacoesUid: [],
    precos: { varejo: { valor: 20 }, legado: { valor: 18 } },
    pricesDiverge: true,
    deleteMark: false,
  },
  {
    key: 'novo-g',
    id: null,
    nome: 'Camiseta G',
    sku: 'CAM-G',
    variacoesUid: [],
    precos: { varejo: { valor: 20 } },
    pricesDiverge: false,
    deleteMark: false,
  },
  {
    key: 'excluido',
    id: 'excluido',
    nome: 'Camiseta excluída',
    sku: 'CAM-X',
    variacoesUid: [],
    precos: { varejo: { valor: 20 } },
    deleteMark: true,
  },
];

afterEach(cleanup);

describe('VariationPricesEditor', () => {
  it('shows live and new children with active and priced inactive lists', () => {
    const onPriceChange = vi.fn();
    render(
      <MantineTestProvider>
        <VariationPricesEditor rows={rows} listas={listas} onPriceChange={onPriceChange} />
      </MantineTestProvider>,
    );

    expect(screen.getByText('Preços por variação')).toBeTruthy();
    expect(screen.getByText('Camiseta P')).toBeTruthy();
    expect(screen.getByText('Camiseta G')).toBeTruthy();
    expect(screen.queryByText('Camiseta excluída')).toBeNull();
    expect(screen.getByText('preço diferente')).toBeTruthy();
    expect(screen.getByText('nova')).toBeTruthy();
    expect(screen.getByText('inativa')).toBeTruthy();

    expect(screen.getByLabelText('Varejo — CAM-P')).toBeTruthy();
    expect(screen.getByLabelText('Preço legado — CAM-P')).toBeTruthy();
    expect(screen.queryByLabelText('Sem preço — CAM-P')).toBeNull();
    expect(screen.queryByLabelText('Preço legado — CAM-G')).toBeNull();

    fireEvent.change(screen.getByLabelText('Varejo — CAM-P'), {
      target: { value: '35' },
    });
    expect(onPriceChange).toHaveBeenLastCalledWith('c1', 'varejo', 35);
  });

  it('uses the unique SKU in accessible names when sibling names match', () => {
    const sameNameRows = rows.slice(0, 2).map((row) => ({
      ...row,
      nome: 'Camiseta',
    }));

    render(
      <MantineTestProvider>
        <VariationPricesEditor
          rows={sameNameRows}
          listas={listas}
          onPriceChange={() => undefined}
        />
      </MantineTestProvider>,
    );

    expect(screen.getByLabelText('Varejo — CAM-P')).toBeTruthy();
    expect(screen.getByLabelText('Varejo — CAM-G')).toBeTruthy();
  });

  it('keeps the editor beside the toggle and reveals it only after opt-out', () => {
    function Harness() {
      const [value, setValue] = useState(true);
      return (
        <VariationPricesField
          value={value}
          onChange={setValue}
          divergentChildren={0}
          rows={rows}
          listas={listas}
          onPriceChange={() => undefined}
        />
      );
    }

    render(
      <MantineTestProvider>
        <Harness />
      </MantineTestProvider>,
    );

    expect(screen.queryByText('Preços por variação')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Propagar preço para as variações/ }));
    expect(screen.getByText('Preços por variação')).toBeTruthy();
  });

  it('renders directional empty and load-error states', () => {
    const { rerender } = render(
      <MantineTestProvider>
        <VariationPricesEditor rows={[]} listas={[]} onPriceChange={() => undefined} />
      </MantineTestProvider>,
    );
    expect(screen.getByText('Nenhuma variação cadastrada.')).toBeTruthy();

    rerender(
      <MantineTestProvider>
        <VariationPricesEditor
          rows={[rows[0]!]}
          listas={[]}
          listasError="offline"
          onPriceChange={() => undefined}
        />
      </MantineTestProvider>,
    );
    expect(screen.getByText('Falha ao carregar as listas de preços: offline')).toBeTruthy();
    expect(screen.getByText('Nenhuma lista de preços cadastrada.')).toBeTruthy();
  });
});
