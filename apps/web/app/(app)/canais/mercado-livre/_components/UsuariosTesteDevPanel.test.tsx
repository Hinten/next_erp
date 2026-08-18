/**
 * `UsuariosTesteDevPanel` — the three states a dev build can land in.
 *
 * The one that matters is the 404: the backend returns it whenever
 * `MERCADO_LIVRE_TEST_USERS_ENABLED` is not `1`, and this panel used to render
 * NOTHING for it. An absent panel with no console error reads as "the feature
 * was never built", not "one env var is unset" — which is exactly how it cost a
 * debugging session. These tests pin that the variable gets NAMED on screen.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MercadoLivreUsuarioTeste } from '@/lib/mercado-livre/client';

const h = vi.hoisted(() => ({
  clientRef: {
    current: null as null | {
      usuariosTeste: (id: string) => Promise<{ usuarios: MercadoLivreUsuarioTeste[] }>;
      criarUsuariosTeste: (id: string) => Promise<unknown>;
    },
  },
}));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.clientRef.current };
});

// The panel gates its button on this bit; grant it so the enabled path renders.
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth')>();
  return { ...actual, usePermission: () => ({ allowed: true, loading: false }) };
});

const { UsuariosTesteDevPanel } = await import('./UsuariosTesteDevPanel');
const { MercadoLivreClientHttpError } = await import('@/lib/mercado-livre/client');

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    // ⚠️ `env="test"` disables Mantine's Transition timers. Without it a leaked
    // timer fires after teardown and reds an UNRELATED file with
    // `window is not defined` — this component mounts a <Modal>.
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
  render(<UsuariosTesteDevPanel integracaoId="i1" />, { wrapper });
}

function setUsuarios(usuarios: MercadoLivreUsuarioTeste[]): void {
  h.clientRef.current = {
    usuariosTeste: vi.fn(async () => ({ usuarios })),
    criarUsuariosTeste: vi.fn(async () => ({})),
  };
}

function setError(err: unknown): void {
  h.clientRef.current = {
    usuariosTeste: vi.fn(() => Promise.reject(err)),
    criarUsuariosTeste: vi.fn(async () => ({})),
  };
}

function usuario(role: 'vendedor' | 'comprador'): MercadoLivreUsuarioTeste {
  return {
    role,
    id: 120506781,
    nickname: `TEST-${role}`,
    password: 'qatest328',
    site_id: 'MLB',
    site_status: 'active',
    email: null,
    createdAt: 1_700_000_000_000,
    createdByUserId: 999,
    codigosVerificacaoEmail: { quatro: '6781', seis: '506781' },
  };
}

describe('UsuariosTesteDevPanel — flag OFF (backend 404)', () => {
  it('NAMES the env var instead of rendering nothing', async () => {
    setError(new MercadoLivreClientHttpError('Not found', 404, null));
    renderPanel();

    expect(await screen.findByTestId('ml-usuarios-teste-flag-off')).toBeTruthy();
    // The literal variable name is the payload of this whole card — a generic
    // "feature disabled" would leave you exactly as stuck as silence did.
    expect(screen.getByText('MERCADO_LIVRE_TEST_USERS_ENABLED=1')).toBeTruthy();
  });

  it('tells you to RESTART, not just to set the variable', async () => {
    // Next reads .env.local at boot only, so "set it" alone sends you back to a
    // still-404ing page and looks like the fix did not work.
    setError(new MercadoLivreClientHttpError('Not found', 404, null));
    renderPanel();

    const card = await screen.findByTestId('ml-usuarios-teste-flag-off');
    expect(card.textContent).toContain('reinicie');
  });

  it('also points at the wrong-backend cause', async () => {
    // A 404 equally means NEXT_PUBLIC_MERCADO_LIVRE_URL is aimed at the deployed
    // backend, which has no flag. Asserting only the env var would send the
    // reader down one branch of two.
    setError(new MercadoLivreClientHttpError('Not found', 404, null));
    renderPanel();

    const card = await screen.findByTestId('ml-usuarios-teste-flag-off');
    expect(card.textContent).toContain('NEXT_PUBLIC_MERCADO_LIVRE_URL');
  });

  it('does NOT offer the mint button while the route is off', async () => {
    setError(new MercadoLivreClientHttpError('Not found', 404, null));
    renderPanel();

    await screen.findByTestId('ml-usuarios-teste-flag-off');
    expect(screen.queryByTestId('ml-criar-usuarios-teste')).toBeNull();
  });
});

describe('UsuariosTesteDevPanel — flag ON', () => {
  it('renders the empty state with the mint button', async () => {
    setUsuarios([]);
    renderPanel();

    expect(await screen.findByTestId('ml-usuarios-teste-panel')).toBeTruthy();
    expect(screen.getByTestId('ml-criar-usuarios-teste')).toBeTruthy();
    expect(screen.queryByTestId('ml-usuarios-teste-flag-off')).toBeNull();
  });

  it('lists a stored user with its password and verification codes', async () => {
    // The password is the reason the store exists — ML never reissues it — and
    // the codes are the only way past the verification prompt (no inbox).
    setUsuarios([usuario('vendedor')]);
    renderPanel();

    expect(await screen.findByText('TEST-vendedor')).toBeTruthy();
    expect(screen.getByText('qatest328')).toBeTruthy();
    const panel = screen.getByTestId('ml-usuarios-teste-panel');
    expect(panel.textContent).toContain('6781');
    expect(panel.textContent).toContain('506781');
  });

  it('disables the mint button once both roles exist', async () => {
    // ⚠️ Wait for the ROWS, not the button. The button renders on the first
    // pass, while `usuarios` is still `[]` — `findByTestId` resolves against
    // that loading frame and the assertion reads `disabled=false` before the
    // query has answered. Anchoring on data that only exists post-fetch is what
    // makes this deterministic.
    setUsuarios([usuario('vendedor'), usuario('comprador')]);
    renderPanel();

    await screen.findByText('TEST-comprador');
    expect(screen.getByTestId('ml-criar-usuarios-teste').hasAttribute('disabled')).toBe(true);
  });
});

describe('UsuariosTesteDevPanel — a non-404 failure', () => {
  it('still renders the panel rather than swallowing the error as "off"', async () => {
    // Only 404 means "disabled". A 500 must not be reported as a missing flag,
    // or a broken backend reads as a config problem and gets debugged wrong.
    setError(new MercadoLivreClientHttpError('Boom', 500, null));
    renderPanel();

    expect(await screen.findByTestId('ml-usuarios-teste-panel')).toBeTruthy();
    expect(screen.queryByTestId('ml-usuarios-teste-flag-off')).toBeNull();
  });
});
