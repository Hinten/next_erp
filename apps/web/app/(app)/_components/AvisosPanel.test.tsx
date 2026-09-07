import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SEVERIDADE_AVISO, TIPO_AVISO, avisoSchema, type Aviso } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { AvisosPanel } from './AvisosPanel';
import type { AvisoRow } from '@/lib/avisos/useAvisos';

const AGORA_US = 1_760_000_000_000_000;

function aviso(over: Partial<Aviso> = {}): Aviso {
  return avisoSchema.parse({
    tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
    severidade: SEVERIDADE_AVISO.atencao,
    criadoEm: AGORA_US,
    atualizadoEm: AGORA_US,
    params: { loja: 'Delfrance', dias: 29 },
    ...over,
  });
}

function row(id: string, over: Partial<Aviso> = {}, naoLido = true): AvisoRow {
  return { id, aviso: aviso(over), naoLido };
}

function renderPanel(rows: AvisoRow[], props: Partial<Parameters<typeof AvisosPanel>[0]> = {}) {
  const onMarcarLido = vi.fn();
  const onMarcarTodosLidos = vi.fn();
  render(
    <MantineTestProvider>
      <AvisosPanel
        rows={rows}
        loading={false}
        naoLidos={rows.filter((r) => r.naoLido).length}
        onMarcarLido={onMarcarLido}
        onMarcarTodosLidos={onMarcarTodosLidos}
        {...props}
      />
    </MantineTestProvider>,
  );
  return { onMarcarLido, onMarcarTodosLidos };
}

describe('AvisosPanel', () => {
  it('renders the pt-BR wording from the row params, not a stored sentence', () => {
    renderPanel([row('a1')]);
    expect(screen.getByText(/Autorização Shopee expirando/)).toBeDefined();
    expect(screen.getByText(/Delfrance/)).toBeDefined();
    expect(screen.getByText(/29 dia/)).toBeDefined();
  });

  it('shows an empty state rather than a bare list', () => {
    renderPanel([]);
    expect(screen.getByText('Nenhum aviso pendente')).toBeDefined();
  });

  it('marks ONE aviso read without touching the others', () => {
    const { onMarcarLido } = renderPanel([row('a1'), row('a2')]);
    const botoes = screen.getAllByText('Marcar como lida');
    expect(botoes).toHaveLength(2);

    fireEvent.click(botoes[0]!);
    expect(onMarcarLido).toHaveBeenCalledExactlyOnceWith('a1');
  });

  it('offers "marcar todas" only while something is unread', () => {
    renderPanel([row('a1', {}, false)], { naoLidos: 0 });
    expect(screen.queryByText('Marcar todas como lidas')).toBeNull();
    expect(screen.getByText('Tudo lido')).toBeDefined();
  });

  it('surfaces the repeat count instead of duplicating the row', () => {
    // Dedup means one row per problem; `ocorrencias` is how the operator learns
    // it happened again.
    renderPanel([row('a1', { ocorrencias: 4 })]);
    expect(screen.getByText('×4')).toBeDefined();
    expect(screen.getAllByTestId('aviso-row')).toHaveLength(1);
  });

  it('renders a runbook for an aviso with no in-app fix', () => {
    renderPanel([row('a1', { tipo: TIPO_AVISO.shopeePushSuspenso, severidade: 'critico' })]);
    expect(screen.getByText(/Reative a assinatura no Console/)).toBeDefined();
  });

  it('links to the stored internal route', () => {
    renderPanel([row('a1', { urlInterna: { rota: '/canais/shopee/abc', campo: null } })]);
    expect(screen.getByText('Abrir').closest('a')?.getAttribute('href')).toBe('/canais/shopee/abc');
  });

  it('renders an allowed external link with noopener', () => {
    renderPanel([row('a1', { urlExterna: 'https://seller.shopee.com.br/x' })]);
    const link = screen.getByText('Abrir no canal').closest('a');
    expect(link?.getAttribute('href')).toBe('https://seller.shopee.com.br/x');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('renders NO external link for a hostile or off-allowlist URL', () => {
    // The row is provider-supplied. A `javascript:` URL must degrade to "no
    // button", never reach an href.
    renderPanel([row('a1', { urlExterna: 'javascript:alert(1)' })]);
    expect(screen.queryByText('Abrir no canal')).toBeNull();

    renderPanel([row('a2', { urlExterna: 'https://evil.com/x' })]);
    expect(screen.queryByText('Abrir no canal')).toBeNull();
  });
});
