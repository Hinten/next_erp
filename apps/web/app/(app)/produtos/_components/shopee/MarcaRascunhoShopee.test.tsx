import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Firestore, FirestoreError } from 'firebase/firestore';
import type { MarcaRascunhoShopee as ParMarcaRascunhoShopee } from '@delfrance/schemas';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';

import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The draft's brand picker over the REAL shortlist reader
 * (`marcasDaContaShopee`, via `lerMarcasShopee`) and the REAL §H Q1 rule
 * (`marcaDaLinhaParaRascunhoShopee`). Doubled: only the listener's state
 * (`h.estado`, what one emission says).
 */

type Linha = SnapshotRow<Readonly<Record<string, unknown>>>;

const h = vi.hoisted(() => ({
  estado: {
    data: undefined,
    loading: true,
    error: undefined,
  } as SnapshotState<readonly Linha[]>,
  contas: [] as (string | null)[],
}));

vi.mock('@/lib/shopee/marcas', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/marcas')>();
  return {
    ...actual,
    useMarcasShopee: (_db: Firestore, integracaoId: string | null) => {
      h.contas.push(integracaoId);
      return actual.lerMarcasShopee(h.estado);
    },
  };
});

const { MarcaRascunhoShopee, ROTULO_SEM_MARCA_SHOPEE, rotuloDaMarcaRascunhoShopee } =
  await import('./MarcaRascunhoShopee');
const { LIMITE_MARCAS_SHOPEE } = await import('@/lib/shopee/marcas');

const CONTA = 'int-1';
const LINK = 'rasc00000000000000001';

/** A stored `brandshopee` row (the doc id is `String(brand_id)`, P9); `''` = a nameless legacy row. */
const linha = (brandId: number, nome: string, display: string | null = null): Linha => ({
  id: String(brandId),
  path: `integracao/${CONTA}/brandshopee/${String(brandId)}`,
  data: { brand_id: brandId, original_brand_name: nome, display_brand_name: display },
});

function comLinhas(linhas: Linha[]): void {
  h.estado = { data: linhas, loading: false, error: undefined, fromCache: false };
}

/** Nike (named, 77), a NAMELESS legacy row (88), Adidas (99). */
const PADRAO = (): Linha[] => [linha(77, 'Nike'), linha(88, ''), linha(99, 'Adidas')];

function show(
  props: {
    marca?: ParMarcaRascunhoShopee | null;
    marcaGuardada?: ParMarcaRascunhoShopee | null;
    editavel?: boolean;
  } = {},
) {
  const onEscolher = vi.fn<(m: ParMarcaRascunhoShopee) => void>();
  render(
    <MantineTestProvider>
      <MarcaRascunhoShopee
        db={{} as Firestore}
        contaId={CONTA}
        contaNome="Loja Principal"
        linkDocId={LINK}
        marca={props.marca === undefined ? null : props.marca}
        marcaGuardada={props.marcaGuardada === undefined ? null : props.marcaGuardada}
        editavel={props.editavel ?? true}
        onEscolher={onEscolher}
      />
    </MantineTestProvider>,
  );
  return { onEscolher };
}

const select = () => screen.getByRole('combobox', { name: 'Marca' });
const valorMostrado = () => (select() as HTMLInputElement).value;

function escolher(rotulo: string): void {
  fireEvent.click(select());
  fireEvent.click(screen.getByRole('option', { name: rotulo }));
}

function rotulosDasOpcoes(): string[] {
  fireEvent.click(select());
  return screen.getAllByRole('option').map((o) => o.textContent ?? '');
}

beforeEach(() => {
  h.contas = [];
  comLinhas(PADRAO());
});

describe('MarcaRascunhoShopee — the read', () => {
  it('listens to THIS conta’s shortlist and renders under its root test id', () => {
    show();
    expect(h.contas.every((c) => c === CONTA)).toBe(true);
    expect(h.contas.length).toBeGreaterThan(0);
    expect(screen.getByTestId(`shopee-rascunho-marca-${LINK}`)).toBeTruthy();
  });

  it('shows a spinner — and no Select — until the listener answers', () => {
    h.estado = { data: undefined, loading: true, error: undefined };
    show();
    expect(screen.getByTestId(`shopee-rascunho-marca-${LINK}-carregando`)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Marca' })).toBeNull();
  });

  it('NEAR-MISS: a listener ERROR says so instead of spinning forever', () => {
    h.estado = {
      data: undefined,
      loading: false,
      error: { code: 'permission-denied', message: 'x' } as FirestoreError,
    };
    show();
    expect(screen.getByTestId(`shopee-rascunho-marca-${LINK}-erro`)).toBeTruthy();
    expect(screen.queryByTestId(`shopee-rascunho-marca-${LINK}-carregando`)).toBeNull();
  });

  it('offers «Sem marca (No Brand)» FIRST, then the shortlist in the reader’s order', () => {
    show();
    expect(rotulosDasOpcoes()).toEqual([ROTULO_SEM_MARCA_SHOPEE, 'Adidas', 'Marca 88', 'Nike']);
  });
});

describe('MarcaRascunhoShopee — what a pick sends (D10, §H Q1)', () => {
  it('«Sem marca» is the explicit brand_id 0 with no name — never null', () => {
    const { onEscolher } = show();
    escolher(ROTULO_SEM_MARCA_SHOPEE);
    expect(onEscolher).toHaveBeenCalledTimes(1);
    expect(onEscolher).toHaveBeenCalledWith({ brand_id: 0, original_brand_name: null });
  });

  it('a named row sends its PAIR', () => {
    const { onEscolher } = show();
    escolher('Adidas');
    expect(onEscolher).toHaveBeenCalledWith({ brand_id: 99, original_brand_name: 'Adidas' });
  });

  it('§H Q1: a NAMELESS row at the STORED brand_id keeps the STORED name', () => {
    // The form moved to Adidas; the operator goes back to the stored brand,
    // whose shortlist row is a nameless legacy one.
    const guardada = { brand_id: 88, original_brand_name: 'Puma (importada)' };
    const { onEscolher } = show({
      marca: { brand_id: 99, original_brand_name: 'Adidas' },
      marcaGuardada: guardada,
    });
    escolher('Marca 88');
    expect(onEscolher).toHaveBeenCalledWith({
      brand_id: 88,
      original_brand_name: 'Puma (importada)',
    });
  });

  it('NEAR-MISS: a nameless row at a DIFFERENT id sends the pair as picked (null name)', () => {
    const { onEscolher } = show({
      marca: { brand_id: 77, original_brand_name: 'Nike' },
      marcaGuardada: { brand_id: 77, original_brand_name: 'Nike' },
    });
    escolher('Marca 88');
    expect(onEscolher).toHaveBeenCalledWith({ brand_id: 88, original_brand_name: null });
  });

  it('NEAR-MISS: a NAMED row at the stored id sends THAT row’s name (a re-pick is how a name arrives)', () => {
    comLinhas([linha(77, 'Nike Oficial'), linha(99, 'Adidas')]);
    const { onEscolher } = show({
      marca: { brand_id: 99, original_brand_name: 'Adidas' },
      marcaGuardada: { brand_id: 77, original_brand_name: 'Nike' },
    });
    escolher('Nike Oficial');
    expect(onEscolher).toHaveBeenCalledWith({ brand_id: 77, original_brand_name: 'Nike Oficial' });
  });

  it('NEAR-MISS: a new local draft has no stored pair — a nameless row sends a null name', () => {
    const { onEscolher } = show({ marca: null, marcaGuardada: null });
    escolher('Marca 88');
    expect(onEscolher).toHaveBeenCalledWith({ brand_id: 88, original_brand_name: null });
  });

  it('read-only: the Select is disabled', () => {
    show({ editavel: false, marca: { brand_id: 77, original_brand_name: 'Nike' } });
    expect((select() as HTMLInputElement).disabled).toBe(true);
    expect(valorMostrado()).toBe('Nike');
  });

  it('NEAR-MISS: editable, the Select is enabled', () => {
    show({ editavel: true });
    expect((select() as HTMLInputElement).disabled).toBe(false);
  });
});

describe('MarcaRascunhoShopee — the held pair', () => {
  it('nothing chosen shows the placeholder (no value)', () => {
    show({ marca: null });
    expect(valorMostrado()).toBe('');
  });

  it('a listed brand shows the ROW’s label, without the "fora da lista" suffix', () => {
    show({ marca: { brand_id: 99, original_brand_name: 'Adidas' } });
    expect(valorMostrado()).toBe('Adidas');
  });

  it('«Sem marca» held shows its own option', () => {
    show({ marca: { brand_id: 0, original_brand_name: null } });
    expect(valorMostrado()).toBe(ROTULO_SEM_MARCA_SHOPEE);
  });

  it('a stored id ABSENT from the shortlist stays selected as "(fora da lista da conta)", and re-picking it sends nothing', () => {
    const { onEscolher } = show({ marca: { brand_id: 555, original_brand_name: 'Antiga' } });
    expect(valorMostrado()).toBe('Antiga (fora da lista da conta)');
    // Picking ANOTHER option is the operator's way out; the held one itself is
    // no pick — it is offered once, and clicking it sends nothing.
    fireEvent.click(select());
    const opcoes = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opcoes.filter((o) => o === 'Antiga (fora da lista da conta)')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: 'Antiga (fora da lista da conta)' }));
    expect(onEscolher).not.toHaveBeenCalled();
    expect(valorMostrado()).toBe('Antiga (fora da lista da conta)');
  });

  it('NEAR-MISS: leaving an unlisted held brand for a listed one sends that row', () => {
    const { onEscolher } = show({
      marca: { brand_id: 555, original_brand_name: 'Antiga' },
      marcaGuardada: { brand_id: 555, original_brand_name: 'Antiga' },
    });
    escolher('Nike');
    expect(onEscolher).toHaveBeenCalledWith({ brand_id: 77, original_brand_name: 'Nike' });
  });

  it('a legacy -1 renders "(fora da lista da conta)" without crashing', () => {
    show({ marca: { brand_id: -1, original_brand_name: null } });
    expect(valorMostrado()).toBe('Marca -1 (fora da lista da conta)');
  });
});

describe('MarcaRascunhoShopee — an empty or cut shortlist', () => {
  it('an EMPTY shortlist says where to register brands (linked) and still offers «Sem marca»', () => {
    comLinhas([]);
    show();
    const vazia = screen.getByTestId(`shopee-rascunho-marca-${LINK}-vazia`);
    expect(vazia.textContent).toContain('Nenhuma marca cadastrada nesta conta.');
    expect(vazia.textContent).toContain('Loja Principal');
    expect(within(vazia).getByRole('link').getAttribute('href')).toBe(`/canais/shopee/${CONTA}`);
    expect(rotulosDasOpcoes()).toEqual([ROTULO_SEM_MARCA_SHOPEE]);
  });

  it('NEAR-MISS: a non-empty shortlist has no such sentence', () => {
    show();
    expect(screen.queryByTestId(`shopee-rascunho-marca-${LINK}-vazia`)).toBeNull();
  });

  it('a shortlist read at the cap says brands past it are not listed', () => {
    comLinhas(
      Array.from({ length: LIMITE_MARCAS_SHOPEE }, (_, i) => linha(i + 1, `M${String(i)}`)),
    );
    show();
    expect(screen.getByTestId(`shopee-rascunho-marca-${LINK}-truncada`)).toBeTruthy();
  });

  it('NEAR-MISS: below the cap, no such note', () => {
    show();
    expect(screen.queryByTestId(`shopee-rascunho-marca-${LINK}-truncada`)).toBeNull();
  });
});

describe('rotuloDaMarcaRascunhoShopee — display only', () => {
  it('reads null / 0 / named / nameless / blank-named pairs', () => {
    expect(rotuloDaMarcaRascunhoShopee(null)).toBe('Nenhuma marca escolhida');
    expect(rotuloDaMarcaRascunhoShopee({ brand_id: 0, original_brand_name: null })).toBe(
      ROTULO_SEM_MARCA_SHOPEE,
    );
    expect(rotuloDaMarcaRascunhoShopee({ brand_id: 77, original_brand_name: 'Nike' })).toBe('Nike');
    expect(rotuloDaMarcaRascunhoShopee({ brand_id: 77, original_brand_name: null })).toBe(
      'Marca 77',
    );
    expect(rotuloDaMarcaRascunhoShopee({ brand_id: 77, original_brand_name: '   ' })).toBe(
      'Marca 77',
    );
  });
});
