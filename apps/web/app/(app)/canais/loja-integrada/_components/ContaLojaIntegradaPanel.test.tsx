/**
 * `ContaLojaIntegradaPanel` — the credential panel on `/canais/loja-integrada/[id]`.
 *
 * Only the backend hook is faked (`useBackendLojaIntegrada`), so the error
 * classes the panel narrows on are the REAL ones from `lib/loja-integrada/client`
 * — narrowing against a fake class is how an ordering test passes while the
 * shipped ordering is wrong. The calendar is replaced by a plain input that
 * exposes its bounds, because what matters here is which dates the panel
 * OFFERS, not Mantine's grid.
 *
 * Pinned, each with its near miss:
 *  - the status states, the most urgent winning (park > vencido > expirando > ok);
 *  - every write sends `versaoEsperada` = the version of the status on screen,
 *    and after a success the NEXT write carries the version just written;
 *  - the token field policy per failure code (cleared vs kept), and a kept
 *    token never reaching the serialised DOM (the field is uncontrolled);
 *  - the length bound the route's schema enforces, refused on the field;
 *  - the status re-read only on mount and when the panel asks — never on a
 *    reconnect or a focus — against the APP's query defaults;
 *  - a 409 `LI_CREDENCIAL_ALTERADA` re-reads the status and says so; a refused
 *    token does not;
 *  - fail closed: no backend / no permission / no status ⇒ nothing can be sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import {
  CODIGO_ERRO_LI,
  MAX_TOKEN_LI,
  SITUACAO_VALIDADE_TOKEN_LI,
  type RespostaCredencialLojaIntegrada,
  type StatusContaLojaIntegrada,
} from '@delfrance/schemas';

import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import { MantineTestProvider } from '@/lib/testing/mantine';

const h = vi.hoisted(() => ({
  podeEscrever: true,
  indisponivel: null as null | 'inseguro' | 'url-invalida',
  semCliente: false,
  agora: 0,
  conta: vi.fn(),
  salvarCredencial: vi.fn(),
  renovarValidade: vi.fn(),
  removerCredencial: vi.fn(),
}));

vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth')>();
  return { ...actual, usePermission: () => ({ allowed: h.podeEscrever, loading: false }) };
});

vi.mock('@/lib/loja-integrada/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/loja-integrada/client')>();
  return {
    ...actual,
    useBackendLojaIntegrada: () =>
      h.semCliente
        ? { client: null, indisponivel: h.indisponivel }
        : {
            client: {
              conta: h.conta,
              salvarCredencial: h.salvarCredencial,
              renovarValidade: h.renovarValidade,
              removerCredencial: h.removerCredencial,
            },
            indisponivel: null,
          },
  };
});

vi.mock('@delfrance/core/datetime', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/core/datetime')>();
  return { ...actual, nowMillis: () => h.agora };
});

// The calendar has its own library tests; a plain input keeps the date
// controllable and exposes the bounds the panel hands it.
vi.mock('@mantine/dates', () => ({
  DatePickerInput: ({
    label,
    value,
    onChange,
    minDate,
    maxDate,
    error,
    disabled,
  }: {
    label: string;
    value: string | null;
    onChange: (valor: string | null) => void;
    minDate?: string;
    maxDate?: string;
    error?: string | null;
    disabled?: boolean;
  }) => (
    <div>
      <input
        aria-label={label}
        value={value ?? ''}
        data-min={minDate}
        data-max={maxDate}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      />
      {error ? <span data-testid="erro-da-data">{error}</span> : null}
    </div>
  ),
}));

const { ContaLojaIntegradaPanel } = await import('./ContaLojaIntegradaPanel');
const { LojaIntegradaClientHttpError, LojaIntegradaClientNetworkError } =
  await import('@/lib/loja-integrada/client');

/** 2026-10-08 15:00 in São Paulo: the window is 2026-10-08..2027-02-05. */
const AGORA = Date.UTC(2026, 9, 8, 18, 0);
const TOKEN = 'li-sentinela-7e2b9c4d1a6f3e8b5c0d2a4f6e8b0c1d';
const VERSAO = 1_790_000_000_123_456;
const VERSAO_NOVA = 1_790_000_900_000_001;

const SEM_TOKEN: StatusContaLojaIntegrada = {
  configurado: false,
  expiraEm: null,
  diasParaExpirar: null,
  situacaoValidade: null,
  atualizadoEmMs: null,
  versaoCredencialUs: null,
  reconexaoPendente: null,
};

const COM_TOKEN: StatusContaLojaIntegrada = {
  configurado: true,
  expiraEm: '2026-12-31',
  diasParaExpirar: 84,
  situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.ok,
  // 2026-10-07 12:00 in São Paulo.
  atualizadoEmMs: Date.UTC(2026, 9, 7, 15, 0),
  versaoCredencialUs: VERSAO,
  reconexaoPendente: null,
};

function resposta(
  patch: Partial<RespostaCredencialLojaIntegrada> = {},
): RespostaCredencialLojaIntegrada {
  return {
    ...COM_TOKEN,
    expiraEm: '2027-01-15',
    diasParaExpirar: 98,
    atualizadoEmMs: AGORA,
    versaoCredencialUs: VERSAO_NOVA,
    reconexaoResolvida: false,
    ...patch,
  };
}

function http(status: number, code: string | null, extras = {}) {
  return new LojaIntegradaClientHttpError(`backend ${String(status)}`, status, code, extras);
}

/**
 * The APP's TanStack defaults (`retry: 1`, `staleTime: 30_000`), not test-only
 * ones: the panel's own `retry: false` / `staleTime: 0` / `refetchOnReconnect:
 * false` are only proved load-bearing against the defaults they override.
 * `retryDelay: 0` only shortens a retry that, if the panel let it happen, would
 * still happen.
 */
function novoQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      ...QUERY_DEFAULT_OPTIONS,
      queries: { ...QUERY_DEFAULT_OPTIONS.queries, retryDelay: 0 },
    },
  });
}

function renderPanel(qc: QueryClient = novoQueryClient()): { readonly desmontar: () => void } {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  const { unmount } = render(<ContaLojaIntegradaPanel integracaoId="conta-1" />, { wrapper });
  return { desmontar: unmount };
}

const campoToken = () => screen.getByLabelText('Personal Token') as HTMLInputElement;
const campoData = () => screen.getByLabelText('Validade do token') as HTMLInputElement;
const botao = (nome: string | RegExp) => screen.getByRole('button', { name: nome });
const botaoSalvar = () => botao('Validar e salvar');
const botaoRenovar = () => botao(/^Só atualizar a validade/);
const botaoRemover = () => botao('Remover token');

function preencher(token: string, data: string): void {
  fireEvent.change(campoToken(), { target: { value: token } });
  fireEvent.change(campoData(), { target: { value: data } });
}

/** The badge element that holds `texto`, for its colour. */
function estiloDoBadge(texto: string | RegExp): string {
  return screen.getByText(texto).closest('[class*="Badge-root"]')?.getAttribute('style') ?? '';
}

beforeEach(() => {
  h.podeEscrever = true;
  h.indisponivel = null;
  h.semCliente = false;
  h.agora = AGORA;
  h.conta.mockReset();
  h.salvarCredencial.mockReset();
  h.renovarValidade.mockReset();
  h.removerCredencial.mockReset();
});

describe('ContaLojaIntegradaPanel — what is stored', () => {
  it('a conta with no token: gray "Sem token"; renew and remove have nothing to act on', async () => {
    h.conta.mockResolvedValue(SEM_TOKEN);
    renderPanel();

    expect(await screen.findByText('Sem token')).toBeTruthy();
    expect(screen.getByText(/Nenhum token salvo/)).toBeTruthy();
    expect(botaoRenovar()).toHaveProperty('disabled', true);
    expect(botaoRemover()).toHaveProperty('disabled', true);
    expect(h.conta).toHaveBeenCalledWith('conta-1');
  });

  it('a configured conta: validated ONCE at save (never "Conectada"), days and date', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    renderPanel();

    expect(await screen.findByText('Configurado — validado ao salvar em 07/10')).toBeTruthy();
    expect(screen.queryByText(/Conectad/)).toBeNull();
    expect(screen.getByText('vence em 84 dias')).toBeTruthy();
    expect(screen.getByText('Validade até 31/12/2026')).toBeTruthy();
    expect(estiloDoBadge('vence em 84 dias')).toContain('green');
    // Nothing to do on a healthy token.
    expect(screen.queryByText(/Renove o token/)).toBeNull();
  });

  it('expirando: yellow, and says to renew in the painel then update the date here', async () => {
    h.conta.mockResolvedValue({
      ...COM_TOKEN,
      diasParaExpirar: 12,
      situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.expirando,
    });
    renderPanel();

    expect(await screen.findByText('vence em 12 dias')).toBeTruthy();
    expect(estiloDoBadge('vence em 12 dias')).toContain('yellow');
    expect(screen.getByText(/Renove o token no painel da Loja Integrada/)).toBeTruthy();
  });

  it('the last day reads "vence hoje", still expirando — never "vence em 0 dias"', async () => {
    h.conta.mockResolvedValue({
      ...COM_TOKEN,
      diasParaExpirar: 0,
      situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.expirando,
    });
    renderPanel();

    expect(await screen.findByText('vence hoje')).toBeTruthy();
    expect(estiloDoBadge('vence hoje')).toContain('yellow');
  });

  it('vencido: red, and names both outcomes (renewed, or revoked)', async () => {
    h.conta.mockResolvedValue({
      ...COM_TOKEN,
      diasParaExpirar: -2,
      situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.vencido,
    });
    renderPanel();

    expect(await screen.findByText('venceu há 2 dias')).toBeTruthy();
    expect(estiloDoBadge('venceu há 2 dias')).toContain('red');
    expect(screen.getByText(/gere um novo no painel/)).toBeTruthy();
  });

  it('⭐ a parked conta: the red reconexão alert WINS over the expiry badge', async () => {
    h.conta.mockResolvedValue({
      ...COM_TOKEN,
      // 2026-10-06 22:30 in São Paulo — already the 7th in UTC.
      reconexaoPendente: { desdeMs: Date.UTC(2026, 9, 7, 1, 30), status: 401 },
    });
    renderPanel();

    expect(await screen.findByText('Reconexão pendente')).toBeTruthy();
    expect(
      screen.getByText(
        /A Loja Integrada recusou o token \(HTTP 401\) em 06\/10; a importação ficará parada/,
      ),
    ).toBeTruthy();
    // The header badge takes the most urgent colour, whatever the expiry says.
    expect(estiloDoBadge(/^Configurado/)).toContain('red');
    // The healthy-looking expiry badge is not shown next to a refusal.
    expect(screen.queryByText('vence em 84 dias')).toBeNull();
    expect(screen.getByText('Validade informada: 31/12/2026')).toBeTruthy();
  });

  it('the token field is never prefilled — the status has no token to prefill it with', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    renderPanel();

    await screen.findByText('vence em 84 dias');
    expect(campoToken().value).toBe('');
  });
});

describe('ContaLojaIntegradaPanel — the date picker', () => {
  it('⭐ offers exactly today..today + 120 days in São Paulo — the routes’ window', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    renderPanel();
    await screen.findByText('vence em 84 dias');

    expect(campoData().getAttribute('data-min')).toBe('2026-10-08');
    expect(campoData().getAttribute('data-max')).toBe('2027-02-05');
  });

  it('a São Paulo evening that is already tomorrow in UTC still offers TODAY', async () => {
    // 2026-10-09 01:30 UTC = 2026-10-08 22:30 in São Paulo.
    h.agora = Date.UTC(2026, 9, 9, 1, 30);
    h.conta.mockResolvedValue(COM_TOKEN);
    renderPanel();
    await screen.findByText('vence em 84 dias');

    expect(campoData().getAttribute('data-min')).toBe('2026-10-08');
  });
});

describe('ContaLojaIntegradaPanel — save', () => {
  it('⭐ sends the trimmed token, the date and the version ON SCREEN; clears the token', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    h.salvarCredencial.mockResolvedValue(resposta({ reconexaoResolvida: true }));
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(`  ${TOKEN}  `, '2027-01-15');
    fireEvent.click(botaoSalvar());

    expect(
      await screen.findByText(
        'Token validado e salvo. Validade até 15/01/2027. A reconexão pendente foi resolvida.',
      ),
    ).toBeTruthy();
    expect(h.salvarCredencial).toHaveBeenCalledTimes(1);
    expect(h.salvarCredencial).toHaveBeenCalledWith('conta-1', {
      token: TOKEN,
      expiraEm: '2027-01-15',
      versaoEsperada: VERSAO,
    });
    expect(campoToken().value).toBe('');
    expect(campoData().value).toBe('');
    // The token is never echoed into the page — text or attribute.
    expect(document.body.innerHTML).not.toContain(TOKEN);
    // Cleared means the button follows: nothing left to send.
    expect(botaoSalvar()).toHaveProperty('disabled', true);
  });

  it('⭐ the NEXT write carries the version just written — no refetch needed, none made', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    h.salvarCredencial.mockResolvedValue(resposta());
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(TOKEN, '2027-01-15');
    fireEvent.click(botaoSalvar());
    await screen.findByText(/Token validado e salvo/);
    // The answer replaced the cached status.
    expect(await screen.findByText('vence em 98 dias')).toBeTruthy();

    preencher('outro-token-qualquer-123456', '2027-01-20');
    fireEvent.click(botaoSalvar());
    await waitFor(() => expect(h.salvarCredencial).toHaveBeenCalledTimes(2));

    expect(h.salvarCredencial.mock.calls[1]![1]).toMatchObject({ versaoEsperada: VERSAO_NOVA });
    expect(h.conta).toHaveBeenCalledTimes(1);
  });

  it('a first save sends versaoEsperada null', async () => {
    h.conta.mockResolvedValue(SEM_TOKEN);
    h.salvarCredencial.mockResolvedValue(resposta());
    renderPanel();
    await screen.findByText('Sem token');

    preencher(TOKEN, '2027-01-15');
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(h.salvarCredencial).toHaveBeenCalledTimes(1));
    expect(h.salvarCredencial.mock.calls[0]![1]).toMatchObject({ versaoEsperada: null });
  });

  it('cannot be sent without a token, without a date, or with only whitespace', async () => {
    h.conta.mockResolvedValue(SEM_TOKEN);
    renderPanel();
    await screen.findByText('Sem token');

    expect(botaoSalvar()).toHaveProperty('disabled', true);
    fireEvent.change(campoToken(), { target: { value: '   ' } });
    fireEvent.change(campoData(), { target: { value: '2027-01-15' } });
    expect(botaoSalvar()).toHaveProperty('disabled', true);
    fireEvent.change(campoToken(), { target: { value: TOKEN } });
    expect(botaoSalvar()).toHaveProperty('disabled', false);
  });

  it('a date past the window is refused HERE, before anything is sent', async () => {
    h.conta.mockResolvedValue(SEM_TOKEN);
    renderPanel();
    await screen.findByText('Sem token');

    preencher(TOKEN, '2027-02-06');

    expect(botaoSalvar()).toHaveProperty('disabled', true);
    expect(screen.getByTestId('erro-da-data').textContent).toBe(
      'Escolha uma data entre 08/10/2026 e 05/02/2027.',
    );
  });

  it.each([
    ['LI_TOKEN_RECUSADO', 422, CODIGO_ERRO_LI.tokenRecusado, /recusou este token \(HTTP 401\)/],
    ['LI_TOKEN_INVALIDO', 422, CODIGO_ERRO_LI.tokenInvalido, /Nada foi enviado à Loja Integrada/],
    [
      'LI_TOKEN_DE_OUTRA_CONTA',
      409,
      CODIGO_ERRO_LI.tokenDeOutraConta,
      /já está salvo em outra conta/,
    ],
    // The backend's read switch is off: until the cutover, or mis-set after it (D17).
    [
      'LI_CHAMADAS_DESLIGADAS',
      503,
      CODIGO_ERRO_LI.chamadasDesligadas,
      /estão desligadas neste backend: até a migração para este sistema, ou por configuração/,
    ],
  ])(
    '%s: its copy, and the token is CLEARED — with no re-read',
    async (_n, status, code, copia) => {
      h.conta.mockResolvedValue(COM_TOKEN);
      h.salvarCredencial.mockRejectedValue(http(status, code, { statusLi: 401 }));
      renderPanel();
      await screen.findByText('vence em 84 dias');

      preencher(TOKEN, '2027-01-15');
      fireEvent.click(botaoSalvar());

      expect(await screen.findByText(copia)).toBeTruthy();
      expect(campoToken().value).toBe('');
      // The date is kept but the field is empty: the button must follow the
      // field, not the verdict of the token that was just cleared.
      expect(campoData().value).toBe('2027-01-15');
      expect(botaoSalvar()).toHaveProperty('disabled', true);
      // Nothing was written, so the status on screen still stands: re-reading
      // it could only adopt ANOTHER operator's version without a 409.
      expect(h.conta).toHaveBeenCalledTimes(1);
    },
  );

  it('⭐ 502 inconclusive: the token is KEPT — resending it is the point', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    h.salvarCredencial.mockRejectedValue(http(502, CODIGO_ERRO_LI.validacaoInconclusiva));
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(TOKEN, '2027-01-15');
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText(/Não foi possível validar o token agora/)).toBeTruthy();
    expect(campoToken().value).toBe(TOKEN);
    expect(campoData().value).toBe('2027-01-15');
  });

  it('⭐ a KEPT token lives only in the field: never in an attribute, never in the markup', async () => {
    // A controlled input syncs React's `value` into the `value` ATTRIBUTE, where
    // anything that serialises the DOM (outerHTML, a snapshot, a replay tool)
    // reads it. `textContent` cannot see attributes; `innerHTML` can.
    h.conta.mockResolvedValue(COM_TOKEN);
    h.salvarCredencial.mockRejectedValue(http(502, CODIGO_ERRO_LI.validacaoInconclusiva));
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(TOKEN, '2027-01-15');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText(/Não foi possível validar o token agora/)).toBeTruthy();
    // The near miss: the token IS still in the field, ready to resend…
    expect(campoToken().value).toBe(TOKEN);
    // …and nowhere in the serialised page.
    expect(campoToken().hasAttribute('value')).toBe(false);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('⭐ a paste longer than MAX_TOKEN_LI is refused ON the field, before anything is sent', async () => {
    h.conta.mockResolvedValue(SEM_TOKEN);
    renderPanel();
    await screen.findByText('Sem token');

    fireEvent.change(campoData(), { target: { value: '2027-01-15' } });
    fireEvent.change(campoToken(), { target: { value: 'x'.repeat(MAX_TOKEN_LI + 1) } });
    expect(botaoSalvar()).toHaveProperty('disabled', true);
    expect(screen.getByText(/longo demais para um Personal Token/)).toBeTruthy();

    // The near miss: exactly the bound, padded the way a paste is, is sendable.
    fireEvent.change(campoToken(), { target: { value: ` ${'x'.repeat(MAX_TOKEN_LI)}\n` } });
    expect(botaoSalvar()).toHaveProperty('disabled', false);
    expect(screen.queryByText(/longo demais para um Personal Token/)).toBeNull();
    expect(h.salvarCredencial).not.toHaveBeenCalled();
  });

  it('a network failure keeps the token too', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    h.salvarCredencial.mockRejectedValue(new LojaIntegradaClientNetworkError(new TypeError('x')));
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(TOKEN, '2027-01-15');
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText(/falha de rede/)).toBeTruthy();
    expect(campoToken().value).toBe(TOKEN);
  });

  it('⭐ 409 LI_CREDENCIAL_ALTERADA: re-reads the status, tells the operator, keeps the token', async () => {
    h.conta.mockResolvedValueOnce(COM_TOKEN).mockResolvedValue({
      ...COM_TOKEN,
      diasParaExpirar: 50,
      versaoCredencialUs: VERSAO_NOVA,
    });
    h.salvarCredencial.mockRejectedValueOnce(http(409, CODIGO_ERRO_LI.credencialAlterada));
    h.salvarCredencial.mockResolvedValue(resposta());
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(TOKEN, '2027-01-15');
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText(/mudou depois que esta tela a leu/)).toBeTruthy();
    expect(await screen.findByText('vence em 50 dias')).toBeTruthy();
    expect(h.conta).toHaveBeenCalledTimes(2);
    expect(campoToken().value).toBe(TOKEN);

    // The retry now carries the version the operator has just been shown.
    fireEvent.click(botaoSalvar());
    await waitFor(() => expect(h.salvarCredencial).toHaveBeenCalledTimes(2));
    expect(h.salvarCredencial.mock.calls[1]![1]).toMatchObject({ versaoEsperada: VERSAO_NOVA });
  });

  it('a refused date goes on the DATE field and keeps the token', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    h.salvarCredencial.mockRejectedValue(
      http(422, CODIGO_ERRO_LI.validadePassada, { campos: ['expiraEm'] }),
    );
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(TOKEN, '2026-10-08');
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(screen.getByTestId('erro-da-data').textContent).toBe(
        'A validade não pode ser anterior a hoje.',
      ),
    );
    expect(campoToken().value).toBe(TOKEN);
  });

  it('⭐ an error nobody knows clears the token, then PROPAGATES (rule 6)', async () => {
    // TanStack reports a callback's throw as `void Promise.reject(e)` — an
    // unhandled rejection, which is the loud outcome rule 6 wants. Capture
    // exactly that one rejection (every other `Promise.reject` passes through),
    // so the test proves the rethrow instead of tripping on it.
    const bug = new Error('bug');
    const propagados: unknown[] = [];
    const rejeitar = Promise.reject.bind(Promise);
    const espiao = vi.spyOn(Promise, 'reject').mockImplementation((motivo?: unknown) => {
      if (motivo !== bug) return rejeitar(motivo);
      propagados.push(motivo);
      return new Promise<never>(() => undefined);
    });
    try {
      h.conta.mockResolvedValue(COM_TOKEN);
      // An async throw, NOT `mockRejectedValue`: that one goes through
      // `Promise.reject` itself and would be captured above.
      h.salvarCredencial.mockImplementation(async () => {
        throw bug;
      });
      renderPanel();
      await screen.findByText('vence em 84 dias');

      preencher(TOKEN, '2027-01-15');
      fireEvent.click(botaoSalvar());

      await waitFor(() => expect(propagados).toEqual([bug]));
      expect(campoToken().value).toBe('');
      // Not dressed up as a known failure either.
      expect(screen.queryByText(/Nada foi salvo/)).toBeNull();
    } finally {
      espiao.mockRestore();
    }
  });
});

describe('ContaLojaIntegradaPanel — renewal', () => {
  it('⭐ sends the date and the version only — the stored token is re-validated, not re-pasted', async () => {
    h.conta.mockResolvedValue({
      ...COM_TOKEN,
      diasParaExpirar: 5,
      situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.expirando,
    });
    h.renovarValidade.mockResolvedValue(resposta());
    renderPanel();
    await screen.findByText('vence em 5 dias');

    fireEvent.change(campoData(), { target: { value: '2027-01-15' } });
    expect(botaoSalvar()).toHaveProperty('disabled', true);
    fireEvent.click(botaoRenovar());

    expect(
      await screen.findByText('Token salvo revalidado na Loja Integrada. Validade até 15/01/2027.'),
    ).toBeTruthy();
    expect(h.renovarValidade).toHaveBeenCalledWith('conta-1', {
      expiraEm: '2027-01-15',
      versaoEsperada: VERSAO,
    });
    expect(h.salvarCredencial).not.toHaveBeenCalled();
  });

  it('LI_CHAMADAS_DESLIGADAS on a renewal: says the calls are off (migration or configuration), no re-read', async () => {
    h.conta.mockResolvedValue(COM_TOKEN);
    h.renovarValidade.mockRejectedValue(http(503, CODIGO_ERRO_LI.chamadasDesligadas));
    renderPanel();
    await screen.findByText('vence em 84 dias');

    fireEvent.change(campoData(), { target: { value: '2027-01-15' } });
    fireEvent.click(botaoRenovar());

    expect(
      await screen.findByText(/até a migração para este sistema, ou por configuração/),
    ).toBeTruthy();
    expect(screen.queryByText(/pode ou não ter sido salvo/)).toBeNull();
    // Nothing was written: the status on screen still stands.
    expect(h.conta).toHaveBeenCalledTimes(1);
    expect(screen.getByText('vence em 84 dias')).toBeTruthy();
  });

  it('LI_CREDENCIAL_AUSENTE (removed meanwhile): asks for a save and re-reads', async () => {
    h.conta.mockResolvedValueOnce(COM_TOKEN).mockResolvedValue(SEM_TOKEN);
    h.renovarValidade.mockRejectedValue(http(409, CODIGO_ERRO_LI.credencialAusente));
    renderPanel();
    await screen.findByText('vence em 84 dias');

    fireEvent.change(campoData(), { target: { value: '2027-01-15' } });
    fireEvent.click(botaoRenovar());

    expect(await screen.findByText(/Salve um Personal Token primeiro/)).toBeTruthy();
    expect(await screen.findByText('Sem token')).toBeTruthy();
  });
});

describe('ContaLojaIntegradaPanel — removal', () => {
  it('⭐ asks first: Cancelar sends nothing; Remover removes and re-reads', async () => {
    h.conta.mockResolvedValueOnce(COM_TOKEN).mockResolvedValue(SEM_TOKEN);
    h.removerCredencial.mockResolvedValue({ ok: true });
    renderPanel();
    await screen.findByText('vence em 84 dias');

    fireEvent.click(botaoRemover());
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.removerCredencial).not.toHaveBeenCalled();

    fireEvent.click(botaoRemover());
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remover' }),
    );

    expect(await screen.findByText(/Token removido/)).toBeTruthy();
    expect(h.removerCredencial).toHaveBeenCalledWith('conta-1');
    expect(await screen.findByText('Sem token')).toBeTruthy();
  });
});

describe('ContaLojaIntegradaPanel — when the status is re-read', () => {
  it('⭐ a reconnect does NOT re-read: a dirty form never silently adopts another version', async () => {
    h.conta.mockResolvedValueOnce(COM_TOKEN).mockResolvedValue({
      ...COM_TOKEN,
      versaoCredencialUs: VERSAO_NOVA,
    });
    h.salvarCredencial.mockResolvedValue(resposta());
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(TOKEN, '2027-01-15');
    try {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      fireEvent.click(botaoSalvar());
      await waitFor(() => expect(h.salvarCredencial).toHaveBeenCalledTimes(1));
    } finally {
      onlineManager.setOnline(true);
    }

    expect(h.conta).toHaveBeenCalledTimes(1);
    // The version the operator was SHOWN — so a changed credential is a 409.
    expect(h.salvarCredencial.mock.calls[0]![1]).toMatchObject({ versaoEsperada: VERSAO });
  });

  it('a window focus does NOT re-read either (the app default; this trips if it flips)', async () => {
    h.conta.mockResolvedValueOnce(COM_TOKEN).mockResolvedValue({
      ...COM_TOKEN,
      versaoCredencialUs: VERSAO_NOVA,
    });
    h.salvarCredencial.mockResolvedValue(resposta());
    renderPanel();
    await screen.findByText('vence em 84 dias');

    preencher(TOKEN, '2027-01-15');
    try {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      fireEvent.click(botaoSalvar());
      await waitFor(() => expect(h.salvarCredencial).toHaveBeenCalledTimes(1));
    } finally {
      focusManager.setFocused(undefined);
    }

    expect(h.conta).toHaveBeenCalledTimes(1);
    expect(h.salvarCredencial.mock.calls[0]![1]).toMatchObject({ versaoEsperada: VERSAO });
  });

  it('a remount inside the app’s 30-second staleTime still re-reads (the form starts empty)', async () => {
    h.conta.mockResolvedValueOnce(COM_TOKEN).mockResolvedValue({
      ...COM_TOKEN,
      diasParaExpirar: 50,
      versaoCredencialUs: VERSAO_NOVA,
    });
    const qc = novoQueryClient();
    const primeira = renderPanel(qc);
    await screen.findByText('vence em 84 dias');
    primeira.desmontar();

    renderPanel(qc);
    expect(await screen.findByText('vence em 50 dias')).toBeTruthy();
    expect(h.conta).toHaveBeenCalledTimes(2);
  });
});

describe('ContaLojaIntegradaPanel — failing closed', () => {
  it('a status read that cannot reach the backend: RetryAlert, and nothing can be saved', async () => {
    h.conta
      .mockRejectedValueOnce(new LojaIntegradaClientNetworkError(new TypeError('x')))
      .mockResolvedValue(SEM_TOKEN);
    renderPanel();

    expect(
      await screen.findByText('Não foi possível contatar o backend da Loja Integrada.'),
    ).toBeTruthy();
    preencher(TOKEN, '2027-01-15');
    // No status, no version to send.
    expect(botaoSalvar()).toHaveProperty('disabled', true);

    fireEvent.click(botao('Tentar novamente'));
    expect(await screen.findByText('Sem token')).toBeTruthy();
    expect(botaoSalvar()).toHaveProperty('disabled', false);
  });

  it('⭐ an unreadable stored credential: no retry offered, but "Remover token" IS — that is the remedy', async () => {
    h.conta.mockRejectedValue(
      http(409, CODIGO_ERRO_LI.credencialInvalida, { campos: ['reconexaoPendente.status'] }),
    );
    renderPanel();

    expect(
      await screen.findByText(/está ilegível \(campos: reconexaoPendente.status\)/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    expect(botaoRemover()).toHaveProperty('disabled', false);
    expect(botaoSalvar()).toHaveProperty('disabled', true);
  });

  it('the near miss: another status failure does NOT enable "Remover token"', async () => {
    h.conta.mockRejectedValue(http(503, null));
    renderPanel();

    await screen.findByText('backend 503');
    expect(botaoRemover()).toHaveProperty('disabled', true);
  });

  it('⭐ an https page with an http backend: "não configurado", the form disabled, nothing read', async () => {
    h.semCliente = true;
    h.indisponivel = 'inseguro';
    renderPanel();

    expect(screen.getByText('Backend da Loja Integrada não configurado')).toBeTruthy();
    expect(screen.getByText(/não é enviado por uma conexão sem criptografia/)).toBeTruthy();
    expect(campoToken()).toHaveProperty('disabled', true);
    expect(campoData()).toHaveProperty('disabled', true);
    expect(botaoSalvar()).toHaveProperty('disabled', true);
    expect(h.conta).not.toHaveBeenCalled();
  });

  it('logged out (no client, no reason): no misconfiguration alert, nothing read', () => {
    h.semCliente = true;
    h.indisponivel = null;
    renderPanel();

    expect(screen.queryByText('Backend da Loja Integrada não configurado')).toBeNull();
    expect(botaoSalvar()).toHaveProperty('disabled', true);
    expect(h.conta).not.toHaveBeenCalled();
  });

  it('without PERM.integracao.write: every write disabled, and it says why', async () => {
    h.podeEscrever = false;
    h.conta.mockResolvedValue(COM_TOKEN);
    renderPanel();
    await screen.findByText('vence em 84 dias');

    expect(screen.getByText('Requer permissão de escrita em integrações.')).toBeTruthy();
    expect(campoToken()).toHaveProperty('disabled', true);
    expect(botaoSalvar()).toHaveProperty('disabled', true);
    expect(botaoRenovar()).toHaveProperty('disabled', true);
    expect(botaoRemover()).toHaveProperty('disabled', true);
  });
});
