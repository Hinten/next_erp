import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { ESTADO_ANUNCIO_SHOPEE, INTEGRACAO_TIPO, SHOPEE_MODEL_STATUS } from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';
import { formatarInstanteShopee } from '@/lib/shopee/anuncioProduto';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * T5 (a)–(c) (reconcile §4, PR 6) and the read-only block: the Shopee tab over
 * EXISTING links. Every read is doubled at its I/O edge — the snapshot hooks,
 * the one-shot `getDocs` of the models — and told apart by WHAT IT WAS BUILT ON
 * (the `MercadoLivreEditor` harness's tagging, never call order). Every rule
 * the tab displays by is the REAL `@delfrance/schemas` function.
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
  /** Every `tabMedi` doc id the tab built a ref to — WHICH tabela it chose to read. */
  tabMediIds: [] as string[],
}));

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

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  return render(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />, { wrapper });
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
});
