import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import {
  ACAO_STATUS_ANUNCIO,
  ESTADO_ANUNCIO_SHOPEE,
  INTEGRACAO_TIPO,
  SHOPEE_MODEL_STATUS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
} from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  type ShopeeClient,
} from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE } from '@/lib/shopee/erros';
import { formatarInstanteShopee } from '@/lib/shopee/anuncioProduto';
import {
  DETALHES_ERRO_SHOPEE_VAZIOS,
  type AnuncioStatusShopee,
  type ProblemaShopee,
  type RespostaPublicarShopee,
  type RespostaReverificarShopee,
} from '@/lib/shopee/wire';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

/**
 * T5 (a)–(c) (reconcile §4, PR 6) and the read-only block: the Shopee tab over
 * EXISTING links. Every read is doubled at its I/O edge — the snapshot hooks,
 * the one-shot `getDocs` of the models — and told apart by WHAT IT WAS BUILT ON
 * (the `MercadoLivreEditor` harness's tagging, never call order). Every rule
 * the tab displays by is the REAL `@delfrance/schemas` function.
 *
 * PR 7 adds the actions (T5 (c) button half, (d), (e), (h), (k), (n)): the
 * client is `shopeeClientFalso` holding only the methods a test expects, so a
 * call to any other route rejects naming itself; the error classes stay REAL
 * (the module is mocked with `importOriginal` spread) for the `instanceof`s.
 */

interface Linha {
  id: string;
  data: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  contas: [] as Linha[],
  links: [] as Linha[],
  filhos: [] as Linha[],
  /** `variashopee` rows per child produto id. */
  varLinks: new Map<string, Linha[]>(),
  /**
   * EVERY `integracao` document by id — what a by-id read finds. `contas` is
   * only the page the bounded live query returned.
   */
  contasPorId: new Map<string, Record<string, unknown>>(),
  produto: { nome: 'Camiseta', paiId: null } as Record<string, unknown> | null,
  tabMedi: null as Record<string, unknown> | null,
  /** The snapshot hooks' `loading` — a re-listen keeps `data` (R1). */
  carregando: false,
  permitidos: new Set<bigint>(),
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  /** Every collection a live query was opened on — what the tab chose to READ. */
  consultas: new Set<string>(),
  /** What `useShopeeClient` hands the editor (`null` = no signed-in user yet). */
  client: null as ShopeeClient | null,
  notify: vi.fn(),
  /** Every `tabMedi` doc id the tab built a ref to — WHICH tabela it chose to read. */
  tabMediIds: [] as string[],
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.client };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

vi.mock('@delfrance/data', () => ({
  // ⚠️ KEEPS THE BASE'S TAGS so a query is told apart by what it was built on —
  // and carries its `limit`, which the `getDocs` double honours.
  buildQuery: (base: object, constraints: readonly { __limit?: number }[] = []) => {
    const n = constraints.find((c) => c.__limit !== undefined)?.__limit;
    return n === undefined ? base : { ...base, __limit: n };
  },
  limit: (n: number) => ({ __limit: n }),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: (q: { __col?: string } | null) => {
    if (q === null) return { data: undefined, loading: false, error: undefined };
    h.consultas.add(q.__col ?? '?');
    const data =
      q.__col === 'integracao' ? h.contas : q.__col === 'prodshopee' ? h.links : h.filhos;
    return { data, loading: h.carregando, error: undefined };
  },
  useDocSnapshot: (ref: { __doc?: string } | null) => {
    if (ref === null) return { data: undefined, loading: false, error: undefined };
    const data = ref.__doc === 'produto' ? h.produto : h.tabMedi;
    return {
      data: data === null ? null : { id: ref.__doc ?? '?', data },
      loading: false,
      error: undefined,
    };
  },
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  getDocs: h.getDocs,
  getDoc: h.getDoc,
}));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({ allowed: h.permitidos.has(bit), loading: false }),
}));
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: {
    ref: () => ({ __col: 'integracao' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __doc: 'integracao', id }),
  },
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    ref: () => ({ __col: 'produtos' }),
    docRef: () => ({ __doc: 'produto' }),
  },
}));
vi.mock('@/lib/data/produtoShopeeLinkCollection', () => ({
  produtoShopeeLinkCollection: { ref: () => ({ __col: 'prodshopee' }) },
}));
vi.mock('@/lib/data/variacaoShopeeLinkCollection', () => ({
  variacaoShopeeLinkCollection: {
    ref: (_db: unknown, ctx: { produtoId: string }) => ({
      __col: 'variashopee',
      produtoId: ctx.produtoId,
    }),
  },
}));
vi.mock('@/lib/data/tabelaDeMedidasCollection', () => ({
  tabelaDeMedidasCollection: {
    docRef: (_db: unknown, _ctx: unknown, id: string) => {
      h.tabMediIds.push(id);
      return { __doc: 'tabMedi' };
    },
  },
}));

const { ShopeeEditor } = await import('./ShopeeEditor');
const { MAX_MODELOS_POR_FILHO } = await import('./ModelosAnuncioShopee');

const conta = (id: string, nome: string, extra: Record<string, unknown> = {}): Linha => ({
  id,
  data: { nome, tipo: INTEGRACAO_TIPO.shopee, ativo: true, shop_id: 987654, ...extra },
});

const link = (id: string, extra: Record<string, unknown> = {}): Linha => ({
  id,
  data: {
    contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
    item_name: `Anúncio ${id}`,
    item_id: 1000001,
    category_id: 100087,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    ...extra,
  },
});

function renderEditor(props: { disabled?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  return render(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} {...props} />, {
    wrapper,
  });
}

const bloco = (linkDocId: string) => screen.getByTestId(`shopee-anuncio-${linkDocId}`);
const painel = (contaId: string) => screen.getByTestId(`shopee-conta-${contaId}`);
/** The link doc ids of the blocks a panel lists, in DOM order. */
const blocosDe = (contaId: string) =>
  within(painel(contaId))
    .queryAllByTestId(/^shopee-anuncio-/)
    .map((el) => el.getAttribute('data-testid')!.slice('shopee-anuncio-'.length));

beforeEach(() => {
  h.contas = [conta('int-1', 'Loja A')];
  h.links = [];
  h.filhos = [];
  h.varLinks = new Map();
  h.contasPorId = new Map();
  h.produto = { nome: 'Camiseta', paiId: null };
  h.tabMedi = null;
  h.carregando = false;
  h.consultas = new Set();
  h.tabMediIds = [];
  h.permitidos = new Set([PERM.integracao.read]);
  h.client = shopeeClientFalso();
  h.notify.mockReset();
  h.getDocs.mockReset();
  h.getDocs.mockImplementation(async (q: { produtoId: string; __limit?: number }) => ({
    docs: (h.varLinks.get(q.produtoId) ?? [])
      .slice(0, q.__limit ?? Number.POSITIVE_INFINITY)
      .map((v) => ({ id: v.id, data: () => v.data })),
  }));
  h.getDoc.mockReset();
  h.getDoc.mockImplementation(async (ref: { id: string }) => ({
    id: ref.id,
    data: () => h.contasPorId.get(ref.id),
  }));
});

describe('ShopeeEditor — which conta a link belongs to', () => {
  it('(a) folds both stored encodings of one conta ref into ONE tab, never showing conta int-12’s link under int-1', () => {
    h.contas = [conta('int-1', 'Loja A'), conta('int-12', 'Loja B')];
    h.links = [
      link('L1', { contaProdutoShopeeOuterRef: 'documents/integracao/int-1' }),
      link('L2', { contaProdutoShopeeOuterRef: 'integracao/int-1' }),
      // NEAR-MISS: `int-12` contains `int-1` — a substring or prefix fold
      // would hand this listing to Loja A.
      link('L3', { contaProdutoShopeeOuterRef: 'documents/integracao/int-12' }),
    ];
    renderEditor();

    expect(blocosDe('int-1').sort()).toEqual(['L1', 'L2']);
    expect(screen.getByRole('tab', { name: /Loja A/ }).textContent).toContain('2 anúncio(s)');

    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));
    expect(blocosDe('int-12')).toEqual(['L3']);
    // No orphan tab was invented for the bare encoding.
    expect(screen.queryByRole('tab', { name: /não encontrada/ })).toBeNull();
  });

  it('(b) gives a conta with no document a tab of its own — the link is shown, never dropped', async () => {
    h.links = [link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' })];
    renderEditor();

    const orfa = await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ });
    // Called missing only after its by-id read said so.
    expect(h.getDoc).toHaveBeenCalledWith(expect.objectContaining({ id: 'int-9' }));
    // It holds the only listing, so it opens first.
    expect(orfa.getAttribute('aria-selected')).toBe('true');
    expect(blocosDe('int-9')).toEqual(['L9']);
    expect(within(painel('int-9')).getByText(/não está cadastrada/)).toBeDefined();
    // The registered conta keeps its tab, honestly empty.
    fireEvent.click(screen.getByRole('tab', { name: /Loja A/ }));
    expect(
      within(painel('int-1')).getByText('Este produto não tem anúncio nesta conta.'),
    ).toBeDefined();
  });

  it('puts the links whose conta ref names no id in a LAST tab of their own', async () => {
    h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: 'documents/tabMedi/tm-1' };
    h.tabMedi = { nome: 'Camisetas adulto', tabelasMedidasShopee: {} };
    h.links = [
      // A raw (unparsed) document with an empty ref — listed FIRST on purpose.
      link('L-sem', { contaProdutoShopeeOuterRef: '' }),
      link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' }),
    ];
    renderEditor();
    await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Loja ASem anúncio',
      'Conta int-9 (não encontrada)1 anúncio(s)',
      'Sem conta legível1 anúncio(s)',
    ]);
    fireEvent.click(screen.getByRole('tab', { name: /Sem conta legível/ }));
    expect(blocosDe('__sem_conta__')).toEqual(['L-sem']);
    expect(within(bloco('L-sem')).getByText(/sem conta legível, nenhum modelo/)).toBeDefined();
  });

  it('reads a conta past the bounded query BY ID and shows its link under it — never "não encontrada" — while a conta with no document still is', async () => {
    // `int-77` exists but sits past the query's page (`h.contas` is the page).
    h.contasPorId.set('int-1', conta('int-1', 'Loja A').data);
    h.contasPorId.set('int-77', conta('int-77', 'Loja Z', { shop_id: 555 }).data);
    h.links = [
      link('L1'),
      link('L77', { contaProdutoShopeeOuterRef: 'integracao/int-77', item_id: 1000077 }),
      // NEAR-MISS: no document at all — the one honest "não encontrada".
      link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9', item_id: 1000009 }),
    ];
    renderEditor();

    await screen.findByRole('tab', { name: /Loja Z/ });
    await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Loja A1 anúncio(s)',
      'Loja Z1 anúncio(s)',
      'Conta int-9 (não encontrada)1 anúncio(s)',
    ]);
    expect(screen.queryByRole('tab', { name: /int-77/ })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Loja Z/ }));
    expect(blocosDe('int-77')).toEqual(['L77']);
    // Its real shop_id: the storefront link is built, and nothing says it is missing.
    expect(
      within(bloco('L77')).getByRole('link', { name: 'Ver na Shopee' }).getAttribute('href'),
    ).toBe('https://shopee.com.br/product/555/1000077');
    expect(within(painel('int-77')).queryByText(/não está cadastrada/)).toBeNull();

    // By id, and only the ids the page lacks — never `int-1`, never a query.
    expect(h.getDoc.mock.calls.map(([ref]) => (ref as { id: string }).id).sort()).toEqual([
      'int-77',
      'int-9',
    ]);
    expect([...h.consultas].sort()).toEqual(['integracao', 'prodshopee']);
  });

  it('NEAR-MISS: a by-id document of ANOTHER channel is no Shopee conta — "não encontrada", as the query would say', async () => {
    // The query filters `tipo == shopee`; the by-id read must not count what it would not.
    h.contasPorId.set(
      'int-ml',
      conta('int-ml', 'Conta do Mercado Livre', { tipo: INTEGRACAO_TIPO.mercadoLivre }).data,
    );
    h.links = [link('L-ml', { contaProdutoShopeeOuterRef: 'integracao/int-ml' })];
    renderEditor();

    await screen.findByRole('tab', { name: /Conta int-ml \(não encontrada\)/ });
    expect(h.getDoc).toHaveBeenCalledWith(expect.objectContaining({ id: 'int-ml' }));
    expect(screen.queryByRole('tab', { name: /Mercado Livre/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /int-ml/ }));
    expect(within(bloco('L-ml')).queryByRole('link', { name: 'Ver na Shopee' })).toBeNull();
  });

  it('reads no id no document can carry, and calls it "não encontrada" without a read', async () => {
    h.links = [
      link('L-rel', { contaProdutoShopeeOuterRef: 'documents/integracao/..' }),
      link('L-res', { item_id: 1000002, contaProdutoShopeeOuterRef: 'integracao/__x__' }),
    ];
    renderEditor();
    expect(screen.getByRole('tab', { name: /Conta \.\. \(não encontrada\)/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Conta __x__ \(não encontrada\)/ })).toBeDefined();
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it('keeps the selected conta while a newly named off-page conta is read, and says "carregando", never "não encontrada"', async () => {
    h.contas = [conta('int-1', 'Loja A'), conta('int-2', 'Loja B')];
    h.contasPorId.set('int-77', conta('int-77', 'Loja Z').data);
    h.links = [
      link('L1'),
      link('L2', { contaProdutoShopeeOuterRef: 'integracao/int-2' }),
      link('L77', { item_id: 1000077, contaProdutoShopeeOuterRef: 'integracao/int-77' }),
    ];
    const { rerender } = renderEditor();
    await screen.findByRole('tab', { name: /Loja Z/ });
    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));

    // A listing on a SECOND conta past the page lands while the tab is open; the
    // re-read of the id set hangs.
    const pendentes = new Map<string, (dados: Record<string, unknown>) => void>();
    h.getDoc.mockImplementation(
      (ref: { id: string }) =>
        new Promise((resolve) => {
          pendentes.set(ref.id, (dados) => resolve({ id: ref.id, data: () => dados }));
        }),
    );
    h.links = [
      ...h.links,
      link('L88', { item_id: 1000088, contaProdutoShopeeOuterRef: 'integracao/int-88' }),
    ];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);

    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Conta int-88 \(carregando…\)/ })).toBeDefined();
    // The conta already read keeps its name while the new set is read.
    expect(screen.getByRole('tab', { name: /Loja Z/ })).toBeDefined();
    expect(screen.queryByRole('tab', { name: /não encontrada/ })).toBeNull();

    await waitFor(() => expect([...pendentes.keys()].sort()).toEqual(['int-77', 'int-88']));
    pendentes.get('int-77')!(conta('int-77', 'Loja Z').data);
    pendentes.get('int-88')!(conta('int-88', 'Loja C').data);
    await screen.findByRole('tab', { name: /Loja C/ });
    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: /carregando/ })).toBeNull();
  });

  it('badges a conta with no listing "Sem anúncio"', () => {
    renderEditor();
    expect(screen.getByRole('tab', { name: /Loja A/ }).textContent).toContain('Sem anúncio');
  });

  it('points to Canais when there is no Shopee conta and no listing at all', () => {
    h.contas = [];
    renderEditor();
    expect(screen.getByText(/Nenhuma conta Shopee cadastrada/)).toBeDefined();
  });
});

describe('ShopeeEditor — the listing state', () => {
  it('(c) reads estadoAnuncio null as "Não verificado" and lists it as LIVE; removido reads "Removido" and sorts last', () => {
    h.links = [
      // Published LATER, but removed: it must still sort after the live one.
      link('L-removido', {
        item_id: 1000002,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
        publicadoEm: 2_000,
      }),
      // Never folded (an imported link): not evidence of anything.
      link('L-nulo', { item_id: 1000001, estadoAnuncio: null, publicadoEm: 1_000 }),
    ];
    renderEditor();

    expect(blocosDe('int-1')).toEqual(['L-nulo', 'L-removido']);
    expect(within(bloco('L-nulo')).getByText('Não verificado')).toBeDefined();
    expect(within(bloco('L-nulo')).queryByText('Removido')).toBeNull();
    expect(within(bloco('L-removido')).getByText('Removido')).toBeDefined();
  });

  it('says who paused a listing, and that it is deboosted', () => {
    h.links = [
      link('L-erp', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado, pausadoPeloErp: true }),
      link('L-shopee', {
        item_id: 1000002,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
        pausadoPeloErp: null,
        deboost: true,
      }),
    ];
    renderEditor();
    expect(within(bloco('L-erp')).getByText('Pausado pelo ERP')).toBeDefined();
    expect(within(bloco('L-shopee')).getByText('Pausado na Shopee')).toBeDefined();
    expect(within(bloco('L-shopee')).getByText('Rebaixado na busca')).toBeDefined();
    expect(within(bloco('L-erp')).queryByText('Rebaixado na busca')).toBeNull();
  });

  it('links a published listing to its storefront page, and a draft to nothing', () => {
    h.links = [
      link('L-pub', { item_id: 1000001 }),
      link('L-rascunho', { item_id: null, estadoAnuncio: null, category_id: null }),
    ];
    renderEditor();

    const ver = within(bloco('L-pub')).getByRole('link', { name: 'Ver na Shopee' });
    expect(ver.getAttribute('href')).toBe('https://shopee.com.br/product/987654/1000001');
    expect(ver.getAttribute('rel')).toContain('noopener');
    expect(within(bloco('L-rascunho')).getByText('Não publicado')).toBeDefined();
    expect(within(bloco('L-rascunho')).queryByRole('link', { name: 'Ver na Shopee' })).toBeNull();
  });

  it('names the link that superseded a listing, and lists it after the live one', () => {
    h.links = [
      link('L-velho', { substituidoPorLinkDocId: 'L-kit', substituidoEm: Date.UTC(2026, 9, 1, 3) }),
      link('L-kit', { item_id: 1000002 }),
    ];
    renderEditor();
    expect(blocosDe('int-1')).toEqual(['L-kit', 'L-velho']);
    expect(
      within(bloco('L-velho')).getByText(/Substituído pelo vínculo L-kit em 01\/10\/2026, 00:00/),
    ).toBeDefined();
  });
});

describe('ShopeeEditor — refusals and violations, through the shared readers', () => {
  it('shows a price refusal while no clean send is newer — a tie shows it — and hides a stale one', () => {
    h.links = [
      link('L-atual', {
        precoRecusaEm: 2_000,
        precoEnviadoEm: 1_000,
        precoRecusaMensagem: 'Preço abaixo do mínimo da categoria.',
        precoRecusaCodigo: 'erp:preco-minimo',
      }),
      link('L-empate', {
        item_id: 1000002,
        precoRecusaEm: 1_500,
        precoEnviadoEm: 1_500,
        precoRecusaMensagem: 'Empate.',
      }),
      link('L-velha', {
        item_id: 1000003,
        precoRecusaEm: 1_000,
        precoEnviadoEm: 2_000,
        precoRecusaMensagem: 'Recusa já superada.',
      }),
    ];
    renderEditor();
    expect(
      within(bloco('L-atual')).getByText(
        /Preço abaixo do mínimo da categoria\. \(código erp:preco-minimo\)/,
      ),
    ).toBeDefined();
    expect(within(bloco('L-empate')).getByText(/Empate\./)).toBeDefined();
    expect(within(bloco('L-velha')).queryByText(/Recusa já superada/)).toBeNull();
    expect(within(bloco('L-velha')).queryByText('Preço recusado')).toBeNull();
  });

  it('keeps a hidden stock refusal on screen while the stock gate’s skip set is armed', () => {
    h.links = [
      // A clean send's stamp is NEWER (the sentence alone would hide), but the
      // fingerprint still matches the listing's reading: the gate skips it.
      link('L-armado', {
        estoqueRecusaEm: 1_000,
        estoqueEnviadoEm: 2_000,
        estoqueRecusaMensagem: 'A Shopee recusou o estoque deste anúncio.',
        estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
        estoqueRecusaItemStatus: 'NORMAL',
        item_status: 'NORMAL',
      }),
      // NEAR-MISS: the same stale stamps, but the reading MOVED — nothing shows.
      link('L-movido', {
        item_id: 1000002,
        estoqueRecusaEm: 1_000,
        estoqueEnviadoEm: 2_000,
        estoqueRecusaMensagem: 'Recusa de outro estado.',
        estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.pausado,
        estoqueRecusaItemStatus: 'UNLIST',
        item_status: 'NORMAL',
      }),
    ];
    renderEditor();
    expect(within(bloco('L-armado')).getByText(/A Shopee recusou o estoque/)).toBeDefined();
    expect(
      within(bloco('L-armado')).getByText(/envio automático de estoque está suspenso/),
    ).toBeDefined();
    expect(within(bloco('L-movido')).queryByText('Estoque recusado')).toBeNull();
  });

  describe('the stock suspension, worded by WHICH half of the skip set is armed', () => {
    // `agoraMs` is captured when the editor mounts, so the clock is frozen
    // BEFORE the render; only `Date` is faked (no timer is involved).
    const AGORA = Date.UTC(2026, 9, 15, 15);
    const PRAZO = AGORA + 60_000;
    /** A clean send NEWER than the refusal: the sentence alone would hide it. */
    const superada = { estoqueRecusaEm: AGORA - 120_000, estoqueEnviadoEm: AGORA - 60_000 };
    const impressao = {
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: 'NORMAL',
      item_status: 'NORMAL',
    };

    beforeEach(() => {
      vi.useFakeTimers({ now: AGORA, toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('TIME only: suspended until the deadline, never "it comes back when the listing changes"', () => {
      h.links = [
        link('L-tempo', { ...superada, estoqueRecusaAte: PRAZO }),
        // NEAR-MISS: a deadline one millisecond ago no longer holds anything.
        link('L-vencido', { ...superada, item_id: 1000002, estoqueRecusaAte: AGORA - 1 }),
        // NEAR-MISS: the exact instant already releases (strict `<`).
        link('L-exato', { ...superada, item_id: 1000003, estoqueRecusaAte: AGORA }),
      ];
      renderEditor();
      const b = within(bloco('L-tempo'));
      expect(b.getByText('Estoque recusado')).toBeDefined();
      expect(
        b.getByText(
          `O envio automático de estoque está suspenso para este anúncio até ${formatarInstanteShopee(PRAZO)!}.`,
        ),
      ).toBeDefined();
      expect(b.queryByText(/neste mesmo estado/)).toBeNull();
      expect(b.queryByText(/quando o anúncio mudar/)).toBeNull();
      for (const id of ['L-vencido', 'L-exato']) {
        expect(within(bloco(id)).queryByText('Estoque recusado')).toBeNull();
        expect(within(bloco(id)).queryByText(/suspenso/)).toBeNull();
      }
    });

    it('both halves: until the deadline, and after it until the listing changes', () => {
      h.links = [link('L-ambos', { ...superada, ...impressao, estoqueRecusaAte: PRAZO })];
      renderEditor();
      expect(
        within(bloco('L-ambos')).getByText(
          `O envio automático de estoque está suspenso para este anúncio até ${formatarInstanteShopee(PRAZO)!}; depois disso, como a Shopee já o recusou neste mesmo estado, só volta quando o anúncio mudar.`,
        ),
      ).toBeDefined();
    });

    it('STATE only: a deadline already past is not printed as what holds it', () => {
      h.links = [link('L-estado', { ...superada, ...impressao, estoqueRecusaAte: AGORA - 1 })];
      renderEditor();
      const b = within(bloco('L-estado'));
      expect(
        b.getByText(
          'O envio automático de estoque está suspenso para este anúncio: a Shopee já o recusou neste mesmo estado. Ele volta quando o anúncio mudar.',
        ),
      ).toBeDefined();
      expect(b.queryByText(/Prazo registrado|até /)).toBeNull();
    });
  });

  it('lists the violations, a legacy row as a duration and never a date', () => {
    h.links = [
      link('L1', {
        violacoesLidasEm: Date.UTC(2026, 9, 2, 3),
        violations: [
          {
            kind: 'deboost',
            violation_type: 'Imagem de baixa qualidade',
            violation_reason: 'A foto principal está desfocada.',
            suggestion: 'Envie uma foto nítida.',
            fix_deadline_time: Date.UTC(2026, 9, 10, 3),
            suggested_category: [{ category_id: 100088, category_name: 'Regatas' }],
            days_to_fix: null,
          },
          { violation_type: 'Registro antigo', days_to_fix: 3 },
        ],
      }),
    ];
    renderEditor();
    const b = within(bloco('L1'));
    expect(b.getByText('Rebaixamento')).toBeDefined();
    expect(b.getByText('A foto principal está desfocada.')).toBeDefined();
    expect(b.getByText('Categorias sugeridas: Regatas')).toBeDefined();
    expect(b.getByText('Corrigir até 10/10/2026, 00:00')).toBeDefined();
    expect(b.getByText('prazo: 3 dias (registro antigo)')).toBeDefined();
    expect(b.getByText('Desde 02/10/2026, 00:00')).toBeDefined();
  });

  it('says when a scheduled publish failed, without inventing a reason', () => {
    h.links = [link('L1', { agendamentoFalhouEm: Date.UTC(2026, 9, 3, 15) })];
    renderEditor();
    expect(
      within(bloco('L1')).getByText(
        'Uma publicação agendada falhou em 03/10/2026, 12:00 — a Shopee não informa o motivo.',
      ),
    ).toBeDefined();
  });
});

describe('ShopeeEditor — the size chart a listing resolves to', () => {
  it('names the template entry of the listing’s conta and category, and says why there is none', () => {
    h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: 'documents/tabMedi/tm-1' };
    h.tabMedi = {
      nome: 'Camisetas adulto',
      tabelasMedidasShopee: {
        'int-1': [{ categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas' }],
      },
    };
    h.links = [
      link('L-com', { category_id: 100087 }),
      link('L-sem', { item_id: 1000002, category_id: 100088 }),
    ];
    renderEditor();
    expect(
      within(bloco('L-com')).getByText(/modelo #700024639 \(categoria «Camisetas»\)/),
    ).toBeDefined();
    expect(within(bloco('L-sem')).getByText(/não tem modelo para a categoria/)).toBeDefined();
    expect(
      within(bloco('L-com'))
        .getByRole('link', { name: /Abrir tabela/ })
        .getAttribute('href'),
    ).toBe('/medidas/tm-1');
    expect(h.tabMediIds).toEqual(['tm-1']);
  });

  it.each([
    ['another collection', 'documents/produtos/tm-1'],
    ['another collection, bare form', 'categorias/tm-1'],
    ['a bare id (no collection)', 'tm-1'],
    ['a subcollection below a tabela', 'documents/tabMedi/tm-1/fotos/f-1'],
    ['a relative-path id', 'documents/tabMedi/..'],
  ])(
    'reads NO tabela for a ref publish would not resolve (%s) — the shared rule, not the last segment',
    (_rotulo, ref) => {
      h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: ref };
      // Present on purpose: reading `tabMedi/<last segment>` would find it.
      h.tabMedi = {
        nome: 'Camisetas adulto',
        tabelasMedidasShopee: {
          'int-1': [{ categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas' }],
        },
      };
      h.links = [link('L1', { category_id: 100087 })];
      renderEditor();
      expect(h.tabMediIds).toEqual([]);
      expect(
        within(bloco('L1')).getByText(
          `Tabela de medidas: o produto aponta para algo que não é uma tabela de medidas (${ref}).`,
        ),
      ).toBeDefined();
      expect(within(bloco('L1')).queryByText(/modelo #/)).toBeNull();
    },
  );

  it('NEAR-MISS: the bare `tabMedi/<id>` form resolves to the same tabela as the canonical one', () => {
    h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: 'tabMedi/tm-1' };
    h.tabMedi = {
      nome: 'Camisetas adulto',
      tabelasMedidasShopee: {
        'int-1': [{ categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas' }],
      },
    };
    h.links = [link('L1', { category_id: 100087 })];
    renderEditor();
    expect(h.tabMediIds).toEqual(['tm-1']);
    expect(within(bloco('L1')).getByText(/modelo #700024639/)).toBeDefined();
  });

  it('says the produto has no tabela when it names none', () => {
    h.links = [link('L1')];
    renderEditor();
    expect(within(bloco('L1')).getByText(/o produto não tem tabela de medidas/)).toBeDefined();
  });
});

describe('ShopeeEditor — the models, read only on demand', () => {
  it('reads nothing until "Ver variações", then lists only THIS listing’s models', async () => {
    h.links = [link('L1', { precoEnviadoEm: 1_000 }), link('L2', { item_id: 1000002 })];
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', [
      {
        id: 'v-l1',
        data: {
          produtoShopeeOuterRef: 'documents/produtos/prod-1/prodshopee/L1',
          model_id: 2000001,
          model_status: SHOPEE_MODEL_STATUS.normal,
          precoEnviado: 49.9,
          precoRecusaEm: 2_000,
          precoRecusaCodigo: 'error_price_too_low',
        },
      },
      {
        // The SAME child's model on the OTHER listing — never under L1.
        id: 'v-l2',
        data: {
          produtoShopeeOuterRef: 'documents/produtos/prod-1/prodshopee/L2',
          model_id: 2000002,
        },
      },
    ]);
    renderEditor();
    expect(h.getDocs).not.toHaveBeenCalled();

    fireEvent.click(within(bloco('L1')).getByRole('button', { name: 'Ver variações' }));
    const tabela = await waitFor(() => screen.getByTestId('shopee-modelos-L1'));
    const t = within(tabela);
    expect(t.getByText('Camiseta P')).toBeDefined();
    expect(t.getByText('2000001')).toBeDefined();
    expect(t.queryByText('2000002')).toBeNull();
    expect(t.getByText('Disponível')).toBeDefined();
    // The model's refusal is newer than both success stamps: it shows.
    expect(t.getByText('Recusado (error_price_too_low)')).toBeDefined();
    // Each child read by its own path, never a collection-group query.
    expect(h.getDocs).toHaveBeenCalledWith(expect.objectContaining({ produtoId: 'f1' }));
  });

  it('bounds each model refusal by the stamps the shared readers name — its own AND the listing’s', async () => {
    h.links = [link('L1', { precoEnviadoEm: 1_000, estoqueEnviadoEm: 1_000 })];
    const L1 = 'documents/produtos/prod-1/prodshopee/L1';
    h.filhos = [
      { id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } },
      { id: 'f2', data: { nome: 'Camiseta M', paiId: 'prod-1' } },
      { id: 'f3', data: { nome: 'Camiseta G', paiId: 'prod-1' } },
    ];
    // f1 — both refusals NEWER than every stamp: both cells show "Recusado".
    h.varLinks.set('f1', [
      {
        id: 'v-f1',
        data: {
          produtoShopeeOuterRef: L1,
          model_id: 2000001,
          precoRecusaEm: 2_000,
          precoRecusaCodigo: 'error_price_too_low',
          estoqueRecusaEm: 1_500,
          estoqueRecusaCodigo: 'error_estoque',
        },
      },
    ]);
    // f2 — NEAR-MISS on the LISTING's stamps: each refusal 1 ms older than the
    // listing's clean send, no stamp of its own. Both hide.
    h.varLinks.set('f2', [
      {
        id: 'v-f2',
        data: {
          produtoShopeeOuterRef: L1,
          model_id: 2000003,
          precoEnviado: 39.9,
          precoRecusaEm: 999,
          precoRecusaCodigo: 'error_anchor_item',
          estoqueRecusaEm: 999,
          estoqueRecusaCodigo: 'error_estoque_velho',
        },
      },
    ]);
    // f3 — NEAR-MISS on the model's OWN price stamp (newer than the listing's,
    // so only its own hides it); its stock refusal TIES the listing's send,
    // and a tie shows.
    h.varLinks.set('f3', [
      {
        id: 'v-f3',
        data: {
          produtoShopeeOuterRef: L1,
          model_id: 2000004,
          precoEnviado: 29.9,
          precoRecusaEm: 2_000,
          precoEnviadoEm: 2_001,
          precoRecusaCodigo: 'error_anchor_modelo',
          estoqueRecusaEm: 1_000,
          estoqueRecusaCodigo: 'error_estoque_empate',
        },
      },
    ]);
    renderEditor();
    fireEvent.click(within(bloco('L1')).getByRole('button', { name: 'Ver variações' }));
    const tabela = await waitFor(() => screen.getByTestId('shopee-modelos-L1'));
    /** [Variação, Modelo, Situação, Estoque, Preço] of one child's row. */
    const celulas = (nome: string) =>
      within(within(tabela).getByText(nome).closest('tr')!)
        .getAllByRole('cell')
        .map((c) => c.textContent);

    expect(celulas('Camiseta P').slice(3)).toEqual([
      'Recusado (error_estoque)',
      'Recusado (error_price_too_low)',
    ]);
    expect(celulas('Camiseta M').slice(3)).toEqual(['—', formatReais(39.9)]);
    expect(celulas('Camiseta G').slice(3)).toEqual([
      'Recusado (error_estoque_empate)',
      formatReais(29.9),
    ]);
  });
});

describe('ShopeeEditor — the models read never answers from a truncated page', () => {
  const L1 = 'documents/produtos/prod-1/prodshopee/L1';
  /** `n` rows of OTHER listings, ids sorting before `v-zz` (the key order a real read returns). */
  const deOutros = (n: number): Linha[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `v-${String(i).padStart(4, '0')}`,
      data: {
        produtoShopeeOuterRef: `documents/produtos/prod-1/prodshopee/L-outro-${String(i)}`,
        model_id: 3000000 + i,
      },
    }));
  const doL1 = (modelId: number): Linha => ({
    id: 'v-zz',
    data: { produtoShopeeOuterRef: L1, model_id: modelId },
  });

  async function abrirModelosDeL1() {
    renderEditor();
    fireEvent.click(within(bloco('L1')).getByRole('button', { name: 'Ver variações' }));
    return within(await waitFor(() => screen.getByTestId('shopee-modelos-L1')));
  }

  beforeEach(() => {
    h.links = [link('L1')];
  });

  it('shows THIS listing’s model even when other listings’ rows fill the first 50 — the old bound', async () => {
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', [...deOutros(60), doL1(2000001)]);
    const t = await abrirModelosDeL1();
    expect(t.getByText('2000001')).toBeDefined();
    expect(screen.queryByTestId('shopee-modelos-truncado-L1')).toBeNull();
    // One read per child, by its path — not one per page.
    expect(h.getDocs).toHaveBeenCalledTimes(1);
  });

  it('says a child’s read stopped at the bound — beside the rows it did find', async () => {
    h.filhos = [
      { id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } },
      { id: 'f2', data: { nome: 'Camiseta M', paiId: 'prod-1' } },
    ];
    // f1: past the bound, this listing's row beyond what is read.
    h.varLinks.set('f1', [...deOutros(MAX_MODELOS_POR_FILHO + 1), doL1(2000001)]);
    h.varLinks.set('f2', [doL1(2000002)]);
    const t = await abrirModelosDeL1();
    expect(t.getByText('2000002')).toBeDefined();
    const aviso = screen.getByTestId('shopee-modelos-truncado-L1');
    expect(aviso.textContent).toContain(`mais de ${String(MAX_MODELOS_POR_FILHO)} registros`);
    expect(aviso.textContent).toContain('Camiseta P');
    expect(aviso.textContent).not.toContain('Camiseta M');
  });

  it('never answers "no linked variation" from a read that stopped at the bound', async () => {
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', [...deOutros(MAX_MODELOS_POR_FILHO + 1), doL1(2000001)]);
    const t = await abrirModelosDeL1();
    expect(screen.getByTestId('shopee-modelos-truncado-L1')).toBeDefined();
    expect(t.queryByText(/Nenhuma variação deste produto está vinculada/)).toBeNull();
    expect(t.getByText('Nenhuma das variações lidas está vinculada a este anúncio.')).toBeDefined();
  });

  it('NEAR-MISS: exactly the bound is a COMPLETE read — no notice, and "none linked" is the truth', async () => {
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', deOutros(MAX_MODELOS_POR_FILHO));
    const t = await abrirModelosDeL1();
    expect(screen.queryByTestId('shopee-modelos-truncado-L1')).toBeNull();
    expect(
      t.getByText('Nenhuma variação deste produto está vinculada a este anúncio.'),
    ).toBeDefined();
  });
});

describe('ShopeeEditor — what it does not read', () => {
  it('sends a variation child to its parent and reads no listing', () => {
    h.produto = { nome: 'Camiseta P', paiId: 'pai-1' };
    h.links = [link('L1')];
    renderEditor();
    expect(screen.getByText(/Os anúncios da Shopee ficam no produto pai/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Abrir o produto pai' }).getAttribute('href')).toBe(
      '/produtos/pai-1/editar',
    );
    expect(screen.queryByTestId('shopee-anuncio-L1')).toBeNull();
    // Not merely hidden: the child's listing subcollection is never queried.
    expect(h.consultas.has('prodshopee')).toBe(false);
  });

  it('calls a produto a child by the publish dispatcher’s rule: a blank paiId is a child, an empty one a root', () => {
    // `' '` — the dispatcher refuses its Republicar as `produto-e-filho`, so the
    // tab must not offer it as a root (a trim would).
    h.produto = { nome: 'Camiseta P', paiId: ' ' };
    h.links = [link('L1')];
    const { unmount } = renderEditor();
    expect(screen.getByTestId('shopee-variacao-filha')).toBeDefined();
    expect(h.consultas.has('prodshopee')).toBe(false);
    unmount();

    // NEAR-MISS: `''` is a root for every server rule — the links are read.
    h.produto = { nome: 'Camiseta', paiId: '' };
    h.consultas = new Set();
    renderEditor();
    expect(screen.queryByTestId('shopee-variacao-filha')).toBeNull();
    expect(h.consultas.has('prodshopee')).toBe(true);
    expect(bloco('L1')).toBeDefined();
  });

  it('asks for the integrações read permission instead of hitting a permission-denied', () => {
    h.permitidos = new Set();
    h.links = [link('L1')];
    renderEditor();
    expect(screen.getByText(/Requer permissão de leitura em integrações/)).toBeDefined();
    expect(screen.queryByTestId('shopee-anuncio-L1')).toBeNull();
  });
});

describe('ShopeeEditor — a non-persistent section (rule R1)', () => {
  it('keeps the selected conta while a re-listen is loading — the spinner gates on data, not on loading', () => {
    h.contas = [conta('int-1', 'Loja A'), conta('int-2', 'Loja B')];
    h.links = [link('L1'), link('L2', { contaProdutoShopeeOuterRef: 'integracao/int-2' })];
    const { rerender } = renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));
    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');

    // What `<Activity>` re-showing the section looks like: the listeners
    // re-subscribe and report `{ data: prev, loading: true }`.
    h.carregando = true;
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(painel('int-2')).getByTestId('shopee-anuncio-L2')).toBeDefined();
  });

  it('(k) keeps the selected conta AND a refused publish’s rows while a re-listen is loading (R1 + R2)', async () => {
    comEscrita();
    h.contas = [conta('int-1', 'Loja A'), conta('int-2', 'Loja B')];
    h.links = [link('L1'), link('L2', { contaProdutoShopeeOuterRef: 'integracao/int-2' })];
    h.client = shopeeClientFalso({
      publicar: () =>
        Promise.reject(
          recusa422([
            {
              campo: null,
              motivo: 'categoria-invalida',
              mensagem: 'A categoria 100087 não aceita este atributo.',
              acao: null,
            },
          ]),
        ),
    });
    const { rerender } = renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));
    fireEvent.click(botao('L2', 'Republicar'));
    await waitFor(() =>
      expect(
        within(bloco('L2')).getByText('A categoria 100087 não aceita este atributo.'),
      ).toBeDefined(),
    );

    h.carregando = true;
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');
    expect(
      within(bloco('L2')).getByText('A categoria 100087 não aceita este atributo.'),
    ).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                    PR 7 — the actions on an existing link                   */
/* -------------------------------------------------------------------------- */

const TIPO = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE;

/** The operator holds `integracao.write` — every action route's bit. */
function comEscrita() {
  h.permitidos = new Set([PERM.integracao.read, PERM.integracao.write]);
}

const botao = (linkDocId: string, nome: string) =>
  within(bloco(linkDocId)).getByRole('button', { name: nome });
const semBotao = (linkDocId: string, nome: string | RegExp) =>
  within(bloco(linkDocId)).queryByRole('button', { name: nome });

/** Every button a block's action row can hold — what a never-folded live link shows. */
const BOTOES_DO_BLOCO = ['Republicar', 'Reverificar', 'Pausar anúncio', 'Reativar anúncio'];
const FRASE_RASCUNHO = 'Primeira publicação: chega na etapa de autoria do anúncio.';
const FRASE_ITEM_ID_INVALIDO =
  'O código do anúncio guardado neste vínculo é inválido — nenhuma ação disponível.';

/** The pause/reactivate run's 200, for ONE listing — shaped like `anuncio-status/route.ts`'s. */
function respostaStatus(
  linkDocId: string,
  mensagem: string,
  extra: Partial<AnuncioStatusShopee> = {},
): AnuncioStatusShopee {
  return {
    canal: 'shopee',
    integracaoId: 'int-1',
    acao: ACAO_STATUS_ANUNCIO.pausar,
    listings: [
      {
        produtoId: 'prod-1',
        produtoNome: 'Camiseta',
        anuncioId: '1000002',
        linkDocId,
        outcome: 'enviado',
        motivo: null,
        mensagem,
        statusFinal: 'UNLIST',
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      },
    ],
    produtosSemAnuncio: [],
    pausadoAte: null,
    ...extra,
  };
}

/** An ordinary listing's republish 200. */
const ITEM_REPUBLICADO: RespostaPublicarShopee = {
  tipo: 'item',
  itemId: 1000001,
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
  itemStatus: 'NORMAL',
  modelos: { total: 0, criados: 0, atualizados: 0, semFilho: 0 },
  fotos: { reutilizadas: 3, enviadas: 1, falhas: 0 },
  avisoShopee: null,
  taxInfoOmitido: null,
  tabelaDeMedidas: {
    sizeChartId: 700024639,
    fonte: 'modelo',
    motivo: null,
    fotoOmitida: null,
    avisoObrigatoria: false,
  },
};

function reverificado(extra: Partial<RespostaReverificarShopee> = {}): RespostaReverificarShopee {
  return {
    acao: 'atualizado',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    deboost: false,
    violacoes: [],
    violacoesLidas: true,
    modelos: null,
    avisoResolvido: false,
    avisoReceitaKit: null,
    ...extra,
  };
}

/** A publish 422 the client built from the body (its `detalhes.problemas`). */
function recusa422(
  problemas: ProblemaShopee[],
  code: string = CODIGO_FALHA_SHOPEE.publicacaoBloqueada,
): ShopeeClientHttpError {
  return new ShopeeClientHttpError(
    `Publicação bloqueada no produto prod-1: ${String(problemas.length)} problema(s)`,
    422,
    code,
    null,
    null,
    { ...DETALHES_ERRO_SHOPEE_VAZIOS, problemas },
  );
}

/** CLI copy — a flag, a script name or the word — must never reach the page (lens 8). */
const TEXTO_DE_TERMINAL = /(^|\s)--[a-z]|:anuncio|comando/i;

describe('ShopeeEditor — pause and reactivate (podeMoverAnuncioShopee)', () => {
  it('(c) offers Pausar on a never-folded listing (estadoAnuncio null) and no status control on a removed one', () => {
    comEscrita();
    h.links = [
      link('L-nulo', { estadoAnuncio: null }),
      link('L-removido', { item_id: 1000002, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    ];
    renderEditor();
    // A missing reading is not evidence of anything: movable BOTH ways.
    expect(botao('L-nulo', 'Pausar anúncio')).toBeDefined();
    expect(botao('L-nulo', 'Reativar anúncio')).toBeDefined();
    // Positive first: the removed block rendered.
    expect(within(bloco('L-removido')).getByText('Removido')).toBeDefined();
    expect(semBotao('L-removido', 'Pausar anúncio')).toBeNull();
    expect(semBotao('L-removido', 'Reativar anúncio')).toBeNull();
  });

  it('(d) confirms a pause, then sends it for THAT listing, named by its link id', async () => {
    comEscrita();
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>(async () =>
      respostaStatus('L2', 'Anúncio pausado na Shopee.'),
    );
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [link('L1'), link('L2', { item_id: 1000002 })];
    renderEditor();

    fireEvent.click(botao('L2', 'Pausar anúncio'));
    const dialogo = screen.getByRole('dialog', { name: 'Pausar anúncio' });
    // A pause stops a live sale: nothing is sent before the confirmation.
    expect(definirStatusAnuncios).not.toHaveBeenCalled();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Pausar' }));

    await waitFor(() =>
      expect(within(bloco('L2')).getByText('Anúncio pausado na Shopee.')).toBeDefined(),
    );
    expect(definirStatusAnuncios).toHaveBeenCalledTimes(1);
    expect(definirStatusAnuncios.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      acao: ACAO_STATUS_ANUNCIO.pausar,
      linkDocId: 'L2',
    });
    expect(within(bloco('L1')).queryByText('Anúncio pausado na Shopee.')).toBeNull();
  });

  it('a failed ID-token refresh ends a confirmed pause WITH an outcome, never in silence', async () => {
    comEscrita();
    // `getAuthToken()` runs outside the client's try: the rejection is the raw
    // Firebase Auth error, none of the client's classes — and nothing was sent.
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>(() =>
      Promise.reject(
        new FirebaseError('auth/network-request-failed', 'Falha ao renovar a sessão.'),
      ),
    );
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [link('L1')];
    renderEditor();

    fireEvent.click(botao('L1', 'Pausar anúncio'));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Pausar anúncio' })).getByRole('button', {
        name: 'Pausar',
      }),
    );

    const desfecho = await waitFor(() => screen.getByTestId('shopee-desfecho-L1'));
    expect(within(desfecho).getByText('Falha ao renovar a sessão.')).toBeDefined();
    expect(definirStatusAnuncios).toHaveBeenCalledTimes(1);
    // The lock is released: the operator can try again.
    expect(botao('L1', 'Pausar anúncio').hasAttribute('disabled')).toBe(false);
  });

  it('a pause confirmation cannot send once its link was rewritten with an id no listing has', () => {
    comEscrita();
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>();
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [link('L1')];
    const { rerender } = renderEditor();
    fireEvent.click(botao('L1', 'Pausar anúncio'));
    const confirmar = () =>
      within(screen.getByRole('dialog', { name: 'Pausar anúncio' })).getByRole('button', {
        name: 'Pausar',
      });
    // NEAR-MISS first: as opened, on an addressable link, the confirmation can send.
    expect(confirmar().hasAttribute('disabled')).toBe(false);

    // The live snapshot repaints while the dialog is open.
    h.links = [link('L1', { item_id: 1.5 })];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(confirmar().hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirmar());
    expect(definirStatusAnuncios).not.toHaveBeenCalled();
  });

  it('sends nothing when the pause is cancelled', () => {
    comEscrita();
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>();
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [link('L1')];
    renderEditor();
    fireEvent.click(botao('L1', 'Pausar anúncio'));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Pausar anúncio' })).getByRole('button', {
        name: 'Cancelar',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Pausar anúncio' })).toBeNull();
    expect(definirStatusAnuncios).not.toHaveBeenCalled();
  });

  it('reactivates a paused listing at once, and says until when the daily quota stopped the run', async () => {
    comEscrita();
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>(async () =>
      respostaStatus('L-pausado', 'A Shopee ainda não reativou o anúncio.', {
        acao: ACAO_STATUS_ANUNCIO.reativar,
        // 03:00Z is São Paulo's midnight.
        pausadoAte: '2026-10-15T03:00:00.000Z',
      }),
    );
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [
      link('L-pausado', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado, pausadoPeloErp: true }),
    ];
    renderEditor();
    expect(semBotao('L-pausado', 'Pausar anúncio')).toBeNull();
    fireEvent.click(botao('L-pausado', 'Reativar anúncio'));

    await waitFor(() =>
      expect(
        within(bloco('L-pausado')).getByText(
          'Cota diária da Shopee esgotada até 15/10/2026, 00:00.',
        ),
      ).toBeDefined(),
    );
    expect(
      within(bloco('L-pausado')).getByText('A Shopee ainda não reativou o anúncio.'),
    ).toBeDefined();
    expect(definirStatusAnuncios.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      acao: ACAO_STATUS_ANUNCIO.reativar,
      linkDocId: 'L-pausado',
    });
  });
});

describe('ShopeeEditor — republish an existing link, never a first publish', () => {
  it('(e) republishes a live listing by its link with no kit option, and offers none on a superseded or removed one', async () => {
    comEscrita();
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    h.client = shopeeClientFalso({ publicar });
    h.links = [
      link('L-vivo'),
      link('L-subst', { item_id: 1000002, substituidoPorLinkDocId: 'L-vivo' }),
      link('L-removido', { item_id: 1000003, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    ];
    renderEditor();

    // Positive first, then the absence: each block rendered its state.
    expect(within(bloco('L-subst')).getByText(/Substituído pelo vínculo L-vivo/)).toBeDefined();
    expect(semBotao('L-subst', 'Republicar')).toBeNull();
    // A superseded kit whose delete did not take is still worth re-reading.
    expect(botao('L-subst', 'Reverificar')).toBeDefined();
    expect(within(bloco('L-removido')).getByText('Removido')).toBeDefined();
    expect(semBotao('L-removido', 'Republicar')).toBeNull();

    fireEvent.click(botao('L-vivo', 'Republicar'));
    await waitFor(() =>
      expect(within(bloco('L-vivo')).getByText('Anúncio republicado na Shopee')).toBeDefined(),
    );
    // EXACTLY the three keys: no `recriar`, no `converterEmKit`, no `principal`
    // (the T5 (f) half this PR owns — the kit arms are not on this button).
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-vivo',
    });
    expect(
      within(bloco('L-vivo')).getByText('Tabela de medidas: modelo #700024639.'),
    ).toBeDefined();
  });

  it('(n) offers no Publicar on a draft link — with or without a category — and says where a first publish comes from', () => {
    comEscrita();
    h.links = [
      link('L-rasc', { item_id: null, estadoAnuncio: null, category_id: null }),
      link('L-rasc-cat', { item_id: null, estadoAnuncio: null, category_id: 100087 }),
      link('L-pub', { item_id: 1000003 }),
    ];
    renderEditor();
    for (const id of ['L-rasc', 'L-rasc-cat']) {
      expect(
        within(bloco(id)).getByText('Primeira publicação: chega na etapa de autoria do anúncio.'),
      ).toBeDefined();
      expect(semBotao(id, /Publicar/)).toBeNull();
      expect(semBotao(id, 'Pausar anúncio')).toBeNull();
      expect(semBotao(id, 'Reverificar')).toBeNull();
    }
    expect(botao('L-pub', 'Republicar')).toBeDefined();
    expect(
      within(bloco('L-pub')).queryByText(
        'Primeira publicação: chega na etapa de autoria do anúncio.',
      ),
    ).toBeNull();
  });

  it('NEAR-MISS: an item id that is present but addresses no listing (0, a quoted number) gets no button at all', () => {
    comEscrita();
    // A parsed link can carry 0 (`z.number().int()`), and a soft-read hands the
    // raw document over, so a stringified id reaches the block as it is.
    h.links = [
      link('L-zero', { item_id: 0, estadoAnuncio: null }),
      link('L-texto', { item_id: '1000001', estadoAnuncio: null }),
    ];
    renderEditor();
    for (const id of ['L-zero', 'L-texto']) {
      // Positive first: the block rendered, as an unpublished listing.
      expect(within(bloco(id)).getByText('Não publicado')).toBeDefined();
      expect(within(bloco(id)).getByText(FRASE_ITEM_ID_INVALIDO)).toBeDefined();
      expect(semBotao(id, 'Reverificar'), id).toBeNull();
      expect(semBotao(id, /Publicar/), id).toBeNull();
      expect(semBotao(id, 'Pausar anúncio'), id).toBeNull();
      expect(semBotao(id, 'Reativar anúncio'), id).toBeNull();
    }
  });

  it('offers NO button on an id the schemas predicates pass but no listing has (a fraction, 2^53, a negative), and says so — never as a draft', () => {
    comEscrita();
    // Never folded and not superseded: `podeMoverAnuncioShopee` (both ways) and
    // `anuncioShopeeVivo` test `isFinite` only, so for the first two ids every
    // one of them says yes — the block's own gate is what refuses.
    h.links = [
      link('L-fracao', { item_id: 1.5, estadoAnuncio: null }),
      link('L-2e53', { item_id: 2 ** 53, estadoAnuncio: null }),
      link('L-negativo', { item_id: -1000001, estadoAnuncio: null }),
    ];
    renderEditor();
    for (const id of ['L-fracao', 'L-2e53', 'L-negativo']) {
      // Positive first: the block rendered, and says why it offers nothing.
      expect(within(bloco(id)).getByText('Não publicado')).toBeDefined();
      expect(within(bloco(id)).getByText(FRASE_ITEM_ID_INVALIDO)).toBeDefined();
      // It is not a draft: no first publish is promised.
      expect(within(bloco(id)).queryByText(FRASE_RASCUNHO)).toBeNull();
      for (const nome of BOTOES_DO_BLOCO) expect(semBotao(id, nome), `${id} ${nome}`).toBeNull();
    }
  });

  it('NEAR-MISS: the ids that DO address a listing — up to Number.MAX_SAFE_INTEGER — get every button', () => {
    comEscrita();
    h.links = [
      link('L-comum', { item_id: 1000001, estadoAnuncio: null }),
      link('L-maximo', { item_id: Number.MAX_SAFE_INTEGER, estadoAnuncio: null }),
    ];
    renderEditor();
    for (const id of ['L-comum', 'L-maximo']) {
      for (const nome of BOTOES_DO_BLOCO) expect(botao(id, nome), `${id} ${nome}`).toBeDefined();
      expect(within(bloco(id)).queryByText(FRASE_ITEM_ID_INVALIDO)).toBeNull();
    }
  });

  it('(h) renders a refused publish by its acao — the button acts on the link the acao names — and never a terminal sentence', async () => {
    comEscrita();
    const problemas: ProblemaShopee[] = [
      {
        campo: 'linkDocId',
        motivo: 'vinculo-substituido',
        mensagem:
          'vínculo L1 (item 1000001): este anúncio foi substituído pelo kit nativo L2 e não é ' +
          'mais publicado pelo ERP — publique sem --link (ou com --link L2)',
        acao: { tipo: TIPO.republicar, linkDocId: 'L2' },
      },
      {
        campo: 'sku',
        motivo: 'kit-ja-existe-na-shopee',
        mensagem:
          'já existe na Shopee um kit com o SKU deste produto (item 1000009) — importe-o ' +
          '(importar:anuncio) em vez de criar outro',
        acao: { tipo: TIPO.importar, itemIds: [1000009] },
      },
      {
        // No `acao`, but written for the CLI: the backstop replaces it.
        campo: null,
        motivo: 'instabilidade-shopee',
        mensagem:
          "a Shopee respondeu com instabilidade ('Too many connections'); a operação pode ter " +
          'sido feita — rode exatamente o mesmo comando de novo daqui a 4 minutos',
        acao: null,
      },
      {
        // A mechanism sentence with no next step: shown as it is.
        campo: 'category_id',
        motivo: 'categoria-invalida',
        mensagem: 'A categoria 100087 não aceita este atributo.',
        acao: null,
      },
    ];
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422(problemas))
      .mockResolvedValueOnce(ITEM_REPUBLICADO);
    h.client = shopeeClientFalso({ publicar });
    h.links = [link('L1'), link('L2', { item_id: 1000002, kitNativo: true })];
    renderEditor();

    fireEvent.click(botao('L1', 'Republicar'));
    const desfecho = await waitFor(() => screen.getByTestId('shopee-desfecho-L1'));
    const d = within(desfecho);
    expect(d.getByText('Publicação bloqueada — nada foi enviado à Shopee')).toBeDefined();
    expect(d.getByText(/sem as opções de kit\. Vínculo: L2\.$/)).toBeDefined();
    expect(d.getByText(/Anúncio\(s\) na Shopee: 1000009\.$/)).toBeDefined();
    expect(d.getByText(/Esta recusa não traz um próximo passo/)).toBeDefined();
    expect(d.getByText('A categoria 100087 não aceita este atributo.')).toBeDefined();
    // The server's CLI sentences never reach the page — not as a row, not anywhere.
    expect(document.body.textContent).not.toMatch(TEXTO_DE_TERMINAL);
    // `importar` points elsewhere: text, no button.
    expect(d.queryByRole('button', { name: /importa/i })).toBeNull();

    // The `republicar` button names the SUCCESSOR, never the block it sits in.
    fireEvent.click(d.getByRole('button', { name: 'Republicar o vínculo L2' }));
    await waitFor(() =>
      expect(within(bloco('L2')).getByText('Anúncio republicado na Shopee')).toBeDefined(),
    );
    expect(publicar).toHaveBeenCalledTimes(2);
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L2',
    });
  });

  it('offers a refusal row’s button only on a LOADED link whose id addresses a listing — the row still names the rest', async () => {
    comEscrita();
    const sucessor = (linkDocId: string): ProblemaShopee => ({
      campo: 'linkDocId',
      motivo: 'vinculo-substituido',
      mensagem: `substituído pelo kit nativo ${linkDocId}`,
      acao: { tipo: TIPO.republicar, linkDocId },
    });
    const problemas: ProblemaShopee[] = [
      // A loaded link whose stored id is a fraction: `anuncioShopeeVivo` passes it.
      sucessor('L-fracao'),
      // A link this tab never loaded: its outcome would land in no block on screen.
      sucessor('L-fora'),
      // NEAR-MISS: a loaded, addressable successor keeps its button.
      sucessor('L2'),
      {
        campo: 'principal',
        motivo: 'opcao-de-kit-em-anuncio-comum',
        mensagem: 'só valem para kit nativo',
        acao: { tipo: TIPO.semOpcoesDeKit },
      },
    ];
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(recusa422(problemas));
    h.client = shopeeClientFalso({ publicar });
    h.links = [
      link('L1'),
      link('L2', { item_id: 1000002 }),
      link('L-fracao', { item_id: 1.5, estadoAnuncio: null }),
    ];
    const { rerender } = renderEditor();

    fireEvent.click(botao('L1', 'Republicar'));
    const d = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L1')));
    // Positive first: every row is there, naming its link.
    expect(d.getByText(/Vínculo: L-fracao\.$/)).toBeDefined();
    expect(d.getByText(/Vínculo: L-fora\.$/)).toBeDefined();
    expect(d.getByRole('button', { name: 'Republicar o vínculo L2' })).toBeDefined();
    expect(d.getByRole('button', { name: 'Republicar sem as opções de kit' })).toBeDefined();
    expect(d.queryByRole('button', { name: 'Republicar o vínculo L-fracao' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Republicar o vínculo L-fora' })).toBeNull();

    // The block's OWN link rewritten with an id no listing has: the outcome
    // stays, its "republish this link" button goes — the other link's stays.
    h.links = [
      link('L1', { item_id: 1.5 }),
      link('L2', { item_id: 1000002 }),
      link('L-fracao', { item_id: 1.5, estadoAnuncio: null }),
    ];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    const depois = within(screen.getByTestId('shopee-desfecho-L1'));
    expect(depois.getByRole('button', { name: 'Republicar o vínculo L2' })).toBeDefined();
    expect(depois.queryByRole('button', { name: 'Republicar sem as opções de kit' })).toBeNull();
    expect(publicar).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['init_tier_variation', 'criação das variações'],
    ['add_kit_item', 'criação do kit — a Shopee não criou o kit'],
    // NEAR-MISS: a step this build does not know is never printed as its code.
    ['etapa_nova_do_servidor', 'uma etapa que esta tela ainda não descreve'],
  ])(
    'says WHERE a mid-publish refusal landed (%s), never the raw step code as a channel state',
    async (etapa, rotulo) => {
      comEscrita();
      const recusa = recusa422(
        [
          {
            campo: 'model_list',
            motivo: 'modelo-recusado',
            mensagem: 'Modelo recusado.',
            acao: null,
          },
        ],
        CODIGO_FALHA_SHOPEE.publicacaoRecusada,
      );
      const comEtapa = new ShopeeClientHttpError(recusa.message, 422, recusa.code, null, null, {
        ...recusa.detalhes,
        etapa,
      });
      h.client = shopeeClientFalso({ publicar: () => Promise.reject(comEtapa) });
      h.links = [link('L1')];
      renderEditor();
      fireEvent.click(botao('L1', 'Republicar'));
      await waitFor(() =>
        expect(within(bloco('L1')).getByText('A Shopee recusou a publicação')).toBeDefined(),
      );
      expect(
        within(bloco('L1')).getByText(
          `Recusada na etapa: ${rotulo}. Escritas anteriores podem já ter chegado à Shopee — use "Reverificar" antes de repetir.`,
        ),
      ).toBeDefined();
      expect(within(bloco('L1')).queryByText(new RegExp(etapa))).toBeNull();
      expect(within(bloco('L1')).queryByText(/Na Shopee agora/)).toBeNull();
    },
  );
});

describe('ShopeeEditor — re-verify, and one write at a time', () => {
  it('disables every write button while one write is in flight, and says what the re-verify found', async () => {
    comEscrita();
    let soltar: (r: RespostaReverificarShopee) => void = () => undefined;
    const reverificarAnuncio = vi.fn<ShopeeClient['reverificarAnuncio']>(
      () =>
        new Promise((resolve) => {
          soltar = resolve;
        }),
    );
    h.client = shopeeClientFalso({ reverificarAnuncio });
    // L2 never folded (`estadoAnuncio: null`): it shows BOTH status buttons, so
    // Reativar is held to the one-write rule too.
    h.links = [link('L1'), link('L2', { item_id: 1000002, estadoAnuncio: null })];
    renderEditor();

    fireEvent.click(botao('L1', 'Reverificar'));
    const escrita = {
      L1: ['Republicar', 'Reverificar', 'Pausar anúncio'],
      L2: ['Republicar', 'Reverificar', 'Pausar anúncio', 'Reativar anúncio'],
    };
    for (const [id, nomes] of Object.entries(escrita)) {
      for (const nome of nomes) expect(botao(id, nome).hasAttribute('disabled'), nome).toBe(true);
    }
    // The spinner sits on the ONE button in flight — that listing, that action.
    expect(botao('L1', 'Reverificar').hasAttribute('data-loading')).toBe(true);
    expect(botao('L2', 'Reverificar').hasAttribute('data-loading')).toBe(false);
    expect(botao('L1', 'Pausar anúncio').hasAttribute('data-loading')).toBe(false);
    expect(reverificarAnuncio.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L1',
    });

    await act(async () => {
      soltar(reverificado({ deboost: true }));
      await Promise.resolve();
    });
    for (const [id, nomes] of Object.entries(escrita)) {
      for (const nome of nomes) expect(botao(id, nome).hasAttribute('disabled'), nome).toBe(false);
    }
    expect(h.notify).toHaveBeenCalledWith({
      color: 'green',
      title: 'Anúncio reverificado — Ativo',
      message:
        'O ERP atualizou o anúncio com o que a Shopee informa agora. Ele está rebaixado na busca.',
    });
  });

  it('re-reads the open models after a re-verify, and toasts a removal', async () => {
    comEscrita();
    h.links = [link('L1')];
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', [
      {
        id: 'v-l1',
        data: {
          produtoShopeeOuterRef: 'documents/produtos/prod-1/prodshopee/L1',
          model_id: 2000001,
        },
      },
    ]);
    h.client = shopeeClientFalso({
      reverificarAnuncio: async () =>
        reverificado({ acao: 'removido', estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    });
    renderEditor();
    fireEvent.click(within(bloco('L1')).getByRole('button', { name: 'Ver variações' }));
    await waitFor(() => screen.getByTestId('shopee-modelos-L1'));
    expect(h.getDocs).toHaveBeenCalledTimes(1);

    fireEvent.click(botao('L1', 'Reverificar'));
    await waitFor(() => expect(h.getDocs).toHaveBeenCalledTimes(2));
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'orange', title: 'Anúncio reverificado — Removido' }),
    );
  });

  it('says the shopee service is unreachable in the block, and a link the conta no longer holds', async () => {
    comEscrita();
    h.client = shopeeClientFalso({
      reverificarAnuncio: () =>
        Promise.reject(new ShopeeClientNetworkError('Failed to fetch', new TypeError('x'))),
      publicar: () =>
        Promise.reject(
          new ShopeeClientHttpError(
            'Nenhum anúncio desta conta.',
            404,
            CODIGO_FALHA_SHOPEE.anuncioNaoEncontrado,
          ),
        ),
    });
    h.links = [link('L1'), link('L2', { item_id: 1000002 })];
    renderEditor();

    fireEvent.click(botao('L1', 'Reverificar'));
    await waitFor(() =>
      expect(
        within(bloco('L1')).getByText('Não foi possível contatar a integração com a Shopee.'),
      ).toBeDefined(),
    );
    expect(h.notify).not.toHaveBeenCalled();

    fireEvent.click(botao('L2', 'Republicar'));
    await waitFor(() =>
      expect(
        within(bloco('L2')).getByText(
          'Este vínculo não pertence mais a esta conta — a lista foi atualizada.',
        ),
      ).toBeDefined(),
    );
  });
});

describe('ShopeeEditor — who may act', () => {
  it('renders no action without integracao.write', () => {
    h.links = [link('L1')];
    renderEditor();
    expect(within(bloco('L1')).getByText('Ativo')).toBeDefined();
    for (const nome of ['Republicar', 'Reverificar', 'Pausar anúncio', 'Reativar anúncio']) {
      expect(semBotao('L1', nome)).toBeNull();
    }
  });

  it('disables every action on a read-only form, and while there is no client', () => {
    comEscrita();
    h.links = [link('L1'), link('L-nulo', { item_id: 1000002, estadoAnuncio: null })];
    const { unmount } = renderEditor({ disabled: true });
    expect(botao('L1', 'Republicar').hasAttribute('disabled')).toBe(true);
    expect(botao('L1', 'Pausar anúncio').hasAttribute('disabled')).toBe(true);
    // A click on an enabled Reativar here WOULD send: `executar` does not read `disabled`.
    expect(botao('L-nulo', 'Reativar anúncio').hasAttribute('disabled')).toBe(true);
    unmount();

    h.client = null;
    renderEditor();
    expect(botao('L1', 'Reverificar').hasAttribute('disabled')).toBe(true);
  });

  it('offers no action on a conta the query did not return', () => {
    comEscrita();
    h.links = [link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' })];
    renderEditor();
    expect(within(bloco('L9')).getByText('Ativo')).toBeDefined();
    expect(semBotao('L9', 'Republicar')).toBeNull();
    expect(semBotao('L9', 'Pausar anúncio')).toBeNull();
  });
});
