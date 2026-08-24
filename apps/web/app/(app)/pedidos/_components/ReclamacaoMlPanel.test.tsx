import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MantineTestProvider } from '@/lib/testing/mantine';

const h = vi.hoisted(() => ({ reclamacaoEstado: vi.fn(), allowed: { value: true } }));

vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth')>();
  return { ...actual, usePermission: () => ({ allowed: h.allowed.value, loading: false }) };
});

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => ({ reclamacaoEstado: h.reclamacaoEstado }) };
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

describe('ReclamacaoMlPanel — review findings on #1228', () => {
  it('renders NOTHING without incidenteResolucao-read', () => {
    // ⚠️ The PR claimed the panel was "invisible until a cargo grants read". It
    // was not — every operator saw the button, and clicking it burned an ML round
    // trip to have verifyCaller answer 403 into a red alert. The route is still
    // the enforcement; this stops offering an action nobody can take.
    h.allowed.value = false;
    wrap(<ReclamacaoMlPanel claimId={5204934310} integracaoId="int-1" />);
    // ⚠️ Assert the PANEL's own content, not an empty container — Mantine injects
    // its stylesheet into the render root, so `textContent` is never ''.
    expect(screen.queryByText('Ver situação e ações')).toBeNull();
    expect(screen.queryByText(/Reclamação Mercado Livre/)).toBeNull();
    // And it must not have reached ML either — the round trip was half the cost.
    expect(h.reclamacaoEstado).not.toHaveBeenCalled();
  });

  it('drops a deadline row whose date cannot be parsed', async () => {
    // ⚠️ `formatarPrazo` returns null for a NON-null unparseable value, and React
    // renders null as nothing — so guarding on `prazo != null` left the row with
    // a blank date. A mandatory action showing no clock is worse than the
    // `Invalid Date` that formatter exists to prevent.
    h.reclamacaoEstado.mockResolvedValue({
      ...ESTADO,
      prazos: [{ acao: 'refund', obrigatoria: true, prazo: 'nao-e-uma-data' }],
    });
    abrir();
    await waitFor(() => expect(screen.getByText(/Ações disponíveis/)).toBeTruthy());
    expect(screen.queryByText('Prazos')).toBeNull();
  });

  it('keeps a deadline row whose date IS parseable', async () => {
    // The positive control — without it the assertion above would pass on a
    // panel that never rendered deadlines at all.
    h.reclamacaoEstado.mockResolvedValue({
      ...ESTADO,
      prazos: [{ acao: 'refund', obrigatoria: true, prazo: '2026-09-01T15:30:00.000Z' }],
    });
    abrir();
    await waitFor(() => expect(screen.getByText('Prazos')).toBeTruthy());
    expect(screen.getByText(/obrigatória/)).toBeTruthy();
  });

  it('translates the status and stage badges', async () => {
    abrir();
    await waitFor(() => expect(screen.getByText('aberta')).toBeTruthy());
    expect(screen.getByText('reclamação')).toBeTruthy();
    // …and does not leak the raw ML vocabulary into a pt-BR screen.
    expect(screen.queryByText('opened')).toBeNull();
    expect(screen.queryByText('claim')).toBeNull();
  });
});
