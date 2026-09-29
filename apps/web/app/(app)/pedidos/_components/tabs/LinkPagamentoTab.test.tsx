import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PERM } from '@delfrance/auth';
import { nowMillis } from '@delfrance/core/datetime';
import { centavosDeReais, formatReais } from '@delfrance/core/money';
import {
  CODIGO_ERRO_LINK,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  LIMITES_LINK_PAGAMENTO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
  PERM_LINK_PAGAMENTO,
  SITUACAO_LINK_PAGAMENTO_LABELS,
  STATUS_LINK_PAGAMENTO,
  STATUS_PAGAMENTO,
  TIPO_INTEGRACAO_PGTO,
  criarLinksPagamentoBodySchema,
  type CriarLinksPagamentoBody,
  type CriarLinksPagamentoResposta,
} from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  MercadoPagoClientHttpError,
  MercadoPagoClientNetworkError,
  type MercadoPagoClient,
} from '@/lib/mercado-pago/client';

import { LinkPagamentoTab, type LinkPagamentoTabProps } from './LinkPagamentoTab';

/*
 * The tab reaches Firestore through three `useSnapshot` listeners (links,
 * pagamentos, metodo_pgto accounts). `buildQuery` is faked to return a query
 * TAGGED with its collection, so the `useSnapshot` fake can serve each listener
 * its own rows — and record which listeners were built at all (a listener
 * without its read bit must never exist). Everything else is real: the pure
 * summary / copy helpers, the form model and `descreverFalhaLink`, so these
 * tests exercise the same rules the route shares.
 */
type Colecao = 'links' | 'pagamentos' | 'contas';
interface Linha {
  id: string;
  path: string;
  data: unknown;
}
interface EstadoSnapshot {
  data: Linha[] | undefined;
  loading: boolean;
  error: Error | undefined;
  /** `useSnapshot`'s metadata: `true` for an emission served from the local cache. */
  fromCache?: boolean;
}

const h = vi.hoisted(() => ({
  concedido: 0n,
  snap: {} as Record<string, EstadoSnapshot>,
  consultas: [] as string[],
  client: null as unknown,
  notify: vi.fn(),
  erro: vi.fn(),
  copiavel: vi.fn(),
}));

vi.mock('@delfrance/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data')>()),
  buildQuery: (ref: { __colecao: string }) => ({ __colecao: ref.__colecao }),
  orderByField: () => ({ __c: 'orderBy' }),
  defaultQueryConstraints: () => [],
}));
vi.mock('@delfrance/data/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data/hooks')>()),
  useSnapshot: (q: { __colecao: string } | null) => {
    if (q === null) return { data: undefined, loading: false, error: undefined };
    h.consultas.push(q.__colecao);
    return h.snap[q.__colecao] ?? { data: undefined, loading: true, error: undefined };
  },
}));
vi.mock('@/lib/data/linkPgtoMercadoPagoCollection', () => ({
  linkPgtoMercadoPagoCollection: { ref: () => ({ __colecao: 'links' }) },
}));
vi.mock('@/lib/data/pagamentoCollection', () => ({
  pagamentoCollection: { ref: () => ({ __colecao: 'pagamentos' }) },
  metodoPagamentoCollection: { ref: () => ({ __colecao: 'contas' }) },
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth', () => ({
  usePermission: (mask: bigint) => ({ allowed: (h.concedido & mask) === mask, loading: false }),
}));
// Partial: the tab narrows on the real error CLASSES, so only the hook is faked.
vi.mock('@/lib/mercado-pago/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mercado-pago/client')>()),
  useMercadoPagoClient: () => h.client,
}));
vi.mock('@mantine/notifications', () => ({
  notifications: { show: h.notify, hide: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: h.erro,
  showCopyableNotification: h.copiavel,
}));
// The calendar has its own library tests; a plain input keeps the date controllable.
vi.mock('@mantine/dates', () => ({
  DatePickerInput: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string | null;
    onChange: (valor: string | null) => void;
  }) => (
    <input
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
    />
  ),
}));

const AGORA = nowMillis();
const DIA = 86_400_000;
const CONTA_REF = 'documents/metodo_pgto/conta-a';

const TODAS_AS_PERMISSOES =
  PERM_LINK_PAGAMENTO.ler |
  PERM_LINK_PAGAMENTO.gerenciar |
  PERM_LINK_PAGAMENTO.listarContas |
  PERM.metodoPagamento.write;

function linha(id: string, data: unknown): Linha {
  return { id, path: `pedidos/pedido123/x/${id}`, data };
}

function conta(id: string, patch: Record<string, unknown> = {}): Linha {
  return linha(id, {
    tipo: TIPO_INTEGRACAO_PGTO.mercadoPago,
    nome: `Conta ${id}`,
    hasLinkPagamento: true,
    user_id: 111,
    dataCadastro: null,
    ultimaModificacao: null,
    ...patch,
  });
}

function urlDoLink(id: string): string {
  return `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${id}`;
}

/** A traceable, open, per-person link of R$ 50,00 on `conta-a`, due in two days. */
function link(id: string, patch: Record<string, unknown> = {}): Linha {
  return linha(id, {
    contaMercadoPagoOuterRef: CONTA_REF,
    valorCobrado: 50,
    link: urlDoLink(id),
    id: `pref-${id}`,
    dataCriacao: AGORA - DIA,
    dataExpiracao: AGORA + 2 * DIA,
    modo: MODO_LINK_PAGAMENTO.individual,
    nomePagador: null,
    quantidadeMaxima: 1,
    grupoId: null,
    ordem: null,
    status: STATUS_LINK_PAGAMENTO.aberto,
    ...patch,
  });
}

/** An approved R$ 50,00 pagamento (dates in µs, like the collection). */
function pagamento(id: string, patch: Record<string, unknown> = {}): Linha {
  return linha(id, {
    valor: 50,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    forma_de_pagamento: null,
    dataAprovacao: AGORA * 1000,
    linkPagamentoId: null,
    primeiroNomePagador: null,
    ...patch,
  });
}

/** `n` cancelled links — they hold no money but count against the per-pedido cap. */
function linksCancelados(n: number): Linha[] {
  return Array.from({ length: n }, (_, k) =>
    link(`L-cancelado-${k}`, { status: STATUS_LINK_PAGAMENTO.cancelado }),
  );
}

/** Serve `data` to one listener — from the SERVER unless `fromCache` says otherwise. */
function servir(colecao: Colecao, data: Linha[], fromCache = false): void {
  h.snap[colecao] = { data, loading: false, error: undefined, fromCache };
}

function respostaCriar(corpo: CriarLinksPagamentoBody): CriarLinksPagamentoResposta {
  return {
    links: corpo.links.map((l) => ({
      linkId: l.linkId,
      preferenceId: `pref-${l.linkId}`,
      link: urlDoLink(l.linkId),
      valorCobrado: l.valor,
      nomePagador: l.nomePagador,
      dataExpiracao: AGORA + DIA,
      modo: corpo.modo,
      quantidadeMaxima: corpo.quantidadeMaxima ?? null,
    })),
    estado: null,
    reaproveitado: false,
  };
}

function clienteFalso() {
  return {
    oauthStart: vi.fn(),
    conta: vi.fn(),
    criarLinks: vi.fn(async (corpo: CriarLinksPagamentoBody) => respostaCriar(corpo)),
    cancelarLink: vi.fn(async (corpo: { pedidoId: string; linkId: string }) => ({
      linkId: corpo.linkId,
      status: STATUS_LINK_PAGAMENTO.cancelado,
    })),
    sincronizarLinks: vi.fn(async () => ({
      encontrados: 2,
      reconciliados: 1,
      ignorados: 1,
      falhas: [] as Array<{ paymentId: string; motivo: string }>,
      transicoes: [],
      truncado: false,
    })),
  } satisfies MercadoPagoClient;
}

let cliente: ReturnType<typeof clienteFalso>;

const PROPS: LinkPagamentoTabProps = {
  pedidoId: 'pedido123',
  pedido: {
    numero: '1234',
    estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    ehSaida: true,
    valorCobrado: 100,
    itensDevolvidos: null,
    clientePedidoOuterRef: null,
  },
  estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  formDirty: false,
  fromCache: false,
  nfeEstado: null,
  nfeCarregando: false,
};

function arvore(patch: Partial<LinkPagamentoTabProps> = {}) {
  return (
    <MantineTestProvider>
      <LinkPagamentoTab {...PROPS} {...patch} />
    </MantineTestProvider>
  );
}

function renderTab(patch: Partial<LinkPagamentoTabProps> = {}) {
  return render(arvore(patch));
}

function botao(nome: string): HTMLButtonElement {
  return screen.getByRole('button', { name: nome }) as HTMLButtonElement;
}

function valorDoCampo(rotulo: string): string {
  return (screen.getByLabelText(rotulo) as HTMLInputElement).value;
}

/** Text with the NO-BREAK SPACE `formatReais` writes after `R$` folded to a plain space. */
function semNbsp(texto: string): string {
  return texto.replace(/ /g, ' ');
}

/**
 * The list row with a CELL that reads exactly `texto` (a name, or a formatted
 * value). Matched on each cell's own text, NBSP folded on BOTH sides, rather than
 * through `*ByText`: Testing Library's normaliser folds the NO-BREAK SPACE of the
 * DOM text but never touches the matcher string, so `formatReais(77)` could not
 * match anything there.
 */
function linhaDaTabela(texto: string): HTMLElement {
  const alvo = semNbsp(texto).trim();
  const celulaIgual = (celula: Element) => semNbsp(celula.textContent ?? '').trim() === alvo;
  const encontrada = screen
    .getAllByTestId('link-pagamento-linha')
    .find((row) => Array.from(row.querySelectorAll('td')).some(celulaIgual));
  if (!encontrada) throw new Error(`Nenhuma linha com "${texto}".`);
  return encontrada;
}

/**
 * Give jsdom a working clipboard for one test (jsdom ships none, so Mantine's
 * `useClipboard` would take its error branch) — the `UsuariosTesteDevPanel` recipe.
 */
function comClipboard() {
  const writeText = vi.fn((_texto: string) => Promise.resolve());
  vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
  return writeText;
}

/** Wait until the create button has left its loading state. */
async function esperarFimDoEnvio(nome: string): Promise<void> {
  await waitFor(() => {
    expect(botao(nome).getAttribute('data-loading')).toBeNull();
  });
}

beforeEach(() => {
  h.concedido = TODAS_AS_PERMISSOES;
  h.snap = {};
  h.consultas = [];
  h.notify.mockReset();
  h.erro.mockReset();
  h.copiavel.mockReset();
  cliente = clienteFalso();
  h.client = cliente;
  servir('links', []);
  servir('pagamentos', []);
  servir('contas', [conta('conta-a', { nome: 'Loja A' })]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LinkPagamentoTab — create gating', () => {
  it('blocks creation while the pedido has unsaved changes, and allows it once saved', () => {
    const { unmount } = renderTab({ formDirty: true });
    const aviso = 'Há alterações não salvas no pedido. Salve antes de gerar links.';
    expect(screen.getByText(aviso)).toBeTruthy();
    expect(botao('Gerar link')).toHaveProperty('disabled', true);
    unmount();

    // Near-miss: the same pedido, saved.
    renderTab({ formDirty: false });
    expect(screen.queryByText(/alterações não salvas/)).toBeNull();
    expect(botao('Gerar link')).toHaveProperty('disabled', false);
  });

  it('waits for the server copy of the pedido and for the NF-e listener', () => {
    const { unmount } = renderTab({ fromCache: true });
    expect(screen.getByText('Carregando a versão mais recente do pedido…')).toBeTruthy();
    expect(botao('Gerar link')).toHaveProperty('disabled', true);
    unmount();

    renderTab({ nfeCarregando: true });
    expect(screen.getByText('Verificando a NF-e do pedido…')).toBeTruthy();
    expect(botao('Gerar link')).toHaveProperty('disabled', true);
  });

  it('waits for the SERVER copy of the links and the pagamentos, not a cached one', () => {
    for (const colecao of ['links', 'pagamentos'] as const) {
      // A cached emission may predate a link or a payment the server already has.
      servir(colecao, [], true);
      const { rerender, unmount } = renderTab();
      expect(screen.getByText('Carregando links e pagamentos…'), colecao).toBeTruthy();
      expect(botao('Gerar link')).toHaveProperty('disabled', true);

      // Near-miss: the server's emission of the very same rows enables it.
      servir(colecao, [], false);
      rerender(arvore());
      expect(screen.queryByText('Carregando links e pagamentos…'), colecao).toBeNull();
      expect(botao('Gerar link')).toHaveProperty('disabled', false);
      unmount();
    }
  });

  it('blocks creation once the pedido holds the maximum number of links', () => {
    const max = LIMITES_LINK_PAGAMENTO.linksPorPedidoMax;
    servir('links', linksCancelados(max));
    const { unmount } = renderTab();
    expect(screen.getByText(MOTIVO_RECUSA_LINK_LABELS.limiteLinks)).toBeTruthy();
    expect(botao('Gerar link')).toHaveProperty('disabled', true);
    unmount();

    // Near-miss: one link fewer leaves room for exactly one more.
    servir('links', linksCancelados(max - 1));
    renderTab();
    expect(screen.queryByText(MOTIVO_RECUSA_LINK_LABELS.limiteLinks)).toBeNull();
    expect(botao('Gerar link')).toHaveProperty('disabled', false);
  });

  it('refuses a vaquinha that would take the pedido past the link cap', async () => {
    servir('links', linksCancelados(LIMITES_LINK_PAGAMENTO.linksPorPedidoMax - 1));
    renderTab();
    fireEvent.click(screen.getByRole('radio', { name: 'Vaquinha por pessoa' }));
    fireEvent.change(screen.getByLabelText('Nome da pessoa 1'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Nome da pessoa 2'), { target: { value: 'Bia' } });
    fireEvent.click(botao('Dividir igualmente'));
    fireEvent.click(botao('Gerar links'));

    // 49 stored + 2 = 51: one past the cap (the single link above fitted).
    expect(await screen.findByText(/O pedido ficaria com 51 links/)).toBeTruthy();
    expect(cliente.criarLinks).not.toHaveBeenCalled();
  });

  it('blocks creation under an NF-e lock but still lets the operator copy a link', async () => {
    const writeText = comClipboard();
    servir('links', [link('L-maria', { nomePagador: 'Maria' })]);
    renderTab({ nfeEstado: ESTADO_NFE.cancelada });

    expect(screen.getByText(/a NF-e deste pedido está "Cancelada"/)).toBeTruthy();
    expect(botao('Gerar link')).toHaveProperty('disabled', true);

    const linhaMaria = linhaDaTabela('Maria');
    fireEvent.click(within(linhaMaria).getByRole('button', { name: 'Copiar link' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(urlDoLink('L-maria'));
    });
  });

  it('names the estado when it does not allow links', () => {
    renderTab({ estado: ESTADO_PEDIDO.pago });
    expect(screen.getByText(/Estado atual: "Pago"/)).toBeTruthy();
    expect(botao('Gerar link')).toHaveProperty('disabled', true);
  });

  it('blocks creation when open links already cover what is left to pay', () => {
    servir('links', [link('L-ana', { nomePagador: 'Ana', valorCobrado: 100 })]);
    renderTab();
    expect(screen.getByText(/já está coberto por links em aberto/)).toBeTruthy();
    expect(botao('Gerar link')).toHaveProperty('disabled', true);
  });

  it('warns before the first link moves an iniciado pedido, and only then', () => {
    const { unmount } = renderTab({ estado: ESTADO_PEDIDO.iniciado });
    expect(screen.getByText('O pedido será travado')).toBeTruthy();
    expect(screen.getByText(/o estoque do pedido é reservado/)).toBeTruthy();
    unmount();

    renderTab({ estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento });
    expect(screen.queryByText('O pedido será travado')).toBeNull();
  });

  it('offers the shared link only as a disabled option', () => {
    renderTab();
    const compartilhado = screen.getByRole('radio', { name: 'Link compartilhado' });
    expect(compartilhado).toHaveProperty('disabled', true);
    // Near-miss: the other modes stay selectable.
    const vaquinha = screen.getByRole('radio', { name: 'Vaquinha por pessoa' });
    expect(vaquinha).toHaveProperty('disabled', false);
  });
});

describe('LinkPagamentoTab — permissions', () => {
  it('without the manage bit lists the links but offers no create, cancel or sync', () => {
    h.concedido = PERM_LINK_PAGAMENTO.ler | PERM_LINK_PAGAMENTO.listarContas;
    servir('links', [link('L-joao', { nomePagador: 'João' })]);
    renderTab();

    expect(screen.getAllByTestId('link-pagamento-linha')).toHaveLength(1);
    expect(screen.getByText(/Requer permissão de escrita em pedidos e pagamentos/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Gerar link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancelar link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sincronizar com Mercado Pago' })).toBeNull();
    // Copying needs no write access.
    expect(botao('Copiar todos os links')).toHaveProperty('disabled', false);
  });

  it('without the read bit builds no listener and says why', () => {
    h.concedido = PERM_LINK_PAGAMENTO.gerenciar | PERM_LINK_PAGAMENTO.listarContas;
    renderTab();

    expect(screen.getByText('Requer permissão de leitura em pagamentos.')).toBeTruthy();
    expect(h.consultas).not.toContain('links');
    expect(h.consultas).not.toContain('pagamentos');
  });

  it('without the account-read bit never lists metodo_pgto', () => {
    h.concedido = PERM_LINK_PAGAMENTO.ler | PERM_LINK_PAGAMENTO.gerenciar;
    renderTab();

    expect(screen.getByText(/Requer permissão de leitura em meios de pagamento/)).toBeTruthy();
    expect(h.consultas).not.toContain('contas');
    expect(h.consultas).toContain('links');
  });
});

describe('LinkPagamentoTab — accounts', () => {
  it('offers only link-enabled, connected accounts, and auto-picks a lone one', async () => {
    servir('contas', [
      conta('conta-a', { nome: 'Loja A' }),
      conta('conta-b', { nome: 'Sem link', hasLinkPagamento: false }),
      conta('conta-c', { nome: 'Sem usuário', user_id: null }),
      // Near-miss: link-enabled and connected, but NOT a Mercado Pago account.
      conta('conta-e', { nome: 'Outro tipo', tipo: null }),
    ]);
    renderTab();
    // Only ONE account qualifies, so it is picked for the operator.
    const select = screen.getByRole('combobox', { name: 'Conta Mercado Pago' });
    expect((select as HTMLInputElement).value).toBe('Loja A');

    fireEvent.click(select);
    expect(await screen.findByRole('option', { name: 'Loja A' })).toBeTruthy();
    for (const nome of ['Sem link', 'Sem usuário', 'Outro tipo']) {
      expect(screen.queryByRole('option', { name: nome }), nome).toBeNull();
    }
  });

  it('does not auto-pick when two accounts qualify', () => {
    servir('contas', [conta('conta-a', { nome: 'Loja A' }), conta('conta-d', { nome: 'Loja D' })]);
    renderTab();
    const select = screen.getByRole('combobox', { name: 'Conta Mercado Pago' });
    expect((select as HTMLInputElement).value).toBe('');
  });

  it('points to the accounts page when none qualifies', () => {
    servir('contas', [
      conta('conta-b', { nome: 'Sem link', hasLinkPagamento: false }),
      conta('conta-c', { nome: 'Sem usuário', user_id: null }),
    ]);
    renderTab();
    expect(screen.getByText('Nenhuma conta Mercado Pago habilitada para links.')).toBeTruthy();
    const anchor = screen.getByRole('link', { name: 'Configurar contas do Mercado Pago' });
    expect(anchor.getAttribute('href')).toBe('/pagamentos/mercado-pago');
    expect(screen.queryByRole('button', { name: 'Gerar link' })).toBeNull();
  });
});

describe('LinkPagamentoTab — creating links', () => {
  it('splits a vaquinha of three exactly to the cent and sends three distinct ids', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('radio', { name: 'Vaquinha por pessoa' }));
    fireEvent.click(botao('Adicionar pessoa'));
    ['Ana', 'Bia', 'Cid'].forEach((nome, i) => {
      fireEvent.change(screen.getByLabelText(`Nome da pessoa ${i + 1}`), {
        target: { value: nome },
      });
    });
    fireEvent.click(botao('Dividir igualmente'));

    expect(valorDoCampo('Valor da pessoa 1')).toMatch(/33,34$/);
    expect(valorDoCampo('Valor da pessoa 2')).toMatch(/33,33$/);
    expect(valorDoCampo('Valor da pessoa 3')).toMatch(/33,33$/);

    fireEvent.click(botao('Gerar links'));
    await waitFor(() => {
      expect(cliente.criarLinks).toHaveBeenCalledTimes(1);
    });

    const corpo = cliente.criarLinks.mock.calls[0]![0];
    expect(criarLinksPagamentoBodySchema.safeParse(corpo).success).toBe(true);
    expect(corpo).toMatchObject({
      pedidoId: 'pedido123',
      metodoId: 'conta-a',
      modo: MODO_LINK_PAGAMENTO.individual,
      valorCobradoEsperado: 100,
    });
    expect(corpo.links.map((l) => l.nomePagador)).toEqual(['Ana', 'Bia', 'Cid']);
    const soma = corpo.links.reduce((total, l) => total + centavosDeReais(l.valor), 0);
    expect(soma).toBe(10_000);
    const ids = corpo.links.map((l) => l.linkId);
    expect(new Set(ids).size).toBe(3);
    ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9]{20}$/));

    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'green', message: '3 link(s) gerado(s).' }),
      );
    });
  });

  it('refuses a draft above what new links may charge without calling the route', async () => {
    const { rerender } = renderTab();
    fireEvent.click(screen.getByRole('radio', { name: 'Vaquinha por pessoa' }));
    fireEvent.change(screen.getByLabelText('Nome da pessoa 1'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Nome da pessoa 2'), { target: { value: 'Bia' } });
    fireEvent.click(botao('Dividir igualmente'));

    // The saved total drops under the draft (another operator edited the pedido):
    // the R$ 100,00 split no longer fits in R$ 90,00.
    rerender(arvore({ pedido: { ...PROPS.pedido, valorCobrado: 90 } }));
    fireEvent.click(botao('Gerar links'));

    expect(await screen.findByText(/Os links somam mais do que o restante/)).toBeTruthy();
    expect(cliente.criarLinks).not.toHaveBeenCalled();
  });

  it('replays the SAME ids after a network failure, and mints new ones after an edit', async () => {
    cliente.criarLinks.mockRejectedValueOnce(new MercadoPagoClientNetworkError('offline'));
    cliente.criarLinks.mockRejectedValueOnce(new MercadoPagoClientNetworkError('offline'));
    renderTab();
    fireEvent.click(botao('Preencher com o valor disponível'));

    fireEvent.click(botao('Gerar link'));
    await waitFor(() => {
      expect(h.erro).toHaveBeenCalledTimes(1);
    });
    await esperarFimDoEnvio('Gerar link');

    fireEvent.click(botao('Gerar link'));
    await waitFor(() => {
      expect(cliente.criarLinks).toHaveBeenCalledTimes(2);
    });
    await esperarFimDoEnvio('Gerar link');
    const primeiro = cliente.criarLinks.mock.calls[0]![0].links[0]!.linkId;
    const segundo = cliente.criarLinks.mock.calls[1]![0].links[0]!.linkId;
    expect(segundo).toBe(primeiro);

    // Near-miss: any edit is a different request, so it gets a new id.
    fireEvent.change(screen.getByLabelText('Nome do pagador'), { target: { value: 'Ana' } });
    fireEvent.click(botao('Gerar link'));
    await waitFor(() => {
      expect(cliente.criarLinks).toHaveBeenCalledTimes(3);
    });
    const terceiro = cliente.criarLinks.mock.calls[2]![0].links[0]!.linkId;
    expect(terceiro).not.toBe(primeiro);
  });

  it('settles an unanswered request once its links show up (the server made them)', async () => {
    cliente.criarLinks.mockRejectedValueOnce(new MercadoPagoClientNetworkError('offline'));
    const { rerender } = renderTab();
    fireEvent.click(botao('Preencher com o valor disponível'));
    fireEvent.click(botao('Gerar link'));
    await waitFor(() => {
      expect(h.erro).toHaveBeenCalledTimes(1);
    });
    await esperarFimDoEnvio('Gerar link');
    const perdido = cliente.criarLinks.mock.calls[0]![0].links[0]!.linkId;

    // Near-miss: an emission WITHOUT that id (someone else's link) settles nothing.
    servir('links', [link('L-outro', { nomePagador: 'Bia', valorCobrado: 1 })]);
    rerender(arvore());
    expect(valorDoCampo('Valor do link')).not.toBe('');
    expect(h.notify).not.toHaveBeenCalled();

    // The lost request DID land: its link is in the listener. Replaying the draft
    // would now also trip the sum check (its own R$ 100,00 counts as open).
    servir('links', [link(perdido, { valorCobrado: 100 })]);
    rerender(arvore());
    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Os links já foram gerados.' }),
      );
    });
    expect(valorDoCampo('Valor do link')).toBe('');
    expect(screen.queryByText(/Os links somam mais/)).toBeNull();
    expect(cliente.criarLinks).toHaveBeenCalledTimes(1);
  });

  it('replays an unanswered request past the client sum check, and checks a new one', async () => {
    cliente.criarLinks.mockRejectedValueOnce(new MercadoPagoClientNetworkError('offline'));
    cliente.criarLinks.mockRejectedValueOnce(new MercadoPagoClientNetworkError('offline'));
    const { rerender } = renderTab();
    fireEvent.click(botao('Preencher com o valor disponível'));
    fireEvent.click(botao('Gerar link'));
    await waitFor(() => {
      expect(h.erro).toHaveBeenCalledTimes(1);
    });
    await esperarFimDoEnvio('Gerar link');

    // Meanwhile R$ 10,00 was paid by hand: the R$ 100,00 draft no longer fits in 90.
    // The EXACT replay still goes out — the route answers `reaproveitado` or refuses.
    servir('pagamentos', [pagamento('pg-manual', { valor: 10 })]);
    rerender(arvore());
    fireEvent.click(botao('Gerar link'));
    await waitFor(() => {
      expect(cliente.criarLinks).toHaveBeenCalledTimes(2);
    });
    await esperarFimDoEnvio('Gerar link');
    const primeiro = cliente.criarLinks.mock.calls[0]![0].links[0]!.linkId;
    expect(cliente.criarLinks.mock.calls[1]![0].links[0]!.linkId).toBe(primeiro);

    // Near-miss: an edited draft is a NEW request, so the client checks the sum again.
    fireEvent.change(screen.getByLabelText('Nome do pagador'), { target: { value: 'Ana' } });
    fireEvent.click(botao('Gerar link'));
    expect(await screen.findByText(/Os links somam mais do que o restante/)).toBeTruthy();
    expect(cliente.criarLinks).toHaveBeenCalledTimes(2);
  });

  it('mints new ids after the route ANSWERED, even with a refusal', async () => {
    cliente.criarLinks.mockRejectedValueOnce(
      new MercadoPagoClientHttpError(
        'Não elegível',
        409,
        CODIGO_ERRO_LINK.naoElegivel,
        MOTIVO_RECUSA_LINK.excedeRestante,
      ),
    );
    renderTab();
    fireEvent.click(botao('Preencher com o valor disponível'));

    fireEvent.click(botao('Gerar link'));
    await waitFor(() => {
      expect(h.erro).toHaveBeenCalledWith(
        expect.objectContaining({
          message: MOTIVO_RECUSA_LINK_LABELS[MOTIVO_RECUSA_LINK.excedeRestante],
        }),
      );
    });
    await esperarFimDoEnvio('Gerar link');

    fireEvent.click(botao('Gerar link'));
    await waitFor(() => {
      expect(cliente.criarLinks).toHaveBeenCalledTimes(2);
    });
    const primeiro = cliente.criarLinks.mock.calls[0]![0].links[0]!.linkId;
    const segundo = cliente.criarLinks.mock.calls[1]![0].links[0]!.linkId;
    expect(segundo).not.toBe(primeiro);
  });

  it('sends the operator to reconnect the account on MP_REAUTH_REQUIRED', async () => {
    cliente.criarLinks.mockRejectedValueOnce(
      new MercadoPagoClientHttpError('Reconecte', 409, 'MP_REAUTH_REQUIRED'),
    );
    renderTab();
    fireEvent.click(botao('Preencher com o valor disponível'));
    fireEvent.click(botao('Gerar link'));

    await waitFor(() => {
      expect(h.erro).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ href: '/pagamentos/mercado-pago/conta-a' }),
        }),
      );
    });
  });

  it('asks for an admin instead of linking a page the operator cannot use', async () => {
    h.concedido =
      PERM_LINK_PAGAMENTO.ler | PERM_LINK_PAGAMENTO.gerenciar | PERM_LINK_PAGAMENTO.listarContas;
    cliente.criarLinks.mockRejectedValueOnce(
      new MercadoPagoClientHttpError('Reconecte', 409, 'MP_REAUTH_REQUIRED'),
    );
    renderTab();
    fireEvent.click(botao('Preencher com o valor disponível'));
    fireEvent.click(botao('Gerar link'));

    await waitFor(() => {
      expect(h.erro).toHaveBeenCalledTimes(1);
    });
    expect(h.erro.mock.calls[0]![0].link).toBeUndefined();
  });

  it('rethrows a non-client error (rule 6) and still leaves the loading state', async () => {
    // `descreverFalhaLink` disowns a TypeError, so the rejection is MEANT to escape
    // (root rule 6); the listener is what asserts it did.
    const escapou = vi.fn();
    process.on('unhandledRejection', escapou);
    try {
      cliente.criarLinks.mockRejectedValueOnce(new TypeError('bug de programação'));
      renderTab();
      fireEvent.click(botao('Preencher com o valor disponível'));
      fireEvent.click(botao('Gerar link'));

      await waitFor(() => {
        expect(escapou).toHaveBeenCalledWith(expect.any(TypeError), expect.anything());
      });
      expect(h.erro).not.toHaveBeenCalled();
      await esperarFimDoEnvio('Gerar link');
    } finally {
      process.off('unhandledRejection', escapou);
    }
  });
});

describe('LinkPagamentoTab — money in flight on links no longer open', () => {
  /** R$ 40,00 paid on link `L-ana`, which expired yesterday (a Pix issued before it lapsed). */
  function pagamentoDoExpirado(status: number): Linha {
    return pagamento('pg-ana', {
      valor: 40,
      linkPagamentoId: 'L-ana',
      status_pagamento: status,
      dataAprovacao: null,
    });
  }

  it('a pending payment on an expired link reduces what new links may charge', async () => {
    servir('links', [
      link('L-ana', { nomePagador: 'Ana', valorCobrado: 40, dataExpiracao: AGORA - DIA }),
    ]);
    // Near-miss first: a REFUSED payment can never land, so nothing is in flight.
    servir('pagamentos', [pagamentoDoExpirado(STATUS_PAGAMENTO.recusado)]);
    const { rerender } = renderTab();
    expect(screen.getByTestId('link-resumo-disponivel').textContent).toBe(formatReais(100));
    expect(screen.queryByTestId('link-resumo-em-transito')).toBeNull();
    expect(screen.queryByText('Pagamentos pendentes em links encerrados')).toBeNull();
    // The draft takes the old full amount.
    fireEvent.click(botao('Preencher com o valor disponível'));

    // The same payment still PENDING may land on top of a new link: it is exposure.
    servir('pagamentos', [pagamentoDoExpirado(STATUS_PAGAMENTO.pendente)]);
    rerender(arvore());
    expect(screen.getByText('Pagamentos pendentes em links encerrados')).toBeTruthy();
    expect(screen.getByTestId('link-resumo-em-transito').textContent).toBe(formatReais(40));
    expect(screen.getByTestId('link-resumo-em-aberto').textContent).toBe(formatReais(0));
    expect(screen.getByTestId('link-resumo-restante').textContent).toBe(formatReais(100));
    expect(screen.getByTestId('link-resumo-disponivel').textContent).toBe(formatReais(60));

    // A batch of the old full amount is refused on the client, as the route would.
    fireEvent.click(botao('Gerar link'));
    expect(await screen.findByText(/Os links somam mais do que o restante/)).toBeTruthy();
    expect(cliente.criarLinks).not.toHaveBeenCalled();
  });

  it('says why creation is blocked when pending payments cover the rest', () => {
    servir('links', [
      link('L-ana', { nomePagador: 'Ana', valorCobrado: 40, dataExpiracao: AGORA - DIA }),
      link('L-bia', { nomePagador: 'Bia', valorCobrado: 60 }),
    ]);
    servir('pagamentos', [pagamentoDoExpirado(STATUS_PAGAMENTO.em_revisao)]);
    renderTab();
    // 100 − 60 open − 40 in flight = 0: nothing left, and cancelling cannot free it.
    expect(screen.getByTestId('link-resumo-disponivel').textContent).toBe(formatReais(0));
    expect(screen.getByText(/pagamentos pendentes em links encerrados\./)).toBeTruthy();
    expect(botao('Gerar link')).toHaveProperty('disabled', true);
  });
});

describe('LinkPagamentoTab — the list', () => {
  function semear(): void {
    servir('links', [
      link('L-maria', { nomePagador: 'Maria', dataCriacao: AGORA - 5 * DIA }),
      link('L-ana', { nomePagador: 'Ana', dataExpiracao: AGORA - DIA }),
      link('L-bia', { nomePagador: 'Bia', status: STATUS_LINK_PAGAMENTO.cancelado }),
      link('L-legado', { modo: null, valorCobrado: 77, status: STATUS_LINK_PAGAMENTO.aberto }),
      link('L-joao', { nomePagador: 'João' }),
    ]);
    servir('pagamentos', [
      pagamento('pg-maria', { linkPagamentoId: 'L-maria', primeiroNomePagador: 'Maria' }),
    ]);
  }

  it('derives each situation from the link and its attributed payments', () => {
    semear();
    renderTab({ pedido: { ...PROPS.pedido, valorCobrado: 200 } });

    const situacao = (texto: string) => within(linhaDaTabela(texto));
    expect(situacao('Maria').getByText(SITUACAO_LINK_PAGAMENTO_LABELS.pago)).toBeTruthy();
    expect(situacao('Ana').getByText(SITUACAO_LINK_PAGAMENTO_LABELS.expirado)).toBeTruthy();
    expect(situacao('Bia').getByText(SITUACAO_LINK_PAGAMENTO_LABELS.cancelado)).toBeTruthy();
    expect(situacao(formatReais(77)).getByText(SITUACAO_LINK_PAGAMENTO_LABELS.legado)).toBeTruthy();
    expect(situacao('João').getByText(SITUACAO_LINK_PAGAMENTO_LABELS.aberto)).toBeTruthy();
    // The payer's first name is shown on the paid row.
    expect(situacao('Maria').getAllByText('Maria')).toHaveLength(2);
  });

  it('offers Cancelar only on an open, traceable link', () => {
    semear();
    renderTab({ pedido: { ...PROPS.pedido, valorCobrado: 200 } });

    expect(screen.getAllByRole('button', { name: 'Cancelar link' })).toHaveLength(1);
    const joao = within(linhaDaTabela('João'));
    expect(joao.queryByRole('button', { name: 'Cancelar link' })).not.toBeNull();
    // A legacy link is never cancellable from here, even while unexpired.
    const legado = within(linhaDaTabela(formatReais(77)));
    expect(legado.queryByRole('button', { name: 'Cancelar link' })).toBeNull();
  });

  it('keeps legacy and closed links out of the exposure that limits new links', () => {
    semear();
    renderTab({ pedido: { ...PROPS.pedido, valorCobrado: 200 } });

    // Total 200, paid 50 (Maria), only João (50) still open: legacy, expired and
    // cancelled links hold nothing.
    expect(screen.getByTestId('link-resumo-pago').textContent).toBe(formatReais(50));
    expect(screen.getByTestId('link-resumo-em-aberto').textContent).toBe(formatReais(50));
    expect(screen.getByTestId('link-resumo-restante').textContent).toBe(formatReais(150));
    expect(screen.getByTestId('link-resumo-disponivel').textContent).toBe(formatReais(100));
  });

  it('copies first names only for quem já pagou, and the open links for todos', async () => {
    const writeText = comClipboard();
    semear();
    renderTab({ pedido: { ...PROPS.pedido, valorCobrado: 200 } });

    fireEvent.click(botao('Copiar quem já pagou'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const pagantes = writeText.mock.calls[0]![0];
    expect(pagantes).toContain('✅ Maria');
    expect(pagantes).not.toContain('R$');
    expect(pagantes).not.toContain('https://');

    fireEvent.click(botao('Copiar todos os links'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(2);
    });
    const todos = writeText.mock.calls[1]![0];
    expect(todos).toContain(urlDoLink('L-joao'));
    // Near-miss: a paid, expired, cancelled or legacy link is not payable any more.
    expect(todos).not.toContain(urlDoLink('L-maria'));
    expect(todos).not.toContain(urlDoLink('L-ana'));
    expect(todos).not.toContain(urlDoLink('L-bia'));
    expect(todos).not.toContain(urlDoLink('L-legado'));
  });

  it('disables both copy buttons when there is nothing to copy', () => {
    renderTab();
    expect(botao('Copiar todos os links')).toHaveProperty('disabled', true);
    expect(botao('Copiar quem já pagou')).toHaveProperty('disabled', true);
  });

  it('cancels a link after confirmation', async () => {
    semear();
    renderTab({ pedido: { ...PROPS.pedido, valorCobrado: 200 } });

    fireEvent.click(within(linhaDaTabela('João')).getByRole('button', { name: 'Cancelar link' }));
    expect(screen.getByText(/Pagamentos já iniciados, como um Pix gerado/)).toBeTruthy();
    fireEvent.click(botao('Confirmar cancelamento'));

    await waitFor(() => {
      expect(cliente.cancelarLink).toHaveBeenCalledWith({
        pedidoId: 'pedido123',
        linkId: 'L-joao',
      });
    });
    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'green', message: 'Link cancelado.' }),
      );
    });
  });

  it('synchronises with Mercado Pago and lists the payments that failed', async () => {
    cliente.sincronizarLinks.mockResolvedValueOnce({
      encontrados: 3,
      reconciliados: 2,
      ignorados: 0,
      falhas: [{ paymentId: '987', motivo: 'transiente' }],
      transicoes: [],
      truncado: false,
    });
    renderTab();

    fireEvent.click(botao('Sincronizar com Mercado Pago'));
    await waitFor(() => {
      expect(cliente.sincronizarLinks).toHaveBeenCalledWith({ pedidoId: 'pedido123' });
    });
    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
    });
    expect(h.copiavel).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', message: '987: transiente' }),
    );
  });
});
