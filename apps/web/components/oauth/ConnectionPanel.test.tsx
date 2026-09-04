/**
 * `ConnectionPanel` — the behaviours the three channel wrappers inherit (#563).
 *
 * The cases that earn their keep are the ones a "these files look the same"
 * refactor could quietly change: the NO-permission channel (Melhor Envio has no
 * gate at all, so a denied claim must still leave its button enabled), the
 * rethrow arm of `describeConnectFailure` (rule 6 — a `null` is a coding bug
 * escaping, not a swallowed error), and the retry button appearing only for a
 * failure that says it is retryable.
 *
 * `navegarPara` is mocked rather than `window.location`: jsdom's `Location` is
 * `[LegacyUnforgeable]`, so `assign` cannot be spied — that is the whole reason
 * the module exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ConnectionFailure, ConnectionPanelProps } from './ConnectionPanel';

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  notify: vi.fn(),
  navegar: vi.fn(),
  allowed: true,
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => h.params }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));
vi.mock('@/lib/oauth/navegarPara', () => ({ navegarPara: h.navegar }));
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth')>();
  return { ...actual, usePermission: () => ({ allowed: h.allowed, loading: false }) };
});

const { ConnectionPanel } = await import('./ConnectionPanel');

interface TestConta {
  readonly connected: boolean;
  readonly apelido: string | null;
}

/** ⚠️ Module-level so `mensagens` stays referentially stable — a fresh map per render re-fires the toast. */
const TOAST = {
  chave: 'ml',
  sucesso: 'Conta conectada.',
  tituloErro: 'Falha ao conectar a conta',
  mensagens: { codigo_invalido: 'O código expirou.' },
} as const;

const URL_CONSENTIMENTO = 'https://auth.example.test/consent?state=abc';

function client(
  over: Partial<{
    oauthStart: (contaId: string) => Promise<{ authorizeUrl: string }>;
    conta: (contaId: string) => Promise<TestConta>;
  }> = {},
) {
  return {
    oauthStart: vi.fn(over.oauthStart ?? (async () => ({ authorizeUrl: URL_CONSENTIMENTO }))),
    conta: vi.fn(over.conta ?? (async () => ({ connected: false, apelido: null }))),
  };
}

const FALHA_GENERICA: ConnectionFailure = {
  message: 'Não foi possível consultar a conta.',
  retryable: false,
};

type Props = ConnectionPanelProps<TestConta>;

function renderPanel(over: Partial<Props> = {}) {
  // `retryDelay` as well as `retry`: a panel that passed its own retry
  // predicate would otherwise sit through the real backoff before the error
  // path renders (the trap `MercadoLivreJobsPanel.test.tsx` documents).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  const props: Props = {
    title: 'Conta Teste',
    contaId: 'c1',
    client: client(),
    queryKey: ['teste-conta', 'c1'],
    toast: TOAST,
    describeContaFailure: () => FALHA_GENERICA,
    describeConnectFailure: () => 'Falha ao iniciar a conexão.',
    renderConnected: (conta) => <span>Identidade: {conta.apelido ?? '—'}</span>,
    ...over,
  };
  render(<ConnectionPanel<TestConta> {...props} />, { wrapper });
  return props;
}

beforeEach(() => {
  h.params = new URLSearchParams();
  h.allowed = true;
  h.notify.mockClear();
  h.navegar.mockClear();
});

describe('ConnectionPanel', () => {
  it('shows the disconnected badge and the Conectar button, without the identity slot', async () => {
    const renderConnected = vi.fn(() => <span>nunca</span>);
    renderPanel({ renderConnected });

    expect(await screen.findByText('Não conectada')).toBeTruthy();
    const botao = screen.getByRole('button', { name: 'Conectar conta' });
    expect((botao as HTMLButtonElement).disabled).toBe(false);
    expect(renderConnected).not.toHaveBeenCalled();
  });

  it('shows the connected badge, the identity slot and Reautenticar', async () => {
    renderPanel({
      client: client({ conta: async () => ({ connected: true, apelido: 'LOJA-1' }) }),
    });

    expect(await screen.findByText('Conectada')).toBeTruthy();
    expect(screen.getByText(/LOJA-1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reautenticar' })).toBeTruthy();
  });

  it('renders the disconnected slot for a conta that answered connected: false', async () => {
    renderPanel({
      renderDisconnected: (conta) => <span>Revogada ({String(conta.connected)})</span>,
    });

    expect(await screen.findByText('Revogada (false)')).toBeTruthy();
  });

  it('disables the button and names the missing permission when a gate is given and denied', async () => {
    h.allowed = false;
    renderPanel({
      permission: { bit: 0b1000n, hint: 'Requer permissão de escrita em integrações.' },
    });

    expect(await screen.findByText('Não conectada')).toBeTruthy();
    const botao = screen.getByRole('button', { name: 'Conectar conta' });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Requer permissão de escrita em integrações.')).toBeTruthy();
  });

  it('leaves the button ENABLED and shows no hint when the channel has no gate', async () => {
    // The Melhor Envio pin: that panel gates on nothing today, so a denied
    // claim must not start disabling its button. `usePermission(0n)` alone
    // answers `allowed: false` while claims load, which is why the component
    // overrides on `permission === undefined` instead of on the bit.
    h.allowed = false;
    renderPanel();

    expect(await screen.findByText('Não conectada')).toBeTruthy();
    const botao = screen.getByRole('button', { name: 'Conectar conta' });
    expect((botao as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Requer permissão/)).toBeNull();
  });

  it('starts the consent flow and navigates to the URL the backend minted', async () => {
    const c = client();
    renderPanel({ client: c, contaId: 'conta-42' });

    fireEvent.click(await screen.findByRole('button', { name: 'Conectar conta' }));

    await waitFor(() => {
      expect(h.navegar).toHaveBeenCalledWith(URL_CONSENTIMENTO);
    });
    expect(c.oauthStart).toHaveBeenCalledWith('conta-42');
    // The order matters: navigating before the URL is minted would drop the state.
    expect(h.navegar.mock.invocationCallOrder[0]).toBeGreaterThan(
      c.oauthStart.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('shows the described connect failure as a red notification and clears the loading state', async () => {
    const c = client({
      oauthStart: async () => {
        throw new TypeError('rede caiu');
      },
    });
    renderPanel({ client: c, describeConnectFailure: () => 'Falha de rede ao iniciar a conexão.' });

    fireEvent.click(await screen.findByRole('button', { name: 'Conectar conta' }));

    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith({
        color: 'red',
        message: 'Falha de rede ao iniciar a conexão.',
      });
    });
    expect(h.navegar).not.toHaveBeenCalled();
    const botao = screen.getByRole('button', { name: 'Conectar conta' });
    expect(botao.getAttribute('data-loading')).toBeNull();
  });

  it('rethrows what the describer disowns instead of notifying (rule 6)', async () => {
    // A `null` means "not a failure this channel knows", so the rejection is
    // MEANT to escape — the listener is what asserts it did. Acknowledged the
    // way `PushProgressDialog.test.tsx` does, so the intentional escape does
    // not fail the run.
    const escapou = vi.fn();
    process.on('unhandledRejection', escapou);
    try {
      const c = client({
        oauthStart: async () => {
          throw new TypeError('bug de programação');
        },
      });
      renderPanel({ client: c, describeConnectFailure: () => null });

      fireEvent.click(await screen.findByRole('button', { name: 'Conectar conta' }));

      await waitFor(() => {
        expect(escapou).toHaveBeenCalledWith(expect.any(TypeError), expect.anything());
      });
      expect(h.notify).not.toHaveBeenCalled();
      const botao = screen.getByRole('button', { name: 'Conectar conta' });
      expect(botao.getAttribute('data-loading')).toBeNull();
    } finally {
      process.off('unhandledRejection', escapou);
    }
  });

  it('offers Tentar novamente only when the conta failure says it is retryable', async () => {
    const falhando = () =>
      client({
        conta: async () => {
          throw new TypeError('caiu');
        },
      });
    renderPanel({
      client: falhando(),
      describeContaFailure: () => ({ message: 'Backend fora do ar.', retryable: true }),
    });

    expect(await screen.findByText('Backend fora do ar.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });

  it('shows the conta failure with NO retry button when it is not retryable', async () => {
    renderPanel({
      client: client({
        conta: async () => {
          throw new TypeError('caiu');
        },
      }),
      describeContaFailure: () => ({
        message: 'Não foi possível consultar a conta.',
        retryable: false,
      }),
    });

    expect(await screen.findByText('Não foi possível consultar a conta.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
  });

  it('toasts the OAuth callback outcome carried in the query string', async () => {
    h.params = new URLSearchParams('ml=connected');
    renderPanel();

    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith({ color: 'green', message: 'Conta conectada.' });
    });
  });

  it('disables the button while the client is null (logged out)', async () => {
    renderPanel({ client: null });

    const botao = await screen.findByRole('button', { name: 'Conectar conta' });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
  });
});
