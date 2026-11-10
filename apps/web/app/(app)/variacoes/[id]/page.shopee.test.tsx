import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import { CODIGO_ERRO_LI, INTEGRACAO_TIPO, grupoDeVariacoesSchema } from '@delfrance/schemas';
import type { RespostaVariacoesShopee } from '@/lib/shopee/wire';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * `/variacoes/[id]` with its "Shopee" tab (#1911 P14), through the REAL page, the REAL
 * `ObjectView` + `saveRecord`, the REAL tab and the REAL `validate`, over an OCC FakeDb
 * (`@delfrance/data/testing`). The Loja Integrada tab's own page test, `page.test.tsx`,
 * stays as it was: it is half of the proof that composing the two tabs changed nothing.
 *
 * What only this file can show: that a Shopee edit reaches the store and touches no other
 * channel's array; that a stored defect blocks nothing until an edit goes through it, and
 * that this holds with the tab never opened (the seed is published from a hidden tab);
 * that the strict field's unreadable element really blocks every save, and that staging
 * its removal really unblocks it; and that a conflicting save merges entry by entry
 * through the form's own machinery, where RHF clones whatever it re-applies.
 *
 * Doubled are only the I/O edges: the snapshot hook (`h.servido` is what the listener
 * shows, `h.docs` what the store holds), the guarded save's engine, the collection handle
 * (its `get` runs the converter's soft parse), the conta list, and both channels' backend
 * clients. Trees are hand-written in the shape of the public captures; everything named
 * «inventada» and every `9xxxxx` id is invented.
 */

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  servido: new Map<string, { raw: Record<string, unknown>; fromCache: boolean }>(),
  occ: null as unknown as import('@delfrance/data/testing').OccEngine,
  ler: (raw: Record<string, unknown>): Record<string, unknown> => raw,
  replace: vi.fn(),
  toasts: [] as string[],
  grades: vi.fn(),
  grade: vi.fn(),
  variacoes: vi.fn(),
  categorias: vi.fn(),
  limitesDoItem: vi.fn(),
  /** The top-level keys each committed write named. */
  escritas: [] as string[][],
  /** The props the page last handed the REAL `ObjectView` (a pass-through spy). */
  propsObjectView: null as Record<string, unknown> | null,
}));

vi.mock('@delfrance/ui', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/ui')>();
  const { createElement } = await import('react');
  const Real = actual.ObjectView as unknown as (p: Record<string, unknown>) => ReactNode;
  return {
    ...actual,
    ObjectView: (p: Record<string, unknown>) => {
      h.propsObjectView = p;
      return createElement(Real, p);
    },
  };
});

function refFalso(path: string) {
  const ref = {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => ({
      exists: () => h.docs.has(path),
      data: () => h.ler(structuredClone(h.docs.get(path)!)),
    }),
    withConverter: () => ref,
  };
  return ref;
}

vi.mock('@/lib/data/grupoDeVariacoesCollection', () => ({
  grupoDeVariacoesCollection: {
    resolvePath: () => 'grupoDeVariacoes',
    ref: () => ({ __col: 'grupoDeVariacoes' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => refFalso(`grupoDeVariacoes/${id}`),
    converter: {},
    merge: vi.fn(),
  },
}));

vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useDocSnapshot: (ref: { path: string } | null) => {
    const servido = ref == null ? undefined : h.servido.get(ref.path);
    if (ref == null || servido === undefined)
      return { data: undefined, loading: ref != null, error: undefined };
    return {
      data: { id: ref.path.split('/')[1], data: h.ler(structuredClone(servido.raw)) },
      loading: false,
      error: undefined,
      fromCache: servido.fromCache,
      hasPendingWrites: false,
      documentPath: ref.path,
    };
  },
}));

vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.occ.runTransaction(fn),
  deleteDoc: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true, loading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'g1' }),
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/useIntegracoes', () => {
  const rows = [
    { id: 'CONTA1', data: { tipo: INTEGRACAO_TIPO.lojaIntegrada, nome: 'Loja A', ativo: true } },
    { id: 'int-1', data: { tipo: INTEGRACAO_TIPO.shopee, nome: 'Conta A', ativo: true } },
    { id: 'int-2', data: { tipo: INTEGRACAO_TIPO.shopee, nome: 'Conta B', ativo: false } },
  ];
  return {
    useIntegracoes: () => ({
      rows,
      byId: new Map(rows.map((r) => [r.id, r.data])),
      status: 'success',
    }),
  };
});
vi.mock('@/lib/loja-integrada/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/loja-integrada/client')>();
  const { lojaIntegradaClientFalso } = await import('@/lib/testing/lojaIntegradaClientFalso');
  const client = lojaIntegradaClientFalso({ grades: h.grades, grade: h.grade });
  return { ...actual, useBackendLojaIntegrada: () => ({ client, indisponivel: null }) };
});
vi.mock('@/lib/shopee/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/client')>();
  const { shopeeClientFalso } = await import('@/lib/testing/shopeeClientFalso');
  const client = shopeeClientFalso({
    variacoes: h.variacoes,
    categorias: h.categorias,
    limitesDoItem: h.limitesDoItem,
  });
  return { ...actual, useShopeeClient: () => client };
});
vi.mock('@mantine/notifications', async (importActual) => {
  const actual = await importActual<typeof import('@mantine/notifications')>();
  return {
    ...actual,
    notifications: {
      ...actual.notifications,
      show: (o: { message?: unknown }) => {
        h.toasts.push(String(o.message));
        return '';
      },
    },
  };
});

const { default: GrupoVariacaoPage } = await import('./page');
const {
  GRUPO_EXCLUDED_FIELDS_EDICAO,
  GRUPO_PERSISTENT_SECTIONS,
  GRUPO_PERSISTENT_SECTIONS_EDICAO,
  GRUPO_SECTIONS_EDICAO,
} = await import('../_components/grupoFields');
const { LojaIntegradaClientHttpError } = await import('@/lib/loja-integrada/client');

const PATH = 'grupoDeVariacoes/g1';
const FASHION = 100244;
const OUTRA_FASHION = 100352;
const BR = 844758844060204;

/** The client converter's soft read: the parsed doc, or the raw one when the parse fails. */
h.ler = (raw) => {
  const r = grupoDeVariacoesSchema.safeParse(raw);
  return (r.success ? r.data : raw) as Doc;
};

const opcao = (id: number, nome: string, variantes: string[]): Doc => ({
  shopee_option_id: id,
  shopee_option_name: nome,
  arakene_variation_id: variantes,
});
const variante = (id: string, nome: string) => ({ id, nome, codigo: null });
const P = variante('v1', 'P');
const M = variante('v2', 'M');
const G = variante('v3', 'G');

const vinculo = (extra: Doc = {}): Doc => ({
  name: 'Camisetas',
  category_id: FASHION,
  variation_id: 101054,
  variation_group_list: 0,
  integracaoShopeeId: 'int-1',
  variationOptions: [opcao(6258, 'Preto', ['v1'])],
  ...extra,
});
/** The import's shape for another category, as a concurrent re-import would write it. */
const DA_IMPORTACAO = vinculo({ name: 'Calças inventadas', category_id: OUTRA_FASHION });

const LINK_LI: Doc = {
  name: 'Tamanho',
  grade_id: 8946,
  integracaoLiId: 'CONTA1',
  variationOptions: [{ li_option_id: 37097, li_option_name: 'P', arakene_variation_id: ['v1'] }],
};
const LINK_AMAZON: Doc = { qualquer: 'coisa inventada', asin: 'INVENTADO' };

function grupo(extra: Doc = {}): Doc {
  return {
    nome: 'Tamanhos',
    codigo: null,
    ordem: 1,
    tipo: 1,
    permiteFotos: false,
    timestamp: 1_700_000_000_000,
    ultimaModificacao: 1_700_000_000_000,
    variacoesIds: ['v1', 'v2', 'v3'],
    variacoes: [P, M, G],
    linksVariacoesli: [LINK_LI],
    linksVariacoesAmazon: [LINK_AMAZON],
    linksVariacoesShopee: [vinculo()],
    ...extra,
  };
}

/** The tree every leaf answers: Cor with one group, Tamanho with two. */
const ARVORE: RespostaVariacoesShopee = {
  leaf: true,
  categoryId: FASHION,
  pathUsed: '/api/v2/product/get_variation_tree',
  standardiseVariationList: [
    {
      variationId: 101054,
      variationName: 'Cor',
      variationGroupList: [
        {
          variationGroupId: 0,
          variationGroupName: '',
          variationOptionList: [
            { variationOptionId: 6258, variationOptionName: 'Preto' },
            { variationOptionId: 9585, variationOptionName: 'Preto' },
            { variationOptionId: 9632, variationOptionName: 'Azul Turquesa' },
          ],
        },
      ],
    },
    {
      variationId: 101056,
      variationName: 'Tamanho',
      variationGroupList: [
        {
          variationGroupId: BR,
          variationGroupName: 'Tamanho (BR)',
          variationOptionList: [{ variationOptionId: 6933, variationOptionName: 'M' }],
        },
        {
          variationGroupId: 841350766059029,
          variationGroupName: 'Tamanho (INT)',
          variationOptionList: [{ variationOptionId: 6270, variationOptionName: 'M' }],
        },
      ],
    },
  ],
};

function semear(raw: Doc) {
  h.docs.set(PATH, structuredClone(raw));
  h.servido.set(PATH, { raw: structuredClone(raw), fromCache: false });
}

/** Another writer's commit, landing after this page loaded (the listener sees it too). */
function escritaConcorrente(alterar: (doc: Doc) => void): Doc {
  const remoto = structuredClone(h.docs.get(PATH)!);
  alterar(remoto);
  h.docs.set(PATH, remoto);
  h.servido.set(PATH, { raw: structuredClone(remoto), fromCache: false });
  return remoto;
}

let rerenderPage: () => void = () => undefined;
async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = () => (
    <QueryClientProvider client={qc}>
      <MantineTestProvider>
        <GrupoVariacaoPage />
      </MantineTestProvider>
    </QueryClientProvider>
  );
  const view = render(arvore());
  rerenderPage = () => view.rerender(arvore());
  await esperar();
}

async function esperar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function clicar(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
  await esperar();
}

async function abrirAba(nome: string) {
  await clicar(screen.getByRole('tab', { name: nome }));
}

const cartao = (categoria = FASHION) => screen.getByTestId(`vinculo-shopee-int-1-${categoria}`);
const bloco = () => screen.getByTestId('vinculador-shopee-conta-int-1');

/** Pick `rotulo` in the `Select` labelled `label` inside `escopo`. */
async function escolher(escopo: HTMLElement, label: string, rotulo: string) {
  await clicar(within(escopo).getAllByLabelText(label)[0]!);
  await clicar(await within(escopo).findByRole('option', { name: rotulo }));
}

async function renomear(nome: string) {
  await abrirAba('Dados gerais');
  await act(async () => {
    // The grupo's own "Nome" comes first; every variante row has one too.
    fireEvent.change(screen.getAllByLabelText('Nome')[0]!, { target: { value: nome } });
  });
}

async function salvar() {
  await clicar(screen.getByRole('button', { name: 'Salvar e continuar' }));
  await esperar();
}

const commits = () => h.occ.txLog.filter((e) => e.phase === 'commit').length;
const guardado = () => h.docs.get(PATH)!;
const conflito = () => screen.queryByText('Registro alterado');
/** The page refused the save with its "fix the tab" toast. */
const recusado = () => h.toasts.some((t) => t.startsWith('Corrija os campos inválidos'));

beforeEach(() => {
  h.docs.clear();
  h.servido.clear();
  h.toasts.length = 0;
  h.escritas.length = 0;
  h.replace.mockReset();
  const desligado = () =>
    new LojaIntegradaClientHttpError('desligadas', 503, CODIGO_ERRO_LI.chamadasDesligadas);
  h.grades.mockReset().mockRejectedValue(desligado());
  h.grade.mockReset().mockRejectedValue(desligado());
  h.variacoes.mockReset().mockResolvedValue(ARVORE);
  h.categorias.mockReset().mockResolvedValue({
    raizes: [
      { categoryId: FASHION, name: 'Camisetas', originalName: null, isLeaf: true },
      { categoryId: OUTRA_FASHION, name: 'Calças inventadas', originalName: null, isLeaf: true },
    ],
    no: null,
  });
  h.limitesDoItem.mockReset();
  h.occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      h.escritas.push(Object.keys(data as Doc));
      const prev = h.docs.get(path) ?? {};
      h.docs.set(path, kind === 'update' ? { ...prev, ...structuredClone(data) } : data);
    },
  });
});

describe('/variacoes/[id] — a aba Shopee na página de edição', () => {
  it('é a última aba, com o nome exato que a frase do publicador cita', async () => {
    semear(grupo());
    await renderPage();

    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toStrictEqual([
      'Dados gerais',
      'Variantes',
      'Loja Integrada',
      'Shopee',
    ]);
    expect(h.variacoes).not.toHaveBeenCalled();
    expect(h.categorias).not.toHaveBeenCalled();
  });

  it('a aba Shopee fica montada escondida: só assim a semente chega ao `validate` sem abri-la', async () => {
    // ⚠️ Under `MantineTestProvider` no tab is ever suspended (`env="test"` renders no
    // `<Activity>`), so the save tests below cannot see this. The chain is pinned in two
    // halves: here, that the page hands `ObjectView` the edit constants; in
    // `SectionTabs.persistence.test.tsx`, that a persistent section keeps its effects.
    semear(grupo());
    await renderPage();

    expect(h.propsObjectView?.persistentSections).toStrictEqual(GRUPO_PERSISTENT_SECTIONS_EDICAO);
    expect(h.propsObjectView?.sections).toStrictEqual(GRUPO_SECTIONS_EDICAO);
    expect(h.propsObjectView?.excludedFields).toStrictEqual(GRUPO_EXCLUDED_FIELDS_EDICAO);
    expect(GRUPO_PERSISTENT_SECTIONS_EDICAO).toStrictEqual(['Loja Integrada', 'Shopee']);
    // ⚠️ QUASE-PAR: the create page has no Shopee tab to keep.
    expect(GRUPO_PERSISTENT_SECTIONS).toStrictEqual(['Loja Integrada']);
  });

  it('abrir a aba lê a árvore da categoria e mostra o guardado, com a etiqueta e as frases', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Shopee');

    expect(h.variacoes).toHaveBeenCalledWith({ integracaoId: 'int-1', categoryId: FASHION });
    expect(within(cartao()).getByText('Cor (101054)')).toBeTruthy();
    expect(screen.getByText(/Nas categorias de moda, a Shopee tem variações padrão/)).toBeTruthy();
    expect(screen.getByText(/A importação de anúncios da Shopee também grava/)).toBeTruthy();
  });
});

describe('/variacoes/[id] — uma edição da Shopee vai na gravação do grupo', () => {
  it('escreve só `linksVariacoesShopee`: os outros canais ficam byte a byte', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Shopee');

    await escolher(cartao(), 'Opção da Shopee para «M»', 'Azul Turquesa (9632)');
    await salvar();

    expect(recusado()).toBe(false);
    expect(commits()).toBe(1);
    expect(h.escritas).toHaveLength(1);
    expect(h.escritas[0]!.filter((k) => k !== 'ultimaModificacao')).toStrictEqual([
      'linksVariacoesShopee',
    ]);
    expect(guardado().linksVariacoesShopee).toEqual([
      vinculo({
        variationOptions: [opcao(6258, 'Preto', ['v1']), opcao(9632, 'Azul Turquesa', ['v2'])],
      }),
    ]);
    expect(guardado().linksVariacoesli).toEqual([LINK_LI]);
    expect(guardado().linksVariacoesAmazon).toEqual([LINK_AMAZON]);
  });

  it('um vínculo adicionado pelo modal grava a conta nua, o grupo exato e nenhum outro campo', async () => {
    semear(grupo({ linksVariacoesShopee: null }));
    await renderPage();
    await abrirAba('Shopee');

    await clicar(within(bloco()).getByRole('button', { name: 'Adicionar vínculo' }));
    const modal = screen.getByTestId('shopee-novo-vinculo-modal');
    const linha = await within(modal).findByTestId(`shopee-categoria-linha-${FASHION}`);
    await clicar(within(linha).getByRole('button', { name: 'Escolher' }));
    await esperar();
    await escolher(modal, 'Variação da Shopee', 'Tamanho (101056)');
    await escolher(modal, 'Grupo de opções', `Tamanho (BR) (${BR})`);
    await clicar(within(modal).getByRole('button', { name: 'Adicionar' }));
    await escolher(cartao(), 'Opção da Shopee para «M»', 'M (6933)');
    await salvar();

    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesShopee).toEqual([
      {
        name: 'Camisetas',
        category_id: FASHION,
        variation_id: 101056,
        variation_group_list: 844758844060204,
        integracaoShopeeId: 'int-1',
        variationOptions: [opcao(6933, 'M', ['v2'])],
      },
    ]);
    expect(guardado().linksVariacoesli).toEqual([LINK_LI]);
    expect(guardado().linksVariacoesAmazon).toEqual([LINK_AMAZON]);
  });

  it('uma variante digitada na aba Variantes vira opção personalizada, com o nome dela', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Variantes');
    await clicar(screen.getByRole('button', { name: 'Adicionar variante' }));
    await act(async () => {
      const nomes = screen.getAllByLabelText('Nome');
      fireEvent.change(nomes[nomes.length - 1]!, { target: { value: ' Cor do ERP ' } });
    });

    await abrirAba('Shopee');
    await escolher(
      cartao(),
      'Opção da Shopee para « Cor do ERP »',
      'Personalizada: « Cor do ERP »',
    );
    await salvar();

    expect(commits()).toBe(1);
    const nova = (guardado().variacoes as { id: string; nome: string }[]).at(-1)!;
    expect(nova.nome).toBe(' Cor do ERP ');
    expect((guardado().linksVariacoesShopee as Doc[])[0]?.variationOptions).toEqual([
      opcao(6258, 'Preto', ['v1']),
      opcao(0, ' Cor do ERP ', [nova.id]),
    ]);
  });

  it('⚠️ QUASE-PAR: uma variante recém-acrescentada, ainda sem nome, não oferece a opção personalizada', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Variantes');
    await clicar(screen.getByRole('button', { name: 'Adicionar variante' }));

    await abrirAba('Shopee');
    // The new variante is the last row; with no name it is labelled by its id.
    const selects = within(cartao()).getAllByRole('combobox', { name: /^Opção da Shopee para «/ });
    expect(selects).toHaveLength(4);
    await clicar(selects.at(-1)!);
    const item = await within(cartao()).findByRole('option', { name: /^Personalizada: «/ });
    expect(item.getAttribute('data-combobox-disabled')).toBe('true');
    await clicar(item);
    expect((selects.at(-1) as HTMLInputElement).value).toBe('Sem opção');
  });

  it('uma remoção preparada sai ao salvar; os outros vínculos voltam como estavam', async () => {
    const inativa = vinculo({ integracaoShopeeId: 'int-2' });
    semear(grupo({ linksVariacoesShopee: [vinculo(), inativa] }));
    await renderPage();
    await abrirAba('Shopee');

    await clicar(within(cartao()).getByRole('button', { name: 'Remover vínculo' }));
    expect(within(cartao()).getByText('Será removido')).toBeTruthy();
    await salvar();

    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesShopee).toEqual([inativa]);
  });

  it('⚠️ uma entrada guardada fica preparada mesmo depois de outra edição ter re-renderizado o form', async () => {
    // RHF drops `formState.defaultValues` from a root re-render unless a `reset` set it;
    // `ObjectView` resets on load. Without the seed, a stored entry would read as NEW and
    // leave the list at once.
    const inativa = vinculo({ integracaoShopeeId: 'int-2' });
    semear(grupo({ linksVariacoesShopee: [inativa] }));
    await renderPage();
    await renomear('Tamanhos (meu)');
    await abrirAba('Shopee');

    const linha = screen.getByTestId('vinculo-shopee-leitura-0');
    await clicar(within(linha).getByRole('button', { name: 'Remover vínculo' }));

    expect(within(linha).getByText('Será removido')).toBeTruthy();
    await clicar(within(linha).getByRole('button', { name: 'Desfazer remoção' }));
    await salvar();
    expect(h.escritas[0]).not.toContain('linksVariacoesShopee');
    expect(guardado().linksVariacoesShopee).toEqual([inativa]);
  });
});

describe('/variacoes/[id] — um defeito guardado só bloqueia pelo vínculo que esta gravação muda', () => {
  const EM_DUAS_OPCOES = vinculo({
    variationOptions: [opcao(6258, 'Preto', ['v1']), opcao(9632, 'Azul Turquesa', ['v1'])],
  });

  it('IGUAL: renomear com defeitos guardados salva, sem abrir a aba, sem ler nada, sem tocar os vínculos', async () => {
    const legado = [EM_DUAS_OPCOES, EM_DUAS_OPCOES, vinculo({ category_id: OUTRA_FASHION })];
    semear(grupo({ linksVariacoesShopee: legado }));
    await renderPage();

    await renomear('Tamanhos renomeado');
    await salvar();

    expect(recusado()).toBe(false);
    expect(commits()).toBe(1);
    expect(guardado().nome).toBe('Tamanhos renomeado');
    expect(guardado().linksVariacoesShopee).toEqual(legado);
    expect(h.escritas[0]).not.toContain('linksVariacoesShopee');
    expect(h.variacoes).not.toHaveBeenCalled();
  });

  it('⚠️ QUASE-PAR: o mesmo defeito numa entrada EDITADA é recusado, na aba Shopee', async () => {
    semear(grupo({ linksVariacoesShopee: [EM_DUAS_OPCOES] }));
    await renderPage();
    await abrirAba('Shopee');

    await escolher(cartao(), 'Opção da Shopee para «M»', 'Preto (9585)');
    await renomear('Tamanhos (meu)');
    await salvar();

    expect(recusado()).toBe(true);
    expect(h.toasts.at(-1)).toContain('"Shopee"');
    expect(commits()).toBe(0);
    expect(screen.getByRole('tab', { name: /Shopee/ }).getAttribute('aria-selected')).toBe('true');
    expect(
      screen.getByText(
        'Vínculos Shopee: a variante «P» está em mais de uma opção do vínculo da categoria 100244.',
      ),
    ).toBeTruthy();
  });

  it('⚠️ QUASE-PAR: resolver o defeito libera a mesma gravação', async () => {
    semear(grupo({ linksVariacoesShopee: [EM_DUAS_OPCOES] }));
    await renderPage();
    await abrirAba('Shopee');

    await escolher(cartao(), 'Opção da Shopee para «P»', 'Preto (6258)');
    await salvar();

    expect(recusado()).toBe(false);
    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesShopee).toEqual([vinculo()]);
  });

  it('editar uma gêmea é recusado: a chave aparece duas vezes', async () => {
    semear(grupo({ linksVariacoesShopee: [vinculo(), vinculo({ name: 'Gêmea' })] }));
    await renderPage();
    await abrirAba('Shopee');

    const [, gemea] = within(bloco()).getAllByTestId(`vinculo-shopee-int-1-${FASHION}`);
    await escolher(gemea!, 'Opção da Shopee para «M»', 'Preto (9585)');
    await salvar();

    expect(recusado()).toBe(true);
    expect(commits()).toBe(0);
    expect(
      screen.getByText(
        'Vínculos Shopee: o vínculo com a conta int-1 na categoria 100244 aparece mais de uma vez.',
      ),
    ).toBeTruthy();
  });

  it('avisos nunca bloqueiam: excluir a variante que um vínculo nomeia salva, e o vínculo fica como estava', async () => {
    // ⚠️ The near-miss of Loja Integrada's rule: the Shopee publisher ignores a dangling id.
    semear(grupo({ linksVariacoesli: [] }));
    await renderPage();
    await abrirAba('Variantes');
    await clicar(screen.getAllByRole('button', { name: 'Remover variante' })[0]!);

    await abrirAba('Shopee');
    expect(
      within(cartao()).getByText(
        'A variante «P» está vinculada à opção «Preto» da Shopee; ao salvar, o vínculo fica sem efeito.',
      ),
    ).toBeTruthy();
    await salvar();

    expect(recusado()).toBe(false);
    expect(commits()).toBe(1);
    expect(guardado().variacoesIds).toEqual(['v2', 'v3']);
    expect(guardado().linksVariacoesShopee).toEqual([vinculo()]);
  });

  it('os dois canais compõem o `validate`: um defeito em cada, as duas abas acusadas', async () => {
    semear(
      grupo({
        linksVariacoesli: [
          LINK_LI,
          {
            ...LINK_LI,
            grade_id: 8950,
            variationOptions: [
              { li_option_id: 1, li_option_name: 'Opção inventada 1', arakene_variation_id: [] },
            ],
          },
        ],
        linksVariacoesShopee: [EM_DUAS_OPCOES],
      }),
    );
    await renderPage();
    await abrirAba('Loja Integrada');
    await clicar(
      within(screen.getByTestId('vinculo-li-CONTA1-8950')).getAllByLabelText(
        'Variantes da opção Opção inventada 1',
      )[0]!,
    );
    await clicar(
      await within(screen.getByTestId('vinculo-li-CONTA1-8950')).findByRole('option', {
        name: 'P',
      }),
    );
    await abrirAba('Shopee');
    await escolher(cartao(), 'Opção da Shopee para «M»', 'Preto (9585)');
    await salvar();

    expect(commits()).toBe(0);
    expect(h.toasts.at(-1)).toContain('Loja Integrada');
    expect(h.toasts.at(-1)).toContain('Shopee');
  });
});

describe('/variacoes/[id] — um elemento ilegível (o campo é estrito)', () => {
  const ILEGIVEL: Doc = { ...vinculo({ category_id: OUTRA_FASHION }), lixo: 1 };

  it('o documento chega cru; salvar é barrado e leva à aba; a remoção preparada libera', async () => {
    const legivel = vinculo();
    semear(grupo({ linksVariacoesShopee: [legivel, ILEGIVEL] }));
    await renderPage();

    await renomear('Tamanhos (meu)');
    await salvar();

    expect(commits()).toBe(0);
    expect(h.toasts.at(-1)).toContain('"Shopee"');
    expect(screen.getByRole('tab', { name: /Shopee/ }).getAttribute('aria-selected')).toBe('true');
    const linha = screen.getByTestId('vinculo-shopee-leitura-1');
    expect(within(linha).getByText(/Vínculo ilegível \(campos: lixo\)/)).toBeTruthy();

    await clicar(within(linha).getByRole('button', { name: 'Remover vínculo' }));
    await salvar();

    expect(commits()).toBe(1);
    expect(guardado().nome).toBe('Tamanhos (meu)');
    expect(guardado().linksVariacoesShopee).toEqual([legivel]);
    expect(guardado().linksVariacoesli).toEqual([LINK_LI]);
    expect(guardado().linksVariacoesAmazon).toEqual([LINK_AMAZON]);
  });

  it('⚠️ QUASE-PAR: desfazer a remoção volta a barrar, e nada foi escrito', async () => {
    semear(grupo({ linksVariacoesShopee: [ILEGIVEL] }));
    await renderPage();
    await abrirAba('Shopee');

    const linha = screen.getByTestId('vinculo-shopee-leitura-0');
    await clicar(within(linha).getByRole('button', { name: 'Remover vínculo' }));
    await clicar(within(linha).getByRole('button', { name: 'Desfazer remoção' }));
    await renomear('Tamanhos (meu)');
    await salvar();

    expect(commits()).toBe(0);
    expect(guardado().linksVariacoesShopee).toEqual([ILEGIVEL]);
  });

  it('um valor que não é lista barra até o botão explícito', async () => {
    semear(grupo({ linksVariacoesShopee: 'não é lista' }));
    await renderPage();
    await renomear('Tamanhos (meu)');
    await salvar();
    expect(commits()).toBe(0);

    await clicar(screen.getByRole('button', { name: 'Substituir por uma lista vazia' }));
    await salvar();

    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesShopee).toEqual([]);
  });
});

describe('/variacoes/[id] — uma gravação em conflito mescla por conta e categoria', () => {
  it('a importação acrescentou outra categoria nesse meio-tempo: fica, e «Salvar mesmo assim» grava as duas', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Shopee');
    await escolher(cartao(), 'Opção da Shopee para «M»', 'Azul Turquesa (9632)');

    escritaConcorrente((doc) => {
      doc.linksVariacoesShopee = [...(doc.linksVariacoesShopee as Doc[]), DA_IMPORTACAO];
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(screen.getByText('mescla por conta e categoria')).toBeTruthy();

    await clicar(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await esperar();

    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesShopee).toEqual([
      vinculo({
        variationOptions: [opcao(6258, 'Preto', ['v1']), opcao(9632, 'Azul Turquesa', ['v2'])],
      }),
      DA_IMPORTACAO,
    ]);
  });

  it('⚠️ QUASE-PAR: os dois mudaram a MESMA chave: fica a versão gravada, marcada, e nada é salvo', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Shopee');
    await escolher(cartao(), 'Opção da Shopee para «M»', 'Azul Turquesa (9632)');

    const remoto = escritaConcorrente((doc) => {
      doc.linksVariacoesShopee = [vinculo({ variationOptions: [opcao(9585, 'Preto', ['v2'])] })];
    });
    await act(async () => rerenderPage());
    await salvar();
    await clicar(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await esperar();

    expect(commits()).toBe(0);
    expect(guardado()).toEqual(remoto);
    expect(
      within(cartao()).getByText(
        'Alterado enquanto você editava (por outra pessoa ou pela importação): esta é a versão gravada. Refaça a sua alteração, se ainda quiser.',
      ),
    ).toBeTruthy();
    expect(h.toasts.at(-1)).toContain('Nada foi salvo');
    expect(h.toasts.at(-1)).toContain('“Vínculos Shopee”');
  });

  it('⚠️ a conta guardada com caminho é a MESMA chave: a mescla não duplica o vínculo', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Shopee');
    await escolher(cartao(), 'Opção da Shopee para «M»', 'Azul Turquesa (9632)');

    const remoto = escritaConcorrente((doc) => {
      doc.linksVariacoesShopee = [vinculo({ integracaoShopeeId: 'documents/integracao/int-1' })];
    });
    await act(async () => rerenderPage());
    await salvar();
    await clicar(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await esperar();

    expect(commits()).toBe(0);
    expect(guardado()).toEqual(remoto);
    expect(within(bloco()).getAllByTestId(`vinculo-shopee-int-1-${FASHION}`)).toHaveLength(1);
  });

  it('removido enquanto eu alterava: a frase, e salvar o descarta', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Shopee');
    await escolher(cartao(), 'Opção da Shopee para «M»', 'Azul Turquesa (9632)');

    escritaConcorrente((doc) => {
      doc.linksVariacoesShopee = [DA_IMPORTACAO];
    });
    await act(async () => rerenderPage());
    await salvar();
    await clicar(screen.getByRole('button', { name: 'Recarregar do servidor' }));

    expect(
      within(cartao()).getByText(
        'Removido enquanto você o alterava: será descartado ao salvar. Altere-o de novo para mantê-lo.',
      ),
    ).toBeTruthy();
    await renomear('Tamanhos (meu)');
    await salvar();

    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesShopee).toEqual([DA_IMPORTACAO]);
  });

  it('⭐ o que o outro escreveu conta como INTOCADO depois da mescla: um defeito dele não barra', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Shopee');
    await escolher(cartao(), 'Opção da Shopee para «M»', 'Azul Turquesa (9632)');

    const comDefeito = vinculo({
      category_id: OUTRA_FASHION,
      variationOptions: [opcao(6258, 'Preto', ['v1']), opcao(9632, 'Azul Turquesa', ['v1'])],
    });
    escritaConcorrente((doc) => {
      doc.linksVariacoesShopee = [...(doc.linksVariacoesShopee as Doc[]), comDefeito];
    });
    await act(async () => rerenderPage());
    await salvar();
    await clicar(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await esperar();

    expect(recusado()).toBe(false);
    expect(commits()).toBe(1);
    expect((guardado().linksVariacoesShopee as Doc[])[1]).toEqual(comDefeito);
  });
});

describe('/variacoes/[id] — #1787: acrescentar e tirar deixa o formulário como estava', () => {
  async function adicionarERemover(doc: Doc) {
    semear(doc);
    await renderPage();
    await abrirAba('Shopee');
    await clicar(within(bloco()).getByRole('button', { name: 'Adicionar vínculo' }));
    const modal = screen.getByTestId('shopee-novo-vinculo-modal');
    const linha = await within(modal).findByTestId(`shopee-categoria-linha-${OUTRA_FASHION}`);
    await clicar(within(linha).getByRole('button', { name: 'Escolher' }));
    await esperar();
    await escolher(modal, 'Variação da Shopee', 'Cor (101054)');
    await clicar(within(modal).getByRole('button', { name: 'Adicionar' }));
    await clicar(within(cartao(OUTRA_FASHION)).getByRole('button', { name: 'Remover vínculo' }));
    expect(screen.queryByTestId(`vinculo-shopee-int-1-${OUTRA_FASHION}`)).toBeNull();
    await salvar();
  }

  it('IGUAL: a chave ausente: nada a salvar, e o campo segue ausente', async () => {
    const { linksVariacoesShopee: _semEla, ...semChave } = grupo();
    await adicionarERemover(semChave);

    expect(h.toasts.at(-1)).toBe('Nenhuma alteração para salvar');
    expect(commits()).toBe(0);
    expect(Object.hasOwn(guardado(), 'linksVariacoesShopee')).toBe(false);
  });

  it('IGUAL: `null` guardado: nada a salvar', async () => {
    await adicionarERemover(grupo({ linksVariacoesShopee: null }));

    expect(h.toasts.at(-1)).toBe('Nenhuma alteração para salvar');
    expect(commits()).toBe(0);
    expect(guardado().linksVariacoesShopee).toBeNull();
  });

  it('⚠️ QUASE-PAR: `[]` guardado: nada a salvar, e continua `[]`, nunca `null`', async () => {
    await adicionarERemover(grupo({ linksVariacoesShopee: [] }));

    expect(h.toasts.at(-1)).toBe('Nenhuma alteração para salvar');
    expect(commits()).toBe(0);
    expect(guardado().linksVariacoesShopee).toEqual([]);
  });

  it('⚠️ QUASE-PAR: acrescentar e NÃO tirar é uma edição de verdade', async () => {
    semear(grupo({ linksVariacoesShopee: null }));
    await renderPage();
    await abrirAba('Shopee');
    await clicar(within(bloco()).getByRole('button', { name: 'Adicionar vínculo' }));
    const modal = screen.getByTestId('shopee-novo-vinculo-modal');
    const linha = await within(modal).findByTestId(`shopee-categoria-linha-${FASHION}`);
    await clicar(within(linha).getByRole('button', { name: 'Escolher' }));
    await esperar();
    await escolher(modal, 'Variação da Shopee', 'Cor (101054)');
    await clicar(within(modal).getByRole('button', { name: 'Adicionar' }));
    await salvar();

    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesShopee).toEqual([vinculo({ variationOptions: [] })]);
  });
});
