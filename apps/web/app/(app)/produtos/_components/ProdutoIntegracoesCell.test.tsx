import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';
import type { Produto } from '@delfrance/schemas';
import type { IntegracoesStatus } from '@/lib/data/useIntegracoes';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { ProdutoIntegracoesCell } from './ProdutoListCells';

/**
 * Only the fields the cell reads. The full schemas are large and the cell
 * takes already-parsed documents, so a narrow cast keeps the fixture honest
 * about what the column actually depends on.
 */
function integracao(over: Partial<Integracao>): Integracao {
  return {
    nome: 'Canal',
    tipo: INTEGRACAO_TIPO.mercadoLivre,
    cor: null,
    ativo: true,
    ...over,
  } as Integracao;
}

function produto(ids: string[]): Produto {
  return { integracoesComProduto: ids } as Produto;
}

function renderCell(
  ids: string[],
  entries: Array<[string, Integracao]>,
  status: IntegracoesStatus = 'success',
) {
  return render(
    <MantineTestProvider>
      <ProdutoIntegracoesCell produto={produto(ids)} byId={new Map(entries)} status={status} />
    </MantineTestProvider>,
  );
}

/**
 * The Badge ROOT, which is where the colour lands — `getByText` returns the
 * inner `Badge-label` span, whose own `style` is always empty. Asserting on
 * that span would have passed for an uncoloured badge too.
 */
function badgeRoot(nome: string): HTMLElement {
  const root = screen.getByText(nome).parentElement;
  // Fails loudly if Mantine ever stops wrapping the label in the styled root,
  // rather than silently asserting against the wrong node again.
  expect(root?.getAttribute('data-variant')).toBeTruthy();
  return root as HTMLElement;
}

describe('ProdutoIntegracoesCell', () => {
  it('renders the integração NAME, not the id and not a count', () => {
    // The bug this column fixes: the generic array renderer printed
    // `N item(s)` because `integracoesComProduto` holds bare document ids.
    renderCell(['i1'], [['i1', integracao({ nome: 'Loja Principal' })]]);
    expect(screen.getByText('Loja Principal')).toBeTruthy();
    expect(screen.queryByText(/item\(s\)/)).toBeNull();
    expect(screen.queryByText('i1')).toBeNull();
  });

  it('orders the badges by nome, not by the stored id order', () => {
    renderCell(
      ['zzz', 'aaa'],
      [
        ['zzz', integracao({ nome: 'Alpha' })],
        ['aaa', integracao({ nome: 'Zulu' })],
      ],
    );
    const rendered = screen.getAllByText(/Alpha|Zulu/).map((el) => el.textContent);
    expect(rendered).toEqual(['Alpha', 'Zulu']);
  });

  it('paints the badge with the registered cor', () => {
    renderCell(['i1'], [['i1', integracao({ nome: 'Azul', cor: 0x2196f3 })]]);
    const { style } = badgeRoot('Azul');
    expect(style.backgroundColor).toBe('rgb(33, 150, 243)');
    // Dark background → near-white text, the legacy contrast rule.
    expect(style.color).toBe('rgb(245, 245, 245)');
  });

  it('decodes a legacy 32-bit ARGB cor to the same colour as the 24-bit form', () => {
    renderCell(['i1'], [['i1', integracao({ nome: 'Legado', cor: 0xff2196f3 })]]);
    expect(badgeRoot('Legado').style.backgroundColor).toBe('rgb(33, 150, 243)');
  });

  it('falls back to a neutral badge when no cor is registered', () => {
    // Every Mercado Livre conta is in this state today.
    renderCell(['i1'], [['i1', integracao({ nome: 'Sem cor', cor: null })]]);
    const root = badgeRoot('Sem cor');
    expect(root.style.backgroundColor).toBe('');
    expect(root.getAttribute('data-variant')).toBe('light');
  });

  it('shows an unresolvable id instead of dropping it', () => {
    // The denorm drifts and can name a deleted conta. An empty cell would read
    // as "listed nowhere", which is the opposite of what the row says.
    renderCell(['fantasma'], []);
    expect(screen.getByText('desconhecida')).toBeTruthy();
  });

  it('keeps resolved badges when only SOME ids resolve', () => {
    renderCell(['i1', 'fantasma'], [['i1', integracao({ nome: 'Loja Principal' })]]);
    expect(screen.getByText('Loja Principal')).toBeTruthy();
    expect(screen.getByText('desconhecida')).toBeTruthy();
  });

  // ⚠️ `byId` is empty while the shared read is in flight and empty when it
  // fails, so without these two branches EVERY badge on EVERY row would read
  // `desconhecida` — reporting a loading spinner or a missing permission as a
  // drifted denorm, the one thing that badge is supposed to mean.
  it('shows a skeleton, not "desconhecida", while the lookup is loading', () => {
    const { container } = renderCell(['i1'], [], 'pending');
    expect(screen.queryByText('desconhecida')).toBeNull();
    expect(container.querySelectorAll('.mantine-Skeleton-root')).toHaveLength(1);
  });

  it('says "indisponível", not "desconhecida", when the lookup failed', () => {
    // e.g. a user whose claims lack PERM.integracao.read → permission-denied.
    renderCell(['i1', 'i2'], [], 'error');
    expect(screen.queryByText('desconhecida')).toBeNull();
    expect(screen.getByText('indisponível')).toBeTruthy();
  });

  it('still renders nothing on no channel even when the lookup failed', () => {
    // Nothing to report: the produto is genuinely listed nowhere.
    const { container } = renderCell([], [], 'error');
    expect(container.querySelectorAll('[data-variant]')).toHaveLength(0);
  });

  it('renders nothing for a produto on no channel', () => {
    // `container.textContent` is not empty — Mantine injects its responsive
    // stylesheet into the render container — so assert on the badges instead.
    const { container } = renderCell([], []);
    expect(container.querySelectorAll('[data-variant]')).toHaveLength(0);
  });
});
