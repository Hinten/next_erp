import { useEffect, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import type { ShopeeReclamacaoEstado } from '@/lib/shopee/wire';
import type { OfertaDevolucaoShopeeModalProps } from './OfertaDevolucaoShopeeModal';

const h = vi.hoisted(() => ({
  reclamacaoEstado: vi.fn(),
  reclamacaoAcao: vi.fn(),
  notify: vi.fn(),
  podeConsultar: { value: true },
  podeExecutar: { value: true },
  semCliente: { value: false },
  modal: { montagens: 0 },
}));

/**
 * ⚠️ Per-BIT, not a single boolean (the ML panel test's lesson): `read` decides
 * whether the panel renders at all, `write` whether it offers buttons, and the
 * operator who may look but not act is only expressible if the mock tells them
 * apart.
 */
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth')>();
  const { PERM } = await import('@delfrance/auth');
  return {
    ...actual,
    usePermission: (bit: bigint) => ({
      allowed: bit === PERM.incidenteResolucao.write ? h.podeExecutar.value : h.podeConsultar.value,
      loading: false,
    }),
  };
});

// The REAL error classes stay: the panel narrows on them.
vi.mock('@/lib/shopee/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/client')>();
  return {
    ...actual,
    useShopeeClient: () =>
      h.semCliente.value
        ? null
        : { reclamacaoEstado: h.reclamacaoEstado, reclamacaoAcao: h.reclamacaoAcao },
  };
});

vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

/**
 * The offer modal is its own module with its own suite; here it is a stub that
 * exposes exactly what the PANEL owes it — the props it passes, what it does
 * with `onConfirm`, and that it UNMOUNTS the modal when closed (a fresh mount
 * per opening is what makes the modal's own reset structural).
 */
vi.mock('./OfertaDevolucaoShopeeModal', () => ({
  OfertaDevolucaoShopeeModal: function Stub(props: OfertaDevolucaoShopeeModalProps) {
    useEffect(() => {
      h.modal.montagens += 1;
    }, []);
    return (
      <div data-testid="oferta-modal">
        <span>carregando:{String(props.carregando)}</span>
        <span>enviando:{String(props.enviando)}</span>
        <span>solucoes:{props.solucoes.map((s) => s.solucao).join(',')}</span>
        {props.erro !== null && <p>erro-do-modal:{props.erro}</p>}
        <button
          type="button"
          onClick={() => props.onConfirm({ solucao: 'REFUND', valorReembolsoMinor: 1234 })}
        >
          stub enviar ajustável
        </button>
        <button type="button" onClick={() => props.onConfirm({ solucao: 'RETURN_REFUND' })}>
          stub enviar fixa
        </button>
        <button type="button" onClick={props.onClose}>
          stub fechar
        </button>
      </div>
    );
  },
}));

const { ReclamacaoShopeePanel, falhaDaAcaoShopee, FRASE_DESFECHO_INCERTO } =
  await import('./ReclamacaoShopeePanel');
const {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  shopeeHttpFallbackMessage,
} = await import('@/lib/shopee/client');
const { FirebaseError } = await import('firebase/app');

/** Fixture ids only. The alphanumeric return_sn is the doc's own shape. */
const SN = '2609100000000001';
const SN_ALFA = '260910ABCDE0001';

const ESTADO: ShopeeReclamacaoEstado = {
  returnSn: SN,
  orderSn: '260910KJBHUJDM',
  pedidoId: 'pedido-1',
  status: 'REQUESTED',
  terminal: false,
  solucao: 'RETURN_REFUND',
  motivo: 'ITEM_DAMAGED',
  motivoReavaliado: null,
  valorReembolso: 89.9,
  valorAntesDesconto: 99.9,
  moeda: 'BRL',
  tipoRequisicao: 0,
  tipoValidacao: 'seller_validation',
  negociacao: null,
  prova: { status: 'NOT_NEEDED' },
  compensacao: null,
  prazos: [{ tipo: 'resposta-vendedor', prazoMs: 1_790_000_000_000, reembolsoAutomatico: true }],
  solucoes: [{ solucao: 'REFUND', ajustavel: true, minimo: 1, maximo: 89.9 }],
  acoesDisponiveis: ['confirmar'],
  motivoSemAcao: null,
  pendenciasForaDoErp: [],
};

const NEGOCIACAO = {
  status: 'PENDING_RESPOND',
  solucaoOfertada: 'REFUND' as const,
  valorOfertado: 45.5,
  contrapropostasRestantes: 2,
};

/** The APP's defaults — an override is only proved load-bearing against them. */
function novoQc(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
}

function host(qc: QueryClient, ui: ReactElement): ReactElement {
  return (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MantineTestProvider>
  );
}

function painel(returnSn = SN, pedidoId = 'pedido-1'): ReactElement {
  return <ReclamacaoShopeePanel integracaoId="int-1" pedidoId={pedidoId} returnSn={returnSn} />;
}

function montar(ui: ReactElement = painel(), qc: QueryClient = novoQc()) {
  return { qc, ...render(host(qc, ui)) };
}

function comEstado(over: Partial<ShopeeReclamacaoEstado>): void {
  h.reclamacaoEstado.mockResolvedValue({ ...ESTADO, ...over });
}

/** Mount, expand, and wait for the Shopee state to be on screen. */
async function abrir(ui?: ReactElement, qc?: QueryClient) {
  const r = montar(ui, qc);
  fireEvent.click(screen.getByRole('button', { name: 'Ver situação e ações' }));
  await screen.findByText('Ações disponíveis na Shopee');
  return r;
}

function adiado<T>() {
  let resolver!: (v: T) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

function botao(nome: string | RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name: nome }) as HTMLButtonElement;
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  h.reclamacaoEstado.mockResolvedValue(ESTADO);
  h.reclamacaoAcao.mockResolvedValue({
    ok: true,
    acao: 'confirmar',
    returnSn: SN,
    atualizacao: 'enfileirada',
  });
  h.podeConsultar.value = true;
  h.podeExecutar.value = true;
  h.semCliente.value = false;
  h.modal.montagens = 0;
});

describe('ReclamacaoShopeePanel — visibility and the read', () => {
  it('renders NOTHING without incidenteResolucao-read, and never reaches the backend', () => {
    h.podeConsultar.value = false;
    montar();
    // ⚠️ The panel's own content, not an empty container — Mantine injects its
    // stylesheet into the render root.
    expect(screen.queryByText('Ver situação e ações')).toBeNull();
    expect(screen.queryByText(/Devolução Shopee/)).toBeNull();
    expect(h.reclamacaoEstado).not.toHaveBeenCalled();
  });

  it('is collapsed by default and issues ZERO calls until expanded', async () => {
    // A pedido can carry several returns; each expansion costs 1–2 Shopee calls.
    montar();
    expect(screen.getByText(`Devolução Shopee #${SN}`)).toBeTruthy();
    await pausa(10);
    expect(h.reclamacaoEstado).not.toHaveBeenCalled();
  });

  it('expanding calls reclamacaoEstado ONCE, for the right conta and return', async () => {
    comEstado({ returnSn: SN_ALFA });
    await abrir(painel(SN_ALFA));
    expect(h.reclamacaoEstado).toHaveBeenCalledTimes(1);
    expect(h.reclamacaoEstado).toHaveBeenCalledWith({ integracaoId: 'int-1', returnSn: SN_ALFA });
  });

  it('logged out (no client): expanding fetches nothing — and runs no query that could fail', async () => {
    h.semCliente.value = true;
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Ver situação e ações' }));
    await pausa(10);
    expect(h.reclamacaoEstado).not.toHaveBeenCalled();
    // A query enabled without a client would run `client!.…` and paint a
    // TypeError into a red alert.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders a backend refusal of the read verbatim, and reads only ONCE (no retry)', async () => {
    // ⚠️ Against the APP defaults (`retry: 1`): a read costs Shopee calls, and
    // "Atualizar" is the retry.
    h.reclamacaoEstado.mockRejectedValue(
      new ShopeeClientHttpError('Esta devolução não existe na Shopee.', 404, 'X'),
    );
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Ver situação e ações' }));
    await screen.findByText('Esta devolução não existe na Shopee.');
    await pausa(30);
    expect(h.reclamacaoEstado).toHaveBeenCalledTimes(1);
  });

  it('rewords ONLY a transport failure of the read (the browser says "Failed to fetch")', async () => {
    h.reclamacaoEstado.mockRejectedValue(new ShopeeClientNetworkError('Failed to fetch'));
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Ver situação e ações' }));
    await screen.findByText(/Não foi possível falar com a integração da Shopee/);
    expect(screen.queryByText('Failed to fetch')).toBeNull();
  });

  it('"Atualizar" refetches', async () => {
    await abrir();
    fireEvent.click(botao('Atualizar'));
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
  });

  it('two returns on one pedido never share query state', async () => {
    // The key is per RETURN; a pedido-level key would show return A's actions
    // on return B's card.
    h.reclamacaoEstado.mockImplementation(({ returnSn }: { returnSn: string }) =>
      Promise.resolve(
        returnSn === SN_ALFA
          ? { ...ESTADO, returnSn, status: 'CLOSED', acoesDisponiveis: [] }
          : { ...ESTADO, returnSn },
      ),
    );
    montar(
      <>
        {painel(SN)}
        {painel(SN_ALFA)}
      </>,
    );
    const [primeiro] = screen.getAllByRole('button', { name: 'Ver situação e ações' });
    fireEvent.click(primeiro!);
    await screen.findByText('solicitada');
    expect(h.reclamacaoEstado).toHaveBeenCalledTimes(1);
    expect(h.reclamacaoEstado).toHaveBeenLastCalledWith({ integracaoId: 'int-1', returnSn: SN });
    expect(screen.queryByText('encerrada')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ver situação e ações' }));
    await screen.findByText('encerrada');
    expect(h.reclamacaoEstado).toHaveBeenLastCalledWith({
      integracaoId: 'int-1',
      returnSn: SN_ALFA,
    });
    expect(screen.getByText('solicitada')).toBeTruthy();
  });
});

describe('ReclamacaoShopeePanel — nothing cached (staleTime 0, gcTime 0)', () => {
  it('a fresh panel on the same return reads AGAIN, even inside the app’s 30 s staleTime', async () => {
    // ⚠️ Remount in ONE synchronous step, before the 0 ms gc timer can run: the
    // previous answer is still in the cache, so only `staleTime: 0` makes the
    // expansion refetch instead of re-showing a remembered action list.
    const qc = novoQc();
    const { rerender } = await abrir(
      <ReclamacaoShopeePanel key="a" integracaoId="int-1" pedidoId="pedido-1" returnSn={SN} />,
      qc,
    );
    expect(h.reclamacaoEstado).toHaveBeenCalledTimes(1);
    rerender(
      host(
        qc,
        <ReclamacaoShopeePanel key="b" integracaoId="int-1" pedidoId="pedido-1" returnSn={SN} />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ver situação e ações' }));
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
  });

  it('leaves NOTHING in the cache once the panel is gone', async () => {
    const qc = novoQc();
    const { unmount } = await abrir(painel(), qc);
    expect(qc.getQueryCache().find({ queryKey: ['shopeeReclamacao', 'int-1', SN] })).toBeDefined();
    unmount();
    await pausa(10);
    expect(
      qc.getQueryCache().find({ queryKey: ['shopeeReclamacao', 'int-1', SN] }),
    ).toBeUndefined();
  });
});

describe('ReclamacaoShopeePanel — what the expanded panel shows', () => {
  it('translates a known status and shows an unknown one RAW', async () => {
    await abrir();
    expect(screen.getByText('solicitada')).toBeTruthy();
    expect(screen.queryByText('REQUESTED')).toBeNull();
  });

  it('an unknown status token is shown raw, never blank', async () => {
    comEstado({ status: 'SOME_NEW_STATUS' });
    await abrir();
    expect(screen.getByText('SOME_NEW_STATUS')).toBeTruthy();
  });

  it('the solução badge comes from the normalised field', async () => {
    await abrir();
    expect(screen.getByText('Devolução e reembolso')).toBeTruthy();
  });

  it('amounts are formatted as reais', async () => {
    await abrir();
    expect(screen.getByText(/Reembolso solicitado: R\$\s89,90/)).toBeTruthy();
    expect(screen.getByText(/Valor antes do desconto: R\$\s99,90/)).toBeTruthy();
  });

  it('omits an absent amount rather than printing R$ 0,00', async () => {
    comEstado({ valorReembolso: null, valorAntesDesconto: null });
    await abrir();
    expect(screen.queryByText(/Reembolso solicitado/)).toBeNull();
    expect(screen.queryByText(/Valor antes do desconto/)).toBeNull();
  });

  it('the reason, translated, and the reassessed one when Shopee set it', async () => {
    comEstado({ motivoReavaliado: 'CHANGE_MIND' });
    await abrir();
    expect(screen.getByText('Produto danificado')).toBeTruthy();
    expect(screen.getByText(/Motivo reavaliado pela Shopee/)).toBeTruthy();
    expect(screen.getByText('O comprador desistiu')).toBeTruthy();
  });

  it('no reassessed line when Shopee set none', async () => {
    await abrir();
    expect(screen.queryByText(/Motivo reavaliado/)).toBeNull();
  });

  it('keeps a parseable deadline, labelled, with the auto-refund badge ONLY on flagged rows', async () => {
    comEstado({
      prazos: [
        { tipo: 'resposta-vendedor', prazoMs: 1_790_000_000_000, reembolsoAutomatico: true },
        { tipo: 'evidencias', prazoMs: 1_790_100_000_000, reembolsoAutomatico: false },
      ],
    });
    await abrir();
    expect(screen.getByText('Prazos')).toBeTruthy();
    expect(screen.getByText(/Responder à solicitação até: \d{2}\/\d{2}\/\d{4}/)).toBeTruthy();
    expect(screen.getByText(/Enviar evidências até: \d{2}\/\d{2}\/\d{4}/)).toBeTruthy();
    expect(screen.getAllByText('reembolso automático')).toHaveLength(1);
  });

  it('drops a deadline with nothing honest to show (0, or past the Date range)', async () => {
    // ⚠️ Filter on the FORMATTED value: `prazoMs != null` is always true for a
    // number, and the row would survive with a blank or "Invalid Date" clock.
    comEstado({
      prazos: [
        { tipo: 'evidencias', prazoMs: 0, reembolsoAutomatico: true },
        { tipo: 'proposta', prazoMs: 9e15, reembolsoAutomatico: false },
      ],
    });
    await abrir();
    expect(screen.queryByText('Prazos')).toBeNull();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  it('legends: a non-normal request type and warehouse validation, as labels', async () => {
    comEstado({ tipoRequisicao: 1, tipoValidacao: 'warehouse_validation' });
    await abrir();
    expect(screen.getByText(/Devolução durante o transporte/)).toBeTruthy();
    expect(screen.getByText(/Validação pelo armazém da Shopee/)).toBeTruthy();
  });

  it('no legend for a normal request and a seller validation', async () => {
    await abrir();
    expect(screen.queryByText(/Tipo de devolução/)).toBeNull();
    expect(screen.queryByText(/Validação pelo armazém/)).toBeNull();
  });

  it('the negotiation block: whose turn, the last offer, the counters left', async () => {
    comEstado({ negociacao: NEGOCIACAO });
    await abrir();
    expect(screen.getByText(/Negociação: aguardando sua resposta/)).toBeTruthy();
    expect(screen.getByText(/Última proposta: Apenas reembolso — R\$\s45,50/)).toBeTruthy();
    expect(screen.getByText('Contrapropostas restantes: 2')).toBeTruthy();
  });

  it('evidence and compensation statuses, labelled', async () => {
    comEstado({
      prova: { status: 'PENDING' },
      compensacao: { status: 'COMPENSATION_REQUESTED', valor: 12.3 },
    });
    await abrir();
    expect(screen.getByText('Evidências: pedidas pela Shopee')).toBeTruthy();
    expect(screen.getByText(/Compensação: pedida — R\$\s12,30/)).toBeTruthy();
  });

  it('the Seller Centre lines come from the BACKEND list, labelled — evidence and pickup', async () => {
    comEstado({
      prova: { status: 'PENDING' },
      pendenciasForaDoErp: ['enviar-evidencias', 'organizar-coleta', 'codigo-futuro'],
    });
    await abrir();
    expect(
      screen.getAllByText('A Shopee pediu evidências — envie pelo Seller Centre.'),
    ).toHaveLength(1);
    expect(screen.getByText(/A coleta do produto devolvido é sua/)).toBeTruthy();
    // A code a newer backend adds costs a raw line, never the panel.
    expect(screen.getByText('codigo-futuro')).toBeTruthy();
  });

  it('…and the web recomputes NONE of them (#1369): evidence PENDING with an empty list says nothing', async () => {
    // The near-miss: a panel deriving the line from `prova.status` itself would
    // be the second copy of the backend's rule.
    comEstado({ prova: { status: 'PENDING' }, pendenciasForaDoErp: [] });
    await abrir();
    expect(screen.queryByText(/envie pelo Seller Centre/)).toBeNull();
  });
});

describe('ReclamacaoShopeePanel — which actions are offered', () => {
  it('a button ONLY for a listed action — an unlisted one is ABSENT, not disabled', async () => {
    await abrir();
    expect(botao('Reembolsar sem devolução').disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Aceitar proposta do comprador' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fazer proposta…' })).toBeNull();
    expect(screen.queryByText('Aceitar proposta do comprador')).toBeNull();
  });

  it('every known action, when listed, is a button; an unknown listed code is a BADGE', async () => {
    comEstado({
      acoesDisponiveis: ['confirmar', 'ofertar', 'aceitar-oferta', 'contestar-no-futuro'],
      negociacao: NEGOCIACAO,
    });
    await abrir();
    expect(botao('Reembolsar sem devolução')).toBeTruthy();
    expect(botao('Fazer proposta…')).toBeTruthy();
    expect(botao('Aceitar proposta do comprador')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'contestar-no-futuro' })).toBeNull();
    expect(screen.getByText('contestar-no-futuro')).toBeTruthy();
  });

  it('without write: the sentence with the action labels, and NO button', async () => {
    h.podeExecutar.value = false;
    comEstado({ acoesDisponiveis: ['confirmar', 'ofertar'] });
    await abrir();
    expect(
      screen.getByText(
        /não tem permissão para resolver reclamações.*Reembolsar sem devolução, Fazer proposta\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reembolsar sem devolução' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fazer proposta…' })).toBeNull();
  });

  it('an empty list shows the backend’s own reason', async () => {
    comEstado({ acoesDisponiveis: [], motivoSemAcao: 'A devolução está em disputa na Shopee.' });
    await abrir();
    expect(screen.getByText('A devolução está em disputa na Shopee.')).toBeTruthy();
  });

  it('an empty list with no reason falls back to the generic sentence, never a blank', async () => {
    comEstado({ acoesDisponiveis: [], motivoSemAcao: null });
    await abrir();
    expect(
      screen.getByText('A Shopee não oferece nenhuma ação a esta devolução agora.'),
    ).toBeTruthy();
  });
});

describe('ReclamacaoShopeePanel — confirmar and aceitar-oferta', () => {
  it('confirmar: the dialog states the consequence WITH the amount, and its button differs from the panel’s', async () => {
    await abrir();
    fireEvent.click(botao('Reembolsar sem devolução'));
    const dialogo = await screen.findByRole('dialog');
    expect(
      within(dialogo).getByText(/Reembolsar R\$\s89,90 sem pedir o produto de volta\?/),
    ).toBeTruthy();
    expect(
      within(dialogo).getByText(
        /A Shopee reembolsa R\$\s89,90 ao comprador, que fica com o produto.*Não é possível desfazer pelo ERP\./,
      ),
    ).toBeTruthy();
    // ⚠️ The commit is a click on a DIFFERENT label — never a repeated
    // muscle-memory click on the one just pressed.
    expect(
      within(dialogo).getByRole('button', { name: /^Confirmar reembolso de R\$\s89,90$/ }),
    ).toBeTruthy();
    expect(within(dialogo).queryByRole('button', { name: 'Reembolsar sem devolução' })).toBeNull();
    expect(h.reclamacaoAcao).not.toHaveBeenCalled();
  });

  it('Cancelar sends nothing', async () => {
    await abrir();
    fireEvent.click(botao('Reembolsar sem devolução'));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await pausa(10);
    expect(h.reclamacaoAcao).not.toHaveBeenCalled();
  });

  it('confirming sends exactly ONE body, exactly the echo, refetches, and writes NOTHING locally', async () => {
    const { qc } = await abrir();
    const setQueryData = vi.spyOn(qc, 'setQueryData');
    fireEvent.click(botao('Reembolsar sem devolução'));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar reembolso de/ }));

    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
    expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1);
    expect(h.reclamacaoAcao.mock.calls[0]).toEqual([
      {
        integracaoId: 'int-1',
        pedidoId: 'pedido-1',
        returnSn: SN,
        acao: 'confirmar',
        valorExibidoMinor: 8990,
      },
    ]);
    // ⚠️ The status on screen is the REFETCH's (Shopee may lag the action) —
    // never a state guessed here.
    expect(setQueryData).not.toHaveBeenCalled();
    expect(screen.getByText('solicitada')).toBeTruthy();
    expect(screen.queryByText('aceita')).toBeNull();
  });

  it('the pedido cross-check sends the pedido ON SCREEN, never the estado’s own', async () => {
    // ⚠️ The estado's pedidoId is derived from the return itself, so echoing it
    // would always agree — and the route's `pedido-divergente` check would never fire.
    comEstado({ pedidoId: 'pedido-de-outra-conta' });
    await abrir(painel(SN, 'pedido-1'));
    fireEvent.click(botao('Reembolsar sem devolução'));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar reembolso de/ }));
    await waitFor(() => expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1));
    expect(h.reclamacaoAcao.mock.calls[0]?.[0]).toMatchObject({ pedidoId: 'pedido-1' });
  });

  it('a refund amount Shopee did not send is echoed as null, and the copy says no number', async () => {
    comEstado({ valorReembolso: null });
    await abrir();
    fireEvent.click(botao('Reembolsar sem devolução'));
    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).queryByText(/R\$/)).toBeNull();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Confirmar reembolso' }));
    await waitFor(() => expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1));
    expect(h.reclamacaoAcao.mock.calls[0]?.[0]).toMatchObject({ valorExibidoMinor: null });
  });

  it('aceitar-oferta: names the buyer’s solução and amount, and echoes BOTH', async () => {
    comEstado({ acoesDisponiveis: ['aceitar-oferta'], negociacao: NEGOCIACAO });
    await abrir();
    fireEvent.click(botao('Aceitar proposta do comprador'));
    const dialogo = await screen.findByRole('dialog');
    expect(
      within(dialogo).getByText(
        /O comprador propôs "Apenas reembolso" com reembolso de R\$\s45,50\./,
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(dialogo).getByRole('button', { name: /^Aceitar proposta de R\$\s45,50$/ }),
    );
    await waitFor(() => expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1));
    expect(h.reclamacaoAcao.mock.calls[0]).toEqual([
      {
        integracaoId: 'int-1',
        pedidoId: 'pedido-1',
        returnSn: SN,
        acao: 'aceitar-oferta',
        valorExibidoMinor: 4550,
        solucaoExibida: 'REFUND',
      },
    ]);
  });

  it('success: ONE green toast, and the "not enqueued" answer changes only the sentence', async () => {
    await abrir();
    fireEvent.click(botao('Reembolsar sem devolução'));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar reembolso de/ }));
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(h.notify).toHaveBeenCalledWith({ color: 'green', message: 'Enviado à Shopee.' });

    h.reclamacaoAcao.mockResolvedValue({
      ok: true,
      acao: 'confirmar',
      returnSn: SN,
      atualizacao: 'nao-enfileirada',
    });
    await waitFor(() => expect(botao('Reembolsar sem devolução').disabled).toBe(false));
    fireEvent.click(botao('Reembolsar sem devolução'));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar reembolso de/ }));
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(2));
    expect(h.notify.mock.calls[1]?.[0]).toMatchObject({ color: 'green' });
    expect(String(h.notify.mock.calls[1]?.[0]?.message)).toMatch(/^Enviado à Shopee\. .+/);
  });
});

describe('ReclamacaoShopeePanel — failures of an action', () => {
  async function confirmarCom(erro: unknown) {
    h.reclamacaoAcao.mockRejectedValue(erro);
    await abrir();
    fireEvent.click(botao('Reembolsar sem devolução'));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar reembolso de/ }));
  }

  it('409: the backend’s sentence verbatim, AND the estado refetched', async () => {
    await confirmarCom(
      new ShopeeClientHttpError(
        'O valor da devolução mudou na Shopee. Confira e tente de novo.',
        409,
        'SHOPEE_RECLAMACAO_ACAO_RECUSADA',
      ),
    );
    await screen.findByText('O valor da devolução mudou na Shopee. Confira e tente de novo.');
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('400: verbatim, and NOT refetched (nothing changed on Shopee)', async () => {
    await confirmarCom(
      new ShopeeClientHttpError('Corpo inválido.', 400, 'SHOPEE_RECLAMACAO_BODY_INVALIDO'),
    );
    await screen.findByText('Corpo inválido.');
    await pausa(20);
    expect(h.reclamacaoEstado).toHaveBeenCalledTimes(1);
  });

  it('network error: "pode ter sido feita", refetched, and NEVER sent a second time', async () => {
    await confirmarCom(new ShopeeClientNetworkError('Failed to fetch'));
    await screen.findByText(FRASE_DESFECHO_INCERTO);
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
    await pausa(30);
    expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1);
  });

  it('a 2xx the browser cannot read is an UNKNOWN outcome too, not a refusal', async () => {
    await confirmarCom(new ShopeeClientRespostaInvalidaError('formato desconhecido', 200, ['ok']));
    await screen.findByText(FRASE_DESFECHO_INCERTO);
    expect(screen.queryByText('formato desconhecido')).toBeNull();
  });

  it('a FAILED TOKEN REFRESH renders its message instead of going silent', async () => {
    // ⚠️ `getAuthToken()` is awaited OUTSIDE the client's try, so a
    // FirebaseError is none of the client's classes; rethrown from a `void`-ed
    // handler it would be an unhandled rejection after an irreversible confirm.
    await confirmarCom(
      new FirebaseError('auth/network-request-failed', 'Falha de rede ao renovar o token.'),
    );
    await screen.findByText(/Falha de rede ao renovar o token/);
  });

  it('a 503 SHOPEE_NETWORK_ERROR after the click is "pode ter sido feita" — never read as a refusal', async () => {
    // The route sent the write and lost the socket: Shopee may have refunded.
    await confirmarCom(
      new ShopeeClientHttpError(
        'Falha de rede ao contatar a Shopee em /api/v2/returns/confirm.',
        503,
        'SHOPEE_NETWORK_ERROR',
      ),
    );
    await screen.findByText(FRASE_DESFECHO_INCERTO);
    expect(screen.queryByText(/Falha de rede ao contatar a Shopee/)).toBeNull();
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
    await pausa(30);
    expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1);
  });

  it('a bare 500 after the click never says "Tente novamente"', async () => {
    await confirmarCom(new ShopeeClientHttpError(shopeeHttpFallbackMessage(500), 500, null));
    await screen.findByText(FRASE_DESFECHO_INCERTO);
    expect(screen.queryByText(/Tente novamente/)).toBeNull();
  });

  it('502 SHOPEE_RECLAMACAO_FALHA_SHOPEE is Shopee REFUSING: verbatim, definite, refetched', async () => {
    await confirmarCom(
      new ShopeeClientHttpError(
        'A Shopee recusou a ação (código error_xyz).',
        502,
        'SHOPEE_RECLAMACAO_FALHA_SHOPEE',
      ),
    );
    await screen.findByText('A Shopee recusou a ação (código error_xyz).');
    expect(screen.queryByText(FRASE_DESFECHO_INCERTO)).toBeNull();
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
  });

  it('buttons are disabled while an action runs', async () => {
    const pendente = adiado<unknown>();
    h.reclamacaoAcao.mockReturnValue(pendente.promessa);
    comEstado({ acoesDisponiveis: ['confirmar', 'ofertar'] });
    await abrir();
    fireEvent.click(botao('Reembolsar sem devolução'));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar reembolso de/ }));
    await waitFor(() => expect(botao('Fazer proposta…').disabled).toBe(true));
    pendente.resolver({ ok: true, acao: 'confirmar', returnSn: SN });
    await waitFor(() => expect(botao('Fazer proposta…').disabled).toBe(false));
  });

  it('buttons are disabled while the estado is being fetched', async () => {
    await abrir();
    const pendente = adiado<ShopeeReclamacaoEstado>();
    h.reclamacaoEstado.mockReturnValue(pendente.promessa);
    fireEvent.click(botao('Atualizar'));
    await waitFor(() => expect(botao('Reembolsar sem devolução').disabled).toBe(true));
    pendente.resolver(ESTADO);
    await waitFor(() => expect(botao('Reembolsar sem devolução').disabled).toBe(false));
  });

  it('after a FAILED refetch the stale actions stay disabled beside the read error — a good read re-arms them', async () => {
    // TanStack keeps the last data on a refetch error; the list from BEFORE the
    // failure must not stay clickable (R4 F2).
    comEstado({ acoesDisponiveis: ['confirmar', 'ofertar'] });
    await abrir();
    h.reclamacaoEstado.mockRejectedValueOnce(new ShopeeClientNetworkError('Failed to fetch'));
    fireEvent.click(botao('Atualizar'));
    await screen.findByText(/Não foi possível falar com a integração da Shopee/);
    // ⚠️ The fetch is OVER (Atualizar is no longer loading), so `isFetching`
    // cannot be what disables the buttons below.
    await waitFor(() => expect(botao('Atualizar').disabled).toBe(false));
    expect(botao('Reembolsar sem devolução').disabled).toBe(true);
    expect(botao('Fazer proposta…').disabled).toBe(true);
    fireEvent.click(botao('Reembolsar sem devolução'));
    await pausa(10);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.reclamacaoAcao).not.toHaveBeenCalled();

    // The near-miss: the lock is the ERROR, not "a refetch happened".
    fireEvent.click(botao('Atualizar'));
    await waitFor(() => expect(botao('Reembolsar sem devolução').disabled).toBe(false));
    expect(botao('Fazer proposta…').disabled).toBe(false);
    expect(screen.queryByText(/Não foi possível falar com a integração da Shopee/)).toBeNull();
  });
});

describe('falhaDaAcaoShopee — the error table, one row per class', () => {
  const INCERTO = { mensagem: FRASE_DESFECHO_INCERTO, invalidar: true, incerto: true };

  it('below 500: verbatim and definite — 409 refetches, any other 4xx does not', () => {
    expect(falhaDaAcaoShopee(new ShopeeClientHttpError('recusada', 409, 'C'))).toEqual({
      mensagem: 'recusada',
      invalidar: true,
      incerto: false,
    });
    expect(falhaDaAcaoShopee(new ShopeeClientHttpError('proibido', 403, null))).toEqual({
      mensagem: 'proibido',
      invalidar: false,
      incerto: false,
    });
    // The boundary's near side: the last status that is still an answer.
    expect(falhaDaAcaoShopee(new ShopeeClientHttpError('quase', 499, null))).toEqual({
      mensagem: 'quase',
      invalidar: false,
      incerto: false,
    });
  });

  it.each([
    // The socket died AFTER the request left (`call.ts`'s fetch rejection).
    ['503 SHOPEE_NETWORK_ERROR', 503, 'SHOPEE_NETWORK_ERROR'],
    // Shopee answered 2xx with a body the backend cannot read.
    ['502 SHOPEE_BAD_RESPONSE', 502, 'SHOPEE_BAD_RESPONSE'],
    // A Shopee error of a kind the route does not classify (transient, rate limit).
    ['502 SHOPEE_HTTP_ERROR', 502, 'SHOPEE_HTTP_ERROR'],
    // No envelope at all — a rethrown bug, a mid-body drop, a gateway.
    ['a bare 500', 500, null],
    ['a gateway 504', 504, null],
    // A code the route never sends on a 5xx is not a known outcome either.
    ['502 with an unknown code', 502, 'C'],
  ])('%s is an UNKNOWN outcome — the write may have reached Shopee (R4 F1)', (_, status, code) => {
    expect(falhaDaAcaoShopee(new ShopeeClientHttpError('falhou', status, code))).toEqual(INCERTO);
  });

  it('a bare 500 never surfaces the fallback’s "Tente novamente" on an action', () => {
    const falha = falhaDaAcaoShopee(
      new ShopeeClientHttpError(shopeeHttpFallbackMessage(500), 500, null),
    );
    expect(falha).toEqual(INCERTO);
    expect(falha?.mensagem).not.toMatch(/Tente novamente/);
  });

  it.each([
    // Shopee ANSWERED the write with an error envelope: a refusal.
    [502, 'SHOPEE_RECLAMACAO_FALHA_SHOPEE', 'A Shopee recusou a ação (código error_xyz).'],
    // The token lease was held: given up before the write's request was built.
    [503, 'SHOPEE_REFRESH_EM_ANDAMENTO', 'Renovação do token em andamento.'],
  ])(
    '…EXCEPT %i %s, whose outcome is known: verbatim, definite, refetched',
    (status, code, msg) => {
      expect(falhaDaAcaoShopee(new ShopeeClientHttpError(msg, status, code))).toEqual({
        mensagem: msg,
        invalidar: true,
        incerto: false,
      });
    },
  );

  it.each([
    ['lower case', 'shopee_reclamacao_falha_shopee'],
    ['a trailing space', 'SHOPEE_RECLAMACAO_FALHA_SHOPEE '],
    ['a prefix of the code', 'SHOPEE_REFRESH'],
    ['the 409 refusal’s code', 'SHOPEE_RECLAMACAO_RECUSADA_PELA_SHOPEE'],
  ])('the exception is EXACT — a 5xx carrying %s stays unknown', (_, code) => {
    expect(falhaDaAcaoShopee(new ShopeeClientHttpError('falhou', 502, code))).toEqual(INCERTO);
  });

  it('a transport failure and an unreadable 2xx are UNKNOWN outcomes', () => {
    const incerto = { mensagem: FRASE_DESFECHO_INCERTO, invalidar: true, incerto: true };
    expect(falhaDaAcaoShopee(new ShopeeClientNetworkError('x'))).toEqual(incerto);
    // ⚠️ A SUBCLASS of the HTTP error — matched first, or its 2xx would read as
    // a definite refusal.
    expect(falhaDaAcaoShopee(new ShopeeClientRespostaInvalidaError('x', 200, []))).toEqual(incerto);
  });

  it('a FirebaseError keeps its message; nothing else is narrowed (root rule 6 — the caller rethrows)', () => {
    expect(falhaDaAcaoShopee(new FirebaseError('auth/x', 'sessão expirada'))).toEqual({
      mensagem: 'sessão expirada',
      invalidar: false,
      incerto: false,
    });
    expect(falhaDaAcaoShopee(new TypeError('bug'))).toBeNull();
    expect(falhaDaAcaoShopee(new Error('bug'))).toBeNull();
    expect(falhaDaAcaoShopee('texto')).toBeNull();
  });
});

describe('ReclamacaoShopeePanel — the offer flow', () => {
  async function abrirOferta() {
    comEstado({ acoesDisponiveis: ['ofertar'] });
    await abrir();
    fireEvent.click(botao('Fazer proposta…'));
    return screen.findByTestId('oferta-modal');
  }

  it('opens the modal with the estado’s solutions', async () => {
    const modal = await abrirOferta();
    expect(within(modal).getByText('solucoes:REFUND')).toBeTruthy();
    expect(within(modal).getByText('carregando:false')).toBeTruthy();
    expect(within(modal).getByText('enviando:false')).toBeTruthy();
  });

  it('sends the chosen solução and the CENTAVOS the modal assembled', async () => {
    const modal = await abrirOferta();
    fireEvent.click(within(modal).getByRole('button', { name: 'stub enviar ajustável' }));
    await waitFor(() => expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1));
    expect(h.reclamacaoAcao.mock.calls[0]).toEqual([
      {
        integracaoId: 'int-1',
        pedidoId: 'pedido-1',
        returnSn: SN,
        acao: 'ofertar',
        solucao: 'REFUND',
        valorReembolsoMinor: 1234,
      },
    ]);
    // Success closes it and says so.
    await waitFor(() => expect(screen.queryByTestId('oferta-modal')).toBeNull());
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('a non-adjustable solução carries NO valorReembolsoMinor key at all', async () => {
    const modal = await abrirOferta();
    fireEvent.click(within(modal).getByRole('button', { name: 'stub enviar fixa' }));
    await waitFor(() => expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1));
    const corpo = h.reclamacaoAcao.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(corpo).toEqual({
      integracaoId: 'int-1',
      pedidoId: 'pedido-1',
      returnSn: SN,
      acao: 'ofertar',
      solucao: 'RETURN_REFUND',
    });
    expect('valorReembolsoMinor' in corpo).toBe(false);
  });

  it('a refusal keeps the modal OPEN with the verbatim sentence, and refreshes the bounds', async () => {
    h.reclamacaoAcao.mockRejectedValue(
      new ShopeeClientHttpError('Fora da faixa que a Shopee permite.', 409, 'C'),
    );
    const modal = await abrirOferta();
    fireEvent.click(within(modal).getByRole('button', { name: 'stub enviar ajustável' }));
    await screen.findByText('erro-do-modal:Fora da faixa que a Shopee permite.');
    expect(screen.getByTestId('oferta-modal')).toBeTruthy();
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
  });

  it('a failed token refresh keeps the modal open with its message (nothing was sent)', async () => {
    h.reclamacaoAcao.mockRejectedValue(
      new FirebaseError('auth/user-token-expired', 'Sessão expirada.'),
    );
    const modal = await abrirOferta();
    fireEvent.click(within(modal).getByRole('button', { name: 'stub enviar ajustável' }));
    await screen.findByText('erro-do-modal:Sessão expirada.');
    expect(screen.getByTestId('oferta-modal')).toBeTruthy();
  });

  it('an UNKNOWN outcome closes the modal and warns on the panel — no armed second send', async () => {
    h.reclamacaoAcao.mockRejectedValue(new ShopeeClientNetworkError('Failed to fetch'));
    const modal = await abrirOferta();
    fireEvent.click(within(modal).getByRole('button', { name: 'stub enviar ajustável' }));
    await screen.findByText(FRASE_DESFECHO_INCERTO);
    expect(screen.queryByTestId('oferta-modal')).toBeNull();
    await pausa(20);
    expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1);
  });

  it('a 503 after the offer left is an UNKNOWN outcome too: "Enviar proposta" is gone, not re-armed', async () => {
    // R4 P4: the modal used to stay open on this 503 with its commit armed, and
    // a second click sent a second proposal.
    h.reclamacaoAcao.mockRejectedValue(
      new ShopeeClientHttpError(
        'Falha de rede ao contatar a Shopee em /api/v2/returns/offer.',
        503,
        'SHOPEE_NETWORK_ERROR',
      ),
    );
    const modal = await abrirOferta();
    fireEvent.click(within(modal).getByRole('button', { name: 'stub enviar ajustável' }));
    await screen.findByText(FRASE_DESFECHO_INCERTO);
    expect(screen.queryByTestId('oferta-modal')).toBeNull();
    expect(screen.queryByText(/erro-do-modal/)).toBeNull();
    await waitFor(() => expect(h.reclamacaoEstado).toHaveBeenCalledTimes(2));
    await pausa(20);
    expect(h.reclamacaoAcao).toHaveBeenCalledTimes(1);
  });

  it.each([
    [502, 'SHOPEE_RECLAMACAO_FALHA_SHOPEE', 'A Shopee recusou a ação (código error_xyz).'],
    [503, 'SHOPEE_REFRESH_EM_ANDAMENTO', 'Renovação do token em andamento.'],
  ])(
    '%i %s on an offer is a KNOWN outcome: the modal stays OPEN with the sentence',
    async (status, code, msg) => {
      h.reclamacaoAcao.mockRejectedValue(new ShopeeClientHttpError(msg, status, code));
      const modal = await abrirOferta();
      fireEvent.click(within(modal).getByRole('button', { name: 'stub enviar ajustável' }));
      await screen.findByText(`erro-do-modal:${msg}`);
      expect(screen.getByTestId('oferta-modal')).toBeTruthy();
      expect(screen.queryByText(FRASE_DESFECHO_INCERTO)).toBeNull();
    },
  );

  it('the modal is UNMOUNTED when closed, so every opening starts fresh', async () => {
    const modal = await abrirOferta();
    expect(h.modal.montagens).toBe(1);
    fireEvent.click(within(modal).getByRole('button', { name: 'stub fechar' }));
    expect(screen.queryByTestId('oferta-modal')).toBeNull();
    fireEvent.click(botao('Fazer proposta…'));
    await screen.findByTestId('oferta-modal');
    expect(h.modal.montagens).toBe(2);
  });

  it('the modal sees the estado refetching (its commit is blocked meanwhile)', async () => {
    const modal = await abrirOferta();
    const pendente = adiado<ShopeeReclamacaoEstado>();
    h.reclamacaoEstado.mockReturnValue(pendente.promessa);
    fireEvent.click(botao('Atualizar'));
    await waitFor(() => expect(within(modal).getByText('carregando:true')).toBeTruthy());
    pendente.resolver({ ...ESTADO, acoesDisponiveis: ['ofertar'] });
    await waitFor(() => expect(within(modal).getByText('carregando:false')).toBeTruthy());
  });
});
