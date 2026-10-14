import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { ESTADO_ANUNCIO_SHOPEE, INTEGRACAO_TIPO, SHOPEE_MODEL_STATUS } from '@delfrance/schemas';
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
  produto: { nome: 'Camiseta', paiId: null } as Record<string, unknown> | null,
  tabMedi: null as Record<string, unknown> | null,
  /** The snapshot hooks' `loading` — a re-listen keeps `data` (R1). */
  carregando: false,
  permitidos: new Set<bigint>(),
  getDocs: vi.fn(),
  /** Every collection a live query was opened on — what the tab chose to READ. */
  consultas: new Set<string>(),
}));

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
  h.produto = { nome: 'Camiseta', paiId: null };
  h.tabMedi = null;
  h.carregando = false;
  h.consultas = new Set();
  h.permitidos = new Set([PERM.integracao.read]);
  h.getDocs.mockReset();
  h.getDocs.mockImplementation(async (q: { produtoId: string }) => ({
    docs: (h.varLinks.get(q.produtoId) ?? []).map((v) => ({ id: v.id, data: () => v.data })),
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
});
