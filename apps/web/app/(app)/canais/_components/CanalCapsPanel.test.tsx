import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { CanalCapsPanel } from './CanalCapsPanel';

function renderPanel(tipo = INTEGRACAO_TIPO.shopee) {
  return render(
    <MantineTestProvider>
      <CanalCapsPanel tipo={tipo} titulo="Shopee" descricao="Integração com a Shopee." />
    </MantineTestProvider>,
  );
}

describe('CanalCapsPanel', () => {
  it('renders the channel row instead of a generic "em construção" message', () => {
    renderPanel();
    expect(screen.getByText('Shopee')).toBeTruthy();
    expect(screen.getByText('não implementado')).toBeTruthy();
    // A capability from each group, so a dropped group is visible.
    expect(screen.getByText('Publicar anúncio')).toBeTruthy();
    expect(screen.getByText('Enviar estoque')).toBeTruthy();
    expect(screen.getByText('Importar pedido')).toBeTruthy();
    expect(screen.getByText('Etiqueta')).toBeTruthy();
    expect(screen.getByText('Perguntas')).toBeTruthy();
    expect(screen.getByText('Pausar / reativar anúncio')).toBeTruthy();
  });

  /**
   * ⚠️ The near-miss the whole tri-state exists for. Shopee's row is
   * `'desconhecido'` almost everywhere; rendering that as "não" would put an
   * unverified claim in front of an operator, which is the failure #815 undid.
   */
  it('renders an unresearched capability as "não pesquisado", never as "não"', () => {
    renderPanel();
    expect(screen.getAllByText('não pesquisado').length).toBeGreaterThan(0);
    expect(screen.queryByText('não')).toBeNull();
    expect(screen.getByText(/não quer dizer que o canal não faz/)).toBeTruthy();
  });

  it('renders the two Shopee facts that ARE evidenced as a real "sim"', () => {
    // `assinaWebhook` and `tabelaDeMedidas` are the only cited values on that
    // row — if they rendered yellow like the rest, the badge would be lying in
    // the other direction.
    renderPanel();
    expect(screen.getAllByText('sim')).toHaveLength(2);
  });

  it('shows a real "não" for an implemented channel that genuinely cannot', () => {
    // Mercado Livre: `kitVirtual: 'nao'`. This is the pair that proves the
    // three states are distinguishable on screen, not only in the type.
    render(
      <MantineTestProvider>
        <CanalCapsPanel
          tipo={INTEGRACAO_TIPO.mercadoLivre}
          titulo="Mercado Livre"
          descricao="Integração com o Mercado Livre."
        />
      </MantineTestProvider>,
    );
    expect(screen.getByText('mercado-livre')).toBeTruthy();
    expect(screen.getAllByText('não').length).toBeGreaterThan(0);
    expect(screen.queryByText('não pesquisado')).toBeNull();
    // An implemented channel gets no "ainda não implementado" alert.
    expect(screen.queryByText(/Canal ainda não implementado/)).toBeNull();
  });

  it('says so plainly for a tipo that is not a marketplace', () => {
    render(
      <MantineTestProvider>
        <CanalCapsPanel
          tipo={INTEGRACAO_TIPO.balcao}
          titulo="Balcão"
          descricao="Venda no balcão."
        />
      </MantineTestProvider>,
    );
    expect(screen.getByText('não-marketplace')).toBeTruthy();
    expect(screen.getByText(/Sem tabela de capacidades/)).toBeTruthy();
    expect(screen.queryByText('Publicar anúncio')).toBeNull();
  });
});
