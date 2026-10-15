import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EntradaTabelaShopee } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import type { ShopeeCategoriaBrowserProps } from '@/components/shopee/ShopeeCategoriaBrowser';
import type {
  CategoriaResumoDto,
  DetalheTabelaMedidasDto,
  ListaTabelasMedidasDto,
  RespostaLimitesShopee,
} from '@/lib/shopee/wire';

const h = vi.hoisted(() => ({
  lista: vi.fn(),
  limites: vi.fn(),
  detalhe: vi.fn(),
}));

// The REAL error classes stay: `erros.ts` narrows on them.
vi.mock('@/lib/shopee/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/client')>();
  return {
    ...actual,
    useShopeeClient: () => ({
      tabelaMedidasLista: h.lista,
      limites: h.limites,
      tabelaMedidasDetalhe: h.detalhe,
    }),
  };
});

/**
 * The browser has its own suite; here it is a stub exposing exactly what the
 * MODAL owes it — where it opens (`categoriaInicial`) — and one button per
 * fixture category standing in for a leaf's "Escolher". The ONE label function
 * stays real: the stored `name` must come from it.
 */
vi.mock('@/components/shopee/ShopeeCategoriaBrowser', async (importActual) => {
  const actual = await importActual<typeof import('@/components/shopee/ShopeeCategoriaBrowser')>();
  return {
    ...actual,
    ShopeeCategoriaBrowser: (props: ShopeeCategoriaBrowserProps) => (
      <div data-testid="browser-stub">
        <span>inicio:{String(props.categoriaInicial)}</span>
        <button type="button" onClick={() => props.onEscolher(CAMISETAS)}>
          stub Camisetas
        </button>
        <button type="button" onClick={() => props.onEscolher(CAMISETAS_VIZINHA)}>
          stub Camisetas vizinha
        </button>
      </div>
    ),
  };
});

const {
  EscolherTabelaShopeeModal,
  chaveDetalheTabelaShopee,
  chaveLimitesShopee,
  chaveListaTabelasShopee,
} = await import('./EscolherTabelaShopeeModal');
const { ShopeeClientHttpError, ShopeeClientNetworkError } = await import('@/lib/shopee/client');
const { linhasDaConta, marcarRemocao } = await import('@/lib/shopee/tabelasMedidasForm');

/** Fixture categories: one leaf, and its neighbour id (±1) for the near-misses. */
const CAMISETAS: CategoriaResumoDto = {
  categoryId: 100087,
  name: 'Camisetas',
  originalName: 'T-Shirts',
  isLeaf: true,
};
const CAMISETAS_VIZINHA: CategoriaResumoDto = {
  categoryId: 100088,
  name: null,
  originalName: 'Pants',
  isLeaf: true,
};

const CONTA = 'int-1';

function lista(over: Partial<ListaTabelasMedidasDto> = {}): ListaTabelasMedidasDto {
  return {
    leaf: true,
    categoryId: 100087,
    tabelas: [
      { sizeChartId: 700024641, sizeChartName: 'Tabela Básica', legivel: true },
      { sizeChartId: 700024613, sizeChartName: null, legivel: true },
      { sizeChartId: 700024639, sizeChartName: null, legivel: false },
    ],
    totalCount: 3,
    truncado: false,
    removidas: 0,
    idsIlegiveis: 0,
    ...over,
  };
}

function limites(
  sizeChartLimit: RespostaLimitesShopee['limites']['sizeChartLimit'],
): RespostaLimitesShopee {
  return { scope: 'category', categoryId: 100087, limites: { sizeChartLimit } };
}

const LIMITE_NEUTRO = {
  sizeChartMandatory: null,
  supportImageSizeChart: null,
  supportTemplateSizeChart: true,
};

/** The doc sample's projection — what the detail route answers for 700024639. */
const DETALHE: DetalheTabelaMedidasDto = {
  tabela: {
    sizeChartId: 700024639,
    sizeChartName: 'testtestt',
    colunas: [
      {
        displayName: 'test single input number',
        inputType: 'Input Single Number',
        unit: 'cm',
        celulas: [
          { tipo: 'numero', option: null, value: 1, minValue: null, maxValue: null },
          { tipo: 'numero', option: null, value: 2, minValue: null, maxValue: null },
        ],
      },
    ],
    linhas: [
      [{ tipo: 'numero', option: null, value: 1, minValue: null, maxValue: null }],
      [{ tipo: 'numero', option: null, value: 2, minValue: null, maxValue: null }],
    ],
    problemas: [],
  },
};

function novoQc(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
}

type Alvo = Parameters<typeof EscolherTabelaShopeeModal>[0]['alvo'];

function show(opts: { alvo?: Alvo; mapa?: unknown; qc?: QueryClient } = {}) {
  const qc = opts.qc ?? novoQc();
  const onConfirmar = vi.fn<(e: EntradaTabelaShopee) => void>();
  const onFechar = vi.fn();
  const { linhas } = linhasDaConta(opts.mapa ?? null, CONTA);
  const ui: ReactElement = (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <EscolherTabelaShopeeModal
          integracaoId={CONTA}
          contaNome="Loja Teste"
          alvo={opts.alvo ?? { tipo: 'adicionar' }}
          linhas={linhas}
          onConfirmar={onConfirmar}
          onFechar={onFechar}
        />
      </QueryClientProvider>
    </MantineTestProvider>
  );
  return { ...render(ui), onConfirmar, onFechar, qc };
}

/** Step 1 → step 2 through the stub, then wait for the list. */
async function escolherCamisetas(qual: 'Camisetas' | 'Camisetas vizinha' = 'Camisetas') {
  fireEvent.click(screen.getByRole('button', { name: `stub ${qual}` }));
  await waitFor(() => expect(h.lista).toHaveBeenCalled());
}

function confirmar(): HTMLButtonElement {
  return screen.getByTestId('shopee-escolher-tabela-confirmar') as HTMLButtonElement;
}

async function marcarModelo(id: number) {
  const opcao = await screen.findByTestId(`shopee-tabela-opcao-${String(id)}`);
  fireEvent.click(within(opcao).getByRole('radio'));
}

beforeEach(() => {
  h.lista.mockReset();
  h.limites.mockReset();
  h.detalhe.mockReset();
  h.lista.mockResolvedValue(lista());
  h.limites.mockResolvedValue(limites(LIMITE_NEUTRO));
  h.detalhe.mockResolvedValue(DETALHE);
});

describe('EscolherTabelaShopeeModal — category → template → entry', () => {
  it('stores the CATEGORY label as `name` — never the chart’s — through the strict 3-key shape', async () => {
    const { onConfirmar } = show();
    expect(screen.getByTestId('shopee-escolher-tabela-modal')).toBeTruthy();
    await escolherCamisetas();
    expect(h.lista).toHaveBeenCalledWith({ integracaoId: CONTA, categoryId: 100087 });
    expect(h.limites).toHaveBeenCalledWith({ integracaoId: CONTA, categoryId: 100087 });

    expect(confirmar().disabled).toBe(true);
    await marcarModelo(700024641);
    expect(confirmar().disabled).toBe(false);
    fireEvent.click(confirmar());

    expect(onConfirmar).toHaveBeenCalledTimes(1);
    const entrada = onConfirmar.mock.calls[0]?.[0];
    // M62: "Tabela Básica" is the chart's name; the corpus stores the category's.
    expect(entrada).toStrictEqual({
      categoryId: 100087,
      size_chart_id: 700024641,
      name: 'Camisetas',
    });
    expect(Object.keys(entrada ?? {})).toEqual(['categoryId', 'size_chart_id', 'name']);
  });

  it('a category with no display name stores the SAME label the browser shows (original name)', async () => {
    const { onConfirmar } = show();
    h.lista.mockResolvedValue(lista({ categoryId: 100088 }));
    await escolherCamisetas('Camisetas vizinha');
    await marcarModelo(700024613);
    fireEvent.click(confirmar());
    expect(onConfirmar).toHaveBeenCalledWith({
      categoryId: 100088,
      size_chart_id: 700024613,
      name: 'Pants',
    });
  });

  it('rows read "<name or Sem nome> #<id>" and flag an unreadable detail', async () => {
    show();
    await escolherCamisetas();
    expect(
      within(await screen.findByTestId('shopee-tabela-opcao-700024641')).getByText(
        'Tabela Básica #700024641',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('shopee-tabela-opcao-700024613')).getByText('Sem nome #700024613'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('shopee-tabela-opcao-700024639')).getByText(
        'Sem nome #700024639 (detalhe ilegível)',
      ),
    ).toBeTruthy();
  });

  it('caches under the frozen keys (list, limites; the detail one is shared with the tab)', async () => {
    const { qc } = show();
    await escolherCamisetas();
    await screen.findByTestId('shopee-tabela-opcao-700024641');
    expect(chaveListaTabelasShopee(CONTA, 100087)).toEqual([
      'shopee',
      'tabela-medidas',
      'lista',
      CONTA,
      100087,
    ]);
    expect(chaveLimitesShopee(CONTA, 100087)).toEqual(['shopee', 'limites', CONTA, 100087]);
    expect(chaveDetalheTabelaShopee(CONTA, 700024639)).toEqual([
      'shopee',
      'tabela-medidas',
      'detalhe',
      CONTA,
      700024639,
    ]);
    expect(qc.getQueryData(['shopee', 'tabela-medidas', 'lista', CONTA, 100087])).toEqual(lista());
    await waitFor(() =>
      expect(qc.getQueryData(['shopee', 'limites', CONTA, 100087])).toEqual(limites(LIMITE_NEUTRO)),
    );
  });

  it('"Cancelar" closes without confirming', async () => {
    const { onConfirmar, onFechar } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onFechar).toHaveBeenCalledTimes(1);
    expect(onConfirmar).not.toHaveBeenCalled();
  });
});

describe('EscolherTabelaShopeeModal — the confirm label comes from THE selector', () => {
  const ENTRADA = { categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas' };

  async function rotulo(mapa: unknown, alvo?: Alvo): Promise<string | null> {
    show({ mapa, alvo });
    await escolherCamisetas();
    await screen.findByTestId('shopee-tabela-opcao-700024641');
    return confirmar().textContent;
  }

  it('no entry for the category → "Adicionar"', async () => {
    expect(await rotulo(null)).toBe('Adicionar');
  });

  it('an ACTIVE entry for the SAME category → "Substituir a tabela desta categoria" + a line saying so', async () => {
    expect(await rotulo({ [CONTA]: [ENTRADA] })).toBe('Substituir a tabela desta categoria');
    expect(
      screen.getByText('Esta conta já tem uma tabela para esta categoria — ela será substituída.'),
    ).toBeTruthy();
  });

  it('NEAR-MISS: an entry for the NEIGHBOUR category (id + 1) → "Adicionar"', async () => {
    expect(await rotulo({ [CONTA]: [{ ...ENTRADA, categoryId: 100088 }] })).toBe('Adicionar');
  });

  it('NEAR-MISS: the same size_chart_id or the same name under ANOTHER category → "Adicionar" (neither is identity)', async () => {
    expect(
      await rotulo({
        [CONTA]: [
          { categoryId: 100086, size_chart_id: 700024641, name: 'Camisetas' },
          { categoryId: 400055, size_chart_id: 700024639, name: 'Camisetas' },
        ],
      }),
    ).toBe('Adicionar');
  });

  it('NEAR-MISS: the same category on ANOTHER conta → "Adicionar"', async () => {
    expect(await rotulo({ 'conta-shopee-irma': [ENTRADA] })).toBe('Adicionar');
  });

  it('an entry STAGED for removal no longer counts → "Adicionar"', async () => {
    const marcado = marcarRemocao({ [CONTA]: [ENTRADA] }, CONTA, 0, true);
    expect(await rotulo(marcado)).toBe('Adicionar');
  });

  it('a legacy string-typed category (unreadable) does not count → "Adicionar"', async () => {
    expect(await rotulo({ [CONTA]: [{ ...ENTRADA, categoryId: '100087' }] })).toBe('Adicionar');
  });

  it('marking the first of two duplicates leaves the second active → still "Substituir…"', async () => {
    const marcado = marcarRemocao(
      { [CONTA]: [ENTRADA, { ...ENTRADA, size_chart_id: 700024641, name: '(Cópia) Camisetas' }] },
      CONTA,
      0,
      true,
    );
    expect(await rotulo(marcado)).toBe('Substituir a tabela desta categoria');
  });

  it('"Trocar" on a stored row is labelled "Trocar" — it always replaces THAT row', async () => {
    expect(
      await rotulo({ [CONTA]: [ENTRADA] }, { tipo: 'trocar', indice: 0, categoriaAtual: 100087 }),
    ).toBe('Trocar');
  });
});

describe('EscolherTabelaShopeeModal — "Trocar" into a category ANOTHER row covers (OBS-1)', () => {
  const CAMISETAS_0 = { categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas' };
  const CALCAS_1 = { categoryId: 400055, size_chart_id: 700024613, name: 'Calças' };
  const DUPLICADA = 'shopee-tabela-trocar-duplicada';

  async function trocar(mapa: unknown, indice: number, categoriaAtual: number) {
    show({ mapa, alvo: { tipo: 'trocar', indice, categoriaAtual } });
    await escolherCamisetas();
    await screen.findByTestId('shopee-tabela-opcao-700024641');
  }

  it('an EARLIER row covers it: "esta ficará ignorada" — and never "ela será substituída" (that row is not replaced)', async () => {
    await trocar({ [CONTA]: [CAMISETAS_0, CALCAS_1] }, 1, 400055);
    expect(screen.getByTestId(DUPLICADA).textContent).toBe(
      'Outra linha desta conta já usa esta categoria e vem antes — esta ficará ignorada. Remova uma das duas.',
    );
    expect(screen.queryByText(/ela será substituída/)).toBeNull();
    // Advice only: the pick can still be confirmed.
    await marcarModelo(700024641);
    expect(confirmar().disabled).toBe(false);
    expect(confirmar().textContent).toBe('Trocar');
  });

  it('a LATER row covers it: this row will win and the other is the one ignored', async () => {
    await trocar({ [CONTA]: [CALCAS_1, CAMISETAS_0] }, 0, 400055);
    expect(screen.getByTestId(DUPLICADA).textContent).toBe(
      'Outra linha desta conta já usa esta categoria — esta passará a valer e a outra ficará ignorada. Remova uma das duas.',
    );
  });

  it('NEAR-MISS: re-picking within the row’s OWN category (no other row) warns nothing', async () => {
    await trocar({ [CONTA]: [CAMISETAS_0, CALCAS_1] }, 0, 100087);
    expect(screen.queryByTestId(DUPLICADA)).toBeNull();
  });

  it('NEAR-MISS: the other row is STAGED for removal — it will not survive the save, so no warning', async () => {
    const marcado = marcarRemocao({ [CONTA]: [CAMISETAS_0, CALCAS_1] }, CONTA, 0, true);
    await trocar(marcado, 1, 400055);
    expect(screen.queryByTestId(DUPLICADA)).toBeNull();
  });

  it('NEAR-MISS: the other row is the NEIGHBOUR category (id + 1) — no warning', async () => {
    await trocar({ [CONTA]: [{ ...CAMISETAS_0, categoryId: 100088 }, CALCAS_1] }, 1, 400055);
    expect(screen.queryByTestId(DUPLICADA)).toBeNull();
  });

  it('"Adicionar" never shows it — its replace-in-place line covers that case', async () => {
    show({ mapa: { [CONTA]: [CAMISETAS_0, CALCAS_1] } });
    await escolherCamisetas();
    await screen.findByTestId('shopee-tabela-opcao-700024641');
    expect(screen.queryByTestId(DUPLICADA)).toBeNull();
    expect(screen.getByText(/ela será substituída/)).toBeTruthy();
  });
});

describe('EscolherTabelaShopeeModal — size_chart_limit is ADVICE (L7)', () => {
  it('"não aceita modelo" is shown AND the confirm stays enabled', async () => {
    h.limites.mockResolvedValue(
      limites({
        sizeChartMandatory: null,
        supportImageSizeChart: null,
        supportTemplateSizeChart: false,
      }),
    );
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText('A Shopee informa que esta categoria não aceita modelo de tabela.'),
    ).toBeTruthy();
    await marcarModelo(700024641);
    expect(confirmar().disabled).toBe(false);
  });

  it('"obrigatória" is shown only for an explicit true', async () => {
    h.limites.mockResolvedValue(
      limites({
        sizeChartMandatory: true,
        supportImageSizeChart: null,
        supportTemplateSizeChart: true,
      }),
    );
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText('Tabela obrigatória nesta categoria (segundo a Shopee).'),
    ).toBeTruthy();
    expect(
      screen.queryByText('A Shopee informa que esta categoria não aceita modelo de tabela.'),
    ).toBeNull();
  });

  it.each([
    ['a null block', null],
    [
      'three null booleans',
      { sizeChartMandatory: null, supportImageSizeChart: null, supportTemplateSizeChart: null },
    ],
  ])('%s (Shopee did not say) says nothing', async (_, limite) => {
    h.limites.mockResolvedValue(limites(limite));
    show();
    await escolherCamisetas();
    await screen.findByTestId('shopee-tabela-opcao-700024641');
    await waitFor(() => expect(h.limites).toHaveBeenCalled());
    expect(screen.queryByTestId('shopee-tabela-limites')).toBeNull();
    expect(screen.queryByTestId('shopee-tabela-limites-falha')).toBeNull();
  });

  it('a FAILED limites read is one muted line and never blocks the pick', async () => {
    h.limites.mockRejectedValue(
      new ShopeeClientHttpError('Shopee recusou', 502, 'SHOPEE_HTTP_ERROR', null, 'other'),
    );
    const { onConfirmar } = show();
    await escolherCamisetas();
    expect(
      await screen.findByText('Não foi possível ler as regras de tabela desta categoria.'),
    ).toBeTruthy();
    await marcarModelo(700024641);
    fireEvent.click(confirmar());
    expect(onConfirmar).toHaveBeenCalledTimes(1);
  });
});

describe('EscolherTabelaShopeeModal — the list', () => {
  const VAZIA = 'Nenhum modelo nesta categoria — crie no Seller Centre e recarregue.';

  it('an empty list where Shopee says templates ARE supported: the plain sentence', async () => {
    h.lista.mockResolvedValue(lista({ tabelas: [], totalCount: 0 }));
    show();
    await escolherCamisetas();
    await waitFor(() =>
      expect(screen.getByTestId('shopee-tabela-lista-vazia').textContent).toBe(VAZIA),
    );
    expect(confirmar().disabled).toBe(true);
  });

  it.each([
    ['null', limites({ ...LIMITE_NEUTRO, supportTemplateSizeChart: null })],
    ['unknown (no limit block)', limites(null)],
    // A 502 `other` is never retried, so the failure lands at once.
    [
      'unknown (the limites read failed)',
      new ShopeeClientHttpError('Shopee recusou', 502, 'SHOPEE_HTTP_ERROR', null, 'other'),
    ],
  ])(
    'an empty list where support is %s: adds "(ou a loja não tem acesso a modelos)"',
    async (_, resposta) => {
      h.lista.mockResolvedValue(lista({ tabelas: [], totalCount: 0 }));
      if (resposta instanceof ShopeeClientHttpError) h.limites.mockRejectedValue(resposta);
      else h.limites.mockResolvedValue(resposta);
      const { qc } = show();
      await escolherCamisetas();
      // Asserted on the SETTLED limites answer, never on its pending state.
      await waitFor(() =>
        expect(qc.getQueryState(['shopee', 'limites', CONTA, 100087])?.status).toBe(
          resposta instanceof ShopeeClientHttpError ? 'error' : 'success',
        ),
      );
      await waitFor(() =>
        expect(screen.getByTestId('shopee-tabela-lista-vazia').textContent).toBe(
          `${VAZIA} (ou a loja não tem acesso a modelos)`,
        ),
      );
    },
  );

  it('R2-F3: an empty list in a category Shopee says takes NO template never says "crie no Seller Centre"', async () => {
    h.lista.mockResolvedValue(lista({ tabelas: [], totalCount: 0 }));
    h.limites.mockResolvedValue(limites({ ...LIMITE_NEUTRO, supportTemplateSizeChart: false }));
    const { qc } = show();
    await escolherCamisetas();
    await waitFor(() =>
      expect(qc.getQueryState(['shopee', 'limites', CONTA, 100087])?.status).toBe('success'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('shopee-tabela-lista-vazia').textContent).toBe(
        'Nenhum modelo nesta categoria — a Shopee informa que ela não aceita modelo de tabela.',
      ),
    );
    expect(screen.queryByText(/Seller Centre/)).toBeNull();
  });

  it('R1-F1: an EMPTY list whose ids Shopee sent unreadable says how many — and never "crie no Seller Centre"', async () => {
    h.lista.mockResolvedValue(lista({ tabelas: [], totalCount: 3, idsIlegiveis: 3 }));
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText(
        '3 modelo(s) da lista da Shopee vieram sem um id legível e não aparecem aqui.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('shopee-tabela-lista-vazia').textContent).toBe(
      'Nenhum modelo desta categoria pôde ser listado aqui.',
    );
    expect(screen.queryByText(/Seller Centre/)).toBeNull();
    // A list that was cut short was never claimed here.
    expect(screen.queryByTestId('shopee-tabela-lista-truncada')).toBeNull();
  });

  it('R1-F1: an EMPTY but TRUNCATED list says it may be incomplete — and never "crie no Seller Centre"', async () => {
    h.lista.mockResolvedValue(lista({ tabelas: [], totalCount: null, truncado: true }));
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText(
        'A lista da Shopee veio incompleta — pode haver modelos que não aparecem aqui.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('shopee-tabela-lista-vazia').textContent).toBe(
      'Nenhum modelo desta categoria pôde ser listado aqui.',
    );
    expect(screen.queryByText(/Seller Centre/)).toBeNull();
    expect(screen.queryByText(/Mostrando os primeiros/)).toBeNull();
    expect(screen.queryByTestId('shopee-tabela-lista-ids-ilegiveis')).toBeNull();
  });

  it('`truncado` counts the rows SHOWN — never Shopee’s total_count', async () => {
    h.lista.mockResolvedValue(lista({ truncado: true, totalCount: 250 }));
    show();
    await escolherCamisetas();
    expect(await screen.findByText('Mostrando os primeiros 3 modelos.')).toBeTruthy();
  });

  it('NEAR-MISS: a COMPLETE list (`truncado: false`, no unreadable id) adds neither line', async () => {
    show();
    await escolherCamisetas();
    await screen.findByTestId('shopee-tabela-opcao-700024641');
    expect(screen.queryByText(/Mostrando os primeiros/)).toBeNull();
    expect(screen.queryByTestId('shopee-tabela-lista-truncada')).toBeNull();
    expect(screen.queryByTestId('shopee-tabela-lista-ids-ilegiveis')).toBeNull();
  });

  it('`idsIlegiveis > 0` beside readable rows says how many list rows had no readable id', async () => {
    h.lista.mockResolvedValue(lista({ idsIlegiveis: 2 }));
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText(
        '2 modelo(s) da lista da Shopee vieram sem um id legível e não aparecem aqui.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('shopee-tabela-opcao-700024641')).toBeTruthy();
  });

  it('a non-leaf answer (`leaf: false`) asks for a subcategory and offers no template', async () => {
    h.lista.mockResolvedValue(lista({ leaf: false, tabelas: [] }));
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText(
        'A Shopee informa que esta categoria tem subcategorias — volte e escolha uma delas.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('shopee-tabela-lista-vazia')).toBeNull();
  });

  it('a category Shopee refuses for templates shows the backend’s own sentence', async () => {
    h.lista.mockRejectedValue(
      new ShopeeClientHttpError(
        'A Shopee não aceita a categoria 100087 para tabelas de medidas nesta loja — escolha outra categoria.',
        404,
        'SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA',
      ),
    );
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText(
        'A Shopee não aceita a categoria 100087 para tabelas de medidas nesta loja — escolha outra categoria.',
      ),
    ).toBeTruthy();
  });

  it('a rate limit (502, kind daily) is NOT retried automatically — the app default would retry once', async () => {
    h.lista.mockRejectedValue(
      new ShopeeClientHttpError('Shopee recusou', 502, 'SHOPEE_HTTP_ERROR', null, 'daily'),
    );
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText(
        'A Shopee limitou as consultas — tente em alguns minutos.',
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    expect(h.lista).toHaveBeenCalledTimes(1);
  });

  it('"Recarregar lista" asks Shopee again; a template gone from the new list cannot be confirmed', async () => {
    show();
    await escolherCamisetas();
    await marcarModelo(700024641);
    expect(confirmar().disabled).toBe(false);

    h.lista.mockResolvedValue(
      lista({ tabelas: [{ sizeChartId: 700024613, sizeChartName: 'Nova', legivel: true }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar lista' }));
    await screen.findByTestId('shopee-tabela-opcao-700024613');
    expect(h.lista).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('shopee-tabela-opcao-700024641')).toBeNull();
    expect(confirmar().disabled).toBe(true);
  });

  it('a network failure surfaces as the network sentence (after the predicate’s own retries)', async () => {
    h.lista.mockRejectedValue(new ShopeeClientNetworkError('Failed to fetch'));
    show();
    await escolherCamisetas();
    expect(
      await screen.findByText(
        'Não foi possível contatar a integração com a Shopee.',
        {},
        { timeout: 8000 },
      ),
    ).toBeTruthy();
    expect(h.lista).toHaveBeenCalledTimes(3);
  }, 12_000);
});

describe('EscolherTabelaShopeeModal — "Ver" draws the chart read-only', () => {
  it('expands the grid from the detail query, and collapses it', async () => {
    const { qc } = show();
    await escolherCamisetas();
    const opcao = await screen.findByTestId('shopee-tabela-opcao-700024639');
    fireEvent.click(within(opcao).getByRole('button', { name: 'Ver' }));
    const grade = await within(opcao).findByTestId('shopee-tabela-grid');
    expect(grade.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(h.detalhe).toHaveBeenCalledWith({ integracaoId: CONTA, sizeChartId: 700024639 });
    expect(qc.getQueryData(['shopee', 'tabela-medidas', 'detalhe', CONTA, 700024639])).toEqual(
      DETALHE,
    );

    fireEvent.click(within(opcao).getByRole('button', { name: 'Ocultar' }));
    expect(within(opcao).queryByTestId('shopee-tabela-grid')).toBeNull();
  });

  it('a template the shop no longer has reads "não existe mais na loja — escolha outra"', async () => {
    h.detalhe.mockRejectedValue(
      new ShopeeClientHttpError(
        'A tabela de medidas 700024641 não existe mais nesta loja da Shopee — escolha outra.',
        404,
        'SHOPEE_TABELA_MEDIDAS_INEXISTENTE',
      ),
    );
    show();
    await escolherCamisetas();
    const opcao = await screen.findByTestId('shopee-tabela-opcao-700024641');
    fireEvent.click(within(opcao).getByRole('button', { name: 'Ver' }));
    expect(
      await within(opcao).findByText('Esta tabela não existe mais na loja — escolha outra.'),
    ).toBeTruthy();
    // Not repeatable: the same id will be just as gone.
    expect(within(opcao).queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(h.detalhe).toHaveBeenCalledTimes(1);
  });
});

describe('EscolherTabelaShopeeModal — where the browser opens', () => {
  it('"adicionar" opens on the roots', () => {
    show();
    expect(screen.getByText('inicio:null')).toBeTruthy();
  });

  it('"trocar" opens on the stored category', () => {
    show({ alvo: { tipo: 'trocar', indice: 0, categoriaAtual: 100087 } });
    expect(screen.getByText('inicio:100087')).toBeTruthy();
  });

  it('"Trocar categoria" goes back to the browser, opened on the category just chosen, with nothing selected', async () => {
    show();
    await escolherCamisetas('Camisetas vizinha');
    fireEvent.click(await screen.findByRole('button', { name: 'Trocar categoria' }));
    expect(screen.getByText('inicio:100088')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'stub Camisetas' }));
    await screen.findByTestId('shopee-tabela-opcao-700024641');
    expect(confirmar().disabled).toBe(true);
  });
});
