import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import type { MarcaDto } from '@delfrance/schemas';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import {
  createTransactionDocuments,
  ObjectViewTransactionDocumentsProvider,
} from '@delfrance/ui/src/object/ObjectViewTransactionDocuments';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { AdicionarMarcasShopeeModalProps } from './AdicionarMarcasShopeeModal';

/**
 * The conta's Marcas section, over the REAL reader (`marcasDaContaShopee`, via
 * `lerMarcasShopee`), the REAL delta helpers (`lib/shopee/marcasDaConta.ts`)
 * and the REAL baseline registry ObjectView owns. Doubled: the listener's
 * state (`h.estado`, what one emission says) and the add modal (its own suite;
 * here a stub that shows what the section hands it and adds one brand).
 */

type Linha = SnapshotRow<Readonly<Record<string, unknown>>>;

const h = vi.hoisted(() => ({
  estado: {
    data: undefined,
    loading: true,
    error: undefined,
  } as SnapshotState<readonly Linha[]>,
  modal: null as AdicionarMarcasShopeeModalProps | null,
  adicionarNoModal: [] as MarcaDto[],
}));

vi.mock('@/lib/shopee/marcas', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/marcas')>();
  // One reading per emission, as the real hook memoizes it: a re-render that
  // is not an emission hands the section the SAME arrays, so an effect that
  // must re-run on something else (unstaging) cannot ride a new array.
  const lidas = new WeakMap<object, ReturnType<typeof actual.lerMarcasShopee>>();
  return {
    ...actual,
    useMarcasShopee: () => {
      const lida = lidas.get(h.estado) ?? actual.lerMarcasShopee(h.estado);
      lidas.set(h.estado, lida);
      return lida;
    },
  };
});

// The handle's ref is a path here: the section keys a staged change's baseline
// by it, and the test's `{}` database could not build a real one.
vi.mock('@/lib/data/marcaShopeeCollection', () => ({
  marcaShopeeCollection: {
    docRef: (_db: unknown, ctx: { integracaoId: string }, id: string) => ({
      path: `integracao/${ctx.integracaoId}/brandshopee/${id}`,
      id,
    }),
  },
}));

vi.mock('./AdicionarMarcasShopeeModal', () => ({
  AdicionarMarcasShopeeModal: (props: AdicionarMarcasShopeeModalProps) => {
    h.modal = props;
    return (
      <div data-testid="modal-stub">
        <button type="button" onClick={() => props.onAdicionar(h.adicionarNoModal)}>
          stub adicionar
        </button>
        <button type="button" onClick={props.onFechar}>
          stub fechar
        </button>
      </div>
    );
  },
}));

const { MarcasShopeeManager } = await import('./MarcasShopeeManager');
const { CAMPO_MARCAS_SHOPEE } = await import('@/lib/shopee/marcasDaConta');

const CONTA = 'int-1';
/** ONE database, as the app's singleton is: a new object per render would re-run every effect. */
const DB = {} as Firestore;
const caminho = (id: string) => `integracao/${CONTA}/brandshopee/${id}`;
const linha = (id: string, data: Record<string, unknown>): Linha => ({
  id,
  path: caminho(id),
  data,
});
const legado = (brand_id: unknown, original_brand_name: unknown) => ({
  brand_id,
  original_brand_name,
  display_brand_name: null,
});

/** Legacy auto ids (20 chars), as the Flutter app wrote them. */
const ID_NIKE = 'a0000000000000000001';
const ID_ADIDAS_1 = 'a0000000000000000002';
const ID_ADIDAS_2 = 'a0000000000000000003';
const ID_SEM_NOME = 'a0000000000000000004';
const ID_ILEGIVEL = 'a0000000000000000005';
const ID_SEM_MARCA = 'a0000000000000000006';

function linhasPadrao(): Linha[] {
  return [
    linha(ID_NIKE, legado(1001, 'Nike')),
    linha(ID_ADIDAS_1, legado(1002, 'Adidas')),
    linha(ID_ADIDAS_2, legado(1002, '')),
    linha(ID_SEM_NOME, legado(7, '')),
  ];
}

/** One listener emission. */
function emitir(
  data: Linha[] | undefined,
  meta: { fromCache?: boolean; hasPendingWrites?: boolean } = {},
) {
  h.estado = {
    data,
    loading: data === undefined,
    error: undefined,
    fromCache: meta.fromCache ?? false,
    hasPendingWrites: meta.hasPendingWrites ?? false,
  };
}

const mudancas: unknown[] = [];

function Host(props: {
  documents: ReturnType<typeof createTransactionDocuments> | null;
  inicial: unknown;
  podeRemover: boolean;
  disabled: boolean;
}) {
  const [value, setValue] = useState<unknown>(props.inicial);
  const manager = (
    <MarcasShopeeManager
      db={DB}
      integracaoId={CONTA}
      value={value}
      onChange={(v) => {
        mudancas.push(v);
        setValue(v);
      }}
      disabled={props.disabled}
      podeRemover={props.podeRemover}
    />
  );
  return (
    <MantineTestProvider>
      {props.documents === null ? (
        manager
      ) : (
        <ObjectViewTransactionDocumentsProvider value={props.documents}>
          {manager}
        </ObjectViewTransactionDocumentsProvider>
      )}
    </MantineTestProvider>
  );
}

function show(
  o: {
    documents?: ReturnType<typeof createTransactionDocuments> | null;
    inicial?: unknown;
    podeRemover?: boolean;
    disabled?: boolean;
  } = {},
) {
  const documents = o.documents === undefined ? createTransactionDocuments() : o.documents;
  const props = {
    documents,
    inicial: o.inicial ?? null,
    podeRemover: o.podeRemover ?? true,
    disabled: o.disabled ?? false,
  };
  const view = render(<Host {...props} />);
  return { ...view, documents, reemitir: () => view.rerender(<Host {...props} />) };
}

const linhaDaMarca = (brandId: number) => screen.getByTestId(`shopee-marca-${String(brandId)}`);
const botao = (nome: string, dentro?: HTMLElement) =>
  (dentro ? within(dentro) : screen).getByRole('button', { name: nome }) as HTMLButtonElement;
const ultimaMudanca = () => mudancas.at(-1);

beforeEach(() => {
  mudancas.length = 0;
  h.modal = null;
  h.adicionarNoModal = [];
  emitir(linhasPadrao());
});

describe('MarcasShopeeManager — the rows, through THE reader', () => {
  it('one row per brand_id: "<name> · id <n>", "(N registros)" for legacy duplicates, "Marca sem nome" for none', () => {
    show();
    expect(within(linhaDaMarca(1001)).getByText('Nike · id 1001')).toBeTruthy();
    expect(within(linhaDaMarca(1002)).getByText('Adidas · id 1002 (2 registros)')).toBeTruthy();
    expect(within(linhaDaMarca(7)).getByText('Marca sem nome (id 7)')).toBeTruthy();
    // The reader's order (rotulo, pt-BR): Adidas, Marca 7, Nike.
    const ordem = screen.getAllByTestId(/^shopee-marca-\d+$/).map((e) => e.dataset.testid);
    expect(ordem).toEqual(['shopee-marca-1002', 'shopee-marca-7', 'shopee-marca-1001']);
  });

  it('two «Nike» rows at ids 1 and 2 are TWO brands ⟷ «Nike» and «NIKE» at one id are ONE', () => {
    emitir([
      linha('a0000000000000000011', legado(1, 'Nike')),
      linha('a0000000000000000012', legado(2, 'Nike')),
      linha('a0000000000000000013', legado(3, 'Nike')),
      linha('a0000000000000000014', legado(3, 'NIKE')),
    ]);
    show();
    expect(within(linhaDaMarca(1)).getByText('Nike · id 1')).toBeTruthy();
    expect(within(linhaDaMarca(2)).getByText('Nike · id 2')).toBeTruthy();
    expect(within(linhaDaMarca(3)).getByText('Nike · id 3 (2 registros)')).toBeTruthy();
    expect(screen.getAllByTestId(/^shopee-marca-\d+$/)).toHaveLength(3);
  });

  it('a STRING «123» brand_id is unreadable and a stored 0 is «Sem marca»: counted, never a brand row', () => {
    emitir([
      ...linhasPadrao(),
      linha(ID_ILEGIVEL, legado('123', 'Texto')),
      linha(ID_SEM_MARCA, legado(0, 'No Brand')),
    ]);
    show();
    expect(screen.queryByTestId('shopee-marca-123')).toBeNull();
    expect(screen.queryByTestId('shopee-marca-0')).toBeNull();
    expect(screen.getByTestId('shopee-marcas-outros-registros').textContent).toBe(
      '2 registro(s) desta lista não são uma marca legível (ilegíveis ou «Sem marca») e não aparecem acima.',
    );
  });

  it('an empty shortlist says so; the read past the limit says it is truncated', () => {
    emitir([]);
    const { unmount } = show();
    expect(screen.getByTestId('shopee-marcas-vazia')).toBeTruthy();
    expect(screen.queryByTestId('shopee-marcas-truncada')).toBeNull();
    unmount();

    emitir(
      Array.from({ length: 500 }, (_, i) => linha(`m${String(i)}`, legado(i + 1, `M${String(i)}`))),
    );
    show();
    expect(screen.getByTestId('shopee-marcas-truncada')).toBeTruthy();
  });

  it('a listener error is shown; before the first emission there is a loader and nothing to click', () => {
    h.estado = {
      data: undefined,
      loading: false,
      error: { message: 'permission-denied' } as never,
    };
    const { unmount } = show();
    expect(screen.getByTestId('shopee-marcas-falha').textContent).toContain('permission-denied');
    unmount();

    emitir(undefined);
    show();
    expect(screen.queryByTestId(/^shopee-marca-\d+$/)).toBeNull();
    expect(botao('Adicionar marcas').disabled).toBe(true);
  });
});

describe('removal is staged: dimmed, undoable, and it names EVERY document of the brand', () => {
  it('Remover ⇒ «Será removida» + Desfazer; Desfazer ⇒ null (the form is pristine again)', () => {
    show();
    fireEvent.click(botao('Remover', linhaDaMarca(1001)));
    expect(ultimaMudanca()).toEqual({
      adicionar: [],
      remover: [{ brandId: 1001, docIds: [ID_NIKE] }],
    });
    expect(within(linhaDaMarca(1001)).getByText('Será removida')).toBeTruthy();
    fireEvent.click(botao('Desfazer', linhaDaMarca(1001)));
    expect(ultimaMudanca()).toBeNull();
    expect(within(linhaDaMarca(1001)).queryByText('Será removida')).toBeNull();
  });

  it('a brand stored as two legacy docs is removed by BOTH ids, canonical first', () => {
    show();
    fireEvent.click(botao('Remover', linhaDaMarca(1002)));
    expect(ultimaMudanca()).toEqual({
      adicionar: [],
      remover: [{ brandId: 1002, docIds: [ID_ADIDAS_1, ID_ADIDAS_2] }],
    });
  });

  it('no Remover — and the reason — without PERM.integracao.delete ⟷ with it, no reason line', () => {
    const { unmount } = show({ podeRemover: false });
    expect(within(linhaDaMarca(1001)).queryByRole('button', { name: 'Remover' })).toBeNull();
    expect(screen.getByTestId('shopee-marcas-sem-permissao-remover').textContent).toBe(
      'Remover marcas requer permissão de exclusão em integrações.',
    );
    // Adding needs only the write bit.
    expect(botao('Adicionar marcas').disabled).toBe(false);
    unmount();

    show({ podeRemover: true });
    expect(botao('Remover', linhaDaMarca(1001))).toBeTruthy();
    expect(screen.queryByTestId('shopee-marcas-sem-permissao-remover')).toBeNull();
  });

  it('a staged removal whose brand left the list keeps its own line and undo', () => {
    emitir([linha(ID_ADIDAS_1, legado(1002, 'Adidas'))]);
    show({ inicial: { adicionar: [], remover: [{ brandId: 1001, docIds: [ID_NIKE] }] } });
    const fora = screen.getByTestId('shopee-marca-removida-fora-1001');
    expect(within(fora).getByText('Será removida')).toBeTruthy();
    fireEvent.click(botao('Desfazer', fora));
    expect(ultimaMudanca()).toBeNull();
    expect(screen.queryByTestId('shopee-marca-removida-fora-1001')).toBeNull();
  });

  it('a doc of the brand that appeared AFTER marking is not in the removal — said, and «Incluir na remoção» re-stages ALL', () => {
    const { reemitir } = show();
    fireEvent.click(botao('Remover', linhaDaMarca(1001)));
    expect(screen.queryByTestId('shopee-marca-registro-novo-1001')).toBeNull();
    // Another operator registered Nike again, at its deterministic id.
    emitir([...linhasPadrao(), linha('1001', legado(1001, 'Nike'))]);
    act(() => reemitir());
    const aviso = screen.getByTestId('shopee-marca-registro-novo-1001');
    expect(aviso.textContent).toContain(
      '1 registro(s) desta marca apareceram depois de marcá-la e não serão removidos',
    );
    fireEvent.click(botao('Incluir na remoção', aviso));
    expect(ultimaMudanca()).toEqual({
      adicionar: [],
      remover: [{ brandId: 1001, docIds: ['1001', ID_NIKE] }],
    });
    expect(screen.queryByTestId('shopee-marca-registro-novo-1001')).toBeNull();
  });

  it('a read-only form offers no change', () => {
    show({ disabled: true });
    expect(botao('Remover', linhaDaMarca(1001)).disabled).toBe(true);
    expect(botao('Adicionar marcas').disabled).toBe(true);
  });

  it('a form value that is not a delta is refused, with a way out', () => {
    show({
      inicial: {
        adicionar: [{ brandId: 0, originalBrandName: 'x', displayBrandName: null }],
        remover: [],
      },
    });
    expect(screen.getByTestId('shopee-marcas-delta-invalido')).toBeTruthy();
    fireEvent.click(botao('Descartar alterações de marcas'));
    expect(ultimaMudanca()).toBeNull();
    expect(screen.getByTestId('shopee-marcas-manager')).toBeTruthy();
  });
});

describe('staged registrations', () => {
  const NIKE_SHOPEE: MarcaDto = {
    brandId: 2001,
    originalBrandName: 'Nike BR',
    displayBrandName: null,
  };

  it('the modal is handed the listed ids, EVERY doc id (unreadable and «Sem marca» included) with its occupant, and the staged adds', () => {
    emitir([
      ...linhasPadrao(),
      linha(ID_ILEGIVEL, legado('123', 'Texto')),
      linha(ID_SEM_MARCA, legado(0, 'No Brand')),
    ]);
    show({ inicial: { adicionar: [NIKE_SHOPEE], remover: [] } });
    fireEvent.click(botao('Adicionar marcas'));
    expect(h.modal).not.toBeNull();
    expect([...h.modal!.cadastradas].sort((a, b) => a - b)).toEqual([7, 1001, 1002]);
    expect([...h.modal!.jaSelecionadas]).toEqual([2001]);
    expect(Object.fromEntries(h.modal!.ocupantes)).toEqual({
      [ID_NIKE]: { tipo: 'marca', brandId: 1001, rotulo: 'Nike · id 1001' },
      // The label the section's row shows, so a refusal names a row on screen.
      [ID_ADIDAS_1]: { tipo: 'marca', brandId: 1002, rotulo: 'Adidas · id 1002 (2 registros)' },
      [ID_ADIDAS_2]: { tipo: 'marca', brandId: 1002, rotulo: 'Adidas · id 1002 (2 registros)' },
      [ID_SEM_NOME]: { tipo: 'marca', brandId: 7, rotulo: 'Marca sem nome (id 7)' },
      [ID_ILEGIVEL]: { tipo: 'ilegivel' },
      [ID_SEM_MARCA]: { tipo: 'sem-marca' },
    });
  });

  it('an add from the modal is staged on top as «Nova», closes the modal, and Desfazer undoes it to null', () => {
    h.adicionarNoModal = [NIKE_SHOPEE];
    show();
    fireEvent.click(botao('Adicionar marcas'));
    fireEvent.click(botao('stub adicionar'));
    expect(screen.queryByTestId('modal-stub')).toBeNull();
    expect(ultimaMudanca()).toEqual({ adicionar: [NIKE_SHOPEE], remover: [] });
    const nova = screen.getByTestId('shopee-marca-nova-2001');
    expect(within(nova).getByText('Nova')).toBeTruthy();
    expect(within(nova).getByText('Nike BR · id 2001')).toBeTruthy();
    // Staged on top of the list.
    const primeira = screen.getAllByTestId(/^shopee-marca-(nova-)?\d+$/)[0];
    expect(primeira?.dataset.testid).toBe('shopee-marca-nova-2001');
    fireEvent.click(botao('Desfazer', nova));
    expect(ultimaMudanca()).toBeNull();
    expect(screen.queryByTestId('shopee-marca-nova-2001')).toBeNull();
  });

  it('a staged add whose brand another operator registered meanwhile says so', () => {
    emitir([...linhasPadrao(), linha('2001', legado(2001, 'Nike BR'))]);
    show({ inicial: { adicionar: [NIKE_SHOPEE], remover: [] } });
    expect(
      within(screen.getByTestId('shopee-marca-nova-2001')).getByText(
        'já consta na lista — desfaça esta adição',
      ),
    ).toBeTruthy();
  });
});

describe('the save baselines: one per DOCUMENT, from server truth only', () => {
  it('a server snapshot seeds EVERY doc path with its data, and marks the section read', () => {
    const { documents } = show();
    for (const l of linhasPadrao()) expect(documents!.getBaseline(l.path)).toEqual(l.data);
    expect(documents!.getFormBaseline(CAMPO_MARCAS_SHOPEE)).toBeNull();
    expect(botao('Remover', linhaDaMarca(1001)).disabled).toBe(false);
    expect(botao('Adicionar marcas').disabled).toBe(false);
  });

  it('a CACHED emission seeds nothing and leaves the section read-only, SAYING why ⟷ the server one then seeds it and the line goes', () => {
    emitir(linhasPadrao(), { fromCache: true });
    const { documents, reemitir } = show();
    expect(documents!.getBaseline(caminho(ID_NIKE))).toBeUndefined();
    expect(documents!.getFormBaseline(CAMPO_MARCAS_SHOPEE)).toBeUndefined();
    expect(botao('Remover', linhaDaMarca(1001)).disabled).toBe(true);
    expect(botao('Adicionar marcas').disabled).toBe(true);
    expect(screen.getByTestId('shopee-marcas-carregando-servidor').textContent).toBe(
      'Carregando a versão do servidor… as marcas poderão ser alteradas quando ela chegar.',
    );

    emitir(linhasPadrao());
    act(() => reemitir());
    expect(documents!.getBaseline(caminho(ID_NIKE))).toEqual(legado(1001, 'Nike'));
    expect(botao('Remover', linhaDaMarca(1001)).disabled).toBe(false);
    expect(screen.queryByTestId('shopee-marcas-carregando-servidor')).toBeNull();
  });

  it('an emission with pending writes seeds nothing — and says why', () => {
    emitir(linhasPadrao(), { hasPendingWrites: true });
    const { documents } = show();
    expect(documents!.getBaseline(caminho(ID_NIKE))).toBeUndefined();
    expect(botao('Adicionar marcas').disabled).toBe(true);
    expect(screen.getByTestId('shopee-marcas-carregando-servidor')).toBeTruthy();
  });

  it('no «Carregando» line where it is not the reason: a server snapshot, a read-only form, the loader', () => {
    const { unmount } = show();
    expect(screen.queryByTestId('shopee-marcas-carregando-servidor')).toBeNull();
    unmount();

    // Disabled for lack of PERM.integracao.write: server truth would change nothing.
    emitir(linhasPadrao(), { fromCache: true });
    const v = show({ disabled: true });
    expect(botao('Adicionar marcas').disabled).toBe(true);
    expect(screen.queryByTestId('shopee-marcas-carregando-servidor')).toBeNull();
    v.unmount();

    // Before any emission the loader stands for it.
    emitir(undefined);
    show();
    expect(screen.queryByTestId('shopee-marcas-carregando-servidor')).toBeNull();
  });

  it('a later emission never MOVES a baseline ⟷ a row first shown by it gets its OWN', () => {
    const { documents, reemitir } = show();
    const outra = linha('a0000000000000000099', legado(3003, 'Puma'));
    emitir([
      // Another operator renamed Nike after the first seed…
      linha(ID_NIKE, legado(1001, 'Nike renomeada')),
      ...linhasPadrao().slice(1),
      // …and registered a brand this page had never seen.
      outra,
    ]);
    act(() => reemitir());
    expect(documents!.getBaseline(caminho(ID_NIKE))).toEqual(legado(1001, 'Nike'));
    expect(documents!.getBaseline(outra.path)).toEqual(outra.data);
    expect(within(linhaDaMarca(3003)).getByText('Puma · id 3003')).toBeTruthy();
  });

  it('a doc another tab deleted is held ABSENT from then on ⟷ one STAGED for removal keeps its row (that removal’s conflict)', () => {
    const { documents, reemitir } = show();
    fireEvent.click(botao('Remover', linhaDaMarca(1002)));
    emitir(linhasPadrao().filter((l) => l.id !== ID_NIKE && l.id !== ID_ADIDAS_1));
    act(() => reemitir());
    // Held as its row, a re-add equal to it would be skipped by the save.
    expect(documents!.getBaseline(caminho(ID_NIKE))).toBeNull();
    // Cleared, the staged removal's `delete` of it would be skipped instead.
    expect(documents!.getBaseline(caminho(ID_ADIDAS_1))).toEqual(legado(1002, 'Adidas'));
    // Undoing that removal hands it back to the rule, on the snapshot already read.
    fireEvent.click(botao('Desfazer', linhaDaMarca(1002)));
    expect(ultimaMudanca()).toBeNull();
    expect(documents!.getBaseline(caminho(ID_ADIDAS_1))).toBeNull();
  });

  it('a doc held ABSENT that a snapshot shows again gets its row back ⟷ not at the id of a STAGED registration', () => {
    const PUMA: MarcaDto = { brandId: 3003, originalBrandName: 'Puma', displayBrandName: null };
    const { documents, reemitir } = show();
    // Nike's doc deleted (server truth), and Puma's deterministic id held absent
    // as a committed removal leaves it.
    emitir(linhasPadrao().filter((l) => l.id !== ID_NIKE));
    act(() => reemitir());
    act(() => documents!.rebase(caminho('3003'), null));
    expect(documents!.getBaseline(caminho(ID_NIKE))).toBeNull();
    h.adicionarNoModal = [PUMA];
    fireEvent.click(botao('Adicionar marcas'));
    fireEvent.click(botao('stub adicionar'));
    // Another tab registered both again; this snapshot shows them.
    const nikeDeNovo = legado(1001, 'NIKE');
    const pumaDeles = legado(3003, 'PUMA');
    emitir([
      ...linhasPadrao().filter((l) => l.id !== ID_NIKE),
      linha(ID_NIKE, nikeDeNovo),
      linha('3003', pumaDeles),
    ]);
    act(() => reemitir());
    // Held absent, a removal of it would be skipped as "already gone".
    expect(documents!.getBaseline(caminho(ID_NIKE))).toEqual(nikeDeNovo);
    // Their row would guard the staged registration's `set` that overwrites it.
    expect(documents!.getBaseline(caminho('3003'))).toBeNull();
  });

  it('a staged registration’s path held as a row no snapshot lists is cleared too ⟷ a listed one is kept', () => {
    const PUMA: MarcaDto = { brandId: 3003, originalBrandName: 'Puma', displayBrandName: null };
    // Their row of the brand, NOT equal to ours (an equal one satisfies the
    // registration, which then leaves the stage — see the F2 block below).
    const linhaDeles = {
      brand_id: 3003,
      original_brand_name: 'PUMA',
      display_brand_name: 'Puma BR',
    };
    const { documents, reemitir } = show({ inicial: { adicionar: [PUMA], remover: [] } });
    // A row held for it (as "Salvar mesmo assim" over their row leaves one),
    // and the next server snapshot does not list it: `null` fails closed at save.
    act(() => documents!.rebase(caminho('3003'), linhaDeles));
    act(() => reemitir());
    // A re-render is not a snapshot: nothing moves until one arrives.
    expect(documents!.getBaseline(caminho('3003'))).toEqual(linhaDeles);
    emitir(linhasPadrao());
    act(() => reemitir());
    expect(documents!.getBaseline(caminho('3003'))).toBeNull();

    act(() => documents!.rebase(caminho('3003'), linhaDeles));
    emitir([...linhasPadrao(), linha('3003', linhaDeles)]);
    act(() => reemitir());
    expect(documents!.getBaseline(caminho('3003'))).toEqual(linhaDeles);
    expect(ultimaMudanca()).toBeUndefined();
  });

  it('a CACHED emission moves nothing: a deleted doc stays held as its row until server truth says so', () => {
    const { documents, reemitir } = show();
    emitir(
      linhasPadrao().filter((l) => l.id !== ID_NIKE),
      { fromCache: true },
    );
    act(() => reemitir());
    expect(documents!.getBaseline(caminho(ID_NIKE))).toEqual(legado(1001, 'Nike'));
    emitir(linhasPadrao().filter((l) => l.id !== ID_NIKE));
    act(() => reemitir());
    expect(documents!.getBaseline(caminho(ID_NIKE))).toBeNull();
  });

  it('a row at the id of a STAGED registration stays unseeded while staged ⟷ the same brand at another id, and the row once unstaged, are seeded', () => {
    const PUMA: MarcaDto = { brandId: 3003, originalBrandName: 'Puma', displayBrandName: null };
    const { documents, reemitir } = show({ inicial: { adicionar: [PUMA], remover: [] } });
    // Another operator registered Puma meanwhile — at its deterministic id —
    // and a legacy app row of it sits at an auto id.
    const deles = linha('3003', legado(3003, 'PUMA'));
    const legadaDela = linha('a0000000000000000098', legado(3003, 'Puma'));
    emitir([...linhasPadrao(), deles, legadaDela]);
    act(() => reemitir());
    expect(documents!.getBaseline(deles.path)).toBeUndefined();
    expect(documents!.getBaseline(legadaDela.path)).toEqual(legadaDela.data);
    fireEvent.click(botao('Desfazer', screen.getByTestId('shopee-marca-nova-3003')));
    expect(ultimaMudanca()).toBeNull();
    expect(documents!.getBaseline(deles.path)).toEqual(deles.data);
  });

  it('outside an ObjectView there is nothing to seed and the section is not held read-only', () => {
    show({ documents: null });
    expect(botao('Remover', linhaDaMarca(1001)).disabled).toBe(false);
  });
});

describe('after the first server snapshot, the section lists and stages from SERVER truth only (#2084 review F1)', () => {
  it('a CACHED emission that drops a brand changes nothing: listed, handed to the modal as registered, its baseline kept ⟷ the SERVER one drops it, offers it, and clears the baseline', () => {
    const { documents, reemitir } = show();
    emitir(
      linhasPadrao().filter((l) => l.id !== ID_NIKE),
      { fromCache: true },
    );
    act(() => reemitir());
    fireEvent.click(botao('Adicionar marcas'));
    expect(h.modal!.cadastradas.has(1001)).toBe(true);
    expect(h.modal!.ocupantes.has(ID_NIKE)).toBe(true);
    fireEvent.click(botao('stub fechar'));
    expect(linhaDaMarca(1001)).toBeTruthy();
    expect(documents!.getBaseline(caminho(ID_NIKE))).toEqual(legado(1001, 'Nike'));

    emitir(linhasPadrao().filter((l) => l.id !== ID_NIKE));
    act(() => reemitir());
    expect(screen.queryByTestId('shopee-marca-1001')).toBeNull();
    fireEvent.click(botao('Adicionar marcas'));
    expect(h.modal!.cadastradas.has(1001)).toBe(false);
    expect(h.modal!.ocupantes.has(ID_NIKE)).toBe(false);
    expect(documents!.getBaseline(caminho(ID_NIKE))).toBeNull();
  });

  it('NEAR-MISS: a CACHED emission showing a doc server truth has not shows nothing new and seeds nothing ⟷ the SERVER one lists it with its own baseline', () => {
    const { documents, reemitir } = show();
    const nova = linha('a0000000000000000099', legado(4004, 'Fila'));
    emitir([...linhasPadrao(), nova], { fromCache: true });
    act(() => reemitir());
    expect(screen.queryByTestId('shopee-marca-4004')).toBeNull();
    expect(documents!.getBaseline(nova.path)).toBeUndefined();
    emitir([...linhasPadrao(), nova]);
    act(() => reemitir());
    expect(within(linhaDaMarca(4004)).getByText('Fila · id 4004')).toBeTruthy();
    expect(documents!.getBaseline(nova.path)).toEqual(nova.data);
  });

  it('undoing a staged removal while the latest emission is CACHED moves the baselines by the last SERVER snapshot', () => {
    const { documents, reemitir } = show();
    fireEvent.click(botao('Remover', linhaDaMarca(1001)));
    // Server truth: another tab deleted Nike — the staged removal keeps its row.
    emitir(linhasPadrao().filter((l) => l.id !== ID_NIKE));
    act(() => reemitir());
    expect(documents!.getBaseline(caminho(ID_NIKE))).toEqual(legado(1001, 'Nike'));
    emitir(
      linhasPadrao().filter((l) => l.id !== ID_NIKE),
      { fromCache: true },
    );
    act(() => reemitir());
    fireEvent.click(botao('Desfazer', screen.getByTestId('shopee-marca-removida-fora-1001')));
    expect(ultimaMudanca()).toBeNull();
    // Held as its row, a re-add equal to it would be skipped by the save unread.
    expect(documents!.getBaseline(caminho(ID_NIKE))).toBeNull();
  });
});

describe('a staged registration held as stored EXACTLY is satisfied, and leaves the delta at once (#2084 review F2)', () => {
  const PUMA: MarcaDto = { brandId: 3003, originalBrandName: 'Puma', displayBrandName: null };
  const FILA: MarcaDto = { brandId: 4004, originalBrandName: 'Fila', displayBrandName: null };
  const linhaPuma = { brand_id: 3003, original_brand_name: 'Puma', display_brand_name: null };

  it('⭐ the registry’s rebase to the very row it writes drops it — INSIDE the rebase, before anything reads the form — and only it', () => {
    const { documents } = show({ inicial: { adicionar: [PUMA, FILA], remover: [] } });
    act(() => {
      documents!.rebase(caminho('3003'), linhaPuma);
      // Synchronous: "Salvar mesmo assim" saves right after this rebase.
      expect(ultimaMudanca()).toEqual({ adicionar: [FILA], remover: [] });
    });
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    expect(screen.getByTestId('shopee-marca-nova-4004')).toBeTruthy();
  });

  it('⭐ NEAR-MISS: a held row of the brand that differs at all — a display name, a case, one extra key — or the same row at ANOTHER id, keeps it staged', () => {
    const { documents } = show({ inicial: { adicionar: [PUMA], remover: [] } });
    for (const deles of [
      { ...linhaPuma, display_brand_name: 'Puma BR' },
      { ...linhaPuma, original_brand_name: 'PUMA' },
      { ...linhaPuma, timestamp: 1_700_000_000_000 },
    ]) {
      act(() => documents!.rebase(caminho('3003'), deles));
    }
    act(() => documents!.rebase(caminho('a0000000000000000098'), linhaPuma));
    act(() => documents!.rebase(caminho('3003'), null));
    expect(mudancas).toEqual([]);
    expect(screen.getByTestId('shopee-marca-nova-3003')).toBeTruthy();
  });

  // The drop reads the delta as the section's LATEST render has it. The click
  // below swaps the staged Puma registration for a staged removal, and the
  // seeding run that follows it in the same commit gives Puma's path its
  // listed row — the very row the old registration wrote. Read against the
  // delta of the render BEFORE the click, that rebase drops "the satisfied
  // add" from a delta that no longer holds it, and hands the form that stale
  // delta: the operator's removal vanishes with nothing said.
  it('⭐ «Remover» on a staged brand another operator registered identically stages the REMOVAL — the drop never reads the delta of an earlier render', () => {
    const { reemitir } = show({ inicial: { adicionar: [PUMA], remover: [] } });
    emitir([...linhasPadrao(), linha('3003', linhaPuma)]);
    act(() => reemitir());
    expect(screen.getByTestId('shopee-marca-nova-3003')).toBeTruthy();
    fireEvent.click(botao('Remover', linhaDaMarca(3003)));
    expect(ultimaMudanca()).toEqual({
      adicionar: [],
      remover: [{ brandId: 3003, docIds: ['3003'] }],
    });
    expect(within(linhaDaMarca(3003)).getByText('Será removida')).toBeTruthy();
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
  });

  it('NEAR-MISS: «Desfazer» on that staged registration leaves nothing staged, and the brand listed', () => {
    const { reemitir } = show({ inicial: { adicionar: [PUMA], remover: [] } });
    emitir([...linhasPadrao(), linha('3003', linhaPuma)]);
    act(() => reemitir());
    fireEvent.click(botao('Desfazer', screen.getByTestId('shopee-marca-nova-3003')));
    expect(ultimaMudanca()).toBeNull();
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    expect(within(linhaDaMarca(3003)).queryByText('Será removida')).toBeNull();
  });
});
