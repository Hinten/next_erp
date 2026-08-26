/**
 * `UsuariosTesteDevPanel` — the three states a dev build can land in.
 *
 * The one that matters is the 404: the backend returns it whenever
 * `MERCADO_LIVRE_TEST_USERS_ENABLED` is not `1`, and this panel used to render
 * NOTHING for it. An absent panel with no console error reads as "the feature
 * was never built", not "one env var is unset" — which is exactly how it cost a
 * debugging session. These tests pin that the variable gets NAMED on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  MercadoLivreConta,
  MercadoLivreUsuarioTeste,
  MercadoLivreUsuariosTesteResult,
} from '@/lib/mercado-livre/client';

const h = vi.hoisted(() => ({
  clientRef: {
    current: null as null | {
      usuariosTeste: (id: string) => Promise<{ usuarios: MercadoLivreUsuarioTeste[] }>;
      conta: (id: string) => Promise<MercadoLivreConta>;
      criarUsuariosTeste: (id: string) => Promise<unknown>;
      criarUsuarioTesteAvulso: (
        id: string,
        role: 'vendedor' | 'comprador',
        opts?: { manterCredencial?: boolean },
      ) => Promise<unknown>;
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
    // The leaked-timer protection comes from `vitest.setup.ts`
    // (`DEFAULT_THEME.respectReducedMotion` + the `prefers-reduced-motion`
    // matchMedia shim), not from this provider — this component mounts a
    // <Modal>. See #1150.
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  render(<UsuariosTesteDevPanel integracaoId="i1" />, { wrapper });
}

const CONTA_CONECTADA: MercadoLivreConta = {
  connected: true,
  me: { id: 999, nickname: 'LOJA-REAL', email: null },
};

/** The mint's reply. `usuarios` is the whole run — one record for a single mint. */
function resultado(over: Partial<MercadoLivreUsuariosTesteResult> = {}) {
  return {
    usuarios: [usuario('comprador')],
    criados: ['comprador' as const],
    reaproveitados: [],
    credenciaisRemovidas: 2,
    credencialRevogada: true,
    conta: { id: 999, nickname: 'LOJA-REAL' },
    ...over,
  };
}

function setUsuarios(
  usuarios: MercadoLivreUsuarioTeste[],
  over: { conta?: MercadoLivreConta; avulso?: () => Promise<unknown> } = {},
): void {
  h.clientRef.current = {
    usuariosTeste: vi.fn(async () => ({ usuarios })),
    conta: vi.fn(async () => over.conta ?? CONTA_CONECTADA),
    criarUsuariosTeste: vi.fn(async () => resultado()),
    criarUsuarioTesteAvulso: vi.fn(over.avulso ?? (async () => resultado())),
  };
}

function setError(err: unknown): void {
  h.clientRef.current = {
    usuariosTeste: vi.fn(() => Promise.reject(err)),
    conta: vi.fn(async () => CONTA_CONECTADA),
    criarUsuariosTeste: vi.fn(async () => resultado()),
    criarUsuarioTesteAvulso: vi.fn(async () => resultado()),
  };
}

function usuario(
  role: 'vendedor' | 'comprador',
  over: Partial<MercadoLivreUsuarioTeste> = {},
): MercadoLivreUsuarioTeste {
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
    ...over,
  };
}

/**
 * Open the additional-mint dialog.
 *
 * ⚠️ Waits for the button to be ENABLED, not merely present. It renders on the
 * first pass, while the conta query is still in flight and `connected` is
 * undefined — a click there is swallowed and the modal never opens, which shows
 * up as an empty Modal root rather than as a failed click. Same trap the
 * `disables the mint button` test below documents for the list query.
 */
async function abrirNovoComprador(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('ml-novo-comprador').hasAttribute('disabled')).toBe(false);
  });
  fireEvent.click(screen.getByTestId('ml-novo-comprador'));
}

/**
 * Give jsdom a working clipboard for one test.
 *
 * ⚠️ jsdom ships NO `navigator.clipboard`, so without this Mantine's
 * `useClipboard` takes its error branch — which is a real case worth testing,
 * just not the happy path.
 */
function comClipboard(writeText: (text: string) => Promise<void>): void {
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    clipboard: { writeText: vi.fn(writeText) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Mint one buyer and wait for the reveal modal it opens. */
async function abrirRevelado(): Promise<void> {
  await screen.findByTestId('ml-usuarios-teste-panel');
  await abrirNovoComprador();
  fireEvent.click(await screen.findByTestId('ml-novo-comprador-entendido'));
  fireEvent.click(screen.getByTestId('ml-novo-comprador-confirmar'));
  await screen.findByTestId('ml-usuario-teste-revelado');
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
    setUsuarios([usuario('vendedor'), usuario('comprador', { id: 2 })]);
    renderPanel();

    await screen.findByText('TEST-comprador');
    expect(screen.getByTestId('ml-criar-usuarios-teste').hasAttribute('disabled')).toBe(true);
  });

  it('⚠️ reads a SET of roles, not a count — two buyers do not stand in for a seller', async () => {
    // `usuarios.length >= 2` disabled the pair bootstrap here, on an account
    // whose seller half does not exist at all. The additional mint makes that
    // arrangement reachable, so the condition has to name what it means.
    setUsuarios([usuario('comprador', { id: 1 }), usuario('comprador', { id: 2 })]);
    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText('TEST-comprador')).toHaveLength(2);
    });
    expect(screen.getByTestId('ml-criar-usuarios-teste').hasAttribute('disabled')).toBe(false);
  });

  it('renders several buyers without a duplicate React key', async () => {
    // The rows used to be keyed on the ROLE, which stopped being unique the
    // moment a second comprador could exist. React only warns, so nothing fails
    // — it just quietly reuses the wrong row's state.
    const avisos: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      avisos.push(args);
    });
    setUsuarios([
      usuario('comprador', { id: 1, nickname: 'TEST-antigo' }),
      usuario('comprador', { id: 2, nickname: 'TEST-novo' }),
    ]);
    renderPanel();

    await screen.findByText('TEST-novo');
    spy.mockRestore();
    expect(JSON.stringify(avisos)).not.toContain('same key');
  });

  it('shows how many of the ten permanent slots are already gone', async () => {
    // ⭐ ML lists nothing and frees a slot only after 60 days idle, so this is
    // the only number the operator will ever see — and it has to say it is a
    // floor rather than the true total.
    setUsuarios([usuario('vendedor'), usuario('comprador', { id: 2 })]);
    renderPanel();

    await screen.findByText('TEST-comprador');
    const vagas = screen.getAllByTestId('ml-usuarios-teste-vagas')[0];
    expect(vagas?.textContent).toContain('de 10');
    expect(vagas?.textContent).toContain('piso');
  });
});

describe('UsuariosTesteDevPanel — the additional buyer mint', () => {
  it('names the connected account and the slot count before anything is spent', async () => {
    // The docblock has always promised "a confirmation naming the account"; the
    // dialog said only "desta conta", which is the one fact that could have
    // prevented a mint against the wrong one.
    setUsuarios([usuario('comprador')]);
    renderPanel();

    await screen.findByText('TEST-comprador');
    await abrirNovoComprador();

    const dialog = await screen.findByTestId('ml-novo-comprador-confirm');
    expect(dialog.textContent).toContain('LOJA-REAL');
    expect(dialog.textContent).toContain('de 10');
  });

  it('keeps the confirm button disabled until the checkbox is ticked', async () => {
    setUsuarios([]);
    renderPanel();

    await screen.findByTestId('ml-usuarios-teste-panel');
    await abrirNovoComprador();

    const confirmar = await screen.findByTestId('ml-novo-comprador-confirmar');
    expect(confirmar.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('ml-novo-comprador-entendido'));
    expect(confirmar.hasAttribute('disabled')).toBe(false);
  });

  it('⚠️ revokes by default — keeping the conta connected needs a deliberate tick', async () => {
    // Polarity is the assertion. An unticked box must produce the SAFE call, so
    // that not reading the dialog cannot leave a real seller account wired up.
    setUsuarios([]);
    renderPanel();

    await screen.findByTestId('ml-usuarios-teste-panel');
    await abrirNovoComprador();
    fireEvent.click(await screen.findByTestId('ml-novo-comprador-entendido'));
    fireEvent.click(screen.getByTestId('ml-novo-comprador-confirmar'));

    // `mutate()` dispatches the mutationFn in a microtask, so a bare assertion
    // here reads the mock before React Query has called it.
    await waitFor(() => {
      expect(h.clientRef.current?.criarUsuarioTesteAvulso).toHaveBeenCalledWith('i1', 'comprador', {
        manterCredencial: false,
      });
    });
  });

  it('passes manterCredencial once the operator opts out', async () => {
    setUsuarios([]);
    renderPanel();

    await screen.findByTestId('ml-usuarios-teste-panel');
    await abrirNovoComprador();
    fireEvent.click(await screen.findByTestId('ml-novo-comprador-entendido'));
    fireEvent.click(screen.getByTestId('ml-novo-comprador-manter'));
    fireEvent.click(screen.getByTestId('ml-novo-comprador-confirmar'));

    await waitFor(() => {
      expect(h.clientRef.current?.criarUsuarioTesteAvulso).toHaveBeenCalledWith('i1', 'comprador', {
        manterCredencial: true,
      });
    });
  });

  it('⭐ will not let the reveal modal be dismissed before the password is copied', async () => {
    // ML never reissues a password. The record is also persisted below, so this
    // gate is about attention rather than being the last copy — but a dialog
    // that closes on a stray click is no gate at all.
    const escrito: string[] = [];
    comClipboard(async (t) => {
      escrito.push(t);
    });
    setUsuarios([]);
    renderPanel();

    await abrirRevelado();

    expect(screen.getByTestId('ml-usuario-teste-revelado').textContent).toContain('qatest328');
    expect(screen.getByTestId('ml-usuario-teste-revelado-fechar').hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.click(screen.getByTestId('ml-usuario-teste-revelado-copiar'));
    await waitFor(() => {
      expect(screen.getByTestId('ml-usuario-teste-revelado-fechar').hasAttribute('disabled')).toBe(
        false,
      );
    });
    // What went to the clipboard is the whole block, not just the password —
    // the verification codes are useless separated from the account.
    expect(escrito[0]).toContain('qatest328');
    expect(escrito[0]).toContain('506781');
  });

  it('⭐ offers a manual way out when the clipboard is refused, and only then', async () => {
    // ⚠️ Trapping an operator whose browser denies clipboard access would trade
    // a small risk for a certain one — jsdom has no `navigator.clipboard` at
    // all, which is exactly that case. The escape hatch appears ONLY on failure.
    setUsuarios([]);
    renderPanel();

    await abrirRevelado();

    expect(screen.queryByTestId('ml-usuario-teste-revelado-fallback')).toBeNull();
    fireEvent.click(screen.getByTestId('ml-usuario-teste-revelado-copiar'));

    const fallback = await screen.findByTestId('ml-usuario-teste-revelado-fallback');
    expect((fallback as HTMLTextAreaElement).value).toContain('qatest328');
    expect(screen.getByTestId('ml-usuario-teste-revelado-fechar').hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.click(screen.getByTestId('ml-usuario-teste-revelado-anotado'));
    expect(screen.getByTestId('ml-usuario-teste-revelado-fechar').hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('disables the action and explains it when the conta is disconnected', async () => {
    // ⚠️ The precondition, not a fault: a previous mint deleted the credential,
    // and the backend resolves a token BEFORE any guard, so an unconnected conta
    // can only answer 409 — even for a call that would have minted nothing.
    setUsuarios([usuario('comprador')], { conta: { connected: false, me: null } });
    renderPanel();

    await screen.findByText('TEST-comprador');
    expect(screen.getByTestId('ml-novo-comprador').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('ml-usuarios-teste-desconectada').textContent).toContain(
      'Conecte novamente a conta real',
    );
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
