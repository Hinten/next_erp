import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { DELETE_MARK, SectionTabs } from '@delfrance/ui';

import { MantineTestProvider } from '@/lib/testing/mantine';
import type {
  CategoriaResumoDto,
  RespostaLimitesDoItemShopee,
  RespostaVariacoesShopee,
  VariacaoDto,
  VariacaoGrupoDto,
} from '@/lib/shopee/wire';

/**
 * The Shopee tab of a variation group, on its own: a real form context, the REAL
 * category browser, a faked backend client (`shopeeClientFalso`, so a route it does
 * not expect rejects naming itself) and a faked conta list.
 *
 * Every tree is hand-written in the shape of the public `get_variation_tree.br-*`
 * captures: public taxonomy where it is named, invented (the `9xxxxx` ids and the
 * «inventada» names) everywhere else.
 *
 * Each rule has a pair and a near miss: a test that a rule APPLIES cannot show where
 * it STOPS. The save's own machinery (blocking, the merge, the seed) is pinned through
 * the real page in `[id]/page.shopee.test.tsx`.
 */

const h = vi.hoisted(() => ({
  variacoes: vi.fn(),
  categorias: vi.fn(),
  limitesDoItem: vi.fn(),
  integracoes: [] as { id: string; data: Record<string, unknown> }[],
  statusIntegracoes: 'success' as 'pending' | 'error' | 'success',
  erroIntegracoes: null as unknown,
}));

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
// As the real hook: `rows` and `byId` are empty unless the read succeeded.
vi.mock('@/lib/data/useIntegracoes', () => ({
  useIntegracoes: () => {
    const rows = h.statusIntegracoes === 'success' ? h.integracoes : [];
    return {
      rows,
      byId: new Map(rows.map((r) => [r.id, r.data])),
      status: h.statusIntegracoes,
      query: { error: h.erroIntegracoes },
    };
  },
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));

const { VinculadorDaShopee } = await import('./VinculadorDaShopee');
const { ShopeeClientHttpError } = await import('@/lib/shopee/client');

type Doc = Record<string, unknown>;

const VARIANTES = [
  { id: 'v1', nome: 'P', codigo: null },
  { id: 'v2', nome: 'M', codigo: null },
  { id: 'v3', nome: 'G', codigo: null },
];

const INT = 841350766059029;
const BR = 844758844060204;
const FASHION = 100244;
const OUTRA_FASHION = 100352;
const CANECA = 900001;
const FALHA = 900002;

const grupo = (id: number, nome: string | null, opcoes: [number, string | null][]) =>
  ({
    variationGroupId: id,
    variationGroupName: nome,
    variationOptionList: opcoes.map(([variationOptionId, variationOptionName]) => ({
      variationOptionId,
      variationOptionName,
    })),
  }) satisfies VariacaoGrupoDto;

const variacao = (id: number, nome: string | null, grupos: VariacaoGrupoDto[]): VariacaoDto => ({
  variationId: id,
  variationName: nome,
  variationGroupList: grupos,
});

const TAMANHO = variacao(101056, 'Tamanho', [
  grupo(INT, 'Tamanho (INT)', [
    [6270, 'M'],
    [900101, 'G inventado INT'],
  ]),
  grupo(BR, 'Tamanho (BR)', [
    [6857, 'P'],
    [6933, 'M'],
    [900102, 'G inventado BR'],
  ]),
]);
const COR = variacao(101054, 'Cor', [
  grupo(0, '', [
    [6258, 'Preto'],
    [9585, 'Preto'],
    [9632, 'Azul Turquesa'],
    [900103, ' Azul '],
  ]),
]);
/**
 * Not in the captures: there, an option-less variation has NO group at all (ESTAMPA's
 * shape); this one empty group is the reason "option-less" is not "group-less". Never
 * bindable.
 */
const ESTILO = variacao(103236, 'Estilo', [grupo(0, '', [])]);
const ESTAMPA = variacao(101264, ' Estampa', []);

const arvore = (
  variacoes: VariacaoDto[],
  categoryId = FASHION,
  leaf = true,
): RespostaVariacoesShopee => ({
  leaf,
  categoryId,
  standardiseVariationList: variacoes,
  pathUsed: '/api/v2/product/get_variation_tree',
});

const opcao = (id: number, nome: string, variantes: string[]): Doc => ({
  shopee_option_id: id,
  shopee_option_name: nome,
  arakene_variation_id: variantes,
});
const vinculo = (extra: Doc = {}): Doc => ({
  name: 'Camisetas',
  category_id: FASHION,
  variation_id: 101054,
  variation_group_list: 0,
  integracaoShopeeId: 'int-1',
  variationOptions: [],
  ...extra,
});
/** A pre-fix import's entry of a two-level variation: group 0. */
const SEM_GRUPO = vinculo({
  variation_id: 101056,
  variationOptions: [opcao(6857, 'P', ['v1']), opcao(6933, 'M', ['v2'])],
});
/** A valid custom entry, as the import writes one. */
const PERSONALIZADO = vinculo({
  name: 'Canecas inventadas',
  category_id: CANECA,
  variation_id: 0,
  variationOptions: [opcao(0, 'P', ['v1'])],
});

const CATEGORIAS: CategoriaResumoDto[] = [
  { categoryId: FASHION, name: 'Camisetas', originalName: 'T-Shirts', isLeaf: true },
  { categoryId: OUTRA_FASHION, name: 'Calças inventadas', originalName: null, isLeaf: true },
  { categoryId: CANECA, name: 'Canecas inventadas', originalName: null, isLeaf: true },
  { categoryId: FALHA, name: 'Categoria que falha', originalName: null, isLeaf: true },
];

const faixaDoNome = (min: number, max: number): RespostaLimitesDoItemShopee => ({
  scope: 'category',
  categoryId: FASHION,
  limites: {
    priceLimit: null,
    wholesalePriceThresholdPercentage: null,
    stockLimit: null,
    itemNameLengthLimit: null,
    itemImageCountLimit: null,
    itemDescriptionLengthLimit: null,
    tierVariationNameLengthLimit: null,
    tierVariationOptionLengthLimit: { min, max },
    itemCountLimit: null,
    extendedDescriptionLimit: null,
    dtsLimit: null,
    weightLimit: null,
    dimensionLimit: null,
    sizeChartLimit: null,
  },
  gtinLimit: null,
  supportsPreOrder: false,
});

const naoEncontrado = () =>
  new ShopeeClientHttpError('falhou', 502, 'SHOPEE_HTTP_ERROR', 'error_not_found', 'other');
const categoriaDesconhecida = () =>
  new ShopeeClientHttpError('sumiu', 404, 'SHOPEE_CATEGORIA_DESCONHECIDA');

/** The latest form value of the field, how often the tab emitted, and whether the form is dirty. */
let valorAtual: () => unknown = () => undefined;
let sujo: () => boolean = () => false;
let emissoes = 0;
let definirVariantes: (v: unknown) => void = () => undefined;

function Harness({
  inicial,
  variantes = VARIANTES,
  disabled = false,
}: {
  inicial: unknown;
  variantes?: unknown;
  disabled?: boolean;
}) {
  const form = useForm({
    defaultValues: { variacoes: variantes, linksVariacoesShopee: inicial },
  });
  const valor = useWatch({ control: form.control, name: 'linksVariacoesShopee' });
  const { isDirty } = form.formState;
  // As `ObjectView` does when the doc loads: without a `reset`, RHF drops
  // `formState.defaultValues` at the root's first re-render, and the seed with it.
  useLayoutEffect(() => {
    form.reset({ variacoes: variantes, linksVariacoesShopee: inicial });
  }, [form, variantes, inicial]);
  useEffect(() => {
    valorAtual = () => form.getValues('linksVariacoesShopee');
    sujo = () => isDirty;
    definirVariantes = (v) => form.setValue('variacoes', v as never);
  }, [form, isDirty]);
  return (
    <FormProvider {...form}>
      <VinculadorDaShopee
        value={valor}
        onChange={(v) => {
          emissoes += 1;
          form.setValue('linksVariacoesShopee', v as never, { shouldDirty: true });
        }}
        disabled={disabled}
      />
    </FormProvider>
  );
}

function Host({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MantineTestProvider>{children}</MantineTestProvider>
    </QueryClientProvider>
  );
}

async function esperar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderTab(
  inicial: unknown,
  props: { variantes?: unknown; disabled?: boolean } = {},
) {
  render(
    <Host>
      <Harness inicial={inicial} {...props} />
    </Host>,
  );
  await esperar();
}

async function clicar(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
  await esperar();
}

/** The `Select`'s input: its dropdown carries the same label. */
const entrada = (escopo: HTMLElement, label: string) =>
  within(escopo).getAllByLabelText(label)[0] as HTMLInputElement;

/** Pick `rotulo` in the `Select` labelled `label` inside `escopo`. */
async function escolher(escopo: HTMLElement, label: string, rotulo: string) {
  await clicar(entrada(escopo, label));
  await clicar(await within(escopo).findByRole('option', { name: rotulo }));
}

/** Every item of that `Select`, in order. The dropdown stays open. */
async function itens(escopo: HTMLElement, label: string) {
  await clicar(entrada(escopo, label));
  const lista = await within(escopo).findByRole('listbox', { name: label });
  return within(lista)
    .getAllByRole('option')
    .map((o) => o.textContent);
}

const blocoDaConta = (conta = 'int-1') => screen.getByTestId(`vinculador-shopee-conta-${conta}`);
const cartao = (categoria = FASHION, conta = 'int-1') =>
  screen.getByTestId(`vinculo-shopee-${conta}-${categoria}`);
const somenteLeitura = (indice: number) => screen.getByTestId(`vinculo-shopee-leitura-${indice}`);
const outras = () => screen.getByTestId('vinculador-shopee-outras');
const modal = () => screen.getByTestId('shopee-novo-vinculo-modal');
const SELECT_P = 'Opção da Shopee para «P»';
const SELECT_M = 'Opção da Shopee para «M»';
const DESCRICAO_DAS_OUTRAS =
  'Contas inativas, que não existem mais ou que não são da Shopee, e vínculos que não nomeiam uma conta. Os vínculos são mantidos e podem ser removidos.';
const FRASE_PERSONALIZADO =
  'Vínculo personalizado (gravado pela importação): as opções levam o nome guardado em cada uma (sem opção guardada, o da variante) e não há o que vincular aqui.';
const FRASE_JA_VINCULADA =
  'Este grupo já tem um vínculo com esta conta para esta categoria — edite-o na lista ou, para trocá-lo, remova-o lá antes de adicionar outro.';
const foraDaLista = (rotulo: string) =>
  `A opção ${rotulo} não está entre as opções atuais da Shopee para a variação e o grupo deste vínculo. O vínculo é mantido: um anúncio publicado pode estar usando essa opção.`;

async function abrirModal(conta = 'int-1') {
  await clicar(within(blocoDaConta(conta)).getByRole('button', { name: 'Adicionar vínculo' }));
}

async function escolherCategoria(categoryId: number) {
  const linha = await within(modal()).findByTestId(`shopee-categoria-linha-${categoryId}`);
  await clicar(within(linha).getByRole('button', { name: 'Escolher' }));
}

const botaoDoModal = (nome: 'Adicionar' | 'Cancelar') =>
  within(modal()).getByRole('button', { name: nome }) as HTMLButtonElement;

beforeEach(() => {
  emissoes = 0;
  h.statusIntegracoes = 'success';
  h.erroIntegracoes = null;
  h.integracoes = [
    { id: 'int-1', data: { tipo: INTEGRACAO_TIPO.shopee, nome: 'Conta A', ativo: true } },
    { id: 'int-12', data: { tipo: INTEGRACAO_TIPO.shopee, nome: 'Conta Doze', ativo: true } },
    { id: 'int-2', data: { tipo: INTEGRACAO_TIPO.shopee, nome: 'Conta B', ativo: false } },
    { id: 'ML1', data: { tipo: INTEGRACAO_TIPO.mercadoLivre, nome: 'ML', ativo: true } },
  ];
  h.categorias.mockReset().mockResolvedValue({ raizes: CATEGORIAS, no: null });
  h.limitesDoItem.mockReset().mockResolvedValue(faixaDoNome(1, 30));
  h.variacoes.mockReset().mockImplementation(async ({ categoryId }: { categoryId: number }) => {
    if (categoryId === CANECA) return arvore([ESTILO, ESTAMPA], CANECA);
    if (categoryId === FALHA) throw naoEncontrado();
    return arvore([TAMANHO, COR, ESTILO, ESTAMPA], categoryId);
  });
});

describe('aba Shopee — o que ela mostra', () => {
  it('não emite nada ao montar: lê a árvore, mostra os avisos, e o formulário segue intacto', async () => {
    const guardado = [SEM_GRUPO, PERSONALIZADO];
    await renderTab(guardado);

    expect(within(cartao()).getByText(/A Shopee exige o grupo de opções/)).toBeTruthy();
    expect(emissoes).toBe(0);
    expect(sujo()).toBe(false);
    expect(valorAtual()).toEqual(guardado);
  });

  it('IGUAL: as formas de caminho da conta caem no bloco da conta que nomeiam', async () => {
    await renderTab([
      vinculo({ integracaoShopeeId: 'documents/integracao/int-1' }),
      vinculo({ integracaoShopeeId: 'integracao/int-1', category_id: OUTRA_FASHION }),
    ]);

    expect(within(blocoDaConta()).getByTestId(`vinculo-shopee-int-1-${FASHION}`)).toBeTruthy();
    expect(
      within(blocoDaConta()).getByTestId(`vinculo-shopee-int-1-${OUTRA_FASHION}`),
    ).toBeTruthy();
    expect(screen.queryByTestId('vinculador-shopee-outras')).toBeNull();
  });

  it('⚠️ QUASE-PAR: `int-12` nunca cai no bloco de `int-1`; caixa e espaço são outra conta', async () => {
    await renderTab([
      vinculo({ integracaoShopeeId: 'int-12' }),
      vinculo({ integracaoShopeeId: 'Int-1' }),
      vinculo({ integracaoShopeeId: ' int-1' }),
    ]);

    expect(within(blocoDaConta()).getByText('Nenhum vínculo com esta conta.')).toBeTruthy();
    expect(within(blocoDaConta('int-12')).getByText('Camisetas (100244)')).toBeTruthy();
    expect(within(outras()).getByText(/conta não reconhecida \(Int-1\)/)).toBeTruthy();
    expect(within(outras()).getByText(/conta não reconhecida \( int-1\)/)).toBeTruthy();
  });

  it('uma conta inativa fica à parte, só leitura, com o nome e a remoção preparada', async () => {
    const daInativa = vinculo({
      integracaoShopeeId: 'int-2',
      variationOptions: [opcao(6258, 'Preto', ['v1'])],
    });
    await renderTab([daInativa]);

    expect(within(outras()).getByText('Vínculos de outras contas')).toBeTruthy();
    expect(within(outras()).getByText(DESCRICAO_DAS_OUTRAS)).toBeTruthy();
    expect(within(outras()).getByText('Conta B (inativa)')).toBeTruthy();
    expect(within(outras()).getByText('Preto (6258) → P')).toBeTruthy();
    // A Mantine `Select`'s input is a combobox: no `Select` at all, so nothing to edit.
    expect(within(outras()).queryByRole('combobox')).toBeNull();
    expect(h.variacoes).not.toHaveBeenCalled();

    await clicar(within(somenteLeitura(0)).getByRole('button', { name: 'Remover vínculo' }));
    expect(valorAtual()).toEqual([{ ...daInativa, [DELETE_MARK]: true }]);
    expect(within(somenteLeitura(0)).getByText('Será removido')).toBeTruthy();

    await clicar(within(somenteLeitura(0)).getByRole('button', { name: 'Desfazer remoção' }));
    expect(valorAtual()).toEqual([daInativa]);
  });

  it('⚠️ QUASE-PAR: uma conta de outro canal fica à parte, e a descrição não a chama de inativa', async () => {
    await renderTab([vinculo({ integracaoShopeeId: 'ML1' })]);

    expect(within(outras()).getByText('ML (não é uma conta da Shopee)')).toBeTruthy();
    expect(within(outras()).getByText(DESCRICAO_DAS_OUTRAS)).toBeTruthy();
    expect(within(outras()).queryByText(/^Contas inativas ou que não existem mais\./)).toBeNull();
  });

  it('uma entrada personalizada é só leitura e nem lê a árvore da categoria', async () => {
    await renderTab([PERSONALIZADO]);

    const item = somenteLeitura(0);
    expect(within(item).getByText('Personalizada')).toBeTruthy();
    expect(within(item).getByText(FRASE_PERSONALIZADO)).toBeTruthy();
    expect(within(item).queryByRole('combobox')).toBeNull();
    expect(h.variacoes).not.toHaveBeenCalled();
    expect(h.limitesDoItem).not.toHaveBeenCalled();
  });

  it('a frase do vínculo personalizado diz o nome guardado de cada opção, e a linha o mostra sem o id 0', async () => {
    // The import binds a live option to a variante spelled otherwise: the publisher
    // sends the row's stored name, never the variante's.
    await renderTab([
      vinculo({
        ...PERSONALIZADO,
        variationOptions: [opcao(0, 'Opção inventada 1', ['v1'])],
      }),
    ]);

    const item = somenteLeitura(0);
    expect(within(item).getByText(FRASE_PERSONALIZADO)).toBeTruthy();
    expect(within(item).getByText('Personalizada: «Opção inventada 1» → P')).toBeTruthy();
    expect(within(item).queryByText(/\(0\)/)).toBeNull();
  });

  it('⚠️ QUASE-PAR: a linha personalizada de mesmo nome da variante lê igual, e uma padrão guarda o id', async () => {
    const daInativa = vinculo({
      integracaoShopeeId: 'int-2',
      variationOptions: [opcao(6258, 'Preto', ['v1']), opcao(0, 'G', ['v3'])],
    });
    await renderTab([PERSONALIZADO, daInativa]);

    expect(within(somenteLeitura(0)).getByText('Personalizada: «P» → P')).toBeTruthy();
    expect(within(somenteLeitura(1)).getByText('Preto (6258) → P')).toBeTruthy();
    expect(within(somenteLeitura(1)).getByText('Personalizada: «G» → G')).toBeTruthy();
  });

  it('a gêmea leva a marca e a frase; a primeira, que a publicação lê, não leva nenhuma', async () => {
    const segunda = vinculo({ name: 'Segunda' });
    await renderTab([vinculo(), segunda]);

    const [primeira, gemea] = within(blocoDaConta()).getAllByTestId(
      `vinculo-shopee-int-1-${FASHION}`,
    );
    expect(within(gemea!).getByText('Não lido pela publicação')).toBeTruthy();
    expect(within(gemea!).getByText(/vem antes na lista; a publicação lê só aquele/)).toBeTruthy();
    expect(within(primeira!).queryByText('Não lido pela publicação')).toBeNull();
    expect(within(primeira!).queryByText(/vem antes na lista/)).toBeNull();
  });

  it('⚠️ QUASE-PAR: a primeira preparada para remoção promove a outra, que deixa de ser gêmea', async () => {
    await renderTab([{ ...vinculo(), [DELETE_MARK]: true }, vinculo({ name: 'Segunda' })]);

    expect(within(blocoDaConta()).queryByText('Não lido pela publicação')).toBeNull();
  });

  it('um elemento ilegível nomeia os campos e pode ser removido; sem chave, fica à parte', async () => {
    const ilegivel = { ...vinculo(), lixo: 1 };
    const semChave = { name: 'Sem conta' };
    await renderTab([ilegivel, semChave, 'não é objeto']);

    const naConta = somenteLeitura(0);
    expect(within(blocoDaConta()).getByTestId('vinculo-shopee-leitura-0')).toBeTruthy();
    expect(
      within(naConta).getByText(
        'Vínculo ilegível (campos: lixo). Enquanto ele existir, este grupo não pode ser salvo — remova-o (você pode recriá-lo em seguida).',
      ),
    ).toBeTruthy();
    expect(within(somenteLeitura(1)).getByText('sem conta')).toBeTruthy();
    expect(within(somenteLeitura(2)).getByText(/^Vínculo ilegível\. Enquanto/)).toBeTruthy();
    // The block holds key-less elements, so its description names them too.
    expect(within(outras()).getByText(DESCRICAO_DAS_OUTRAS)).toBeTruthy();

    await clicar(within(naConta).getByRole('button', { name: 'Remover vínculo' }));
    expect((valorAtual() as unknown[])[0]).toEqual({ ...ilegivel, [DELETE_MARK]: true });
    expect((valorAtual() as unknown[])[1]).toEqual(semChave);
  });

  it('um valor que não é lista: nada é escrito até o botão explícito, e adicionar fica desligado', async () => {
    await renderTab('não é lista');

    expect(
      screen.getByText(
        'Os vínculos da Shopee guardados neste grupo não estão numa lista e não podem ser lidos nem salvos assim.',
      ),
    ).toBeTruthy();
    expect(
      (
        within(blocoDaConta()).getByRole('button', {
          name: 'Adicionar vínculo',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(emissoes).toBe(0);

    await clicar(screen.getByRole('button', { name: 'Substituir por uma lista vazia' }));
    expect(valorAtual()).toEqual([]);
  });

  it('as marcas da mescla têm as duas frases', async () => {
    await renderTab([
      { ...vinculo(), _conflitoVinculoShopee: 'alterado' },
      { ...vinculo({ category_id: OUTRA_FASHION }), _conflitoVinculoShopee: 'removido' },
    ]);

    expect(
      within(cartao()).getByText(
        'Alterado enquanto você editava (por outra pessoa ou pela importação): esta é a versão gravada. Refaça a sua alteração, se ainda quiser.',
      ),
    ).toBeTruthy();
    expect(
      within(cartao(OUTRA_FASHION)).getByText(
        'Removido enquanto você o alterava: será descartado ao salvar. Altere-o de novo para mantê-lo.',
      ),
    ).toBeTruthy();
  });

  it('sem conta ativa da Shopee, diz isso; uma conta de outro canal não conta', async () => {
    h.integracoes = [
      { id: 'ML1', data: { tipo: INTEGRACAO_TIPO.mercadoLivre, nome: 'ML', ativo: true } },
    ];
    await renderTab(null);

    expect(screen.getByText('Nenhuma conta ativa da Shopee.')).toBeTruthy();
    expect(screen.queryByTestId('vinculador-shopee-conta-ML1')).toBeNull();
  });

  it('o erro do formulário aparece na aba', async () => {
    render(
      <Host>
        <FormWithError />
      </Host>,
    );
    await esperar();
    expect(screen.getByText('Vínculos Shopee: inventado.')).toBeTruthy();
  });

  it('só leitura: sem adicionar, sem remover, e os Selects desligados', async () => {
    await renderTab([vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] })], {
      disabled: true,
    });

    expect(within(blocoDaConta()).queryByRole('button', { name: 'Adicionar vínculo' })).toBeNull();
    expect(within(cartao()).queryByRole('button', { name: 'Remover vínculo' })).toBeNull();
    expect(entrada(cartao(), SELECT_P).disabled).toBe(true);
    expect(within(cartao()).queryByText(/Para trocar a variação/)).toBeNull();
  });
});

function FormWithError() {
  const form = useForm({ defaultValues: { variacoes: VARIANTES, linksVariacoesShopee: null } });
  return (
    <FormProvider {...form}>
      <VinculadorDaShopee
        value={null}
        onChange={() => undefined}
        error="Vínculos Shopee: inventado."
      />
    </FormProvider>
  );
}

describe('aba Shopee — a lista de contas não veio (permissão)', () => {
  const guardado = [vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] })];

  it('sem a permissão, diz qual falta e lista o guardado com os ids, sem blocos nem título de "outras"', async () => {
    h.statusIntegracoes = 'error';
    h.erroIntegracoes = new FirebaseError('permission-denied', 'negado');
    await renderTab(guardado);

    expect(
      screen.getByText(
        'Você está sem permissão para ler as contas da Shopee: o seu cargo precisa da permissão de leitura de Integrações. Os vínculos guardados aparecem abaixo, sem edição.',
      ),
    ).toBeTruthy();
    expect(within(outras()).getByText('Preto (6258) → P')).toBeTruthy();
    expect(within(outras()).getByText('conta int-1 (lista de contas indisponível)')).toBeTruthy();
    // ⚠️ They may be the active conta's own: "contas inativas" would be a false claim.
    expect(within(outras()).queryByText('Vínculos de outras contas')).toBeNull();
    expect(screen.queryByText('Nenhuma conta ativa da Shopee.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adicionar vínculo' })).toBeNull();
    expect(h.variacoes).not.toHaveBeenCalled();
  });

  it('⚠️ QUASE-PAR: outra falha não acusa permissão', async () => {
    h.statusIntegracoes = 'error';
    h.erroIntegracoes = new FirebaseError('unavailable', 'fora do ar');
    await renderTab(guardado);

    expect(
      screen.getByText(
        'Não foi possível ler as contas da Shopee. Os vínculos guardados aparecem abaixo, sem edição.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/sem permissão/)).toBeNull();
  });

  it('enquanto lê as contas, não chama nenhuma de "não reconhecida"', async () => {
    h.statusIntegracoes = 'pending';
    await renderTab(guardado);

    expect(within(outras()).getByText('conta int-1 (lendo a lista de contas…)')).toBeTruthy();
    expect(screen.queryByText('Nenhuma conta ativa da Shopee.')).toBeNull();
  });
});

describe('aba Shopee — quando ela lê', () => {
  it('não lê a árvore com a aba escondida, e lê ao abrir, uma vez por categoria', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pagina = (aba: string) => (
      <QueryClientProvider client={qc}>
        <MantineTestProvider>
          <SectionTabs
            sections={['Dados gerais', 'Shopee']}
            persistentSections={['Shopee']}
            contents={{
              'Dados gerais': null,
              Shopee: <Harness inicial={[vinculo(), vinculo({ name: 'Gêmea' })]} />,
            }}
            value={aba}
            onChange={() => undefined}
          />
        </MantineTestProvider>
      </QueryClientProvider>
    );
    const view = render(pagina('Dados gerais'));
    await esperar();
    expect(h.variacoes).not.toHaveBeenCalled();

    await act(async () => {
      view.rerender(pagina('Shopee'));
    });
    await esperar();
    expect(h.variacoes.mock.calls.map(([i]) => i)).toStrictEqual([
      { integracaoId: 'int-1', categoryId: FASHION },
    ]);
  });

  it('um vínculo preparado para remoção não lê nada', async () => {
    await renderTab([{ ...vinculo(), [DELETE_MARK]: true }]);
    expect(h.variacoes).not.toHaveBeenCalled();
  });
});

describe('adicionar um vínculo — o que libera', () => {
  it('sem variante viva: botão desligado e a frase; uma preparada para exclusão não conta', async () => {
    await renderTab(null, {
      variantes: [{ id: 'v1', nome: 'P', codigo: null, [DELETE_MARK]: true }],
    });

    expect(
      within(blocoDaConta()).getByText(
        'Cadastre as variantes deste grupo (aba Variantes) antes de vincular.',
      ),
    ).toBeTruthy();
    expect(
      (
        within(blocoDaConta()).getByRole('button', {
          name: 'Adicionar vínculo',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('⚠️ QUASE-PAR: uma variante digitada agora mesmo já libera', async () => {
    await renderTab(null, { variantes: [] });
    await act(async () => {
      definirVariantes([{ id: 'nova', nome: 'Inventada', codigo: null }]);
    });
    await esperar();

    expect(
      (
        within(blocoDaConta()).getByRole('button', {
          name: 'Adicionar vínculo',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('abre na categoria, com o título da conta e nada a adicionar ainda; Cancelar fecha', async () => {
    await renderTab(null);
    await abrirModal();

    expect(screen.getByText('Novo vínculo com a Shopee — Conta A')).toBeTruthy();
    expect(within(modal()).getByText('Categoria da Shopee')).toBeTruthy();
    expect(await within(modal()).findByTestId('shopee-categoria-browser')).toBeTruthy();
    expect(botaoDoModal('Adicionar').disabled).toBe(true);

    await clicar(botaoDoModal('Cancelar'));
    expect(screen.queryByTestId('shopee-novo-vinculo-modal')).toBeNull();
    expect(emissoes).toBe(0);
  });
});

describe('adicionar um vínculo — a chave já existe', () => {
  it('um vínculo legível da chave: a frase, sem ler a árvore e sem adicionar', async () => {
    await renderTab([vinculo()]);
    h.variacoes.mockClear();
    await abrirModal();
    await escolherCategoria(FASHION);

    expect(within(modal()).getByText(FRASE_JA_VINCULADA)).toBeTruthy();
    expect(h.variacoes).not.toHaveBeenCalled();
    // The card's own read already cached this tree: only the missing step proves nothing is offered.
    expect(within(modal()).queryAllByLabelText('Variação da Shopee')).toHaveLength(0);
    expect(botaoDoModal('Adicionar').disabled).toBe(true);
  });

  it('IGUAL: guardado com caminho é a mesma chave da conta', async () => {
    await renderTab([vinculo({ integracaoShopeeId: 'documents/integracao/int-1' })]);
    await abrirModal();
    await escolherCategoria(FASHION);

    expect(within(modal()).getByText(/já tem um vínculo com esta conta/)).toBeTruthy();
  });

  it('⚠️ QUASE-PAR: o vínculo de `int-12` não ocupa a chave de `int-1`', async () => {
    await renderTab([vinculo({ integracaoShopeeId: 'int-12' })]);
    await abrirModal();
    await escolherCategoria(FASHION);

    expect(within(modal()).queryByText(/já tem um vínculo/)).toBeNull();
    await esperar();
    expect(entrada(modal(), 'Variação da Shopee')).toBeTruthy();
  });

  it('só um ilegível na chave: pede para removê-lo antes', async () => {
    await renderTab([{ ...vinculo(), lixo: 1 }]);
    await abrirModal();
    await escolherCategoria(FASHION);

    expect(
      within(modal()).getByText(
        'Este grupo já tem um vínculo ilegível com esta conta para esta categoria — remova-o na lista antes de adicionar outro.',
      ),
    ).toBeTruthy();
    expect(botaoDoModal('Adicionar').disabled).toBe(true);
  });

  it('uma entrada personalizada ocupa a chave: a frase aponta a remoção, e removê-la libera a chave', async () => {
    await renderTab([PERSONALIZADO]);
    await abrirModal();
    await escolherCategoria(CANECA);

    // Read-only, it has nothing to edit: the sentence's other exit is the one it takes.
    expect(within(modal()).getByText(FRASE_JA_VINCULADA)).toBeTruthy();
    expect(botaoDoModal('Adicionar').disabled).toBe(true);

    await clicar(botaoDoModal('Cancelar'));
    await clicar(within(somenteLeitura(0)).getByRole('button', { name: 'Remover vínculo' }));
    await abrirModal();
    await escolherCategoria(CANECA);
    await esperar();

    expect(within(modal()).queryByText(/já tem um vínculo/)).toBeNull();
    expect(
      within(modal()).getByText(
        'Esta categoria não tem variações padrão da Shopee: não é preciso vincular. A publicação usa variações personalizadas, com o nome do grupo e das variantes.',
      ),
    ).toBeTruthy();
  });

  it('uma remoção preparada libera a chave para o substituto', async () => {
    await renderTab([{ ...vinculo(), [DELETE_MARK]: true }]);
    await abrirModal();
    await escolherCategoria(FASHION);

    expect(within(modal()).queryByText(/já tem um vínculo/)).toBeNull();
    await esperar();
    expect(entrada(modal(), 'Variação da Shopee')).toBeTruthy();
  });

  it('«Trocar categoria» volta ao navegador e leva a frase embora', async () => {
    await renderTab([vinculo()]);
    await abrirModal();
    await escolherCategoria(FASHION);
    expect(within(modal()).getByText('Categoria: Camisetas (100244)')).toBeTruthy();

    await clicar(within(modal()).getByRole('button', { name: 'Trocar categoria' }));
    expect(await within(modal()).findByTestId('shopee-categoria-browser')).toBeTruthy();
    expect(within(modal()).queryByText(/já tem um vínculo/)).toBeNull();
    await escolherCategoria(OUTRA_FASHION);
    expect(within(modal()).getByText('Categoria: Calças inventadas (100352)')).toBeTruthy();
  });
});

describe('adicionar um vínculo — o que a árvore responde', () => {
  async function ateAArvore(categoryId: number) {
    await renderTab(null);
    await abrirModal();
    await escolherCategoria(categoryId);
    await esperar();
  }

  it('caneca (variações sem nenhuma opção): não é preciso vincular, nada entra', async () => {
    await ateAArvore(CANECA);

    expect(
      within(modal()).getByText(
        'Esta categoria não tem variações padrão da Shopee: não é preciso vincular. A publicação usa variações personalizadas, com o nome do grupo e das variantes.',
      ),
    ).toBeTruthy();
    expect(within(modal()).queryByLabelText('Variação da Shopee')).toBeNull();
    expect(botaoDoModal('Adicionar').disabled).toBe(true);
    expect(emissoes).toBe(0);
  });

  it('⚠️ QUASE-PAR da caneca: uma variação com opção leva ao seletor, sem as vazias, e já escolhida', async () => {
    h.variacoes.mockResolvedValue(arvore([ESTILO, COR, ESTAMPA]));
    await ateAArvore(FASHION);

    expect(within(modal()).queryByText(/não é preciso vincular/)).toBeNull();
    expect(entrada(modal(), 'Variação da Shopee').value).toBe('Cor (101054)');
    expect(await itens(modal(), 'Variação da Shopee')).toStrictEqual(['Cor (101054)']);
  });

  it('⚠️ não é folha: pede a categoria final, nunca «não é preciso vincular» (leia `leaf` primeiro)', async () => {
    h.variacoes.mockResolvedValue(arvore([], FASHION, false));
    await ateAArvore(FASHION);

    expect(
      within(modal()).getByText('Escolha uma categoria final (sem subcategorias).'),
    ).toBeTruthy();
    expect(within(modal()).queryByText(/não é preciso vincular/)).toBeNull();
    expect(botaoDoModal('Adicionar').disabled).toBe(true);
  });

  it('um grupo só `{0, ""}`: sem seletor de grupo, grava 0 e o vínculo nasce com a conta nua', async () => {
    await ateAArvore(FASHION);

    await escolher(modal(), 'Variação da Shopee', 'Cor (101054)');
    expect(within(modal()).queryByLabelText('Grupo de opções')).toBeNull();
    await clicar(botaoDoModal('Adicionar'));

    expect(valorAtual()).toEqual([
      {
        name: 'Camisetas',
        category_id: FASHION,
        variation_id: 101054,
        variation_group_list: 0,
        integracaoShopeeId: 'int-1',
        variationOptions: [],
      },
    ]);
    expect(screen.queryByTestId('shopee-novo-vinculo-modal')).toBeNull();
    // The new card opens with every variante on «Sem opção».
    expect(entrada(cartao(), SELECT_P).value).toBe('Sem opção');
    expect(entrada(cartao(), SELECT_M).value).toBe('Sem opção');
    expect(entrada(cartao(), 'Opção da Shopee para «G»').value).toBe('Sem opção');
  });

  it('⚠️ QUASE-PAR: dois grupos com opções: a escolha é obrigatória e grava os 15 dígitos exatos', async () => {
    await ateAArvore(FASHION);

    await escolher(modal(), 'Variação da Shopee', 'Tamanho (101056)');
    expect(botaoDoModal('Adicionar').disabled).toBe(true);
    expect(within(modal()).getByText(/mais de um grupo de opções/)).toBeTruthy();
    expect(await itens(modal(), 'Grupo de opções')).toStrictEqual([
      `Tamanho (INT) (${INT})`,
      `Tamanho (BR) (${BR})`,
    ]);

    await clicar(await within(modal()).findByRole('option', { name: `Tamanho (BR) (${BR})` }));
    expect(botaoDoModal('Adicionar').disabled).toBe(false);
    await clicar(botaoDoModal('Adicionar'));

    expect((valorAtual() as Doc[])[0]?.variation_group_list).toBe(844758844060204);
  });

  it('um grupo com opções e outro vazio: o único é automático, com o id dele', async () => {
    h.variacoes.mockResolvedValue(
      arvore([
        variacao(101056, 'Tamanho', [
          grupo(INT, 'Tamanho (INT)', []),
          grupo(BR, 'Tamanho (BR)', [[6933, 'M']]),
        ]),
      ]),
    );
    await ateAArvore(FASHION);

    expect(within(modal()).queryByLabelText('Grupo de opções')).toBeNull();
    await clicar(botaoDoModal('Adicionar'));
    expect((valorAtual() as Doc[])[0]?.variation_group_list).toBe(BR);
  });

  it('trocar a variação zera o grupo escolhido', async () => {
    await ateAArvore(FASHION);
    await escolher(modal(), 'Variação da Shopee', 'Tamanho (101056)');
    await escolher(modal(), 'Grupo de opções', `Tamanho (BR) (${BR})`);
    await escolher(modal(), 'Variação da Shopee', 'Cor (101054)');
    await escolher(modal(), 'Variação da Shopee', 'Tamanho (101056)');

    expect(entrada(modal(), 'Grupo de opções').value).toBe('');
    expect(botaoDoModal('Adicionar').disabled).toBe(true);
  });

  it('502 `error_not_found`: a frase do backend desatualizado, sem «Tentar de novo», Adicionar desligado', async () => {
    await ateAArvore(FALHA);

    expect(within(modal()).getByText(/o backend da Shopee está desatualizado/)).toBeTruthy();
    expect(within(modal()).queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(botaoDoModal('Adicionar').disabled).toBe(true);
  });

  it('⚠️ categoria desconhecida no modal: frase genérica, nunca «remova o vínculo» (não há vínculo)', async () => {
    h.variacoes.mockRejectedValue(categoriaDesconhecida());
    await ateAArvore(FASHION);

    expect(
      within(modal()).getByText('Não foi possível carregar as variações da Shopee.'),
    ).toBeTruthy();
    expect(within(modal()).queryByText(/remova o vínculo/)).toBeNull();
    expect(botaoDoModal('Adicionar').disabled).toBe(true);
  });

  it('uma falha repetível oferece «Tentar de novo», e tentar lê de novo', async () => {
    h.variacoes.mockRejectedValueOnce(new ShopeeClientHttpError('Fora do ar', 500, null));
    await ateAArvore(FASHION);
    expect(botaoDoModal('Adicionar').disabled).toBe(true);

    await clicar(within(modal()).getByRole('button', { name: 'Tentar de novo' }));

    expect(entrada(modal(), 'Variação da Shopee')).toBeTruthy();
    expect(h.variacoes).toHaveBeenCalledTimes(2);
  });
});

describe('o cartão — as opções da variante', () => {
  const TAMANHO_BR = vinculo({ variation_id: 101056, variation_group_list: BR });

  it('o cabeçalho vem da árvore, com o grupo; sem árvore, os ids', async () => {
    await renderTab([TAMANHO_BR]);
    expect(within(cartao()).getByText('Camisetas (100244)')).toBeTruthy();
    expect(within(cartao()).getByText(`Tamanho (101056) · Tamanho (BR) (${BR})`)).toBeTruthy();
    expect(
      within(cartao()).getByText('Para trocar a variação, remova este vínculo e adicione outro.'),
    ).toBeTruthy();
  });

  it('⚠️ QUASE-PAR: sem a árvore, o cabeçalho traz os ids', async () => {
    h.variacoes.mockRejectedValue(naoEncontrado());
    await renderTab([TAMANHO_BR]);

    expect(within(cartao()).getByText(`Variação 101056 · Grupo ${BR}`)).toBeTruthy();
  });

  it('grupo BR escolhido: oferece o `M` 6933 do BR, nunca o 6270 do INT, na ordem combinada', async () => {
    await renderTab([TAMANHO_BR]);

    expect(await itens(cartao(), SELECT_P)).toStrictEqual([
      'Sem opção',
      'P (6857)',
      'M (6933)',
      'G inventado BR (900102)',
      'Personalizada: «P»',
    ]);
  });

  it('⚠️ QUASE-PAR: grupo INT escolhido: oferece o 6270, nunca o 6933', async () => {
    await renderTab([vinculo({ variation_id: 101056, variation_group_list: INT })]);

    const oferecidos = await itens(cartao(), SELECT_P);
    expect(oferecidos).toContain('M (6270)');
    expect(oferecidos).not.toContain('M (6933)');
  });

  it('dois «Preto» são dois itens e duas linhas: escolher 6258 nunca toca o 9585', async () => {
    const com9585 = opcao(9585, 'Preto', ['v2']);
    await renderTab([vinculo({ variationOptions: [com9585] })]);

    const oferecidos = await itens(cartao(), SELECT_P);
    expect(oferecidos).toContain('Preto (6258)');
    expect(oferecidos).toContain('Preto (9585)');

    await clicar(await within(cartao()).findByRole('option', { name: 'Preto (6258)' }));

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      com9585,
      opcao(6258, 'Preto', ['v1']),
    ]);
    expect(entrada(cartao(), SELECT_P).value).toBe('Preto (6258)');
    expect(entrada(cartao(), SELECT_M).value).toBe('Preto (9585)');
  });

  it('o nome da Shopee aparece aparado e é guardado como veio', async () => {
    await renderTab([vinculo()]);

    await escolher(cartao(), SELECT_P, 'Azul (900103)');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(900103, ' Azul ', ['v1'])]);
    expect(entrada(cartao(), SELECT_P).value).toBe('Azul (900103)');
  });

  it('um rótulo sem nome é «Sem nome (id)», e a variação com nome de espaço sai aparada', async () => {
    h.variacoes.mockResolvedValue(
      arvore([
        variacao(101054, null, [grupo(0, '', [[9632, 'Azul Turquesa']])]),
        variacao(101264, ' Estampa', [grupo(0, '', [[900104, 'Opção inventada 1']])]),
      ]),
    );
    await renderTab(null);
    await abrirModal();
    await escolherCategoria(FASHION);
    await esperar();

    expect(await itens(modal(), 'Variação da Shopee')).toStrictEqual([
      'Sem nome (101054)',
      'Estampa (101264)',
    ]);
  });

  it('⚠️ PAR (#1911 P14b, INVERTIDO DE PROPÓSITO): a opção personalizada NOVA guarda o nome da variante com as pontas aparadas', async () => {
    const variantes = [{ id: 'v9', nome: ' Cor do ERP ', codigo: null }];
    await renderTab([vinculo()], { variantes });

    await escolher(cartao(), 'Opção da Shopee para « Cor do ERP »', 'Personalizada: «Cor do ERP»');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(0, 'Cor do ERP', ['v9'])]);
    expect(entrada(cartao(), 'Opção da Shopee para « Cor do ERP »').value).toBe(
      'Personalizada: «Cor do ERP»',
    );
  });

  it.each(['Cor  do ERP', 'cor do erp'])(
    '⛔ QUASE (#1911 P14b): a variante %j é guardada como foi digitada — o espaço de dentro e a caixa não dobram',
    async (nome) => {
      await renderTab([vinculo()], { variantes: [{ id: 'v9', nome, codigo: null }] });

      // One variante, so one `Select` and one custom item (the accessible name
      // collapses inner whitespace, so the labels are matched by prefix).
      await clicar(within(cartao()).getAllByLabelText(/^Opção da Shopee para «/)[0]!);
      await clicar(await within(cartao()).findByRole('option', { name: /^Personalizada: «/ }));

      expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(0, nome, ['v9'])]);
    },
  );

  it('⚠️ PAR (#1911 P14b): a linha guardada «Cor do ERP» e a variante « Cor do ERP » são UM item — escolhê-lo junta a variante à linha', async () => {
    const variantes = [
      { id: 'v1', nome: 'P', codigo: null },
      { id: 'v9', nome: ' Cor do ERP ', codigo: null },
    ];
    await renderTab([vinculo({ variationOptions: [opcao(0, 'Cor do ERP', ['v1'])] })], {
      variantes,
    });
    const SELECT_V9 = 'Opção da Shopee para « Cor do ERP »';

    const oferecidos = await itens(cartao(), SELECT_V9);
    expect(oferecidos.filter((o) => o === 'Personalizada: «Cor do ERP»')).toHaveLength(1);
    await clicar(
      await within(cartao()).findByRole('option', { name: 'Personalizada: «Cor do ERP»' }),
    );

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      opcao(0, 'Cor do ERP', ['v1', 'v9']),
    ]);
  });

  it('⚠️ RESÍDUO (#1911 P14b): uma linha LEGADA guardada « Cor do ERP » ao lado da variante « Cor do ERP » — dois itens com um rótulo só, e cada um vai para a sua linha', async () => {
    const legada = opcao(0, ' Cor do ERP ', ['v1']);
    const variantes = [
      { id: 'v1', nome: 'P', codigo: null },
      { id: 'v9', nome: ' Cor do ERP ', codigo: null },
    ];
    await renderTab([vinculo({ variationOptions: [legada] })], { variantes });
    const SELECT_V9 = 'Opção da Shopee para « Cor do ERP »';

    await clicar(entrada(cartao(), SELECT_V9));
    // The stored row comes first (verbatim), the variante's custom item last (trimmed).
    const doisItens = await within(cartao()).findAllByRole('option', {
      name: 'Personalizada: «Cor do ERP»',
    });
    expect(doisItens).toHaveLength(2);
    await clicar(doisItens[1]!);
    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      legada,
      opcao(0, 'Cor do ERP', ['v9']),
    ]);

    // Re-picking the stored one moves the variante back onto it: harmless either way.
    await clicar(entrada(cartao(), SELECT_V9));
    const deNovo = await within(cartao()).findAllByRole('option', {
      name: 'Personalizada: «Cor do ERP»',
    });
    expect(deNovo).toHaveLength(2);
    await clicar(deNovo[0]!);
    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      opcao(0, ' Cor do ERP ', ['v1', 'v9']),
    ]);
  });

  it('uma linha personalizada guardada com o nome da variante não repete o item', async () => {
    await renderTab([vinculo({ variationOptions: [opcao(0, 'P', ['v1'])] })]);

    const oferecidos = await itens(cartao(), SELECT_P);
    expect(oferecidos.filter((o) => o === 'Personalizada: «P»')).toHaveLength(1);
    expect(entrada(cartao(), SELECT_P).value).toBe('Personalizada: «P»');
  });

  it('⚠️ QUASE-PAR: outra linha personalizada é outro item, e a variante segue a sua', async () => {
    await renderTab([
      vinculo({ variationOptions: [opcao(0, 'p', ['v2']), opcao(0, 'P', ['v1'])] }),
    ]);

    const oferecidos = await itens(cartao(), SELECT_P);
    expect(oferecidos).toContain('Personalizada: «p»');
    expect(oferecidos).toContain('Personalizada: «P»');
    expect(entrada(cartao(), SELECT_M).value).toBe('Personalizada: «p»');
  });

  it.each([
    // No name: the variante is labelled by its id.
    ['', /^Opção da Shopee para «v-sem-nome»$/, /^Personalizada: «v-sem-nome»$/],
    // Only spaces: the label shows them, and the trim still reads no name.
    ['   ', /^Opção da Shopee para «\s*»$/, /^Personalizada: «\s*»$/],
  ])(
    'variante sem nome (%j): o item «Personalizada» aparece desligado, e nada grava uma linha sem nome',
    async (nome, rotuloDoSelect, rotuloDoItem) => {
      const variantes = [{ id: 'v-sem-nome', nome, codigo: null }];
      await renderTab([vinculo()], { variantes });

      await clicar(within(cartao()).getAllByLabelText(rotuloDoSelect)[0]!);
      const item = await within(cartao()).findByRole('option', { name: rotuloDoItem });
      expect(item.getAttribute('data-combobox-disabled')).toBe('true');
      await clicar(item);

      expect(emissoes).toBe(0);
      expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([]);
    },
  );

  it('⚠️ QUASE-PAR: nomear a variante liga o item, e escolhê-lo grava o nome', async () => {
    const variantes = [{ id: 'v-sem-nome', nome: '', codigo: null }];
    await renderTab([vinculo()], { variantes });
    await act(async () => {
      definirVariantes([{ id: 'v-sem-nome', nome: 'Cor do ERP', codigo: null }]);
    });
    await esperar();

    await escolher(cartao(), 'Opção da Shopee para «Cor do ERP»', 'Personalizada: «Cor do ERP»');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      opcao(0, 'Cor do ERP', ['v-sem-nome']),
    ]);
    expect(within(cartao()).queryByText(/está sem nome/)).toBeNull();
  });

  it('escolher a mesma opção não é edição: nenhuma emissão', async () => {
    await renderTab([vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] })]);

    await escolher(cartao(), SELECT_P, 'Preto (6258)');

    expect(emissoes).toBe(0);
    expect(sujo()).toBe(false);
  });

  it('⚠️ QUASE-PAR: «Sem opção» tira a variante, e a linha que esvaziou sai', async () => {
    await renderTab([
      vinculo({
        variationOptions: [opcao(6258, 'Preto', ['v1']), opcao(9585, 'Preto', ['v2'])],
      }),
    ]);

    await escolher(cartao(), SELECT_P, 'Sem opção');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(9585, 'Preto', ['v2'])]);
    expect(emissoes).toBe(1);
  });

  it('uma edição mexe só nesta entrada: as outras voltam como estavam, chaves preservadas', async () => {
    const outra = vinculo({ category_id: OUTRA_FASHION });
    const ilegivel = { ...vinculo({ category_id: 900003 }), lixo: 'mantido' };
    const daInativa = vinculo({ integracaoShopeeId: 'int-2' });
    await renderTab([outra, vinculo(), ilegivel, daInativa]);

    await escolher(cartao(), SELECT_P, 'Preto (6258)');

    const valor = valorAtual() as Doc[];
    expect(valor[0]).toEqual(outra);
    expect(valor[2]).toEqual(ilegivel);
    expect(valor[3]).toEqual(daInativa);
  });

  it('sem nome na árvore: aparece desligada, e nada a grava com um nome inventado', async () => {
    h.variacoes.mockResolvedValue(
      arvore([
        variacao(101054, 'Cor', [
          grupo(0, '', [
            [900105, null],
            [900106, '  '],
            [6258, 'Preto'],
          ]),
        ]),
      ]),
    );
    await renderTab([vinculo()]);

    await clicar(entrada(cartao(), SELECT_P));
    const semNome = await within(cartao()).findAllByRole('option', { name: /^Sem nome \(9001/ });
    expect(semNome).toHaveLength(2);
    // Both: `null` AND a blank one, which `trim` reads as no name too.
    expect(semNome.map((o) => o.getAttribute('data-combobox-disabled'))).toStrictEqual([
      'true',
      'true',
    ]);
    expect(emissoes).toBe(0);
  });

  it('⚠️ QUASE-PAR: se uma linha guardada já traz o nome, é escolhível por ela', async () => {
    h.variacoes.mockResolvedValue(
      arvore([variacao(101054, 'Cor', [grupo(0, '', [[9632, null]])])]),
    );
    await renderTab([vinculo({ variationOptions: [opcao(9632, 'Azul Turquesa', ['v2'])] })]);

    await escolher(cartao(), SELECT_P, 'Azul Turquesa (9632)');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      opcao(9632, 'Azul Turquesa', ['v2', 'v1']),
    ]);
  });

  it('⚠️ QUASE-PAR: a linha que só o guardado ainda traz também dá o nome, depois que a edição a tirou', async () => {
    h.variacoes.mockResolvedValue(
      arvore([variacao(101054, 'Cor', [grupo(0, '', [[9632, null]])])]),
    );
    await renderTab([vinculo({ variationOptions: [opcao(9632, 'Azul Turquesa', ['v2'])] })]);

    await escolher(cartao(), SELECT_M, 'Sem opção');
    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([]);
    await escolher(cartao(), SELECT_M, 'Azul Turquesa (9632)');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      opcao(9632, 'Azul Turquesa', ['v2']),
    ]);
  });

  it('uma variante que ficou em duas opções: Select vazio, a frase, e escolher resolve', async () => {
    await renderTab([
      vinculo({
        variationOptions: [opcao(6258, 'Preto', ['v1']), opcao(9632, 'Azul Turquesa', ['v1'])],
      }),
    ]);

    expect(entrada(cartao(), SELECT_P).value).toBe('');
    expect(
      within(cartao()).getByText(
        'A variante «P» está em mais de uma opção (Preto (6258), Azul Turquesa (9632)) — a publicação pode usar qualquer uma delas, ou recusar o anúncio. Escolha uma.',
      ),
    ).toBeTruthy();

    await escolher(cartao(), SELECT_P, 'Azul Turquesa (9632)');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      opcao(9632, 'Azul Turquesa', ['v1']),
    ]);
    expect(within(cartao()).queryByText(/está em mais de uma opção/)).toBeNull();
  });

  it('avisa, sem impedir: várias variantes numa opção, id que sumiu, e variante removida agora', async () => {
    await renderTab([
      vinculo({
        variationOptions: [
          opcao(6258, 'Preto', ['v1', 'v2']),
          opcao(9632, 'Azul Turquesa', ['fantasma', 'v3']),
        ],
      }),
    ]);

    expect(
      within(cartao()).getByText(
        'As variantes «P», «M» estão na mesma opção «Preto»: um produto que tenha mais de uma delas não poderá ser publicado.',
      ),
    ).toBeTruthy();
    expect(
      within(cartao()).getByText(
        'A opção «Azul Turquesa» está vinculada a uma variante que não existe mais neste grupo (fantasma); a publicação a ignora.',
      ),
    ).toBeTruthy();

    await act(async () => {
      definirVariantes(VARIANTES.slice(0, 2));
    });
    await esperar();
    expect(
      within(cartao()).getByText(
        'A variante «G» está vinculada à opção «Azul Turquesa» da Shopee; ao salvar, o vínculo fica sem efeito.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Opção da Shopee para «G»')).toBeNull();
  });

  it('remover uma entrada guardada é preparado: fica à vista, com o desfazer, e sem Select ativo', async () => {
    const guardado = vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] });
    await renderTab([guardado]);

    await clicar(within(cartao()).getByRole('button', { name: 'Remover vínculo' }));

    expect(valorAtual()).toEqual([{ ...guardado, [DELETE_MARK]: true }]);
    expect(within(cartao()).getByText('Será removido')).toBeTruthy();
    expect(entrada(cartao(), SELECT_P).disabled).toBe(true);

    await clicar(within(cartao()).getByRole('button', { name: 'Desfazer remoção' }));
    expect(valorAtual()).toEqual([guardado]);
  });
});

describe('o cartão — um id que a árvore não lista', () => {
  const COM_6933 = vinculo({
    category_id: OUTRA_FASHION,
    variation_id: 101056,
    variation_group_list: BR,
    variationOptions: [opcao(6933, 'M', ['v2'])],
  });
  const SEM_6933 = arvore(
    [variacao(101056, 'Tamanho', [grupo(BR, 'Tamanho (BR)', [[6857, 'P']])])],
    OUTRA_FASHION,
  );

  it('fica selecionado e marcado, com o aviso, e nada é removido', async () => {
    h.variacoes.mockResolvedValue(SEM_6933);
    await renderTab([COM_6933]);

    const noCartao = cartao(OUTRA_FASHION);
    expect(entrada(noCartao, SELECT_M).value).toBe('M (6933) — fora da lista atual');
    expect(within(noCartao).getByText(foraDaLista('M (6933)'))).toBeTruthy();
    expect(emissoes).toBe(0);
    expect(entrada(noCartao, SELECT_M).disabled).toBe(false);
  });

  it('⚠️ QUASE-PAR: escolher a opção de outra variante no mesmo vínculo nunca derruba o id que a árvore não lista', async () => {
    h.variacoes.mockResolvedValue(SEM_6933);
    await renderTab([COM_6933]);
    const noCartao = cartao(OUTRA_FASHION);

    await escolher(noCartao, SELECT_P, 'P (6857)');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([
      opcao(6933, 'M', ['v2']),
      opcao(6857, 'P', ['v1']),
    ]);
    expect(entrada(noCartao, SELECT_M).value).toBe('M (6933) — fora da lista atual');
  });

  it('⚠️ tirar a variante de uma opção guardada fora da árvore e voltar: a opção guardada continua escolhível, com o nome guardado', async () => {
    h.variacoes.mockResolvedValue(SEM_6933);
    await renderTab([COM_6933]);
    const noCartao = cartao(OUTRA_FASHION);

    // The row 6933 loses its last variante, so the rebuild drops it from the draft…
    await escolher(noCartao, SELECT_M, 'P (6857)');
    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(6857, 'P', ['v2'])]);
    // …and the seed still offers it: the way back exists, under its stored name.
    expect(await itens(noCartao, SELECT_M)).toContain('M (6933) — fora da lista atual');
    await clicar(
      await within(noCartao).findByRole('option', { name: 'M (6933) — fora da lista atual' }),
    );

    expect(valorAtual()).toEqual([COM_6933]);
    expect(sujo()).toBe(false);
  });

  it('⚠️ QUASE-PAR: uma entrada nova da mesma chave, de outra variação, não herda as linhas guardadas', async () => {
    h.variacoes.mockResolvedValue(
      arvore(
        [
          variacao(101056, 'Tamanho', [grupo(BR, 'Tamanho (BR)', [[6857, 'P']])]),
          variacao(101054, 'Cor', [grupo(0, '', [[6258, 'Preto']])]),
        ],
        OUTRA_FASHION,
      ),
    );
    await renderTab([COM_6933]);

    await clicar(within(cartao(OUTRA_FASHION)).getByRole('button', { name: 'Remover vínculo' }));
    await abrirModal();
    await escolherCategoria(OUTRA_FASHION);
    await esperar();
    await escolher(modal(), 'Variação da Shopee', 'Cor (101054)');
    await clicar(botaoDoModal('Adicionar'));

    const [, nova] = within(blocoDaConta()).getAllByTestId(`vinculo-shopee-int-1-${OUTRA_FASHION}`);
    const oferecidos = await itens(nova!, SELECT_M);
    expect(oferecidos).toStrictEqual(['Sem opção', 'Preto (6258)', 'Personalizada: «M»']);
  });

  it('uma entrada preparada para remoção não diz mais que a opção está fora da lista; desfazer traz o aviso de volta', async () => {
    h.variacoes.mockResolvedValue(SEM_6933);
    await renderTab([COM_6933]);
    const noCartao = cartao(OUTRA_FASHION);

    await clicar(within(noCartao).getByRole('button', { name: 'Remover vínculo' }));
    expect(within(noCartao).queryByText(/não está entre as opções atuais/)).toBeNull();
    expect(
      within(noCartao).getByText(
        'Um anúncio publicado nesta categoria que use a variação 101056 será recusado ao republicar até que este vínculo seja recriado.',
      ),
    ).toBeTruthy();

    await clicar(within(noCartao).getByRole('button', { name: 'Desfazer remoção' }));
    expect(within(noCartao).getByText(foraDaLista('M (6933)'))).toBeTruthy();
    expect(within(noCartao).queryByText(/será recusado ao republicar/)).toBeNull();
  });

  it('⚠️ QUASE-PAR: sem ler a árvore, não se pode dizer que está fora: sem marca e sem aviso', async () => {
    h.variacoes.mockRejectedValue(naoEncontrado());
    await renderTab([COM_6933]);

    const noCartao = cartao(OUTRA_FASHION);
    expect(entrada(noCartao, SELECT_M).value).toBe('M (6933)');
    expect(within(noCartao).queryByText(/não está entre as opções atuais/)).toBeNull();
  });

  it('⚠️ QUASE-PAR: sem ler a árvore, a opção guardada segue escolhível depois de sair do rascunho', async () => {
    h.variacoes.mockRejectedValue(naoEncontrado());
    const comPreto = vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] });
    await renderTab([comPreto]);

    await escolher(cartao(), SELECT_P, 'Personalizada: «P»');
    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(0, 'P', ['v1'])]);

    expect(await itens(cartao(), SELECT_P)).toContain('Preto (6258)');
  });

  it('⚠️ QUASE-PAR: um id de OUTRO grupo também está fora do grupo escolhido', async () => {
    await renderTab([
      vinculo({
        variation_id: 101056,
        variation_group_list: BR,
        variationOptions: [opcao(6270, 'M', ['v2'])],
      }),
    ]);

    expect(entrada(cartao(), SELECT_M).value).toBe('M (6270) — fora da lista atual');
    expect(within(cartao()).getByText(foraDaLista('M (6270)'))).toBeTruthy();
  });

  it('uma variação que a árvore não tem mais: as linhas ficam, todas marcadas', async () => {
    h.variacoes.mockResolvedValue(arvore([COR], OUTRA_FASHION));
    await renderTab([COM_6933]);

    const noCartao = cartao(OUTRA_FASHION);
    expect(within(noCartao).getByText(`Variação 101056 · Grupo ${BR}`)).toBeTruthy();
    expect(entrada(noCartao, SELECT_M).value).toBe('M (6933) — fora da lista atual');
  });
});

describe('o cartão — grupo 0 guardado', () => {
  it('variação com dois grupos: pede o grupo, com o aviso, e as opções ficam desligadas até escolher', async () => {
    await renderTab([SEM_GRUPO]);

    expect(
      within(cartao()).getByText(
        'A Shopee exige o grupo de opções desta variação, e este vínculo não o registra. Escolha o grupo — ou reimporte o anúncio, que o registra.',
      ),
    ).toBeTruthy();
    expect(entrada(cartao(), SELECT_P).disabled).toBe(true);
    // Every group's ids count while none is chosen: 6857 is listed, so no false warning.
    expect(within(cartao()).queryByText(/não está entre as opções atuais/)).toBeNull();
    expect(entrada(cartao(), SELECT_P).value).toBe('P (6857)');

    await escolher(cartao(), 'Grupo de opções', `Tamanho (BR) (${BR})`);

    expect((valorAtual() as Doc[])[0]).toEqual({ ...SEM_GRUPO, variation_group_list: BR });
    expect(entrada(cartao(), SELECT_P).disabled).toBe(false);
    expect(within(cartao()).queryByLabelText('Grupo de opções')).toBeNull();
    expect(within(cartao()).queryByText(/A Shopee exige o grupo/)).toBeNull();
  });

  it('uma opção de OUTRO grupo: sem aviso enquanto falta o grupo; escolhido o BR, a linha fica e a frase diz variação e grupo', async () => {
    const doInt = vinculo({ variation_id: 101056, variationOptions: [opcao(6270, 'M', ['v2'])] });
    await renderTab([doInt]);

    expect(within(cartao()).queryByText(/não está entre as opções atuais/)).toBeNull();

    await escolher(cartao(), 'Grupo de opções', `Tamanho (BR) (${BR})`);

    expect((valorAtual() as Doc[])[0]).toEqual({ ...doInt, variation_group_list: BR });
    expect(within(cartao()).getByText(foraDaLista('M (6270)'))).toBeTruthy();
  });

  it('⚠️ QUASE-PAR: variação de um grupo: 0 é o sentinela, sem seletor nem aviso, e as opções abertas', async () => {
    await renderTab([vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] })]);

    expect(within(cartao()).queryByLabelText('Grupo de opções')).toBeNull();
    expect(within(cartao()).queryByText(/A Shopee exige o grupo/)).toBeNull();
    expect(entrada(cartao(), SELECT_P).disabled).toBe(false);
    expect(within(cartao()).getByText('Cor (101054)')).toBeTruthy();
  });

  it('⚠️ QUASE-PAR: um grupo só, com id próprio: 0 guardado lê as opções dele', async () => {
    h.variacoes.mockResolvedValue(
      arvore([variacao(101056, 'Tamanho', [grupo(BR, 'Tamanho (BR)', [[6933, 'M']])])]),
    );
    await renderTab([vinculo({ variation_id: 101056 })]);

    expect(entrada(cartao(), SELECT_P).disabled).toBe(false);
    expect(await itens(cartao(), SELECT_P)).toContain('M (6933)');
    expect((valorAtual() as Doc[])[0]?.variation_group_list).toBe(0);
  });

  it('só leitura: mostra o aviso, sem seletor de grupo', async () => {
    await renderTab([SEM_GRUPO], { disabled: true });

    expect(within(cartao()).getByText(/A Shopee exige o grupo/)).toBeTruthy();
    expect(within(cartao()).queryByLabelText('Grupo de opções')).toBeNull();
  });

  it('com a árvore fora do ar não há como dizer que falta grupo: as opções guardadas seguem editáveis', async () => {
    h.variacoes.mockRejectedValue(naoEncontrado());
    await renderTab([SEM_GRUPO]);

    expect(within(cartao()).queryByText(/A Shopee exige o grupo/)).toBeNull();
    expect(entrada(cartao(), SELECT_P).disabled).toBe(false);
    expect(entrada(cartao(), SELECT_P).value).toBe('P (6857)');
  });
});

describe('o cartão — a faixa do nome personalizado', () => {
  const CUSTOM_30 = 'x'.repeat(30);
  const CUSTOM_31 = 'x'.repeat(31);

  it('30 caracteres cabem numa faixa 1..30', async () => {
    await renderTab([vinculo({ variationOptions: [opcao(0, CUSTOM_30, ['v1'])] })]);

    expect(h.limitesDoItem).toHaveBeenCalledWith({ integracaoId: 'int-1', categoryId: FASHION });
    expect(within(cartao()).queryByText(/caracteres e a Shopee aceita/)).toBeNull();
  });

  it('⚠️ QUASE-PAR: 31 avisam, sem impedir nada', async () => {
    await renderTab([vinculo({ variationOptions: [opcao(0, CUSTOM_31, ['v1'])] })]);

    expect(
      within(cartao()).getByText(
        `A opção personalizada «${CUSTOM_31}» tem 31 caracteres e a Shopee aceita 1..30 — encurte o nome da variante (aba Variantes) e escolha de novo a opção personalizada dela aqui.`,
      ),
    ).toBeTruthy();
    expect(emissoes).toBe(0);
  });

  it('renomear a variante não muda a linha guardada: o aviso fica até escolher de novo a opção personalizada dela', async () => {
    const curto = 'Nome inventado curto';
    await renderTab([vinculo()], { variantes: [{ id: 'v1', nome: CUSTOM_31, codigo: null }] });
    await escolher(
      cartao(),
      `Opção da Shopee para «${CUSTOM_31}»`,
      `Personalizada: «${CUSTOM_31}»`,
    );
    expect(within(cartao()).getByText(/tem 31 caracteres e a Shopee aceita 1\.\.30/)).toBeTruthy();

    await act(async () => {
      definirVariantes([{ id: 'v1', nome: curto, codigo: null }]);
    });
    await esperar();
    // The row keeps the name it was chosen with: a rename re-syncs nothing.
    expect(within(cartao()).getByText(/tem 31 caracteres e a Shopee aceita 1\.\.30/)).toBeTruthy();
    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(0, CUSTOM_31, ['v1'])]);

    // ⚠️ QUASE-PAR: the exit the sentence names clears it.
    await escolher(cartao(), `Opção da Shopee para «${curto}»`, `Personalizada: «${curto}»`);
    expect(within(cartao()).queryByText(/caracteres e a Shopee aceita/)).toBeNull();
    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(0, curto, ['v1'])]);
  });

  it('⚠️ um nome PADRÃO de 32 caracteres nunca avisa, e nem lê a faixa', async () => {
    const nome = 'Sola De Borracha Anti-Derrapante';
    expect(nome).toHaveLength(32);
    await renderTab([vinculo({ variationOptions: [opcao(900107, nome, ['v1'])] })]);

    expect(within(cartao()).queryByText(/caracteres e a Shopee aceita/)).toBeNull();
    expect(h.limitesDoItem).not.toHaveBeenCalled();
  });

  it('⚠️ QUASE-PAR: uma linha personalizada sem variante nunca é enviada: nem lê a faixa, nem avisa', async () => {
    await renderTab([vinculo({ variationOptions: [opcao(0, CUSTOM_31, [])] })]);

    expect(within(cartao()).queryByText(/caracteres e a Shopee aceita/)).toBeNull();
    expect(h.limitesDoItem).not.toHaveBeenCalled();
  });

  it('uma falha ao ler a faixa não diz nada: a publicação recusa o nome por conta própria', async () => {
    h.limitesDoItem.mockRejectedValue(naoEncontrado());
    await renderTab([vinculo({ variationOptions: [opcao(0, CUSTOM_31, ['v1'])] })]);

    expect(within(cartao()).queryByText(/caracteres e a Shopee aceita/)).toBeNull();
    // The read WAS made, and nothing in the card speaks of its failure.
    expect(h.limitesDoItem).toHaveBeenCalledWith({ integracaoId: 'int-1', categoryId: FASHION });
    expect(within(cartao()).queryAllByRole('alert')).toHaveLength(0);
    expect(within(cartao()).queryByText('falhou')).toBeNull();
  });
});

describe('o cartão — quando a leitura falha', () => {
  it('502 `error_not_found`: a frase, sem nada novo, e o guardado segue editável', async () => {
    h.variacoes.mockRejectedValue(naoEncontrado());
    await renderTab([vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] })]);

    expect(
      within(cartao()).getByText(
        'A Shopee não reconheceu a consulta de variações (HTTP 404): o backend da Shopee está desatualizado. Os vínculos guardados continuam aqui e podem ser removidos; para escolher opções novas, o backend precisa ser atualizado.',
      ),
    ).toBeTruthy();
    expect(within(cartao()).queryByRole('button', { name: 'Tentar de novo' })).toBeNull();

    expect(await itens(cartao(), SELECT_P)).toStrictEqual([
      'Sem opção',
      'Preto (6258)',
      'Personalizada: «P»',
    ]);
    await clicar(await within(cartao()).findByRole('option', { name: 'Personalizada: «P»' }));
    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(0, 'P', ['v1'])]);
  });

  it('⚠️ QUASE-PAR: outro 502 fica na frase do backend, não na do 404', async () => {
    h.variacoes.mockRejectedValue(
      new ShopeeClientHttpError('Falha inventada na Shopee', 502, 'SHOPEE_HTTP_ERROR', 'outro'),
    );
    await renderTab([vinculo()]);

    expect(within(cartao()).getByText('Falha inventada na Shopee')).toBeTruthy();
    expect(within(cartao()).queryByText(/está desatualizado/)).toBeNull();
  });

  it('categoria desconhecida numa entrada guardada: a terceira frase, só leitura, com Remover', async () => {
    h.variacoes.mockRejectedValue(categoriaDesconhecida());
    await renderTab([vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] })]);

    expect(
      within(cartao()).getByText(
        'Esta categoria não existe mais na árvore desta conta — remova o vínculo ou recrie-o em outra categoria.',
      ),
    ).toBeTruthy();
    expect(entrada(cartao(), SELECT_P).disabled).toBe(true);
    expect(within(cartao()).getByRole('button', { name: 'Remover vínculo' })).toBeTruthy();
  });

  it('uma falha repetível oferece «Tentar de novo», e tentar lê de novo', async () => {
    h.variacoes.mockRejectedValueOnce(new ShopeeClientHttpError('Fora do ar', 500, null));
    await renderTab([vinculo()]);

    await clicar(within(cartao()).getByRole('button', { name: 'Tentar de novo' }));

    expect(within(cartao()).queryByText('Fora do ar')).toBeNull();
    expect(within(cartao()).getByText('Cor (101054)')).toBeTruthy();
    expect(h.variacoes).toHaveBeenCalledTimes(2);
  });
});

describe('remover um vínculo — o que a publicação faz depois (#1911 P14b)', () => {
  const FRASE_ACRESCENTA =
    'Ao remover este vínculo, a próxima publicação acrescenta a opção «P» e move o modelo para ela; «Opção inventada 1» fica sem modelo.';
  const FRASE_RECUSA_101054 =
    'Um anúncio publicado nesta categoria que use a variação 101054 será recusado ao republicar até que este vínculo seja recriado.';
  /** The import bound the live option «Opção inventada 1» to the variante «P». */
  const RENOMEADA = vinculo({
    ...PERSONALIZADO,
    variationOptions: [opcao(0, 'Opção inventada 1', ['v1'])],
  });
  const PADRAO = vinculo({ variationOptions: [opcao(6258, 'Preto', ['v1'])] });

  async function remover(escopo: () => HTMLElement) {
    await clicar(within(escopo()).getByRole('button', { name: 'Remover vínculo' }));
  }

  describe('personalizada (Q2)', () => {
    it('remover diz que a opção «P» será acrescentada; desfazer leva a frase embora', async () => {
      await renderTab([RENOMEADA]);
      expect(screen.queryByText(/Ao remover este vínculo/)).toBeNull();

      await remover(() => somenteLeitura(0));
      expect(within(somenteLeitura(0)).getByText(FRASE_ACRESCENTA)).toBeTruthy();

      await clicar(within(somenteLeitura(0)).getByRole('button', { name: 'Desfazer remoção' }));
      expect(screen.queryByText(/Ao remover este vínculo/)).toBeNull();
    });

    it('⛔ QUASE: a linha já tem o nome da variante — ela volta a casar, sem frase', async () => {
      await renderTab([PERSONALIZADO]);

      await remover(() => somenteLeitura(0));

      expect(within(somenteLeitura(0)).getByText('Será removido')).toBeTruthy();
      expect(screen.queryByText(/Ao remover este vínculo/)).toBeNull();
    });
  });

  describe('padrão (Q3b)', () => {
    it('remover diz que um anúncio da variação 101054 será recusado; desfazer leva a frase embora', async () => {
      await renderTab([PADRAO]);

      await remover(() => cartao());
      expect(within(cartao()).getByText(FRASE_RECUSA_101054)).toBeTruthy();

      await clicar(within(cartao()).getByRole('button', { name: 'Desfazer remoção' }));
      expect(screen.queryByText(/será recusado ao republicar/)).toBeNull();
    });

    it('⚠️ PAR: trocar por OUTRA variação (101056) na mesma chave — a frase fica, com o id da removida', async () => {
      await renderTab([PADRAO]);
      await remover(() => cartao());
      await abrirModal();
      await escolherCategoria(FASHION);
      await esperar();
      await escolher(modal(), 'Variação da Shopee', 'Tamanho (101056)');
      await escolher(modal(), 'Grupo de opções', `Tamanho (BR) (${BR})`);
      await clicar(botaoDoModal('Adicionar'));

      const [removida] = within(blocoDaConta()).getAllByTestId(`vinculo-shopee-int-1-${FASHION}`);
      expect(within(removida!).getByText(FRASE_RECUSA_101054)).toBeTruthy();
    });

    it('⛔ QUASE: recriar a MESMA variação (101054) na mesma chave — a frase sai', async () => {
      await renderTab([PADRAO]);
      await remover(() => cartao());
      await abrirModal();
      await escolherCategoria(FASHION);
      await esperar();
      await escolher(modal(), 'Variação da Shopee', 'Cor (101054)');
      await clicar(botaoDoModal('Adicionar'));

      expect(within(blocoDaConta()).getAllByTestId(`vinculo-shopee-int-1-${FASHION}`)).toHaveLength(
        2,
      );
      expect(screen.queryByText(/será recusado ao republicar/)).toBeNull();
    });

    it('⛔ QUASE: remover uma entrada NOVA (do modal) a tira de vez — não há frase', async () => {
      await renderTab(null);
      await abrirModal();
      await escolherCategoria(FASHION);
      await esperar();
      await escolher(modal(), 'Variação da Shopee', 'Cor (101054)');
      await clicar(botaoDoModal('Adicionar'));

      await remover(() => cartao());

      expect(screen.queryByTestId(`vinculo-shopee-int-1-${FASHION}`)).toBeNull();
      expect(screen.queryByText(/será recusado ao republicar/)).toBeNull();
    });
  });

  describe('vínculos de outras contas', () => {
    it('uma conta INATIVA da Shopee ainda pode ser publicada: as duas frases aparecem', async () => {
      await renderTab([
        vinculo({ ...RENOMEADA, integracaoShopeeId: 'int-2' }),
        vinculo({ ...PADRAO, integracaoShopeeId: 'int-2' }),
      ]);

      await remover(() => somenteLeitura(0));
      await remover(() => somenteLeitura(1));

      expect(within(somenteLeitura(0)).getByText(FRASE_ACRESCENTA)).toBeTruthy();
      expect(within(somenteLeitura(1)).getByText(FRASE_RECUSA_101054)).toBeTruthy();
    });

    it.each(['ML1', 'int-9'])(
      '⛔ QUASE: a conta %j não é uma conta da Shopee que exista — nenhuma publicação a lê, sem frase',
      async (conta) => {
        await renderTab([
          vinculo({ ...RENOMEADA, integracaoShopeeId: conta }),
          vinculo({ ...PADRAO, integracaoShopeeId: conta }),
        ]);

        await remover(() => somenteLeitura(0));
        await remover(() => somenteLeitura(1));

        expect(within(somenteLeitura(0)).getByText('Será removido')).toBeTruthy();
        expect(within(somenteLeitura(1)).getByText('Será removido')).toBeTruthy();
        expect(screen.queryByText(/Ao remover este vínculo/)).toBeNull();
        expect(screen.queryByText(/será recusado ao republicar/)).toBeNull();
      },
    );

    it.each([
      ['lendo a lista de contas', 'pending', null],
      ['sem permissão para a lista', 'error', new FirebaseError('permission-denied', 'negado')],
    ] as const)(
      'com a lista de contas %s, a conta pode ser publicável: a frase aparece',
      async (_caso, status, erro) => {
        h.statusIntegracoes = status;
        h.erroIntegracoes = erro;
        await renderTab([RENOMEADA, PADRAO]);

        await remover(() => somenteLeitura(0));
        await remover(() => somenteLeitura(1));

        expect(within(somenteLeitura(0)).getByText(FRASE_ACRESCENTA)).toBeTruthy();
        expect(within(somenteLeitura(1)).getByText(FRASE_RECUSA_101054)).toBeTruthy();
      },
    );

    // The near-miss of the ML1/int-9 test above: there the READ list says the conta is
    // not Shopee's; here no list was read, so even a conta named like another
    // channel's may be Shopee's — the warning still shows.
    it.each([
      ['lendo a lista de contas', 'pending', null],
      ['sem permissão para a lista', 'error', new FirebaseError('permission-denied', 'negado')],
    ] as const)(
      'com a lista de contas %s, até a conta ML1 pode ser da Shopee: a frase aparece',
      async (_caso, status, erro) => {
        h.statusIntegracoes = status;
        h.erroIntegracoes = erro;
        await renderTab([
          vinculo({ ...RENOMEADA, integracaoShopeeId: 'ML1' }),
          vinculo({ ...PADRAO, integracaoShopeeId: 'ML1' }),
        ]);

        await remover(() => somenteLeitura(0));
        await remover(() => somenteLeitura(1));

        expect(within(somenteLeitura(0)).getByText(FRASE_ACRESCENTA)).toBeTruthy();
        expect(within(somenteLeitura(1)).getByText(FRASE_RECUSA_101054)).toBeTruthy();
      },
    );
  });
});

describe('o cartão — «Escolha uma.» só onde há o que escolher (#1911 P14b, Q4)', () => {
  const EM_DUAS = [opcao(6258, 'Preto', ['v1']), opcao(9632, 'Azul Turquesa', ['v1'])];
  const SEM_ESCOLHA =
    'A variante «P» está em mais de uma opção (Preto (6258), Azul Turquesa (9632)) — a publicação pode usar qualquer uma delas, ou recusar o anúncio.';

  it('uma entrada personalizada: a frase termina sem «Escolha uma.»', async () => {
    await renderTab([
      vinculo({
        ...PERSONALIZADO,
        variationOptions: [opcao(0, 'P', ['v1']), opcao(0, 'Opção inventada 1', ['v1'])],
      }),
    ]);

    expect(
      within(somenteLeitura(0)).getByText(
        'A variante «P» está em mais de uma opção (P, Opção inventada 1) — a publicação pode usar qualquer uma delas, ou recusar o anúncio.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Escolha uma\./)).toBeNull();
  });

  it('a entrada de uma conta inativa: a frase termina sem «Escolha uma.»', async () => {
    await renderTab([vinculo({ integracaoShopeeId: 'int-2', variationOptions: EM_DUAS })]);

    expect(within(outras()).getByText(SEM_ESCOLHA)).toBeTruthy();
    expect(screen.queryByText(/Escolha uma\./)).toBeNull();
  });

  it('uma categoria desconhecida: a frase termina sem «Escolha uma.»', async () => {
    h.variacoes.mockRejectedValue(categoriaDesconhecida());
    await renderTab([vinculo({ variationOptions: EM_DUAS })]);

    expect(within(cartao()).getByText(SEM_ESCOLHA)).toBeTruthy();
    expect(screen.queryByText(/Escolha uma\./)).toBeNull();
  });

  it('um formulário só de leitura: a frase termina sem «Escolha uma.»', async () => {
    await renderTab([vinculo({ variationOptions: EM_DUAS })], { disabled: true });

    expect(within(cartao()).getByText(SEM_ESCOLHA)).toBeTruthy();
    expect(screen.queryByText(/Escolha uma\./)).toBeNull();
  });

  it('⛔ QUASE: o cartão que espera o grupo vai poder escolher depois — mantém «Escolha uma.»', async () => {
    await renderTab([
      vinculo({
        variation_id: 101056,
        variationOptions: [opcao(6857, 'P', ['v1']), opcao(6933, 'M', ['v1'])],
      }),
    ]);

    // The group is missing, so nothing is editable YET.
    expect(within(cartao()).getByText(/A Shopee exige o grupo/)).toBeTruthy();
    expect(entrada(cartao(), SELECT_P).disabled).toBe(true);
    expect(
      within(cartao()).getByText(
        'A variante «P» está em mais de uma opção (P (6857), M (6933)) — a publicação pode usar qualquer uma delas, ou recusar o anúncio. Escolha uma.',
      ),
    ).toBeTruthy();
  });
});

describe('#1787 — tirar o que se acabou de acrescentar volta ao que estava', () => {
  async function adicionarERemover(inicial: unknown) {
    await renderTab(inicial);
    await abrirModal();
    await escolherCategoria(FASHION);
    await esperar();
    await escolher(modal(), 'Variação da Shopee', 'Cor (101054)');
    await clicar(botaoDoModal('Adicionar'));
    expect(sujo()).toBe(true);
    await clicar(within(cartao()).getByRole('button', { name: 'Remover vínculo' }));
  }

  it('IGUAL: `null` guardado volta a `null`, intacto', async () => {
    await adicionarERemover(null);
    expect(valorAtual()).toBeNull();
    expect(sujo()).toBe(false);
  });

  it('⚠️ QUASE-PAR: `[]` guardado volta a `[]`, nunca a `null`', async () => {
    await adicionarERemover([]);
    expect(valorAtual()).toEqual([]);
    expect(sujo()).toBe(false);
  });

  it('⚠️ QUASE-PAR: sobrando outra entrada, ela fica e nada é preparado', async () => {
    const outra = vinculo({ category_id: OUTRA_FASHION });
    await adicionarERemover([outra]);
    expect(valorAtual()).toEqual([outra]);
    expect(sujo()).toBe(false);
  });

  it('⚠️ uma entrada GUARDADA nunca sai de vez: fica preparada, mesmo sendo a única', async () => {
    const guardado = vinculo();
    await renderTab([guardado]);
    await clicar(within(cartao()).getByRole('button', { name: 'Remover vínculo' }));
    expect(valorAtual()).toEqual([{ ...guardado, [DELETE_MARK]: true }]);
  });

  it('trocar a variação e desistir: o substituto da mesma chave sai de vez, e desfazer a remoção volta ao pristino', async () => {
    const guardado = vinculo();
    await renderTab([guardado]);
    await clicar(within(cartao()).getByRole('button', { name: 'Remover vínculo' }));
    await abrirModal();
    await escolherCategoria(FASHION);
    await esperar();
    await escolher(modal(), 'Variação da Shopee', 'Tamanho (101056)');
    await escolher(modal(), 'Grupo de opções', `Tamanho (BR) (${BR})`);
    await clicar(botaoDoModal('Adicionar'));
    const [, substituto] = within(blocoDaConta()).getAllByTestId(`vinculo-shopee-int-1-${FASHION}`);

    await clicar(within(substituto!).getByRole('button', { name: 'Remover vínculo' }));

    expect(within(blocoDaConta()).getAllByTestId(`vinculo-shopee-int-1-${FASHION}`)).toHaveLength(
      1,
    );
    expect(within(blocoDaConta()).getAllByText('Será removido')).toHaveLength(1);
    expect(valorAtual()).toEqual([{ ...guardado, [DELETE_MARK]: true }]);

    await clicar(within(cartao()).getByRole('button', { name: 'Desfazer remoção' }));
    expect(valorAtual()).toEqual([guardado]);
    expect(sujo()).toBe(false);
  });
});
