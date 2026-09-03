import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';
import type { IntegracoesStatus } from '@/lib/data/useIntegracoes';
import { MantineTestProvider } from '@/lib/testing/mantine';

import type { PushAlvo } from '../push/types';
import { AvisoCanaisNaoSuportados } from './AvisoCanaisNaoSuportados';
import { suporteEstoqueDoCanal } from '../estoque/registry';

/** Only the fields the warning reads; the full schema is large. */
function integracao(over: Partial<Integracao>): Integracao {
  return { nome: 'Canal', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true, ...over } as Integracao;
}

const alvo = (ids: string[]): PushAlvo => ({
  produtoId: 'p1',
  produtoNome: 'Camiseta',
  integracoesComProduto: ids,
});

function renderAviso(
  alvos: readonly PushAlvo[],
  entries: Array<[string, Integracao]>,
  status: IntegracoesStatus = 'success',
) {
  return render(
    <MantineTestProvider>
      <AvisoCanaisNaoSuportados
        acao="estoque"
        alvos={alvos}
        veredito={suporteEstoqueDoCanal}
        byId={new Map(entries)}
        status={status}
      />
    </MantineTestProvider>,
  );
}

describe('AvisoCanaisNaoSuportados', () => {
  it('names each unsupported conta and the reason', () => {
    renderAviso(
      [alvo(['shopee-1'])],
      [['shopee-1', integracao({ nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee })]],
    );
    // The title the absence assertions below key off — asserted here so they
    // cannot pass vacuously against a phrase this component never renders.
    expect(screen.getByText(/serão pulados/)).toBeTruthy();
    expect(screen.getByText(/Shopee BR/)).toBeTruthy();
    expect(screen.getByText(/ainda não foi verificado/)).toBeTruthy();
  });

  it('says nothing when every conta in the selection is supported', () => {
    renderAviso(
      [alvo(['ml-1'])],
      [['ml-1', integracao({ nome: 'Loja ML', tipo: INTEGRACAO_TIPO.mercadoLivre })]],
    );
    expect(screen.queryByText(/serão pulados/)).toBeNull();
  });

  it('lists one line per conta, not one per tipo', () => {
    // Two Shopee accounts are two things the operator has to act on, and the
    // conta name is the only handle they have on either.
    renderAviso(
      [alvo(['s1', 's2'])],
      [
        ['s1', integracao({ nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee })],
        ['s2', integracao({ nome: 'Shopee SP', tipo: INTEGRACAO_TIPO.shopee })],
      ],
    );
    expect(screen.getByText(/Shopee BR/)).toBeTruthy();
    expect(screen.getByText(/Shopee SP/)).toBeTruthy();
  });

  it('dedupes a conta named by several selected produtos', () => {
    renderAviso(
      [alvo(['s1']), { ...alvo(['s1']), produtoId: 'p2' }],
      [['s1', integracao({ nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee })]],
    );
    expect(screen.getAllByText(/Shopee BR/)).toHaveLength(1);
  });

  /**
   * ⚠️ The near-miss that matters most. `byId` is empty in three very different
   * situations and only `status` tells them apart — a failed read (a user
   * without `PERM.integracao.read` gets `permission-denied`) must NOT be
   * rendered as "this channel is not supported".
   */
  it.each(['pending', 'error'] as const)('renders nothing while status is %s', (status) => {
    renderAviso([alvo(['shopee-1'])], [], status);
    expect(screen.queryByText(/serão pulados/)).toBeNull();
    expect(screen.queryByText(/Shopee/)).toBeNull();
  });

  it('stays silent about a conta id the collection does not hold', () => {
    // That is the run's own "Integração não encontrada" row, and claiming a
    // capability verdict about a document nobody read would be inventing one.
    renderAviso([alvo(['sumiu'])], []);
    expect(screen.queryByText(/serão pulados/)).toBeNull();
  });
});
