import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ListaDePrecos, Produto } from '@delfrance/schemas';
import type { ListaDePrecosRow } from '@/lib/data/useListasDePrecos';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { ProdutoPrecoCell } from './ProdutoListCells';

/**
 * The Preço column: the default lista's value inline, and the button onto every
 * other lista the produto is priced in.
 *
 * Fixtures are narrow casts of already-parsed documents, same idiom as
 * `ProdutoIntegracoesCell.test.tsx` — the cell takes what TableView projected,
 * so a fixture carrying only those fields keeps the test honest about what the
 * column actually depends on.
 */
function lista(id: string, nome: string): ListaDePrecosRow {
  return { id, data: { nome, padrao: false } as ListaDePrecos };
}

function produto(precos: Record<string, { valor: number }> | null): Produto {
  return { nome: 'Camiseta', sku: 'CAM-1', precos } as Produto;
}

const LISTAS = [lista('padrao', 'Padrão'), lista('atacado', 'Atacado')];

function renderCell(p: Produto, listas = LISTAS, padraoId: string | null = 'padrao') {
  return render(
    <MantineTestProvider>
      <ProdutoPrecoCell produto={p} listas={listas} listaPadraoId={padraoId} />
    </MantineTestProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProdutoPrecoCell', () => {
  it('shows the default lista value inline, so the common question needs no click', () => {
    renderCell(produto({ padrao: { valor: 129.9 }, atacado: { valor: 99.9 } }));
    expect(screen.getByText('R$ 129,90')).toBeTruthy();
  });

  it('hides the button entirely when the produto carries no price at all', () => {
    // Hidden rather than disabled: on a catalog where most rows are priced, an
    // unpriced row is exactly what is worth spotting from across the table, and
    // a disabled control still reads as "there is something here".
    renderCell(produto(null));
    expect(screen.queryByRole('button', { name: /Ver todos os preços/ })).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('offers the button even when the DEFAULT lista has no entry', () => {
    // The inline value degrades to an em-dash, but "priced in some other lista"
    // is precisely when the operator needs to see the rest.
    renderCell(produto({ atacado: { valor: 99.9 } }));
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ver todos os preços/ })).toBeTruthy();
  });

  it('lists every lista the produto is priced in, and flags the default one', () => {
    renderCell(produto({ padrao: { valor: 129.9 }, atacado: { valor: 99.9 } }));
    fireEvent.click(screen.getByRole('button', { name: /Ver todos os preços/ }));
    expect(screen.getByText('Padrão')).toBeTruthy();
    expect(screen.getByText('Atacado')).toBeTruthy();
    expect(screen.getByText('R$ 99,90')).toBeTruthy();
    expect(screen.getByText('padrão')).toBeTruthy();
  });

  it('omits a lista the produto has no entry for rather than padding it with a dash', () => {
    renderCell(produto({ padrao: { valor: 129.9 } }));
    fireEvent.click(screen.getByRole('button', { name: /Ver todos os preços/ }));
    expect(screen.queryByText('Atacado')).toBeNull();
  });

  it('does not let the click reach the row, which is a link to the produto editor', () => {
    // Without stopPropagation + preventDefault the dialog opens and the router
    // navigates away from it in the same click.
    const onRowClick = vi.fn();
    render(
      <MantineTestProvider>
        <div onClick={onRowClick}>
          <ProdutoPrecoCell
            produto={produto({ padrao: { valor: 129.9 } })}
            listas={LISTAS}
            listaPadraoId="padrao"
          />
        </div>
      </MantineTestProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ver todos os preços/ }));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
