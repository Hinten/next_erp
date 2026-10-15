/**
 * `ContaShopeePanel` — the Shopee configuration of the shared `ConnectionPanel`.
 *
 * Rendered through the REAL panel rather than a stub: the thing worth pinning is
 * that this channel's renderers reach the screen in the states the backend can
 * actually answer with, and a stubbed panel would assert only that props were
 * passed. Only `useShopeeClient` is mocked, so the error classes the describers
 * narrow on are the real ones — narrowing against a fake class is how a
 * most-derived-first ordering test passes while the shipped ordering is wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MantineTestProvider } from '@/lib/testing/mantine';
import type { ShopeeContaStatus } from '@/lib/shopee/wire';

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  notify: vi.fn(),
  conta: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => h.params }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth')>();
  return { ...actual, usePermission: () => ({ allowed: true, loading: false }) };
});
vi.mock('@/lib/shopee/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/client')>();
  return {
    ...actual,
    useShopeeClient: () => ({
      conta: h.conta,
      oauthStart: async () => ({ authorizeUrl: 'https://partner.test/consent' }),
    }),
  };
});

const { ContaShopeePanel, descreverFalhaConexaoShopee, descreverFalhaContaShopee } =
  await import('./ContaShopeePanel');
const { ShopeeClientHttpError, ShopeeClientNetworkError, ShopeeClientRespostaInvalidaError } =
  await import('@/lib/shopee/client');

const CONTA_BASE: ShopeeContaStatus = {
  connected: true,
  shopId: 220_099,
  mainAccountId: null,
  authTime: Date.UTC(2026, 0, 10, 12),
  expireTime: Date.UTC(2026, 11, 10, 12),
  diasParaExpirar: 120,
  loja: { shopName: 'Delfrance BR', region: 'BR', status: 'NORMAL' },
  credencial: { expiraEm: Date.UTC(2026, 0, 10, 16), expirada: false, renovacaoFalhou: false },
};

function renderPanel(conta: ShopeeContaStatus): void {
  h.conta.mockResolvedValue(conta);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  render(<ContaShopeePanel integracaoId="i1" />, { wrapper });
}

beforeEach(() => {
  h.params = new URLSearchParams();
  h.notify.mockClear();
  h.conta.mockReset();
});

describe('ContaShopeePanel — connected', () => {
  it('names the shop, its id and its region', async () => {
    renderPanel(CONTA_BASE);

    expect(await screen.findByText('Conectada')).toBeTruthy();
    expect(screen.getByText('Delfrance BR · #220099 · BR')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reautenticar' })).toBeTruthy();
  });

  it('falls back to the id when the shop NAME is missing, and calls the expiry harmless', async () => {
    // `loja` is a side read that needs a live ~4 h access token; a read that
    // lands while the renewal has not happened yet still knows WHICH shop this
    // is, and the credential line is what stops the missing name reading as a
    // broken conta. The renewal is automatic, so this copy asks for nothing.
    renderPanel({
      ...CONTA_BASE,
      loja: null,
      credencial: { expiraEm: Date.UTC(2026, 0, 10, 16), expirada: true, renovacaoFalhou: false },
    });

    // The id is the whole identity here, shown ONCE — `Loja 220099 · #220099`
    // is the near-miss this pins against.
    expect(await screen.findByText('Loja #220099')).toBeTruthy();
    expect(screen.queryByText(/220099 · #220099/)).toBeNull();
    expect(screen.getByText(/Token de acesso expirado no momento da leitura/)).toBeTruthy();
    expect(screen.getByText(/não é preciso fazer nada/)).toBeTruthy();
    // And it is NOT the alarming one: an expiry alone must never send the
    // operator to Reautenticar.
    expect(screen.queryByText(/a Shopee recusou a renovação/)).toBeNull();
  });

  it('⭐ paints a REFUSED renewal red and points at Reautenticar — never the reassuring line', async () => {
    // The only credential state an operator can act on. Ordering is the whole
    // assertion: a conta whose renewal was refused is expired too, so a panel
    // that checked `expirada` first would tell this operator that nothing needs
    // doing while the integration is dead.
    renderPanel({
      ...CONTA_BASE,
      loja: null,
      credencial: { expiraEm: Date.UTC(2026, 0, 10, 16), expirada: true, renovacaoFalhou: true },
    });

    const linha = await screen.findByText(/a Shopee recusou a renovação/);
    // Red, not dimmed: this is the one line on the card that asks for a click,
    // and `c="dimmed"` would file it beside the four informational ones.
    expect(linha.getAttribute('style')).toContain('red');
    expect(screen.getByText(/clique em Reautenticar/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reautenticar' })).toBeTruthy();
    expect(screen.queryByText(/não é preciso fazer nada/)).toBeNull();
  });

  it('shows the red line even when the stored token has not lapsed yet', async () => {
    // `renovacaoFalhou` does not wait for `expirada`: the refusal is the fact
    // that matters, and the panel must not go quiet for the tail of a token
    // that can no longer be renewed.
    renderPanel({
      ...CONTA_BASE,
      credencial: { expiraEm: Date.UTC(2026, 0, 10, 16), expirada: false, renovacaoFalhou: true },
    });

    expect(await screen.findByText(/a Shopee recusou a renovação/)).toBeTruthy();
  });

  it('⚠️ NEAR MISS — says NOTHING while the token is alive and renewing fine', async () => {
    // The control on both cases above: the healthy state is `expirada: false`
    // AND `renovacaoFalhou: false`, and it must stay silent, or the panel cries
    // wolf on every conta. A component that rendered either line unconditionally
    // would pass every other case in this block.
    renderPanel(CONTA_BASE);

    expect(await screen.findByText('Conectada')).toBeTruthy();
    expect(screen.queryByText(/Token de acesso expirado/)).toBeNull();
    expect(screen.queryByText(/a Shopee recusou a renovação/)).toBeNull();
  });

  it('renders a main-account consent, which carries no shop id at all', async () => {
    renderPanel({ ...CONTA_BASE, shopId: null, mainAccountId: 88_001, loja: null });

    expect(await screen.findByText('Conta principal #88001')).toBeTruthy();
  });

  it('paints the AUTHORIZATION clock — never the token one — beside its dates', async () => {
    renderPanel({ ...CONTA_BASE, diasParaExpirar: 12 });

    const badge = await screen.findByText('expira em 12 dias');
    expect(badge).toBeTruthy();
    // The colour comes from `corExpiracaoAutorizacao` (thresholds pinned in
    // `lib/shopee/expiracao.test.ts`); what this asserts is the WIRING — that
    // the panel feeds the badge from `diasParaExpirar` and not from the
    // credential clock, which in this fixture is still healthy.
    expect(badge.closest('[class*="Badge-root"]')?.getAttribute('style')).toContain('yellow');
    expect(screen.getByText(/Autorização válida até \d{2}\/\d{2}\/\d{4}/)).toBeTruthy();
    expect(screen.getByText(/autorizada em \d{2}\/\d{2}\/\d{4}/)).toBeTruthy();
  });

  it('flags a banned shop', async () => {
    renderPanel({
      ...CONTA_BASE,
      loja: { shopName: 'Delfrance BR', region: 'BR', status: 'BANNED' },
    });

    expect(await screen.findByText('Loja banida')).toBeTruthy();
  });

  it('flags a frozen shop', async () => {
    renderPanel({
      ...CONTA_BASE,
      loja: { shopName: 'Delfrance BR', region: 'BR', status: 'FROZEN' },
    });

    expect(await screen.findByText('Loja congelada')).toBeTruthy();
  });

  it('shows NO lifecycle badge for a normal shop or an unknown status', async () => {
    // `status` degrades to `null` on a value the wire schema does not know
    // (`.catch(null)`), and "we do not recognise this" must not paint a warning.
    renderPanel({ ...CONTA_BASE, loja: { shopName: 'Delfrance BR', region: null, status: null } });

    expect(await screen.findByText('Delfrance BR · #220099')).toBeTruthy();
    expect(screen.queryByText('Loja banida')).toBeNull();
    expect(screen.queryByText('Loja congelada')).toBeNull();
  });
});

describe('ContaShopeePanel — disconnected', () => {
  it('explains a REVOKED authorization, naming the shop that stopped working', async () => {
    renderPanel({
      connected: false,
      shopId: 220_099,
      mainAccountId: null,
      authTime: null,
      expireTime: null,
      diasParaExpirar: null,
      loja: null,
      credencial: null,
    });

    expect(await screen.findByText('Não conectada')).toBeTruthy();
    expect(screen.getByText(/não reconhece mais a loja #220099/)).toBeTruthy();
    expect(screen.getByText(/escolha 365 dias/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conectar conta' })).toBeTruthy();
  });

  it('stays silent for a conta nobody ever connected — the near-miss of the hint above', async () => {
    renderPanel({
      connected: false,
      shopId: null,
      mainAccountId: null,
      authTime: null,
      expireTime: null,
      diasParaExpirar: null,
      loja: null,
      credencial: null,
    });

    expect(await screen.findByText('Não conectada')).toBeTruthy();
    expect(screen.queryByText(/não reconhece mais a loja/)).toBeNull();
    expect(screen.queryByText(/conta principal/)).toBeNull();
  });

  it('explains a main-account consent, which stores a credential but binds no shop', async () => {
    // The backend answers `connected: false` here because it has no shop to ask
    // Shopee about; without this line the operator would see the green
    // "conectada" toast beside a gray badge and nothing in between.
    renderPanel({
      connected: false,
      shopId: null,
      mainAccountId: 990_001,
      authTime: null,
      expireTime: null,
      diasParaExpirar: null,
      loja: null,
      credencial: { expiraEm: Date.UTC(2026, 0, 10, 16), expirada: false, renovacaoFalhou: false },
    });

    expect(await screen.findByText('Não conectada')).toBeTruthy();
    expect(screen.getByText(/conta principal #990001/)).toBeTruthy();
    expect(screen.getByText(/nenhuma loja está ligada ainda/)).toBeTruthy();
    // It is NOT the revoked hint — the two disconnected-with-data states differ.
    expect(screen.queryByText(/não reconhece mais a loja/)).toBeNull();
  });
});

describe('descreverFalhaContaShopee', () => {
  it('describes an unreadable 2xx body through the MOST DERIVED class', () => {
    // `ShopeeClientRespostaInvalidaError extends ShopeeClientHttpError` with a
    // 2xx `status`; matched by the base arm first it would inherit that arm's
    // `status >= 500` verdict — i.e. `retryable: false` for the wrong reason
    // today, and silently wrong the day the backend answers 502 with a bad body.
    const err = new ShopeeClientRespostaInvalidaError('Formato inesperado.', 200, [
      'loja.shopName',
    ]);
    expect(descreverFalhaContaShopee(err)).toEqual({
      message: 'Formato inesperado.',
      retryable: false,
    });
  });

  it('turns the backend’s own upstream codes into copy the operator can act on', () => {
    expect(
      descreverFalhaContaShopee(new ShopeeClientHttpError('x', 503, 'SHOPEE_NETWORK_ERROR')),
    ).toEqual({
      message: 'O backend não conseguiu falar com a Shopee. Tente de novo em instantes.',
      retryable: true,
    });
    expect(
      descreverFalhaContaShopee(new ShopeeClientHttpError('x', 502, 'SHOPEE_BAD_RESPONSE')),
    ).toEqual({
      message: 'A Shopee devolveu uma resposta em formato inesperado — avise o suporte.',
      retryable: false,
    });
  });

  it('offers a retry for a 5xx and refuses one for a 4xx or a 501', () => {
    const retryavel = (status: number, code: string | null = null) =>
      descreverFalhaContaShopee(new ShopeeClientHttpError('backend disse', status, code)).retryable;
    expect(retryavel(500)).toBe(true);
    expect(retryavel(502)).toBe(true);
    // Near-misses of that threshold: a verdict about THIS request never changes
    // on a second identical request.
    expect(retryavel(499)).toBe(false);
    expect(retryavel(404)).toBe(false);
    expect(retryavel(501)).toBe(false);
    expect(
      descreverFalhaContaShopee(new ShopeeClientHttpError('backend disse', 404, null)),
    ).toEqual({ message: 'backend disse', retryable: false });
  });

  it('gives a browser-side network failure its own retryable copy', () => {
    expect(descreverFalhaContaShopee(new ShopeeClientNetworkError('offline'))).toEqual({
      message: 'Falha de rede ao consultar a conta.',
      retryable: true,
    });
  });

  it('is TOTAL — anything else still produces copy, because there is nowhere to rethrow', () => {
    expect(descreverFalhaContaShopee(new TypeError('boom'))).toEqual({
      message: 'Não foi possível consultar a conta.',
      retryable: false,
    });
    expect(descreverFalhaContaShopee(null).message).toBe('Não foi possível consultar a conta.');
  });
});

describe('descreverFalhaConexaoShopee', () => {
  it('shows the backend message for an HTTP failure', () => {
    expect(
      descreverFalhaConexaoShopee(
        new ShopeeClientHttpError('Esta conta não é uma integração da Shopee.', 400, null),
      ),
    ).toBe('Esta conta não é uma integração da Shopee.');
  });

  it('gives a network failure its own copy', () => {
    expect(descreverFalhaConexaoShopee(new ShopeeClientNetworkError('x'))).toBe(
      'Falha de rede ao iniciar a conexão.',
    );
  });

  it('returns null for anything that is not a Shopee client error', () => {
    // Rule 6: not ours to describe — `ConnectionPanel` rethrows it.
    expect(descreverFalhaConexaoShopee(new TypeError('boom'))).toBeNull();
    expect(descreverFalhaConexaoShopee('nope')).toBeNull();
    expect(descreverFalhaConexaoShopee(null)).toBeNull();
  });
});
