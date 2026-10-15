import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import type {
  CategoriaNoDto,
  CategoriaResumoDto,
  RespostaCategoriasShopee,
} from '@/lib/shopee/wire';

const h = vi.hoisted(() => ({
  categorias: vi.fn(),
  semCliente: { value: false },
}));

// The REAL error classes stay: `erros.ts` narrows on them.
vi.mock('@/lib/shopee/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/client')>();
  return {
    ...actual,
    useShopeeClient: () => (h.semCliente.value ? null : { categorias: h.categorias }),
  };
});

const { ShopeeCategoriaBrowser, chaveCategoriasShopee, rotuloCategoriaShopee } =
  await import('./ShopeeCategoriaBrowser');
const { ShopeeClientHttpError } = await import('@/lib/shopee/client');
const { MENSAGEM_CATEGORIA_DESCONHECIDA } = await import('@/lib/shopee/erros');

/** Fixture tree. Ids are fixtures; one conta `int-1`. */
const ROUPAS: CategoriaResumoDto = {
  categoryId: 100001,
  name: 'Roupas',
  originalName: 'Clothes',
  isLeaf: false,
};
const CASA: CategoriaResumoDto = {
  categoryId: 100500,
  name: 'Casa',
  originalName: null,
  isLeaf: true,
};
const CAMISETAS: CategoriaResumoDto = {
  categoryId: 100087,
  name: 'Camisetas',
  originalName: 'T-Shirts',
  isLeaf: true,
};
const CALCAS: CategoriaResumoDto = {
  categoryId: 100088,
  name: null,
  originalName: 'Pants',
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

const RESPOSTAS = new Map<number | null, RespostaCategoriasShopee>([
  [null, { raizes: [ROUPAS, CASA], no: null }],
  [100001, no(ROUPAS, 0, [ROUPAS], [CAMISETAS, CALCAS, VESTIDOS])],
  [100087, no(CAMISETAS, 100001, [ROUPAS, CAMISETAS], [])],
  [100500, no(CASA, 0, [CASA], [])],
  [100090, no(VESTIDOS, 100001, [ROUPAS, VESTIDOS], [])],
]);

function desconhecida(id: number) {
  return new ShopeeClientHttpError(
    `Categoria ${String(id)} não existe na árvore desta conta.`,
    404,
    'SHOPEE_CATEGORIA_DESCONHECIDA',
  );
}

function arvore(input: { integracaoId: string; categoryId: number | null }) {
  const r = RESPOSTAS.get(input.categoryId);
  return r === undefined ? Promise.reject(desconhecida(input.categoryId ?? 0)) : Promise.resolve(r);
}

/** The APP's defaults (`retry: 1`) — the component's own `retry` is only proved against them. */
function novoQc(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
}

function show(
  props: { categoriaInicial?: number | null; disabled?: boolean } = {},
  qc: QueryClient = novoQc(),
) {
  const onEscolher = vi.fn();
  const ui: ReactElement = (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <ShopeeCategoriaBrowser
          integracaoId="int-1"
          categoriaInicial={props.categoriaInicial ?? null}
          onEscolher={onEscolher}
          disabled={props.disabled}
        />
      </QueryClientProvider>
    </MantineTestProvider>
  );
  return { ...render(ui), onEscolher, qc };
}

function linha(id: number): HTMLElement {
  return screen.getByTestId(`shopee-categoria-linha-${String(id)}`);
}

function pedidos(): (number | null)[] {
  return h.categorias.mock.calls.map(
    (c) => (c[0] as { integracaoId: string; categoryId: number | null }).categoryId,
  );
}

beforeEach(() => {
  h.categorias.mockReset();
  h.categorias.mockImplementation(arvore);
  h.semCliente.value = false;
});

describe('ShopeeCategoriaBrowser — drill-down, leaf-only pick', () => {
  it('opens on the ROOTS and asks with categoryId null', async () => {
    show();
    await screen.findByTestId('shopee-categoria-linha-100001');
    expect(h.categorias).toHaveBeenCalledWith({ integracaoId: 'int-1', categoryId: null });
    expect(screen.getByTestId('shopee-categoria-browser')).toBeTruthy();
  });

  it('a non-leaf row DRILLS IN and offers no "Escolher"; a leaf row offers "Escolher" and hands back the row itself', async () => {
    const { onEscolher } = show();
    await screen.findByTestId('shopee-categoria-linha-100001');
    expect(within(linha(100001)).queryByRole('button', { name: 'Escolher' })).toBeNull();

    fireEvent.click(within(linha(100001)).getByRole('button', { name: 'Roupas' }));
    await screen.findByTestId('shopee-categoria-linha-100087');
    expect(pedidos()).toEqual([null, 100001]);
    expect(onEscolher).not.toHaveBeenCalled();

    // A non-leaf child still only drills.
    expect(within(linha(100090)).queryByRole('button', { name: 'Escolher' })).toBeNull();

    fireEvent.click(within(linha(100087)).getByRole('button', { name: 'Escolher' }));
    expect(onEscolher).toHaveBeenCalledTimes(1);
    expect(onEscolher).toHaveBeenCalledWith(CAMISETAS);
  });

  it('a ROOT that is a leaf is pickable right away (the gate is isLeaf, not depth)', async () => {
    const { onEscolher } = show();
    await screen.findByTestId('shopee-categoria-linha-100500');
    fireEvent.click(within(linha(100500)).getByRole('button', { name: 'Escolher' }));
    expect(onEscolher).toHaveBeenCalledWith(CASA);
  });

  it('the breadcrumb comes from pathFromRoot; "Categorias" goes back to the roots', async () => {
    show();
    fireEvent.click(
      within(await screen.findByTestId('shopee-categoria-linha-100001')).getByRole('button', {
        name: 'Roupas',
      }),
    );
    fireEvent.click(
      within(await screen.findByTestId('shopee-categoria-linha-100090')).getByRole('button', {
        name: 'Vestidos',
      }),
    );
    const caminho = await screen.findByText('Nenhuma subcategoria neste nível.');
    expect(caminho).toBeTruthy();
    const migalhas = screen.getByTestId('shopee-categoria-caminho');
    expect(migalhas.textContent).toBe('Categorias›Roupas›Vestidos');

    // A crumb goes back one level — the parent's cached children.
    fireEvent.click(within(migalhas).getByRole('button', { name: 'Roupas' }));
    await screen.findByTestId('shopee-categoria-linha-100087');

    fireEvent.click(
      within(screen.getByTestId('shopee-categoria-caminho')).getByRole('button', {
        name: 'Categorias',
      }),
    );
    await screen.findByTestId('shopee-categoria-linha-100500');
    expect(pedidos()).toEqual([null, 100001, 100090]);
  });

  it('labels a row display name → original name → "Categoria <id>"', async () => {
    expect(rotuloCategoriaShopee(CAMISETAS)).toBe('Camisetas');
    expect(rotuloCategoriaShopee(CALCAS)).toBe('Pants');
    expect(rotuloCategoriaShopee({ categoryId: 100091, name: null, originalName: null })).toBe(
      'Categoria 100091',
    );
    // An EMPTY display name is Shopee's value, shown as sent — not a gap to fill.
    expect(rotuloCategoriaShopee({ categoryId: 100091, name: '', originalName: 'X' })).toBe('');

    show({ categoriaInicial: 100001 });
    expect(await screen.findByText('Pants')).toBeTruthy();
  });

  it('disabled: nothing is clickable — no "Escolher", no drilling', async () => {
    const { onEscolher } = show({ disabled: true });
    await screen.findByTestId('shopee-categoria-linha-100500');
    const escolher = within(linha(100500)).getByRole('button', { name: 'Escolher' });
    expect((escolher as HTMLButtonElement).disabled).toBe(true);
    const drill = within(linha(100001)).getByRole('button', { name: 'Roupas' });
    expect((drill as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(escolher);
    expect(onEscolher).not.toHaveBeenCalled();
  });

  it('caches each level under ["shopee","categorias",integracaoId,categoryId|null]', async () => {
    const { qc } = show();
    await screen.findByTestId('shopee-categoria-linha-100001');
    expect(chaveCategoriasShopee('int-1', null)).toEqual(['shopee', 'categorias', 'int-1', null]);
    expect(qc.getQueryData(['shopee', 'categorias', 'int-1', null])).toEqual(RESPOSTAS.get(null));
    expect(qc.getQueryState(['shopee', 'categorias', 'int-1', 100001])).toBeUndefined();
  });

  it('logged out (no client): asks nothing', () => {
    h.semCliente.value = true;
    show();
    expect(h.categorias).not.toHaveBeenCalled();
  });
});

describe('ShopeeCategoriaBrowser — categoriaInicial', () => {
  it('a stored LEAF opens on its PARENT level, so its siblings are the alternatives', async () => {
    show({ categoriaInicial: 100087 });
    await screen.findByTestId('shopee-categoria-linha-100088');
    expect(pedidos()).toEqual([100087, 100001]);
    expect(screen.getByTestId('shopee-categoria-linha-100087')).toBeTruthy();
    expect(screen.getByTestId('shopee-categoria-caminho').textContent).toBe('Categorias›Roupas');
  });

  it('a leaf whose parentId is 0 (a root) opens on the roots', async () => {
    show({ categoriaInicial: 100500 });
    await screen.findByTestId('shopee-categoria-linha-100001');
    expect(pedidos()).toEqual([100500, null]);
  });

  it('a stored legacy NON-leaf opens on its OWN children — one request', async () => {
    show({ categoriaInicial: 100001 });
    await screen.findByTestId('shopee-categoria-linha-100087');
    expect(pedidos()).toEqual([100001]);
  });

  it('a stored category the tree no longer holds (404 SHOPEE_CATEGORIA_DESCONHECIDA) opens the roots with a note', async () => {
    show({ categoriaInicial: 100999 });
    await screen.findByTestId('shopee-categoria-linha-100001');
    // ONE sentence — the one `descreverFalhaShopee` answers for the same code.
    expect(screen.getByTestId('shopee-categoria-desconhecida').textContent).toBe(
      MENSAGEM_CATEGORIA_DESCONHECIDA,
    );
    expect(MENSAGEM_CATEGORIA_DESCONHECIDA).toMatch(/escolha outra\.$/);
    expect(pedidos()).toEqual([100999, null]);
  });

  it('the note goes once the operator navigates', async () => {
    show({ categoriaInicial: 100999 });
    fireEvent.click(
      within(await screen.findByTestId('shopee-categoria-linha-100001')).getByRole('button', {
        name: 'Roupas',
      }),
    );
    await screen.findByTestId('shopee-categoria-linha-100087');
    expect(screen.queryByTestId('shopee-categoria-desconhecida')).toBeNull();
  });

  it('NEAR-MISS: a 404 WITHOUT that code (a backend predating the route) is an error, not "gone from the tree"', async () => {
    h.categorias.mockImplementation(() =>
      Promise.reject(new ShopeeClientHttpError('rota ausente', 404, null)),
    );
    show({ categoriaInicial: 100087 });
    expect(await screen.findByText('rota ausente')).toBeTruthy();
    expect(screen.queryByTestId('shopee-categoria-desconhecida')).toBeNull();
    expect(screen.queryByTestId('shopee-categoria-linha-100001')).toBeNull();

    // The way out is explicit: start from the roots.
    h.categorias.mockImplementation(arvore);
    fireEvent.click(screen.getByRole('button', { name: 'Começar pelas categorias principais' }));
    await screen.findByTestId('shopee-categoria-linha-100001');
  });
});

describe('ShopeeCategoriaBrowser — failures', () => {
  it('a Shopee rate limit (502, kind burst) shows the limit copy and is NOT retried (the app default would retry once)', async () => {
    h.categorias.mockImplementation(() =>
      Promise.reject(
        new ShopeeClientHttpError('Shopee recusou', 502, 'SHOPEE_HTTP_ERROR', null, 'burst'),
      ),
    );
    show();
    expect(
      await screen.findByText(
        'A Shopee limitou as consultas — tente em alguns minutos.',
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    expect(h.categorias).toHaveBeenCalledTimes(1);
    // Not repeatable: no "Tentar de novo" offered.
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('a 503 is offered a manual "Tentar de novo" that asks again', async () => {
    let falhas = 0;
    h.categorias.mockImplementation(
      (input: { integracaoId: string; categoryId: number | null }) => {
        falhas += 1;
        // Fails until the three automatic attempts are spent, then heals.
        return falhas <= 3
          ? Promise.reject(new ShopeeClientHttpError('Indisponível', 503, 'SHOPEE_NETWORK_ERROR'))
          : arvore(input);
      },
    );
    show();
    const tentar = await screen.findByRole('button', { name: 'Tentar de novo' }, { timeout: 8000 });
    fireEvent.click(tentar);
    await screen.findByTestId('shopee-categoria-linha-100001');
  }, 12_000);
});

describe('ShopeeCategoriaBrowser — loading', () => {
  it('shows no rows until the first answer arrives', async () => {
    let soltar: (r: RespostaCategoriasShopee) => void = () => undefined;
    h.categorias.mockImplementation(
      () =>
        new Promise<RespostaCategoriasShopee>((resolve) => {
          soltar = resolve;
        }),
    );
    show();
    expect(screen.queryByTestId('shopee-categoria-linha-100001')).toBeNull();
    soltar({ raizes: [ROUPAS], no: null });
    await waitFor(() => expect(screen.getByTestId('shopee-categoria-linha-100001')).toBeTruthy());
  });
});

describe('ShopeeCategoriaBrowser — ways out, and the current level', () => {
  it('a failed LEVEL below the roots offers "Voltar às categorias principais", which goes back', async () => {
    h.categorias.mockImplementation((input: { integracaoId: string; categoryId: number | null }) =>
      input.categoryId === ROUPAS.categoryId
        ? Promise.reject(
            new ShopeeClientHttpError('Shopee recusou', 502, 'SHOPEE_HTTP_ERROR', null, 'other'),
          )
        : arvore(input),
    );
    show();
    fireEvent.click(
      within(await screen.findByTestId('shopee-categoria-linha-100001')).getByRole('button', {
        name: 'Roupas',
      }),
    );
    // Not repeatable (a 502 `other`): this button is the only way back.
    expect(await screen.findByText('Shopee recusou')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar às categorias principais' }));
    await screen.findByTestId('shopee-categoria-linha-100500');
  });

  it('NEAR-MISS: a failed ROOTS read offers no "Voltar" — it is already the top', async () => {
    h.categorias.mockImplementation(() =>
      Promise.reject(
        new ShopeeClientHttpError('Shopee recusou', 502, 'SHOPEE_HTTP_ERROR', null, 'other'),
      ),
    );
    show();
    expect(await screen.findByText('Shopee recusou')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Voltar às categorias principais' })).toBeNull();
  });

  it('the CURRENT level is the last crumb and is not a button; its ancestors are', async () => {
    show({ categoriaInicial: 100090 });
    await screen.findByText('Nenhuma subcategoria neste nível.');
    const migalhas = screen.getByTestId('shopee-categoria-caminho');
    expect(migalhas.textContent).toBe('Categorias›Roupas›Vestidos');
    expect(within(migalhas).queryByRole('button', { name: 'Vestidos' })).toBeNull();
    expect(within(migalhas).getByRole('button', { name: 'Roupas' })).toBeTruthy();
  });

  it('logged out (no client): the query never runs, so no failure is painted either', async () => {
    h.semCliente.value = true;
    show();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Não foi possível carregar as categorias da Shopee.')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
