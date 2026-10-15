import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import {
  ACAO_STATUS_ANUNCIO,
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  ESTADO_ANUNCIO_SHOPEE,
  INTEGRACAO_TIPO,
  SHOPEE_MODEL_STATUS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  TIPO_AVISO,
  chaveAvisoReceitaKitShopee,
} from '@delfrance/schemas';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  type ShopeeClient,
} from '@/lib/shopee/client';
import {
  TEXTO_ACAO_SUGERIDA,
  TEXTO_AVISO_KIT,
  TEXTO_MOTIVO_KIT,
  chaveIncerto,
} from '@/lib/shopee/anuncioProduto';
import { CODIGO_FALHA_SHOPEE } from '@/lib/shopee/erros';
import {
  DETALHES_ERRO_SHOPEE_VAZIOS,
  type AnuncioStatusShopee,
  type KitPublicadoShopee,
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
 *
 * PR 8 adds the native kit (T5 (f), (g), (h) Recriar, (i), (j), (l), (m)): the
 * kit badge, the recipe preview over the children's `paiId ==` shape and the
 * component names by id, the open aviso by its deterministic id, the create
 * arms under the ONE lock, and the uncertain create with its stored wait — the
 * REAL `sessionStorage` of jsdom, cleared before every test.
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
  produto: { nome: 'Camiseta', paiId: null } as Record<string, unknown> | null,
  tabMedi: null as Record<string, unknown> | null,
  /** The snapshot hooks' `loading` — a re-listen keeps `data` (R1). */
  carregando: false,
  permitidos: new Set<bigint>(),
  getDocs: vi.fn(),
  /** Every collection a live query was opened on — what the tab chose to READ. */
  consultas: new Set<string>(),
  /** What `useShopeeClient` hands the editor (`null` = no signed-in user yet). */
  client: null as ShopeeClient | null,
  notify: vi.fn(),
  /** The `shopeeKitReceitaDivergente` aviso doc, by its deterministic id (`null` = none). */
  aviso: null as Record<string, unknown> | null,
  /** Every aviso doc id the tab subscribed to. */
  avisosLidos: new Set<string>(),
  /** Component produto id → `nome`, for the recipe's one-shot name read. */
  nomes: new Map<string, string>(),
  getDocsByIds: vi.fn(),
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.client };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

vi.mock('@delfrance/data', () => ({
  // ⚠️ PASSES THE BASE THROUGH so a query is told apart by what it was built on.
  buildQuery: (base: unknown) => base,
  limit: () => ({}),
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
  useDocSnapshot: (ref: { __doc?: string; id?: string } | null) => {
    if (ref === null) return { data: undefined, loading: false, error: undefined };
    if (ref.__doc === 'aviso') h.avisosLidos.add(ref.id ?? '?');
    const data = ref.__doc === 'produto' ? h.produto : ref.__doc === 'aviso' ? h.aviso : h.tabMedi;
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
}));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({ allowed: h.permitidos.has(bit), loading: false }),
}));
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { ref: () => ({ __col: 'integracao' }) },
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
  tabelaDeMedidasCollection: { docRef: () => ({ __doc: 'tabMedi' }) },
}));
vi.mock('@/lib/data/avisoCollection', () => ({
  avisoCollection: {
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __doc: 'aviso', id }),
  },
}));
vi.mock('@/lib/data/getDocsByIds', () => ({ getDocsByIds: h.getDocsByIds }));

const { ShopeeEditor } = await import('./ShopeeEditor');

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
  h.produto = { nome: 'Camiseta', paiId: null };
  h.tabMedi = null;
  h.carregando = false;
  h.consultas = new Set();
  h.permitidos = new Set([PERM.integracao.read]);
  h.client = shopeeClientFalso();
  h.notify.mockReset();
  h.getDocs.mockReset();
  h.getDocs.mockImplementation(async (q: { produtoId: string }) => ({
    docs: (h.varLinks.get(q.produtoId) ?? []).map((v) => ({ id: v.id, data: () => v.data })),
  }));
  h.aviso = null;
  h.avisosLidos = new Set();
  h.nomes = new Map();
  h.getDocsByIds.mockReset();
  h.getDocsByIds.mockImplementation(
    async (_db: unknown, _handle: unknown, ids: readonly string[]) =>
      new Map(ids.filter((id) => h.nomes.has(id)).map((id) => [id, { nome: h.nomes.get(id) }])),
  );
  window.sessionStorage.clear();
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

  it('(b) gives a conta the query did not return a tab of its own — the link is shown, never dropped', () => {
    h.links = [link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' })];
    renderEditor();

    const orfa = screen.getByRole('tab', { name: /Conta int-9 \(não encontrada\)/ });
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

  it('puts the links whose conta ref names no id in a LAST tab of their own', () => {
    h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: 'documents/tabMedi/tm-1' };
    h.tabMedi = { nome: 'Camisetas adulto', tabelasMedidasShopee: {} };
    h.links = [
      // A raw (unparsed) document with an empty ref — listed FIRST on purpose.
      link('L-sem', { contaProdutoShopeeOuterRef: '' }),
      link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' }),
    ];
    renderEditor();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Loja ASem anúncio',
      'Conta int-9 (não encontrada)1 anúncio(s)',
      'Sem conta legível1 anúncio(s)',
    ]);
    fireEvent.click(screen.getByRole('tab', { name: /Sem conta legível/ }));
    expect(blocosDe('__sem_conta__')).toEqual(['L-sem']);
    expect(within(bloco('L-sem')).getByText(/sem conta legível, nenhum modelo/)).toBeDefined();
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
        // No `acao`, but written for the CLI: the tab's own motivo copy
        // replaces it (PR 8, `TEXTO_MOTIVO_KIT`; the terminal backstop stands behind).
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
    // The motivo's own copy (PR 8), then the id the `acao` names.
    expect(
      d.getByText(`${TEXTO_MOTIVO_KIT['vinculo-substituido'] ?? '?'} Vínculo: L2.`),
    ).toBeDefined();
    expect(d.getByText(/Anúncio\(s\) na Shopee: 1000009\.$/)).toBeDefined();
    expect(d.getByText(TEXTO_MOTIVO_KIT['instabilidade-shopee'] ?? '?')).toBeDefined();
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

  it('names the mid-publish state when Shopee refused after a write', async () => {
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
      etapa: 'init_tier_variation',
    });
    h.client = shopeeClientFalso({ publicar: () => Promise.reject(comEtapa) });
    h.links = [link('L1')];
    renderEditor();
    fireEvent.click(botao('L1', 'Republicar'));
    await waitFor(() =>
      expect(within(bloco('L1')).getByText('A Shopee recusou a publicação')).toBeDefined(),
    );
    expect(within(bloco('L1')).getByText('Na Shopee agora: init_tier_variation.')).toBeDefined();
  });
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
    h.links = [link('L1'), link('L2', { item_id: 1000002 })];
    renderEditor();

    fireEvent.click(botao('L1', 'Reverificar'));
    const escrita = ['Republicar', 'Reverificar', 'Pausar anúncio'];
    for (const id of ['L1', 'L2']) {
      for (const nome of escrita) expect(botao(id, nome).hasAttribute('disabled')).toBe(true);
    }
    expect(reverificarAnuncio.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L1',
    });

    await act(async () => {
      soltar(reverificado({ deboost: true }));
      await Promise.resolve();
    });
    for (const id of ['L1', 'L2']) {
      for (const nome of escrita) expect(botao(id, nome).hasAttribute('disabled')).toBe(false);
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
    h.links = [link('L1')];
    const { unmount } = renderEditor({ disabled: true });
    expect(botao('L1', 'Republicar').hasAttribute('disabled')).toBe(true);
    expect(botao('L1', 'Pausar anúncio').hasAttribute('disabled')).toBe(true);
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

/* -------------------------------------------------------------------------- */
/*                         PR 8 — the native kit                               */
/* -------------------------------------------------------------------------- */

/** A kit produto (`ehKit`) with two sellable units — f2's lone component of quantity 1 is a warning. */
function comKit() {
  h.produto = { nome: 'Kit Camiseta', paiId: null, ehKit: true };
  h.filhos = [
    {
      id: 'f2',
      data: {
        nome: 'Kit G',
        paiId: 'prod-1',
        ordem: 1,
        componentesKit: { c2: { quantidade: 1 } },
      },
    },
    {
      id: 'f1',
      data: {
        nome: 'Kit P',
        paiId: 'prod-1',
        ordem: 0,
        componentesKit: { c1: { quantidade: 2 }, c2: { quantidade: 1 } },
      },
    },
  ];
  h.nomes = new Map([
    ['c1', 'Camiseta'],
    ['c2', 'Boné'],
  ]);
}

const linkKit = (id = 'L-kit', extra: Record<string, unknown> = {}) =>
  link(id, { item_id: 1000002, kitNativo: true, ...extra });

/** A native-kit run's 200 — shaped like `publicar/route.ts`'s kit body. */
function kitPublicado(extra: Partial<KitPublicadoShopee> = {}): RespostaPublicarShopee {
  return {
    tipo: 'kit',
    arma: 'kit-recriar',
    desfecho: 'criado',
    itemId: 1000005,
    linkDocId: 'L-kit-novo',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    kitNativo: true,
    modelos: { vinculados: 2, anexados: 2, semFilho: 0 },
    antecessor: { itemId: 1000002, linkDocId: 'L-kit', excluido: true, substituido: true },
    avisos: [],
    avisosResolvidos: 0,
    recusa: null,
    ...extra,
  };
}

/** The 202: the server could not tell whether `add_kit_item` ran. */
function kitIncerto(extra: Partial<KitPublicadoShopee> = {}): RespostaPublicarShopee {
  return kitPublicado({
    desfecho: 'incerto',
    itemId: null,
    linkDocId: null,
    estadoAnuncio: null,
    itemStatus: null,
    kitNativo: null,
    antecessor: null,
    recusa: { codigo: 'error_server', fraseShopee: 'System busy.', motivo: null },
    ...extra,
  });
}

const kitDe = (linkDocId: string) => within(screen.getByTestId(`shopee-kit-${linkDocId}`));
const incertoDaConta = () => screen.getByTestId('shopee-kit-incerto-int-1');

/** Opens the kit confirmation from the block's button and confirms it. */
function confirmarKit(linkDocId: string, botaoDoBloco: string, titulo: string) {
  fireEvent.click(kitDe(linkDocId).getByRole('button', { name: botaoDoBloco }));
  const dialogo = screen.getByRole('dialog', { name: titulo });
  fireEvent.click(within(dialogo).getByRole('button', { name: botaoDoBloco }));
}

/** Lets the client's promise and every state update it causes land (fake timers: no waitFor). */
async function assentar() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const AGORA = Date.UTC(2026, 9, 15, 15, 0, 0);

describe('ShopeeEditor — the native kit: badge, recipe and aviso', () => {
  it('badges a live native kit "Kit nativo" and a removed one "Kit nativo (inativo)" — and an ordinary listing of an ordinary produto has no kit section', () => {
    h.links = [
      linkKit('L-kit'),
      linkKit('L-kit-rem', { item_id: 1000003, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
      link('L-comum', { item_id: 1000004 }),
    ];
    renderEditor();
    expect(within(bloco('L-kit')).getByText('Kit nativo')).toBeDefined();
    expect(within(bloco('L-kit-rem')).getByText('Kit nativo (inativo)')).toBeDefined();
    expect(within(bloco('L-kit-rem')).queryByText('Kit nativo')).toBeNull();
    expect(within(bloco('L-comum')).getByText('Ativo')).toBeDefined();
    expect(within(bloco('L-comum')).queryByText(/Kit nativo/)).toBeNull();
    expect(screen.queryByTestId('shopee-kit-L-comum')).toBeNull();
  });

  it('reads the recipe only once "Ver composição" opens: each unit’s components by name, and structure warnings that disable nothing', async () => {
    comEscrita();
    comKit();
    h.links = [linkKit('L-kit')];
    renderEditor();
    // Collapsed: neither the children nor the names are read.
    expect(kitDe('L-kit').getByRole('button', { name: 'Ver composição' })).toBeDefined();
    expect(h.consultas.has('produtos')).toBe(false);
    expect(h.getDocsByIds).not.toHaveBeenCalled();

    fireEvent.click(kitDe('L-kit').getByRole('button', { name: 'Ver composição' }));
    const receita = within(screen.getByTestId('shopee-receita-kit'));
    expect(h.consultas.has('produtos')).toBe(true);
    // Units in `ordem` order, each component by its name once the one-shot read lands.
    await waitFor(() =>
      expect(receita.getByText('2 × Camiseta (c1); 1 × Boné (c2)')).toBeDefined(),
    );
    expect(receita.getAllByRole('row').map((r) => r.textContent)).toEqual([
      'VariaçãoComponentes',
      'Kit P2 × Camiseta (c1); 1 × Boné (c2)',
      'Kit G1 × Boné (c2)',
    ]);
    // ONE name read for the distinct components, by id.
    expect(h.getDocsByIds).toHaveBeenCalledTimes(1);
    expect(h.getDocsByIds.mock.calls[0]?.[2]).toEqual(['c1', 'c2']);
    // The schemas adapter's warning, worded for the operator…
    expect(
      within(screen.getByTestId('shopee-receita-kit-avisos')).getByText(
        /A variação Kit G tem um único componente com quantidade 1/,
      ),
    ).toBeDefined();
    // …and never a reason to disable a button.
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('warns that a kit with NO variation cannot be published yet — the saved children, never the form', async () => {
    comEscrita();
    comKit();
    h.filhos = [];
    h.links = [linkKit('L-kit')];
    renderEditor();
    fireEvent.click(kitDe('L-kit').getByRole('button', { name: 'Ver composição' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('shopee-receita-kit-avisos')).getByText(
          /O kit não tem variação vendável/,
        ),
      ).toBeDefined(),
    );
    expect(h.getDocsByIds).not.toHaveBeenCalled();
  });

  it('shows the conta’s OPEN kit-recipe aviso, read by its deterministic id, in the inbox’s own words', () => {
    h.permitidos = new Set([PERM.integracao.read, PERM.aviso.read]);
    h.links = [linkKit('L-kit')];
    const aberto = {
      tipo: TIPO_AVISO.shopeeKitReceitaDivergente,
      params: { kit: 'prod-1', anuncio: '1000002', vinculo: 'L-kit', variacoes: 'f1' },
      resolvidoEm: null,
    };
    h.aviso = aberto;
    const { unmount } = renderEditor();
    expect(h.avisosLidos).toEqual(new Set([chaveAvisoReceitaKitShopee('int-1', 'prod-1')]));
    const aviso = within(screen.getByTestId('shopee-aviso-receita-int-1'));
    expect(aviso.getByText(/use "Recriar kit" no anúncio do vínculo L-kit/)).toBeDefined();
    expect(aviso.getByText(/na aba Shopee do produto/)).toBeDefined();
    unmount();

    // A resolved one is history: not shown.
    h.aviso = { ...aberto, resolvidoEm: 1_790_000_000_000_000 };
    const { unmount: desmontar } = renderEditor();
    expect(screen.queryByTestId('shopee-aviso-receita-int-1')).toBeNull();
    desmontar();

    // A conta with no native-kit link reads no aviso at all.
    h.avisosLidos = new Set();
    h.links = [link('L-comum')];
    renderEditor();
    expect(within(bloco('L-comum')).getByText('Ativo')).toBeDefined();
    expect(h.avisosLidos.size).toBe(0);
  });
});

describe('ShopeeEditor — recriar / converter em kit nativo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(f) Recriar sends {recriar, linkDocId, principal} after a confirmation; Converter sends {converterEmKit} — never both', async () => {
    comEscrita();
    comKit();
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockResolvedValueOnce(kitPublicado())
      .mockResolvedValueOnce(
        kitPublicado({
          arma: 'kit-converter',
          linkDocId: 'L-kit-2',
          antecessor: { itemId: 1000001, linkDocId: 'L-comum', excluido: false, substituido: true },
        }),
      );
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit'), link('L-comum', { item_id: 1000001 })];
    renderEditor();
    // Each arm only where it applies: a native kit recreates, an ordinary listing of a kit converts.
    expect(kitDe('L-kit').queryByRole('button', { name: 'Converter em kit nativo' })).toBeNull();
    expect(kitDe('L-comum').queryByRole('button', { name: 'Recriar kit' })).toBeNull();

    fireEvent.click(kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }));
    const dialogo = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' }));
    // A create makes a NEW kit on Shopee: nothing is sent before the confirmation.
    expect(publicar).not.toHaveBeenCalled();
    expect(
      dialogo.getByText(/só é excluído na Shopee depois que o novo estiver ativo/),
    ).toBeDefined();
    fireEvent.click(dialogo.getByRole('combobox', { name: 'Componente principal' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Boné (c2)' }));
    fireEvent.click(dialogo.getByRole('button', { name: 'Recriar kit' }));

    await waitFor(() =>
      expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined(),
    );
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
      recriar: true,
      principal: 'c2',
    });
    expect(
      within(bloco('L-kit')).getByText('Kit novo: vínculo L-kit-novo (anúncio 1000005 na Shopee).'),
    ).toBeDefined();
    expect(
      within(bloco('L-kit')).getByText(
        'O anúncio anterior (vínculo L-kit) foi excluído na Shopee.',
      ),
    ).toBeDefined();

    // No principal picked for this link: the ERP chooses, and no key is sent.
    confirmarKit('L-comum', 'Converter em kit nativo', 'Converter em kit nativo');
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-comum',
      converterEmKit: true,
    });
    for (const [corpo] of publicar.mock.calls) {
      expect(corpo.recriar === true && corpo.converterEmKit === true).toBe(false);
    }
  });

  it('offers no Converter on a produto that is not a kit — the server’s own pre-filter', () => {
    comEscrita();
    h.links = [link('L-comum')];
    renderEditor();
    expect(within(bloco('L-comum')).getByRole('button', { name: 'Republicar' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Converter em kit nativo' })).toBeNull();
  });

  it('(g) two clicks that land before a re-render send ONE kit create, and every write button waits for it', async () => {
    comEscrita();
    comKit();
    let soltar: (r: RespostaPublicarShopee) => void = () => undefined;
    const publicar = vi.fn<ShopeeClient['publicar']>(
      () =>
        new Promise((resolve) => {
          soltar = resolve;
        }),
    );
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit'), link('L-comum', { item_id: 1000001 })];
    renderEditor();

    fireEvent.click(kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }));
    const confirmar = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' })).getByRole(
      'button',
      { name: 'Recriar kit' },
    );
    // Both handlers run against the SAME render — a state-only lock reads `emVoo === null` twice.
    act(() => {
      confirmar.click();
      confirmar.click();
    });
    expect(publicar).toHaveBeenCalledTimes(1);
    for (const nome of ['Republicar', 'Reverificar', 'Pausar anúncio']) {
      expect(botao('L-comum', nome).hasAttribute('disabled')).toBe(true);
    }
    expect(
      kitDe('L-comum')
        .getByRole('button', { name: 'Converter em kit nativo' })
        .hasAttribute('disabled'),
    ).toBe(true);

    act(() => soltar(kitPublicado()));
    await waitFor(() =>
      expect(botao('L-comum', 'Republicar').hasAttribute('disabled')).toBe(false),
    );
    expect(publicar).toHaveBeenCalledTimes(1);
    expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined();
  });

  it('(h) a 422 whose acao is recriar opens the Recriar confirmation on the link it NAMES — and no terminal text renders', async () => {
    comEscrita();
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(
        recusa422([
          {
            campo: 'linkDocId',
            motivo: 'listagem-removida',
            mensagem:
              'o kit 1000002 foi removido na Shopee — publique com --link L2 --recriar para criar ' +
              'um kit novo (publicar:anuncio)',
            acao: { tipo: TIPO.recriar, linkDocId: 'L2' },
          },
        ]),
      )
      .mockResolvedValueOnce(kitPublicado({ antecessor: null, linkDocId: 'L-kit-novo' }));
    h.client = shopeeClientFalso({ publicar });
    h.links = [
      link('L1'),
      linkKit('L2', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido, item_id: 1000002 }),
    ];
    renderEditor();

    fireEvent.click(botao('L1', 'Republicar'));
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L1')));
    expect(desfecho.getByText(`${TEXTO_ACAO_SUGERIDA[TIPO.recriar]} Vínculo: L2.`)).toBeDefined();
    expect(document.body.textContent).not.toMatch(TEXTO_DE_TERMINAL);

    fireEvent.click(desfecho.getByRole('button', { name: 'Recriar o kit do vínculo L2' }));
    const dialogo = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' }));
    // The modal speaks of L2 — the removed kit the acao named, not the block the row sits in.
    expect(
      dialogo.getByText(/O kit antigo \(vínculo L2\) já foi excluído na Shopee/),
    ).toBeDefined();
    fireEvent.click(dialogo.getByRole('button', { name: 'Recriar kit' }));
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L2',
      recriar: true,
    });
    await waitFor(() =>
      expect(within(bloco('L2')).getByText('Kit nativo criado na Shopee')).toBeDefined(),
    );
  });

  it('an informar-principal refusal of a recriar re-opens the SAME arm on the same link with the pick — NEAR-MISS: after a plain republish it offers none', async () => {
    comEscrita();
    comKit();
    const principalObrigatorio: ProblemaShopee = {
      campo: 'principal',
      motivo: 'principal-obrigatorio',
      mensagem: 'o kit tem componentes de mais de um anúncio da Shopee — informe (--principal)',
      acao: { tipo: TIPO.informarPrincipal },
    };
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422([principalObrigatorio]))
      .mockResolvedValueOnce(kitPublicado())
      .mockRejectedValueOnce(recusa422([principalObrigatorio]));
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit')];
    renderEditor();

    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L-kit')));
    expect(desfecho.getByText(TEXTO_MOTIVO_KIT['principal-obrigatorio'] ?? '?')).toBeDefined();
    fireEvent.click(desfecho.getByRole('button', { name: 'Escolher o componente principal' }));
    const dialogo = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' }));
    fireEvent.click(dialogo.getByRole('combobox', { name: 'Componente principal' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Camiseta (c1)' }));
    fireEvent.click(dialogo.getByRole('button', { name: 'Recriar kit' }));
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
      recriar: true,
      principal: 'c1',
    });

    // The same refusal answering a plain republish: there is no kit arm to re-open.
    await waitFor(() =>
      expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined(),
    );
    fireEvent.click(botao('L-kit', 'Republicar'));
    const outra = within(await waitFor(() => screen.getByTestId('shopee-problema-L-kit-0')));
    expect(outra.getByText(TEXTO_MOTIVO_KIT['principal-obrigatorio'] ?? '?')).toBeDefined();
    expect(outra.queryByRole('button')).toBeNull();
  });

  it('(i) a 202 is UNCERTAIN: Repetir waits aguardarMs, then re-sends the IDENTICAL body — never "falhou"', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockResolvedValueOnce(kitIncerto({ aguardarMs: 60_000 }))
      .mockResolvedValueOnce(kitPublicado());
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit')];
    renderEditor();

    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    await assentar();
    const incerto = within(incertoDaConta());
    expect(incerto.getByText('A Shopee pode ter criado o kit')).toBeDefined();
    expect(incerto.getByText('A Shopee respondeu: System busy.')).toBeDefined();
    // Not an outcome of the link and never a failure: the kit may exist.
    expect(screen.queryByTestId('shopee-desfecho-L-kit')).toBeNull();
    expect(document.body.textContent).not.toMatch(/falhou/i);
    const repetir = () => incerto.getByRole('button', { name: 'Repetir' });
    expect(repetir().hasAttribute('disabled')).toBe(true);
    // A second create would be a second kit: the arm waits too.
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(true);
    // The wait and the body are kept for this browser tab.
    const guardado: unknown = JSON.parse(
      window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1')) ?? 'null',
    );
    expect(guardado).toStrictEqual({ ate: AGORA + 60_000, corpo: publicar.mock.calls[0]?.[0] });

    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(repetir().hasAttribute('disabled')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(repetir().hasAttribute('disabled')).toBe(false);

    fireEvent.click(repetir());
    await assentar();
    expect(publicar).toHaveBeenCalledTimes(2);
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
      recriar: true,
    });
    // IDENTICAL: a plain publish here would reach a different arm.
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual(publicar.mock.calls[0]?.[0]);
    expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined();
    // Answered: the wait is over, here and in the store.
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
  });

  it('(l) a 202 WITHOUT aguardarMs waits the schemas’ AGUARDAR_KIT_INCERTO_SHOPEE_MS', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    h.client = shopeeClientFalso({ publicar: async () => kitIncerto() });
    h.links = [linkKit('L-kit')];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    await assentar();
    const repetir = () => within(incertoDaConta()).getByRole('button', { name: 'Repetir' });
    act(() => {
      vi.advanceTimersByTime(AGUARDAR_KIT_INCERTO_SHOPEE_MS - 1);
    });
    expect(repetir().hasAttribute('disabled')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(repetir().hasAttribute('disabled')).toBe(false);
  });

  it('(j) a network error, a 503 or a 504 on a create is UNCERTAIN — never the failure copy', async () => {
    for (const falha of [
      new ShopeeClientNetworkError('Failed to fetch', new TypeError('x')),
      new ShopeeClientHttpError('indisponível', 503, 'SHOPEE_UNAVAILABLE'),
      new ShopeeClientHttpError('tempo esgotado', 504, null),
    ]) {
      window.sessionStorage.clear();
      comEscrita();
      comKit();
      h.client = shopeeClientFalso({ publicar: () => Promise.reject(falha) });
      h.links = [linkKit('L-kit')];
      const { unmount } = renderEditor();
      confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
      await waitFor(() => expect(incertoDaConta()).toBeDefined());
      expect(screen.queryByTestId('shopee-desfecho-L-kit')).toBeNull();
      expect(screen.queryByText('Não foi possível contatar a integração com a Shopee.')).toBeNull();
      const guardado = JSON.parse(
        window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1')) ?? 'null',
      ) as { ate: number } | null;
      // No body carried a wait: the schemas’ constant, from the moment it failed.
      expect(guardado?.ate).toBeGreaterThan(Date.now() + AGUARDAR_KIT_INCERTO_SHOPEE_MS - 60_000);
      unmount();
    }
  });

  it('NEAR-MISS: a rate-limited 502 on a create is a DEFINITE refusal — the failure copy, no wait', async () => {
    comEscrita();
    comKit();
    h.client = shopeeClientFalso({
      publicar: () =>
        Promise.reject(
          new ShopeeClientHttpError('limite', 502, 'SHOPEE_HTTP_ERROR', null, 'burst'),
        ),
    });
    h.links = [linkKit('L-kit')];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    await waitFor(() => expect(screen.getByTestId('shopee-desfecho-L-kit')).toBeDefined());
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('keeps an uncertain create across a reload of the tab, and a DEFINITE answer to its Repetir ends it', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    const corpo = {
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
      recriar: true as const,
      principal: 'c2',
    };
    window.sessionStorage.setItem(
      chaveIncerto('int-1', 'prod-1'),
      JSON.stringify({ ate: AGORA + 30_000, corpo }),
    );
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(
      recusa422([
        {
          campo: 'sku',
          motivo: 'kit-ja-existe-na-shopee',
          mensagem:
            'já existe na Shopee um kit com o SKU deste produto — importe-o (importar:anuncio)',
          acao: { tipo: TIPO.importar, itemIds: [1000005] },
        },
      ]),
    );
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit')];
    renderEditor();

    // A fresh page found it in the store: the wait holds, and so does the arm.
    const repetir = () => within(incertoDaConta()).getByRole('button', { name: 'Repetir' });
    expect(repetir().hasAttribute('disabled')).toBe(true);
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(true);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    fireEvent.click(repetir());
    await assentar();
    // The stored body, verbatim — the principal included.
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual(corpo);
    // The server read the shop and said "the kit exists": the uncertainty is over.
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
    expect(
      within(screen.getByTestId('shopee-desfecho-L-kit')).getByText(
        /Anúncio\(s\) na Shopee: 1000005/,
      ),
    ).toBeDefined();
  });

  it('ignores a stored value that is not a body it may re-send', () => {
    comEscrita();
    comKit();
    window.sessionStorage.setItem(chaveIncerto('int-1', 'prod-1'), '{corrompido');
    h.links = [linkKit('L-kit')];
    renderEditor();
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('(m) a kit 200 words each aviso by its code — an unknown one and "constructor" read the neutral line — with buttons on the links the BODY names', async () => {
    comEscrita();
    comKit();
    const reverificarAnuncio = vi.fn<ShopeeClient['reverificarAnuncio']>(async () =>
      reverificado(),
    );
    h.client = shopeeClientFalso({
      publicar: async () =>
        kitPublicado({
          antecessor: { itemId: 1000002, linkDocId: 'L-kit', excluido: false, substituido: true },
          avisos: [
            { codigo: 'kit-antigo-nao-excluido', produtoId: null },
            { codigo: 'kit-codigo-novo', produtoId: 'f1' },
            { codigo: 'constructor', produtoId: null },
          ],
        }),
      reverificarAnuncio,
    });
    h.links = [linkKit('L-kit'), linkKit('L-kit-novo', { item_id: 1000005 })];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');

    const avisos = within(await waitFor(() => screen.getByTestId('shopee-kit-avisos')));
    expect(avisos.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      TEXTO_AVISO_KIT['kit-antigo-nao-excluido'],
      'Aviso da Shopee (kit-codigo-novo). (produto f1)',
      'Aviso da Shopee (constructor).',
    ]);
    expect(document.body.textContent).not.toMatch(TEXTO_DE_TERMINAL);
    expect(
      within(bloco('L-kit')).getByText(
        'O anúncio anterior (vínculo L-kit) foi marcado como substituído e ainda pode estar ' +
          'vendendo na Shopee.',
      ),
    ).toBeDefined();
    // The old kit's re-verify, on the link the body names.
    fireEvent.click(
      within(bloco('L-kit')).getByRole('button', { name: 'Reverificar o vínculo L-kit' }),
    );
    await waitFor(() => expect(reverificarAnuncio).toHaveBeenCalledTimes(1));
    expect(reverificarAnuncio.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
    });
  });
});
