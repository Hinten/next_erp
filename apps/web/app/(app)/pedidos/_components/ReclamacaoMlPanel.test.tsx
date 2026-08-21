import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MantineTestProvider } from '@/lib/testing/mantine';

const h = vi.hoisted(() => ({
  reclamacaoEstado: vi.fn(),
  reclamacaoAcao: vi.fn(),
  allowed: { value: true },
}));

vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth')>();
  return { ...actual, usePermission: () => ({ allowed: h.allowed.value, loading: false }) };
});

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return {
    ...actual,
    useMercadoLivreClient: () => ({
      reclamacaoEstado: h.reclamacaoEstado,
      reclamacaoAcao: h.reclamacaoAcao,
    }),
  };
});

const { ReclamacaoMlPanel } = await import('./ReclamacaoMlPanel');

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MantineTestProvider>,
  );
}

const ESTADO = {
  claimId: 5204934310,
  status: 'opened',
  stage: 'claim',
  tipo: 'mediations',
  reasonId: 'PDD9551',
  tipoReclamacao: 'PDD' as const,
  acoesDisponiveis: ['refund'],
  prazos: [{ acao: 'refund', obrigatoria: false, prazo: null }],
  podeResponder: false,
  motivoSemResposta: null,
  expectativas: [
    { playerRole: 'complainant', expectedResolution: 'return_product', status: 'pending' },
  ],
  expectativasIndisponiveis: false,
  ofertasParciais: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.reclamacaoEstado.mockResolvedValue(ESTADO);
  h.reclamacaoAcao.mockResolvedValue({ ok: true, status: 'closed', acao: 'reembolso' });
  h.allowed.value = true;
});

function abrir() {
  wrap(<ReclamacaoMlPanel claimId={5204934310} integracaoId="int-1" />);
  fireEvent.click(screen.getByText('Ver situação e ações'));
}

describe('ReclamacaoMlPanel', () => {
  it('issues NO ML call until the operator opens it', () => {
    // ⚠️ A pedido can carry several incidentes. Fetching on render would be up
    // to three ML calls each, on a tab an operator opens to read history.
    wrap(<ReclamacaoMlPanel claimId={5204934310} integracaoId="int-1" />);
    expect(h.reclamacaoEstado).not.toHaveBeenCalled();
  });

  it('fetches once opened, for the right claim and account', async () => {
    abrir();
    await waitFor(() =>
      expect(h.reclamacaoEstado).toHaveBeenCalledWith({
        integracaoId: 'int-1',
        claimId: 5204934310,
      }),
    );
  });

  it('shows what the buyer wants, translated', async () => {
    // The block that has to be on screen BEFORE any action: choosing between
    // refund, return and partial without it is guessing.
    abrir();
    await waitFor(() =>
      expect(screen.getByText(/Devolver o produto e receber o dinheiro/)).toBeTruthy(),
    );
    expect(screen.getByText(/Comprador/)).toBeTruthy();
  });

  it('renders ONLY the verbs ML currently offers', async () => {
    // ⚠️ Presence is the truth, and the ABSENCE half is what makes this
    // non-vacuous: a panel that rendered all four unconditionally would pass a
    // presence-only assertion while offering a refund ML already withdrew.
    abrir();
    await waitFor(() => expect(screen.getByText('Reembolsar integralmente')).toBeTruthy());
    expect(screen.queryByText('Aceitar devolução')).toBeNull();
    expect(screen.queryByText('Abrir mediação')).toBeNull();
    expect(screen.queryByText('Reembolso parcial…')).toBeNull();
  });

  it('explains an empty action list with the channel reason, not a blank', async () => {
    h.reclamacaoEstado.mockResolvedValue({
      ...ESTADO,
      acoesDisponiveis: [],
      motivoSemResposta: 'Reclamação encerrada no Mercado Livre',
    });
    abrir();
    await waitFor(() =>
      expect(screen.getByText('Reclamação encerrada no Mercado Livre')).toBeTruthy(),
    );
  });

  it('distinguishes "could not read the expectations" from "there are none"', async () => {
    // ⚠️ A blank would read as "the buyer wants nothing", which is a different
    // claim from "we failed to ask".
    h.reclamacaoEstado.mockResolvedValue({
      ...ESTADO,
      expectativas: null,
      expectativasIndisponiveis: true,
    });
    abrir();
    await waitFor(() =>
      expect(screen.getByText('Não foi possível ler o que cada parte espera.')).toBeTruthy(),
    );
  });

  it('renders a backend refusal verbatim', async () => {
    // The 409 body names what the operator can do next; paraphrasing loses it.
    h.reclamacaoEstado.mockRejectedValue(new Error('Esta conta não tem acesso a esta reclamação.'));
    abrir();
    await waitFor(() =>
      expect(screen.getByText('Esta conta não tem acesso a esta reclamação.')).toBeTruthy(),
    );
  });
});

describe('ReclamacaoMlPanel — the action buttons', () => {
  async function abrirCom(acoes: string[]) {
    h.reclamacaoEstado.mockResolvedValue({ ...ESTADO, acoesDisponiveis: acoes });
    abrir();
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalled());
  }

  it('offers a button ONLY for a verb ML currently allows', async () => {
    // ⚠️ The absence half is what makes this non-vacuous — a panel rendering all
    // three unconditionally would satisfy a presence-only assertion while
    // offering a refund ML already withdrew.
    await abrirCom(['refund']);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reembolsar integralmente' })).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Aceitar devolução' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abrir mediação' })).toBeNull();
  });

  it('treats allow_return_label as allow_return — one decision, two ML verbs', async () => {
    await abrirCom(['allow_return_label']);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Aceitar devolução' })).toBeTruthy(),
    );
  });

  it('does NOT run the action until the operator confirms', async () => {
    // ⚠️ Every one of these is irreversible on ML's side. A click must never be
    // the commit.
    await abrirCom(['refund']);
    const btn = await screen.findByRole('button', { name: 'Reembolsar integralmente' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/Reembolsar o valor integral\?/)).toBeTruthy());
    expect(h.reclamacaoAcao).not.toHaveBeenCalled();
  });

  it('states the CONSEQUENCE in the confirmation, not the verb', async () => {
    // "Confirmar reembolso?" tells an operator nothing they did not know.
    await abrirCom(['refund']);
    fireEvent.click(await screen.findByRole('button', { name: 'Reembolsar integralmente' }));
    await waitFor(() =>
      expect(screen.getByText(/volta para o comprador.*não é possível desfazer/i)).toBeTruthy(),
    );
  });

  it('cancelling runs nothing', async () => {
    await abrirCom(['refund']);
    fireEvent.click(await screen.findByRole('button', { name: 'Reembolsar integralmente' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText(/Reembolsar o valor integral\?/)).toBeNull());
    expect(h.reclamacaoAcao).not.toHaveBeenCalled();
  });

  it('confirming sends the action and refetches the LIVE state', async () => {
    // ⚠️ Writes nothing locally: the confirmation the operator sees is ML's own
    // word, via a refetch — not a state we guessed.
    await abrirCom(['refund']);
    fireEvent.click(await screen.findByRole('button', { name: 'Reembolsar integralmente' }));
    const chamadasAntes = h.reclamacaoEstado.mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar reembolso integral' }));

    await waitFor(() =>
      expect(h.reclamacaoAcao).toHaveBeenCalledWith({
        integracaoId: 'int-1',
        claimId: 5204934310,
        acao: 'reembolso',
      }),
    );
    await waitFor(() =>
      expect(h.reclamacaoEstado.mock.calls.length).toBeGreaterThan(chamadasAntes),
    );
  });

  it('renders a backend refusal verbatim and leaves the buttons usable', async () => {
    const { MercadoLivreClientHttpError } = await import('@/lib/mercado-livre/client');
    h.reclamacaoAcao.mockRejectedValue(
      new MercadoLivreClientHttpError(
        'Ação "refund" não disponível nesta reclamação. Disponíveis: allow_return',
        409,
        'ML_ACAO_INDISPONIVEL',
      ),
    );
    await abrirCom(['refund']);
    fireEvent.click(await screen.findByRole('button', { name: 'Reembolsar integralmente' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar reembolso integral' }));

    await waitFor(() =>
      expect(screen.getByText(/não disponível nesta reclamação.*allow_return/)).toBeTruthy(),
    );
  });

  it('shows no buttons without the permission, and says why', async () => {
    // The real gate is `verifyCaller` on the backend; this exists so the operator
    // does not read an empty row as "the claim is closed".
    h.allowed.value = false;
    await abrirCom(['refund']);
    await waitFor(() => expect(screen.getByText(/não tem permissão para resolver/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Reembolsar integralmente' })).toBeNull();
  });
});
