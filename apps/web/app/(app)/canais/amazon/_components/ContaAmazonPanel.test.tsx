/**
 * `ContaAmazonPanel` — the Amazon configuration of the shared `ConnectionPanel`.
 *
 * Rendered through the REAL panel rather than a stub: the thing worth pinning is
 * that this channel's renderers reach the screen in the states the backend can
 * actually answer with. Only `useBackendAmazon` is mocked, so the error classes
 * the describers narrow on are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Profiler, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CODIGO_ERRO_AMAZON, type StatusContaAmazon } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  notify: vi.fn(),
  navegar: vi.fn(),
  conta: vi.fn(),
  oauthStart: vi.fn(),
  indisponivel: null as null | 'inseguro' | 'url-invalida',
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => h.params }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));
vi.mock('@/lib/oauth/navegarPara', () => ({ navegarPara: h.navegar }));
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth')>();
  return { ...actual, usePermission: () => ({ allowed: true, loading: false }) };
});
vi.mock('@/lib/amazon/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/amazon/client')>();
  return {
    ...actual,
    useBackendAmazon: () =>
      h.indisponivel === null
        ? { client: { conta: h.conta, oauthStart: h.oauthStart }, indisponivel: null }
        : { client: null, indisponivel: h.indisponivel },
  };
});

const { ContaAmazonPanel } = await import('./ContaAmazonPanel');
const { AmazonBackendError } = await import('@/lib/amazon/erros');
const { MENSAGENS_RETORNO_OAUTH_AMAZON } = await import('./amazonOAuthErrors');

const CONECTADA: StatusContaAmazon = {
  connected: true,
  credencialInvalida: false,
  autorizadoEm: '2026-03-10',
  reautorizarAte: '2027-03-10',
  diasParaReautorizar: 146,
  reconexaoPendente: null,
  chamadasLigadas: true,
};

const NAO_CONECTADA: StatusContaAmazon = {
  connected: false,
  credencialInvalida: false,
  autorizadoEm: null,
  reautorizarAte: null,
  diasParaReautorizar: null,
  reconexaoPendente: null,
  chamadasLigadas: true,
};

/**
 * The Mantine colour of the Alert whose title is `titulo`, as the CSS variable
 * family its inline style references (`--mantine-color-<cor>-light`, …).
 *
 * Colour is the panel's main severity cue, so it is pinned per Alert: a
 * switch-off note shown as a warning, or a near reauthorization shown as an
 * emergency, must fail here. Matched on the variable family rather than the
 * bare word, so `red` cannot match by accident inside an unrelated token.
 */
function estiloDoAlerta(titulo: string): string {
  return screen.getByText(titulo).closest('[role="alert"]')?.getAttribute('style') ?? '';
}

const COR = (cor: 'red' | 'yellow' | 'blue') => `--mantine-color-${cor}-`;

function novoQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
}

function renderPanel(conta: StatusContaAmazon | null): void {
  if (conta !== null) h.conta.mockResolvedValue(conta);
  const qc = novoQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  render(<ContaAmazonPanel integracaoId="conta-1" />, { wrapper });
}

beforeEach(() => {
  h.params = new URLSearchParams();
  h.notify.mockClear();
  h.navegar.mockClear();
  h.conta.mockReset();
  h.oauthStart.mockReset();
  h.indisponivel = null;
});

describe('ContaAmazonPanel — connected', () => {
  it('shows the authorization and reauthorization dates from the server, split as civil dates', async () => {
    renderPanel(CONECTADA);

    expect(await screen.findByText('Conectada')).toBeTruthy();
    expect(screen.getByText('Autorizada em 10/03/2026 · reautorizar até 10/03/2027')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reautenticar' })).toBeTruthy();
    expect(h.conta).toHaveBeenCalledWith('conta-1');
  });

  it('⚠️ NEAR MISS — a healthy conta shows NONE of the three alerts', async () => {
    renderPanel(CONECTADA);

    await screen.findByText('Conectada');
    expect(screen.queryByText('Reautorização próxima')).toBeNull();
    expect(screen.queryByText('Prazo de reautorização vencido')).toBeNull();
    expect(screen.queryByText('Autorização recusada pela Amazon')).toBeNull();
    expect(screen.queryByText('Integração desligada')).toBeNull();
  });

  it('⭐ warns at exactly the threshold (30 days), naming THIS card’s button', async () => {
    renderPanel({ ...CONECTADA, diasParaReautorizar: 30 });

    expect(await screen.findByText('Reautorização próxima')).toBeTruthy();
    expect(
      screen.getByText(/A autorização da Amazon desta conta vence em 30 dia\(s\) \(10\/03\/2027\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Clique em Reautenticar abaixo/)).toBeTruthy();
    expect(screen.getByText(/Não use o botão de reautorizar do Seller Central/)).toBeTruthy();
    // Yellow — a warning, not the overdue/parked red (the near miss).
    const estilo = estiloDoAlerta('Reautorização próxima');
    expect(estilo).toContain(COR('yellow'));
    expect(estilo).not.toContain(COR('red'));
  });

  it('⚠️ NEAR MISS — is silent at 31 days', async () => {
    renderPanel({ ...CONECTADA, diasParaReautorizar: 31 });

    await screen.findByText('Conectada');
    expect(screen.queryByText('Reautorização próxima')).toBeNull();
  });

  it('says "vence hoje" on the date itself, never "em 0 dia(s)"', async () => {
    renderPanel({ ...CONECTADA, diasParaReautorizar: 0 });

    expect(await screen.findByText(/vence hoje/)).toBeTruthy();
    expect(screen.queryByText(/em 0 dia/)).toBeNull();
  });

  it('turns red once the date has passed, never "em -2 dia(s)"', async () => {
    renderPanel({ ...CONECTADA, diasParaReautorizar: -2, reautorizarAte: '2026-10-13' });

    expect(await screen.findByText('Prazo de reautorização vencido')).toBeTruthy();
    expect(screen.getByText(/já passou \(13\/10\/2026\)/)).toBeTruthy();
    expect(screen.queryByText(/-2 dia/)).toBeNull();
    const estilo = estiloDoAlerta('Prazo de reautorização vencido');
    expect(estilo).toContain(COR('red'));
    expect(estilo).not.toContain(COR('yellow'));
  });

  it('⭐ shows the parked state in red, with the refusal date and HTTP status', async () => {
    renderPanel({ ...CONECTADA, reconexaoPendente: { desde: '2026-10-01', status: 400 } });

    expect(await screen.findByText('Autorização recusada pela Amazon')).toBeTruthy();
    const alerta = screen.getByText(/A Amazon recusou a autorização desta conta em 01\/10\/2026/);
    expect(alerta.textContent).toContain('(HTTP 400)');
    expect(alerta.textContent).toContain('está parada');
    // Red, not the reauthorization's yellow: this is the one state where the
    // conta's integration has already stopped.
    const estilo = estiloDoAlerta('Autorização recusada pela Amazon');
    expect(estilo).toContain(COR('red'));
    expect(estilo).not.toContain(COR('yellow'));
  });

  it('says the switch is off for a connected conta too', async () => {
    renderPanel({ ...CONECTADA, chamadasLigadas: false });

    expect(await screen.findByText('Integração desligada')).toBeTruthy();
    expect(screen.getByText(/desligadas neste backend até a virada/)).toBeTruthy();
    // Info blue: nothing is wrong with THIS conta — never a warning colour.
    const estilo = estiloDoAlerta('Integração desligada');
    expect(estilo).toContain(COR('blue'));
    expect(estilo).not.toContain(COR('yellow'));
    expect(estilo).not.toContain(COR('red'));
  });
});

describe('ContaAmazonPanel — not connected', () => {
  it('offers Conectar conta and says the switch is off — while the button stays enabled', async () => {
    renderPanel({ ...NAO_CONECTADA, chamadasLigadas: false });

    expect(await screen.findByText('Integração desligada')).toBeTruthy();
    expect(screen.getByText('Não conectada')).toBeTruthy();
    const botao = screen.getByRole('button', { name: 'Conectar conta' });
    expect(botao.hasAttribute('disabled')).toBe(false);
  });

  it('notes a credential that no longer parses, and that a new connection replaces it', async () => {
    renderPanel({ ...NAO_CONECTADA, credencialInvalida: true });

    expect(await screen.findByText(/A credencial salva desta conta está ilegível/)).toBeTruthy();
  });

  it('⚠️ NEAR MISS — a plain unconnected conta with the switch on renders no note', async () => {
    renderPanel(NAO_CONECTADA);

    await screen.findByText('Não conectada');
    await waitFor(() => expect(h.conta).toHaveBeenCalled());
    expect(screen.queryByText('Integração desligada')).toBeNull();
    expect(screen.queryByText(/ilegível/)).toBeNull();
  });
});

describe('ContaAmazonPanel — connect', () => {
  it('navigates to the consent URL the backend answered', async () => {
    h.oauthStart.mockResolvedValue({ authorizeUrl: 'https://consentimento.test/x' });
    renderPanel(NAO_CONECTADA);

    fireEvent.click(await screen.findByRole('button', { name: 'Conectar conta' }));

    await waitFor(() => {
      expect(h.navegar).toHaveBeenCalledWith('https://consentimento.test/x');
    });
    expect(h.oauthStart).toHaveBeenCalledWith('conta-1');
  });

  it('⭐ maps the switch-off 503 to copy and stays on the page', async () => {
    h.oauthStart.mockRejectedValue(
      new AmazonBackendError('x', 503, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS),
    );
    renderPanel({ ...NAO_CONECTADA, chamadasLigadas: false });

    fireEvent.click(await screen.findByRole('button', { name: 'Conectar conta' }));

    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith({
        color: 'red',
        message: expect.stringContaining('desligada até a virada') as unknown,
      });
    });
    expect(h.navegar).not.toHaveBeenCalled();
  });

  it('says the backend is not configured, and disables the button, when the build cannot reach it safely', async () => {
    h.indisponivel = 'inseguro';
    renderPanel(null);

    expect(await screen.findByText('Backend da Amazon não configurado')).toBeTruthy();
    expect(screen.getByText(/NEXT_PUBLIC_AMAZON_URL/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conectar conta' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(h.conta).not.toHaveBeenCalled();
  });
});

describe('ContaAmazonPanel — the callback toast', () => {
  it('⭐ fires ONCE across re-renders (the message map is referentially stable)', async () => {
    h.params = new URLSearchParams('amazon=error&reason=vendedor_diferente');
    h.conta.mockResolvedValue(CONECTADA);
    const qc = novoQueryClient();
    // Counted by React's Profiler, which reports each commit of the PANEL's own
    // subtree — never by mutating a variable during render.
    const commits: string[] = [];
    const contarCommit = (_id: string, fase: string) => {
      commits.push(fase);
    };
    function Host({ rodada }: { rodada: number }) {
      return (
        <MantineTestProvider>
          <QueryClientProvider client={qc}>
            <span data-rodada={rodada} />
            <Profiler id="painel-amazon" onRender={contarCommit}>
              <ContaAmazonPanel integracaoId="conta-1" />
            </Profiler>
          </QueryClientProvider>
        </MantineTestProvider>
      );
    }

    const { rerender } = render(<Host rodada={0} />);
    await screen.findByText('Conectada');
    const antes = commits.length;
    rerender(<Host rodada={1} />);
    rerender(<Host rodada={2} />);
    rerender(<Host rodada={3} />);

    // The Profiler proves the panel DID re-render three more times; the effect
    // still ran once.
    expect(commits.length - antes).toBeGreaterThanOrEqual(3);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith({
      color: 'red',
      title: 'Falha ao conectar a conta Amazon',
      message: MENSAGENS_RETORNO_OAUTH_AMAZON.vendedor_diferente,
    });
  });

  it('toasts a successful connection in green', async () => {
    h.params = new URLSearchParams('amazon=connected');
    renderPanel(CONECTADA);

    await screen.findByText('Conectada');
    expect(h.notify).toHaveBeenCalledWith({ color: 'green', message: 'Conta Amazon conectada.' });
  });
});
