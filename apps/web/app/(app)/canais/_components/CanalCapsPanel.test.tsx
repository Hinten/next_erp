import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { INTEGRACAO_TIPO, marketplaceCapsFor } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { CAMPOS_CAPS, CanalCapsPanel } from './CanalCapsPanel';

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
   * ⚠️ The other half of the exhaustiveness guard.  is a total
   * `Record`, so a NEW capability with no label is a compile error — but a
   * field that has a label and sits in no group would compile and still never
   * render. The expected list is derived from the live caps object, so it
   * cannot pass by agreeing with a second copy of itself.
   *
   * This matters more than usual because the panel is sold as the Phase 0
   * checklist: a cap missing from it is a question nobody is asked to answer.
   */
  it('renders every capability the row carries, with none left ungrouped', () => {
    renderPanel();
    const caps = marketplaceCapsFor(INTEGRACAO_TIPO.shopee);
    const esperados = [
      ...Object.keys(caps).filter(
        (k) => k !== 'channel' && k !== 'implementado' && k !== 'estoque',
      ),
      ...Object.keys(caps.estoque).map((k) => `estoque.${k}`),
    ];

    for (const campo of esperados) {
      const descritor = (CAMPOS_CAPS as Record<string, { rotulo: string } | undefined>)[campo];
      expect(descritor, `${campo} has no label in CAMPOS_CAPS`).toBeDefined();
      expect(screen.getByText(descritor!.rotulo), `${campo} never reaches the screen`).toBeTruthy();
    }
    // …and nothing is labelled that the row no longer carries.
    expect(Object.keys(CAMPOS_CAPS).sort()).toEqual(esperados.sort());
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
