import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  CategoriaNoDto,
  CategoriaResumoDto,
  RecomendacaoDto,
  RespostaCategoriasShopee,
  RespostaRecomendacaoCategoriaShopee,
} from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';

/**
 * The draft's Categoria: the held category's path label, the "Escolher
 * categoria" modal — Shopee's suggestions for the title and the REAL
 * `ShopeeCategoriaBrowser` — over a doubled client (`categorias`,
 * `recomendacaoCategoria`), the app's query defaults. Ids are fixtures.
 */

const h = vi.hoisted(() => ({
  categorias: vi.fn(),
  recomendacao: vi.fn(),
  semCliente: { value: false },
}));

// The REAL error classes stay: `erros.ts` narrows on them.
vi.mock('@/lib/shopee/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/client')>();
  return {
    ...actual,
    useShopeeClient: () =>
      h.semCliente.value
        ? null
        : { categorias: h.categorias, recomendacaoCategoria: h.recomendacao },
  };
});

const {
  CategoriaRascunhoShopee,
  FRASE_CATEGORIA_NAO_FOLHA_SHOPEE,
  FRASE_SEM_CATEGORIA_RASCUNHO_SHOPEE,
  FRASE_SEM_SUGESTOES_SHOPEE,
  FRASE_SUGESTAO_FORA_DA_ARVORE_SHOPEE,
  FRASE_SUGESTAO_NAO_FOLHA_SHOPEE,
  FRASE_SUGESTOES_NUNCA_APLICADAS_SHOPEE,
  FRASE_SUGESTOES_SEM_TITULO_SHOPEE,
  TITULO_ESCOLHA_CATEGORIA_SHOPEE,
  chaveRecomendacaoCategoriaShopee,
  fraseDaCategoriaInexistenteShopee,
  fraseDasSugestoesForaDaArvoreShopee,
  idDeCategoriaShopeeValido,
} = await import('./CategoriaRascunhoShopee');
const { ShopeeClientHttpError } = await import('@/lib/shopee/client');
const { MENSAGEM_CATEGORIA_DESCONHECIDA } = await import('@/lib/shopee/erros');
const { FRASE_TROCA_DE_CATEGORIA_APAGA_ATRIBUTOS_SHOPEE, ROTULO_VOLTAR_CATEGORIA_GRAVADA_SHOPEE } =
  await import('@/lib/shopee/anuncioProduto');

const CONTA = 'int-1';
const LINK = 'rasc00000000000000001';
const RAIZ = `shopee-rascunho-categoria-${LINK}`;

const ROUPAS: CategoriaResumoDto = {
  categoryId: 100001,
  name: 'Roupas',
  originalName: 'Clothes',
  isLeaf: false,
};
const CAMISETAS: CategoriaResumoDto = {
  categoryId: 100087,
  name: 'Camisetas',
  originalName: 'T-Shirts',
  isLeaf: true,
};
const VESTIDOS: CategoriaResumoDto = {
  categoryId: 100090,
  name: 'Vestidos',
  originalName: null,
  isLeaf: false,
};

function no(
  row: CategoriaResumoDto,
  parentId: number,
  pathFromRoot: CategoriaResumoDto[],
  children: CategoriaResumoDto[],
): RespostaCategoriasShopee {
  const n: CategoriaNoDto = { ...row, parentId, pathFromRoot, children };
  return { raizes: null, no: n };
}

const ARVORE = new Map<number | null, RespostaCategoriasShopee>([
  [null, { raizes: [ROUPAS], no: null }],
  [100001, no(ROUPAS, 0, [ROUPAS], [CAMISETAS, VESTIDOS])],
  [100087, no(CAMISETAS, 100001, [ROUPAS, CAMISETAS], [])],
  [100090, no(VESTIDOS, 100001, [ROUPAS, VESTIDOS], [])],
]);

function arvore(input: { integracaoId: string; categoryId: number | null }) {
  const r = ARVORE.get(input.categoryId);
  return r === undefined
    ? Promise.reject(
        new ShopeeClientHttpError(
          `Categoria ${String(input.categoryId)} não existe na árvore desta conta.`,
          404,
          'SHOPEE_CATEGORIA_DESCONHECIDA',
        ),
      )
    : Promise.resolve(r);
}

const sugestao = (
  position: number,
  categoryId: number,
  isLeaf: boolean | null,
  pathFromRoot: CategoriaResumoDto[],
  name: string | null = null,
): RecomendacaoDto => ({ position, categoryId, name, isLeaf, pathFromRoot });

const SUGESTOES: RespostaRecomendacaoCategoriaShopee = {
  recomendacoes: [
    sugestao(1, 100087, true, [ROUPAS, CAMISETAS], 'Camisetas'),
    sugestao(2, 100090, false, [ROUPAS, VESTIDOS], 'Vestidos'),
    sugestao(3, 999999, null, []),
  ],
  unresolved: 1,
  applied: false,
};

function show(
  props: {
    contaId?: string | null;
    categoryId?: number | null;
    titulo?: string | null;
    editavel?: boolean;
    atributosGravados?: boolean;
    /** `bloco.podeVoltarCategoria` — the put-back button is offered. */
    voltar?: boolean;
  } = {},
) {
  const qc = new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
  const onEscolher = vi.fn<(categoryId: number) => void>();
  const onVoltar = vi.fn<() => void>();
  const ui = (p: typeof props) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <CategoriaRascunhoShopee
          contaId={p.contaId === undefined ? CONTA : p.contaId}
          linkDocId={LINK}
          categoryId={p.categoryId === undefined ? null : p.categoryId}
          titulo={p.titulo === undefined ? 'Camiseta básica' : p.titulo}
          editavel={p.editavel ?? true}
          atributosGravados={p.atributosGravados ?? false}
          onEscolher={onEscolher}
          onVoltar={p.voltar === true ? onVoltar : null}
        />
      </QueryClientProvider>
    </MantineTestProvider>
  );
  const r = render(ui(props));
  return {
    ...r,
    onEscolher,
    onVoltar,
    qc,
    rerenderCom: (p: typeof props) => r.rerender(ui(p)),
  };
}

const rotulo = () => screen.getByTestId(`${RAIZ}-rotulo`);

function abrir(nome: 'Escolher categoria' | 'Trocar categoria' = 'Escolher categoria'): void {
  fireEvent.click(within(screen.getByTestId(RAIZ)).getByRole('button', { name: nome }));
}

beforeEach(() => {
  h.categorias.mockReset();
  h.categorias.mockImplementation(arvore);
  h.recomendacao.mockReset();
  h.recomendacao.mockResolvedValue(SUGESTOES);
  h.semCliente.value = false;
});

describe('CategoriaRascunhoShopee — the label', () => {
  it('NO category ⇒ says so and makes NO request (rev. 2a B.7 (b): the seeded e2e draft stays stub-free)', async () => {
    show({ categoryId: null });
    expect(rotulo().textContent).toBe(FRASE_SEM_CATEGORIA_RASCUNHO_SHOPEE);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.categorias).not.toHaveBeenCalled();
    expect(h.recomendacao).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: a held category reads its path from the conta tree, with its id', async () => {
    show({ categoryId: 100087 });
    await waitFor(() => expect(rotulo().textContent).toContain('Roupas › Camisetas'));
    expect(rotulo().textContent).toContain('#100087');
    expect(h.categorias).toHaveBeenCalledWith({ integracaoId: CONTA, categoryId: 100087 });
    expect(rotulo().textContent).not.toContain(FRASE_CATEGORIA_NAO_FOLHA_SHOPEE);
  });

  it('a held NON-LEAF category says it is not a final one (the publish refuses it)', async () => {
    show({ categoryId: 100090 });
    await waitFor(() => expect(rotulo().textContent).toContain(FRASE_CATEGORIA_NAO_FOLHA_SHOPEE));
  });

  it('a held id the tree no longer holds says so', async () => {
    show({ categoryId: 424242 });
    await waitFor(() => expect(rotulo().textContent).toContain(MENSAGEM_CATEGORIA_DESCONHECIDA));
    expect(rotulo().textContent).toContain('#424242');
  });
});

describe('CategoriaRascunhoShopee — who may pick', () => {
  it('not editable (`incerta`, busy, read-only) ⇒ the label alone, no picker button', () => {
    show({ categoryId: 100087, editavel: false });
    expect(within(screen.getByTestId(RAIZ)).queryByRole('button')).toBeNull();
  });

  it('NEAR-MISS: editable ⇒ "Escolher categoria" with none held, "Trocar categoria" with one', () => {
    const { unmount } = show({ categoryId: null });
    expect(screen.getByRole('button', { name: 'Escolher categoria' })).toBeTruthy();
    unmount();
    show({ categoryId: 100087 });
    expect(screen.getByRole('button', { name: 'Trocar categoria' })).toBeTruthy();
  });

  it('a modal already open CLOSES when the block stops being editable — no pick can land', async () => {
    const { rerenderCom } = show({ categoryId: null });
    abrir();
    await screen.findByTestId(`${RAIZ}-modal`);
    rerenderCom({ categoryId: null, editavel: false });
    expect(screen.queryByTestId(`${RAIZ}-modal`)).toBeNull();
    expect(screen.queryByTestId('shopee-categoria-browser')).toBeNull();
  });
});

describe('CategoriaRascunhoShopee — «Voltar à categoria gravada» (R1-rule7#5)', () => {
  it('`incerta` with an unsaved change: the picker is closed and the put-back is the ONE button — it fires `onVoltar`, never a pick', () => {
    const { onVoltar, onEscolher } = show({ categoryId: 100090, editavel: false, voltar: true });
    const botoes = within(screen.getByTestId(RAIZ)).getAllByRole('button');
    expect(botoes.map((b) => b.textContent)).toEqual([ROTULO_VOLTAR_CATEGORIA_GRAVADA_SHOPEE]);
    fireEvent.click(botoes[0]!);
    expect(onVoltar).toHaveBeenCalledTimes(1);
    expect(onEscolher).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`${RAIZ}-modal`)).toBeNull();
  });

  it('NEAR-MISS: not offered (`onVoltar: null`) ⇒ no such button, editable or not', () => {
    const { unmount } = show({ categoryId: 100090, editavel: false });
    expect(
      screen.queryByRole('button', { name: ROTULO_VOLTAR_CATEGORIA_GRAVADA_SHOPEE }),
    ).toBeNull();
    unmount();
    show({ categoryId: 100090 });
    expect(
      screen.queryByRole('button', { name: ROTULO_VOLTAR_CATEGORIA_GRAVADA_SHOPEE }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Trocar categoria' })).toBeTruthy();
  });
});

describe('CategoriaRascunhoShopee — the suggestions (offered, never applied)', () => {
  it('are requested only once the modal OPENS, with the TRIMMED title', async () => {
    show({ titulo: '  Camiseta básica  ' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.recomendacao).not.toHaveBeenCalled();
    abrir();
    expect(screen.getByText(TITULO_ESCOLHA_CATEGORIA_SHOPEE)).toBeTruthy();
    await screen.findByTestId('shopee-rascunho-sugestao-1');
    expect(h.recomendacao).toHaveBeenCalledTimes(1);
    expect(h.recomendacao).toHaveBeenCalledWith({ integracaoId: CONTA, nome: 'Camiseta básica' });
  });

  it('a LEAF suggestion is pickable: "Usar esta" sends its id and closes the modal', async () => {
    const { onEscolher } = show();
    abrir();
    const linha = await screen.findByTestId('shopee-rascunho-sugestao-1');
    expect(linha.textContent).toContain('Roupas › Camisetas');
    fireEvent.click(within(linha).getByRole('button', { name: 'Usar esta' }));
    expect(onEscolher).toHaveBeenCalledTimes(1);
    expect(onEscolher).toHaveBeenCalledWith(100087);
    await waitFor(() => expect(screen.queryByTestId(`${RAIZ}-modal`)).toBeNull());
  });

  it('NEAR-MISS: a non-leaf suggestion and one outside the conta tree offer NO pick, and say why', async () => {
    show();
    abrir();
    const naoFolha = await screen.findByTestId('shopee-rascunho-sugestao-2');
    expect(within(naoFolha).queryByRole('button')).toBeNull();
    expect(naoFolha.textContent).toContain(FRASE_SUGESTAO_NAO_FOLHA_SHOPEE);
    const fora = screen.getByTestId('shopee-rascunho-sugestao-3');
    expect(within(fora).queryByRole('button')).toBeNull();
    expect(fora.textContent).toContain(FRASE_SUGESTAO_FORA_DA_ARVORE_SHOPEE);
    expect(fora.textContent).toContain('Categoria 999999');
  });

  it('counts the suggested ids the tree lacks, and says suggestions are never applied', async () => {
    show();
    abrir();
    await screen.findByTestId('shopee-rascunho-sugestao-1');
    const sugestoes = screen.getByTestId('shopee-rascunho-sugestoes');
    expect(sugestoes.textContent).toContain(fraseDasSugestoesForaDaArvoreShopee(1));
    expect(sugestoes.textContent).toContain(FRASE_SUGESTOES_NUNCA_APLICADAS_SHOPEE);
  });

  it('NEAR-MISS: nothing unresolved ⇒ no such count; an empty list says so', async () => {
    h.recomendacao.mockResolvedValue({ recomendacoes: [], unresolved: 0, applied: false });
    show();
    abrir();
    await screen.findByText(FRASE_SEM_SUGESTOES_SHOPEE);
    expect(screen.getByTestId('shopee-rascunho-sugestoes').textContent).not.toContain(
      'não existem na árvore',
    );
  });

  it('a BLANK title asks for one and makes no request', async () => {
    show({ titulo: '   ' });
    abrir();
    expect(await screen.findByText(FRASE_SUGESTOES_SEM_TITULO_SHOPEE)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.recomendacao).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: a null title too', async () => {
    show({ titulo: null });
    abrir();
    expect(await screen.findByText(FRASE_SUGESTOES_SEM_TITULO_SHOPEE)).toBeTruthy();
    expect(h.recomendacao).not.toHaveBeenCalled();
  });

  it('a failed suggestion read says so, with a retry that asks again', async () => {
    h.recomendacao.mockRejectedValueOnce(new ShopeeClientHttpError('Shopee caiu.', 500, null));
    show();
    abrir();
    const tentar = await screen.findByRole('button', { name: 'Tentar de novo' });
    expect(screen.getByTestId('shopee-rascunho-sugestoes').textContent).toContain('Shopee caiu.');
    fireEvent.click(tentar);
    await screen.findByTestId('shopee-rascunho-sugestao-1');
    expect(h.recomendacao).toHaveBeenCalledTimes(2);
  });

  it('caches by conta and trimmed title', () => {
    expect(chaveRecomendacaoCategoriaShopee(CONTA, 'Camiseta')).toEqual([
      'shopee',
      'recomendacao',
      CONTA,
      'Camiseta',
    ]);
  });
});

describe('CategoriaRascunhoShopee — the browser and the attributes warning', () => {
  it('a LEAF picked in the browser is sent and closes the modal; a non-leaf only drills', async () => {
    const { onEscolher } = show({ categoryId: null });
    abrir();
    const browser = await screen.findByTestId('shopee-categoria-browser');
    fireEvent.click(
      within(await within(browser).findByTestId('shopee-categoria-linha-100001')).getByRole(
        'button',
        { name: 'Roupas' },
      ),
    );
    const camisetas = await within(browser).findByTestId('shopee-categoria-linha-100087');
    expect(onEscolher).not.toHaveBeenCalled();
    fireEvent.click(within(camisetas).getByRole('button', { name: 'Escolher' }));
    expect(onEscolher).toHaveBeenCalledWith(100087);
    await waitFor(() => expect(screen.queryByTestId(`${RAIZ}-modal`)).toBeNull());
  });

  it('the browser opens where the held category lives (its parent level)', async () => {
    show({ categoryId: 100087 });
    abrir('Trocar categoria');
    const browser = await screen.findByTestId('shopee-categoria-browser');
    await within(browser).findByTestId('shopee-categoria-linha-100090');
  });

  it('a draft storing attributes is warned BEFORE a pick that a category change clears them', async () => {
    show({ atributosGravados: true });
    abrir();
    expect(
      within(await screen.findByTestId(`${RAIZ}-modal`)).getByText(
        FRASE_TROCA_DE_CATEGORIA_APAGA_ATRIBUTOS_SHOPEE,
      ),
    ).toBeTruthy();
  });

  it('NEAR-MISS: none stored ⇒ no warning', async () => {
    show({ atributosGravados: false });
    abrir();
    await screen.findByTestId(`${RAIZ}-modal`);
    expect(screen.queryByText(FRASE_TROCA_DE_CATEGORIA_APAGA_ATRIBUTOS_SHOPEE)).toBeNull();
  });
});

describe('CategoriaRascunhoShopee — a held id that names no category (R7-roundtrip#2)', () => {
  it('a legacy `0` asks NOTHING: a plain sentence (never the route’s raw 400), «Escolher categoria», and the browser opens at the ROOTS', async () => {
    show({ categoryId: 0 });
    expect(rotulo().textContent).toBe(fraseDaCategoriaInexistenteShopee(0, true));
    expect(rotulo().textContent).toBe(
      'A categoria guardada (#0) não existe na Shopee. Escolha uma categoria.',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(h.categorias).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId(RAIZ)).queryByRole('button', { name: 'Trocar categoria' }),
    ).toBeNull();
    abrir('Escolher categoria');
    const browser = await screen.findByTestId('shopee-categoria-browser');
    await within(browser).findByTestId('shopee-categoria-linha-100001');
    expect(h.categorias.mock.calls.map(([i]) => (i as { categoryId: unknown }).categoryId)).toEqual(
      [null],
    );
  });

  it('a negative id too; not editable ⇒ the fact alone — no exit the block does not offer', async () => {
    show({ categoryId: -1, editavel: false });
    expect(rotulo().textContent).toBe('A categoria guardada (#-1) não existe na Shopee.');
    expect(within(screen.getByTestId(RAIZ)).queryByRole('button')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.categorias).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: a positive id is read and labelled from the tree, with «Trocar categoria»', async () => {
    show({ categoryId: 100087 });
    await waitFor(() => expect(rotulo().textContent).toContain('Roupas › Camisetas'));
    expect(h.categorias).toHaveBeenCalledWith({ integracaoId: CONTA, categoryId: 100087 });
    expect(screen.getByRole('button', { name: 'Trocar categoria' })).toBeTruthy();
  });

  it('THE positive-id test the tab’s bands request shares: 0 and negatives name no category ⟷ 1 and up do', () => {
    expect(idDeCategoriaShopeeValido(null)).toBe(false);
    expect(idDeCategoriaShopeeValido(0)).toBe(false);
    expect(idDeCategoriaShopeeValido(-1)).toBe(false);
    expect(idDeCategoriaShopeeValido(1)).toBe(true);
    expect(idDeCategoriaShopeeValido(100017)).toBe(true);
  });
});

describe('CategoriaRascunhoShopee — no conta that can answer (R2-drafts#6)', () => {
  it('`contaId: null` reads NOTHING — the held id as plain text, no spinner, no picker even if "editable"', async () => {
    show({ contaId: null, categoryId: 100087, editavel: true });
    expect(rotulo().textContent).toBe('Categoria 100087');
    expect(within(screen.getByTestId(RAIZ)).queryByRole('button')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.categorias).not.toHaveBeenCalled();
    expect(h.recomendacao).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: the same id with a conta is read', async () => {
    show({ contaId: CONTA, categoryId: 100087, editavel: false });
    await waitFor(() => expect(h.categorias).toHaveBeenCalledTimes(1));
  });
});
