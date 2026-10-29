import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  MOTIVO_RECUSA_MARCA_SHOPEE,
  type CategoriaResumoDto,
  type MarcaDto,
  type RespostaMarcasShopee,
} from '@delfrance/schemas';
import type { OcupanteDoRegistroMarcaShopee } from '@/lib/shopee/marcasDaConta';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import type { ShopeeCategoriaBrowserProps } from '@/components/shopee/ShopeeCategoriaBrowser';

/**
 * The add modal of the conta's Marcas section: category → status → one page
 * of Shopee's brands → the DTOs handed to `onAdicionar`. Doubled: the client's
 * `marcas` read (one call per page) and the category browser (its own suite).
 */

const h = vi.hoisted(() => ({
  marcas: vi.fn(),
  /**
   * A reason forced onto the shared registration rule for some rows
   * (`undefined` = the real rule decides) — what a re-derivation in the modal
   * could not reproduce.
   */
  motivoForcado: null as
    | ((
        dto: import('@delfrance/schemas').MarcaDto,
      ) => import('@delfrance/schemas').MotivoRecusaMarcaShopee | null | undefined)
    | null,
}));

// The REAL registration rule, with a hook to force its answer: the modal must
// take its verdict AND its reason from it, never from a copy of the rule.
vi.mock('@delfrance/schemas', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/schemas')>();
  return {
    ...actual,
    motivoRecusaMarcaShopee: (dto: MarcaDto) => {
      const forcado = h.motivoForcado?.(dto);
      return forcado !== undefined ? forcado : actual.motivoRecusaMarcaShopee(dto);
    },
  };
});

// The REAL error classes stay: `erros.ts` narrows on them.
vi.mock('@/lib/shopee/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => ({ marcas: h.marcas }) };
});

vi.mock('@/components/shopee/ShopeeCategoriaBrowser', async (importActual) => {
  const actual = await importActual<typeof import('@/components/shopee/ShopeeCategoriaBrowser')>();
  return {
    ...actual,
    ShopeeCategoriaBrowser: (props: ShopeeCategoriaBrowserProps) => (
      <div data-testid="browser-stub">
        <span>inicio:{String(props.categoriaInicial)}</span>
        <button type="button" onClick={() => props.onEscolher(TENIS)}>
          stub Tênis
        </button>
        <button type="button" onClick={() => props.onEscolher(BOLSAS)}>
          stub Bolsas
        </button>
      </div>
    ),
  };
});

const {
  AdicionarMarcasShopeeModal,
  chaveMarcasShopee,
  proximoOffsetDasMarcas,
  STATUS_MARCA_SHOPEE,
} = await import('./AdicionarMarcasShopeeModal');
const { ShopeeClientHttpError } = await import('@/lib/shopee/client');

const CONTA = 'int-1';
const TENIS: CategoriaResumoDto = {
  categoryId: 100087,
  name: 'Tênis',
  originalName: 'Sneakers',
  isLeaf: true,
};
const BOLSAS: CategoriaResumoDto = {
  categoryId: 100088,
  name: null,
  originalName: 'Bags',
  isLeaf: true,
};

const marca = (
  brandId: number,
  originalBrandName: string,
  displayBrandName: string | null = null,
): MarcaDto => ({
  brandId,
  originalBrandName,
  displayBrandName,
});
const NIKE = marca(1001, 'Nike');
const ADIDAS = marca(1002, 'Adidas', 'adidas Originals');
const PUMA = marca(1003, 'Puma');

function pagina(over: Partial<RespostaMarcasShopee> = {}): RespostaMarcasShopee {
  return {
    leaf: true,
    categoryId: 100087,
    status: 1,
    offset: 0,
    pageSize: 100,
    marcas: [NIKE, ADIDAS],
    hasNextPage: false,
    nextOffset: null,
    isMandatory: null,
    inputType: null,
    ...over,
  };
}

interface Opcoes {
  cadastradas?: number[];
  jaSelecionadas?: number[];
  ocupantes?: Record<string, OcupanteDoRegistroMarcaShopee>;
}

function show(o: Opcoes = {}) {
  const qc = new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
  const onAdicionar = vi.fn<(m: MarcaDto[]) => void>();
  const onFechar = vi.fn();
  const ui = (props: Opcoes): ReactElement => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <AdicionarMarcasShopeeModal
          integracaoId={CONTA}
          cadastradas={new Set(props.cadastradas ?? [])}
          jaSelecionadas={new Set(props.jaSelecionadas ?? [])}
          ocupantes={new Map(Object.entries(props.ocupantes ?? {}))}
          onAdicionar={onAdicionar}
          onFechar={onFechar}
        />
      </QueryClientProvider>
    </MantineTestProvider>
  );
  const view = render(ui(o));
  return { ...view, onAdicionar, onFechar, rerenderCom: (p: Opcoes) => view.rerender(ui(p)) };
}

async function escolher(qual: 'Tênis' | 'Bolsas' = 'Tênis') {
  fireEvent.click(screen.getByRole('button', { name: `stub ${qual}` }));
  await waitFor(() => expect(h.marcas).toHaveBeenCalled());
}

const opcao = (brandId: number) => screen.findByTestId(`shopee-marca-opcao-${String(brandId)}`);
async function caixa(brandId: number): Promise<HTMLInputElement> {
  return within(await opcao(brandId)).getByRole('checkbox') as HTMLInputElement;
}
const confirmar = () =>
  screen.getByTestId('shopee-adicionar-marcas-confirmar') as HTMLButtonElement;

beforeEach(() => {
  h.motivoForcado = null;
  h.marcas.mockReset();
  h.marcas.mockResolvedValue(pagina());
});

describe('AdicionarMarcasShopeeModal — category → page → picked DTOs', () => {
  it('asks the FIRST page (offset 0, approved) of the picked leaf and hands the ticked DTOs on VERBATIM', async () => {
    const { onAdicionar } = show();
    expect(screen.getByTestId('browser-stub')).toBeTruthy();
    expect(h.marcas).not.toHaveBeenCalled();
    await escolher();
    expect(h.marcas).toHaveBeenCalledWith({
      integracaoId: CONTA,
      categoryId: 100087,
      status: STATUS_MARCA_SHOPEE.aprovadas,
      offset: 0,
    });
    expect(confirmar().disabled).toBe(true);
    expect(confirmar().textContent).toBe('Adicionar selecionadas (0)');
    fireEvent.click(await caixa(1002));
    fireEvent.click(await caixa(1001));
    expect(confirmar().textContent).toBe('Adicionar selecionadas (2)');
    fireEvent.click(confirmar());
    // Selection order, the DTOs as Shopee sent them (display name included).
    expect(onAdicionar).toHaveBeenCalledWith([ADIDAS, NIKE]);
  });

  it('a row reads "<original> (<display, when it differs>) · id <n>"', async () => {
    h.marcas.mockResolvedValue(pagina({ marcas: [NIKE, ADIDAS, marca(1004, 'Puma', 'Puma')] }));
    show();
    await escolher();
    expect(within(await opcao(1001)).getByText('Nike · id 1001')).toBeTruthy();
    expect(within(await opcao(1002)).getByText('Adidas (adidas Originals) · id 1002')).toBeTruthy();
    // Near-miss: a display name equal to the original is not repeated.
    expect(within(await opcao(1004)).getByText('Puma · id 1004')).toBeTruthy();
  });

  it('unticking takes a brand back out; Cancelar hands nothing on', async () => {
    const { onAdicionar, onFechar } = show();
    await escolher();
    fireEvent.click(await caixa(1001));
    fireEvent.click(await caixa(1001));
    expect(confirmar().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onFechar).toHaveBeenCalledTimes(1);
    expect(onAdicionar).not.toHaveBeenCalled();
  });
});

describe('what cannot be picked is shown, disabled, never dropped', () => {
  it('Shopee’s 0 ("No Brand") is hidden, with the «Sem marca» note ⟷ a page without it has no note', async () => {
    h.marcas.mockResolvedValue(pagina({ marcas: [marca(0, 'No Brand'), NIKE] }));
    const { unmount } = show();
    await escolher();
    await opcao(1001);
    expect(screen.queryByTestId('shopee-marca-opcao-0')).toBeNull();
    expect(screen.getByTestId('shopee-marcas-sem-marca-oculta').textContent).toContain(
      '«Sem marca» está sempre disponível no anúncio',
    );
    unmount();

    h.marcas.mockReset();
    h.marcas.mockResolvedValue(pagina());
    show();
    await escolher();
    await opcao(1001);
    expect(screen.queryByTestId('shopee-marcas-sem-marca-oculta')).toBeNull();
  });

  it('already in the shortlist ⇒ checked + disabled «já cadastrada», by INTEGER id (123 ≠ 1234 ≠ 12)', async () => {
    h.marcas.mockResolvedValue(
      pagina({ marcas: [marca(123, 'Alfa'), marca(1234, 'Beta'), marca(12, 'Gama')] }),
    );
    show({ cadastradas: [123] });
    await escolher();
    const alfa = await caixa(123);
    expect(alfa.checked).toBe(true);
    expect(alfa.disabled).toBe(true);
    expect(within(await opcao(123)).getByText('já cadastrada')).toBeTruthy();
    for (const vizinha of [1234, 12]) {
      const c = await caixa(vizinha);
      expect(c.checked).toBe(false);
      expect(c.disabled).toBe(false);
    }
  });

  it('already staged ⇒ checked + disabled «já selecionada», and never handed on twice', async () => {
    const { onAdicionar } = show({ jaSelecionadas: [1001] });
    await escolher();
    const nike = await caixa(1001);
    expect(nike.checked).toBe(true);
    expect(nike.disabled).toBe(true);
    expect(within(await opcao(1001)).getByText('já selecionada')).toBeTruthy();
    fireEvent.click(await caixa(1002));
    fireEvent.click(confirmar());
    expect(onAdicionar).toHaveBeenCalledWith([ADIDAS]);
  });

  it('a brand the registration refuses is disabled with the reason ⟷ an edge-spaced name is NOT blank and goes on verbatim', async () => {
    h.marcas.mockResolvedValue(
      pagina({ marcas: [marca(1005, '   '), marca(-3, 'Quebrada'), marca(1006, ' Nike ')] }),
    );
    const { onAdicionar } = show();
    await escolher();
    const semNome = await caixa(1005);
    expect(semNome.disabled).toBe(true);
    expect(within(await opcao(1005)).getByText('(sem nome) · id 1005')).toBeTruthy();
    // Near-miss: the edge-spaced name is shown as Shopee sent it, never "(sem nome)".
    expect(
      within(await opcao(1006)).getByText(' Nike  · id 1006', { normalizer: (t) => t }),
    ).toBeTruthy();
    expect(
      within(await opcao(1005)).getByText('sem nome na Shopee — não pode ser cadastrada'),
    ).toBeTruthy();
    expect((await caixa(-3)).disabled).toBe(true);
    expect(within(await opcao(-3)).getByText('id inválido — não pode ser cadastrada')).toBeTruthy();
    fireEvent.click(await caixa(1006));
    fireEvent.click(confirmar());
    expect(onAdicionar).toHaveBeenCalledWith([marca(1006, ' Nike ')]);
  });

  it('a document id taken by a row that is NOT this brand ⇒ disabled ⟷ "01001" is not 1001’s id', async () => {
    const { unmount } = show({ ocupantes: { '1001': { tipo: 'ilegivel' } } });
    await escolher();
    expect((await caixa(1001)).disabled).toBe(true);
    expect((await caixa(1002)).disabled).toBe(false);
    unmount();

    show({
      ocupantes: { '01001': { tipo: 'ilegivel' }, aaaaaaaaaaaaaaaaaaaa: { tipo: 'sem-marca' } },
    });
    await escolher();
    expect((await caixa(1001)).disabled).toBe(false);
  });

  it('the «ocupada» line names WHAT holds the id and what clears it — the removal the section offers, or none here', async () => {
    h.marcas.mockResolvedValue(pagina({ marcas: [NIKE, ADIDAS, PUMA] }));
    show({
      ocupantes: {
        // Another brand's row, as the section's list labels it.
        '1001': { tipo: 'marca', brandId: 4004, rotulo: 'Fila · id 4004' },
        '1002': { tipo: 'sem-marca' },
        '1003': { tipo: 'ilegivel' },
      },
    });
    await escolher();
    expect(
      within(await opcao(1001)).getByText(
        'o registro 1001 desta lista é da marca «Fila · id 4004» — esta só pode ser cadastrada depois que essa marca for removida da lista e a remoção, salva',
      ),
    ).toBeTruthy();
    expect(
      within(await opcao(1002)).getByText(
        'o registro 1002 desta lista guarda «Sem marca» e esta tela não o remove — esta marca só pode ser cadastrada depois que ele for excluído fora do ERP, por quem administra o banco de dados',
      ),
    ).toBeTruthy();
    expect(
      within(await opcao(1003)).getByText(
        'o registro 1003 desta lista é ilegível e esta tela não o remove — esta marca só pode ser cadastrada depois que ele for excluído fora do ERP, por quem administra o banco de dados',
      ),
    ).toBeTruthy();
    for (const id of [1001, 1002, 1003]) expect((await caixa(id)).disabled).toBe(true);
  });

  it('the verdict AND the reason are the shared rule’s: a well-formed row it refuses is worded by ITS reason ⟷ a row it accepts stays pickable', async () => {
    // Forced answers no copy of the rule could give: a positive id refused as
    // «id inválido», a named brand refused as «sem nome», and a blank-named
    // brand ACCEPTED.
    h.motivoForcado = (dto) =>
      dto.brandId === 2_000_000
        ? MOTIVO_RECUSA_MARCA_SHOPEE.idInvalido
        : dto.brandId === 1007
          ? MOTIVO_RECUSA_MARCA_SHOPEE.semNome
          : dto.brandId === 1005
            ? null
            : undefined;
    h.marcas.mockResolvedValue(
      pagina({
        marcas: [marca(2_000_000, 'Grande'), marca(1007, 'Nomeada'), marca(1005, '   '), NIKE],
      }),
    );
    show();
    await escolher();
    expect((await caixa(2_000_000)).disabled).toBe(true);
    expect(
      within(await opcao(2_000_000)).getByText('id inválido — não pode ser cadastrada'),
    ).toBeTruthy();
    expect((await caixa(1007)).disabled).toBe(true);
    expect(
      within(await opcao(1007)).getByText('sem nome na Shopee — não pode ser cadastrada'),
    ).toBeTruthy();
    // Near-misses: what the shared rule accepts is pickable, whatever its name looks like.
    expect((await caixa(1005)).disabled).toBe(false);
    expect(within(await opcao(1005)).queryByText(/não pode ser cadastrada/)).toBeNull();
    expect((await caixa(1001)).disabled).toBe(false);
  });

  it('a pick that becomes blocked while the modal is open (staged elsewhere) is not handed on', async () => {
    const { onAdicionar, rerenderCom } = show();
    await escolher();
    fireEvent.click(await caixa(1001));
    fireEvent.click(await caixa(1002));
    expect(confirmar().textContent).toBe('Adicionar selecionadas (2)');
    rerenderCom({ cadastradas: [1001] });
    expect(confirmar().textContent).toBe('Adicionar selecionadas (1)');
    fireEvent.click(confirmar());
    expect(onAdicionar).toHaveBeenCalledWith([ADIDAS]);
  });
});

describe('paging: Shopee’s cursor, only while it says there is more', () => {
  it('«Carregar mais» asks `offset = nextOffset` VERBATIM (37, never offset + pageSize) and appends the page', async () => {
    h.marcas
      .mockResolvedValueOnce(pagina({ hasNextPage: true, nextOffset: 37 }))
      .mockResolvedValueOnce(
        pagina({ offset: 37, marcas: [PUMA], hasNextPage: false, nextOffset: 999 }),
      );
    const { onAdicionar } = show();
    await escolher();
    await opcao(1001);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await opcao(1003);
    expect(h.marcas).toHaveBeenCalledTimes(2);
    expect(h.marcas).toHaveBeenLastCalledWith({
      integracaoId: CONTA,
      categoryId: 100087,
      status: STATUS_MARCA_SHOPEE.aprovadas,
      offset: 37,
    });
    // Page 1 stays on screen beside page 2.
    expect(screen.getByTestId('shopee-marca-opcao-1001')).toBeTruthy();
    // The LAST page says no more: its non-null cursor is no reason to ask again.
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    // A selection made on page 1 survives loading page 2.
    fireEvent.click(await caixa(1001));
    fireEvent.click(await caixa(1003));
    fireEvent.click(confirmar());
    expect(onAdicionar).toHaveBeenCalledWith([NIKE, PUMA]);
  });

  it('a last page with a non-null `nextOffset` offers no «Carregar mais»', async () => {
    h.marcas.mockResolvedValue(pagina({ hasNextPage: false, nextOffset: 100 }));
    show();
    await escolher();
    await opcao(1001);
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    expect(screen.queryByTestId('shopee-marcas-sem-cursor')).toBeNull();
  });

  it('`hasNextPage` with no cursor ⇒ no button, and it says so', async () => {
    h.marcas.mockResolvedValue(pagina({ hasNextPage: true, nextOffset: null }));
    show();
    await escolher();
    await opcao(1001);
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    expect(screen.getByTestId('shopee-marcas-sem-cursor')).toBeTruthy();
  });

  it('a repeated brand across two pages is ONE row', async () => {
    h.marcas
      .mockResolvedValueOnce(pagina({ hasNextPage: true, nextOffset: 2 }))
      .mockResolvedValueOnce(pagina({ offset: 2, marcas: [NIKE, PUMA] }));
    show();
    await escolher();
    await opcao(1001);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await opcao(1003);
    expect(screen.getAllByTestId('shopee-marca-opcao-1001')).toHaveLength(1);
  });

  it('NEAR-MISS: brands sharing a NAME at different ids stay separate rows, across pages and within one — identity is the id', async () => {
    const generica = marca(2001, 'Genérica');
    const homonima = marca(2002, 'Genérica');
    h.marcas
      .mockResolvedValueOnce(pagina({ marcas: [generica], hasNextPage: true, nextOffset: 1 }))
      .mockResolvedValueOnce(pagina({ offset: 1, marcas: [homonima, marca(2003, 'GENÉRICA')] }));
    const { onAdicionar } = show();
    await escolher();
    await opcao(2001);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await opcao(2002);
    expect(await opcao(2003)).toBeTruthy();
    fireEvent.click(await caixa(2001));
    fireEvent.click(await caixa(2002));
    fireEvent.click(confirmar());
    expect(onAdicionar).toHaveBeenCalledWith([generica, homonima]);
  });

  it('proximoOffsetDasMarcas: the cursor only under hasNextPage', () => {
    expect(proximoOffsetDasMarcas(pagina({ hasNextPage: true, nextOffset: 37 }))).toBe(37);
    expect(proximoOffsetDasMarcas(pagina({ hasNextPage: true, nextOffset: 0 }))).toBe(0);
    expect(proximoOffsetDasMarcas(pagina({ hasNextPage: false, nextOffset: 37 }))).toBeUndefined();
    expect(proximoOffsetDasMarcas(pagina({ hasNextPage: true, nextOffset: null }))).toBeUndefined();
  });
});

describe('status, category and the answers that are not a list', () => {
  it('«Em análise» asks status 2 under its own cache key; the empty copy names the status', async () => {
    h.marcas.mockImplementation(async (input: { status: number }) =>
      input.status === STATUS_MARCA_SHOPEE.emAnalise ? pagina({ status: 2, marcas: [] }) : pagina(),
    );
    show();
    await escolher();
    await opcao(1001);
    fireEvent.click(screen.getByText('Em análise'));
    await waitFor(() =>
      expect(h.marcas).toHaveBeenLastCalledWith({
        integracaoId: CONTA,
        categoryId: 100087,
        status: STATUS_MARCA_SHOPEE.emAnalise,
        offset: 0,
      }),
    );
    expect((await screen.findByTestId('shopee-marcas-vazia')).textContent).toBe(
      'Nenhuma marca em análise nesta categoria.',
    );
    expect(chaveMarcasShopee(CONTA, 100087, 2)).toEqual(['shopee', 'marcas', CONTA, 100087, 2]);
  });

  it('`isMandatory: true` says the brand is mandatory ⟷ null and false say nothing', async () => {
    h.marcas.mockResolvedValue(pagina({ isMandatory: true }));
    const { unmount } = show();
    await escolher();
    expect((await screen.findByTestId('shopee-marcas-obrigatoria')).textContent).toBe(
      'Nesta categoria a marca é obrigatória.',
    );
    unmount();
    for (const isMandatory of [null, false]) {
      h.marcas.mockReset();
      h.marcas.mockResolvedValue(pagina({ isMandatory }));
      const v = show();
      await escolher();
      await opcao(1001);
      expect(screen.queryByTestId('shopee-marcas-obrigatoria')).toBeNull();
      v.unmount();
    }
  });

  it('`leaf: false` reads as "choose a subcategory", never as "no brands"', async () => {
    h.marcas.mockResolvedValue(pagina({ leaf: false, marcas: [] }));
    show();
    await escolher();
    expect(
      await screen.findByText(
        'A Shopee informa que esta categoria tem subcategorias — volte e escolha uma delas.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('shopee-marcas-vazia')).toBeNull();
  });

  it('a failed read shows the backend’s words ⟷ a repeatable failure offers «Tentar de novo»', async () => {
    h.marcas.mockRejectedValue(new ShopeeClientHttpError('categoryId inválido.', 400, null));
    const { unmount } = show();
    await escolher();
    expect((await screen.findByTestId('shopee-marcas-erro')).textContent).toContain(
      'categoryId inválido.',
    );
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    unmount();

    h.marcas.mockReset();
    // A 500 is repeatable by hand and never retried on its own (`shopeeQueryRetry`).
    h.marcas.mockRejectedValueOnce(new ShopeeClientHttpError('Falha no servidor.', 500, null));
    h.marcas.mockResolvedValue(pagina());
    show();
    await escolher();
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar de novo' }));
    expect(await opcao(1001)).toBeTruthy();
  });

  it('«Trocar categoria» reopens the browser at the last pick, and the selection survives it', async () => {
    const { onAdicionar } = show();
    await escolher();
    fireEvent.click(await caixa(1001));
    fireEvent.click(screen.getByRole('button', { name: 'Trocar categoria' }));
    expect(screen.getByText('inicio:100087')).toBeTruthy();
    h.marcas.mockResolvedValue(pagina({ categoryId: 100088, marcas: [PUMA] }));
    fireEvent.click(screen.getByRole('button', { name: 'stub Bolsas' }));
    fireEvent.click(await caixa(1003));
    expect(confirmar().textContent).toBe('Adicionar selecionadas (2)');
    fireEvent.click(confirmar());
    expect(onAdicionar).toHaveBeenCalledWith([NIKE, PUMA]);
  });
});
