import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import { PERM } from '@delfrance/auth';
import { integracaoSchema, marcaShopeeArmazenadaSchema, type MarcaDto } from '@delfrance/schemas';
import type { ObjectViewProps } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { AdicionarMarcasShopeeModalProps } from '../_components/AdicionarMarcasShopeeModal';

/**
 * `/canais/shopee/[id]` with its Marcas section (#1911 P9), through the REAL
 * page, the REAL `ObjectView` + `saveRecord`, the REAL Marcas section, reader
 * and delta writes, over an OCC FakeDb (`@delfrance/data/testing`).
 *
 * What only this file can show: that the conta's ONE save writes the staged
 * brand registrations and removals as guarded siblings of the conta — only
 * when something is staged, every document of a removed brand, the new row at
 * its deterministic id — and never over a change made since the section seeded
 * its baselines from server truth (root `CLAUDE.md` rule 7, tier 3).
 *
 * Doubled are only the I/O edges: the two snapshot hooks (`h.servido` is what
 * the listeners show, `h.docs` what the store holds — they differ exactly when
 * a test says another writer moved the store), `runTransaction`, the two
 * collection handles (their `get` runs the converter's soft parse), and the
 * unrelated pickers and panels. The add modal is a stub (its own suite) that
 * stages `h.adicionar` (usually {@link PUMA}) minus the brands it is handed as
 * already registered or already selected — the real modal refuses those.
 *
 * The shortlist listener emits as server truth unless `h.colecaoEmCache` says
 * the emission came FROM CACHE (a remote change Watch delivered before
 * CURRENT), and hands back one state per emission, as the real hook does.
 */

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  servido: new Map<string, { raw: Record<string, unknown>; fromCache: boolean }>(),
  occ: null as unknown as import('@delfrance/data/testing').OccEngine,
  ler: (_path: string, raw: Record<string, unknown>): Record<string, unknown> => raw,
  permissoes: 0n,
  replace: vi.fn(),
  toasts: [] as string[],
  props: null as ObjectViewProps<never> | null,
  adicionar: [] as unknown[],
  /** The add modal's props, as last rendered. */
  modal: null as AdicionarMarcasShopeeModalProps | null,
  /** The shortlist listener's next emissions come FROM CACHE. */
  colecaoEmCache: false,
}));

function refFalso(path: string) {
  const ref = {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => ({
      exists: () => h.docs.has(path),
      data: () => h.ler(path, structuredClone(h.docs.get(path)!)),
    }),
    withConverter: () => ref,
  };
  return ref;
}

vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: {
    resolvePath: () => 'integracao',
    ref: () => ({ __col: 'integracao' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => refFalso(`integracao/${id}`),
    converter: {},
    merge: vi.fn(),
  },
}));
vi.mock('@/lib/data/marcaShopeeCollection', () => ({
  marcaShopeeCollection: {
    ref: (_db: unknown, ctx: { integracaoId: string }) => ({
      __col: `integracao/${ctx.integracaoId}/brandshopee`,
    }),
    docRef: (_db: unknown, ctx: { integracaoId: string }, id: string) =>
      refFalso(`integracao/${ctx.integracaoId}/brandshopee/${id}`),
  },
}));

vi.mock('@delfrance/data', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data')>()),
  buildQuery: (base: object, cs: unknown[]) => ({ ...base, cs }),
  limit: (n: number) => ({ limit: n }),
}));

vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useDocSnapshot: (ref: { path: string } | null) => {
    const servido = ref == null ? undefined : h.servido.get(ref.path);
    if (ref == null || servido === undefined)
      return { data: undefined, loading: ref != null, error: undefined };
    return {
      data: {
        id: ref.path.slice(ref.path.lastIndexOf('/') + 1),
        data: h.ler(ref.path, structuredClone(servido.raw)),
      },
      loading: false,
      error: undefined,
      fromCache: servido.fromCache,
      hasPendingWrites: false,
      documentPath: ref.path,
    };
  },
  useSnapshot: (() => {
    // One state per EMISSION, as the real hook holds it (set once per
    // snapshot): a re-render that is not an emission hands back the SAME
    // object, so nothing downstream can ride a fresh one.
    const vazio = { data: [], loading: false, error: undefined };
    const ultimos = new Map<string, { chave: string; estado: unknown }>();
    return (q: { __col?: string } | null) => {
      const col = q?.__col;
      if (col === undefined) return vazio;
      const linhas = [...h.servido.entries()]
        .filter(([path]) => path.startsWith(`${col}/`))
        .map(([path, s]) => ({
          id: path.slice(path.lastIndexOf('/') + 1),
          path,
          data: h.ler(path, structuredClone(s.raw)),
        }));
      const estado = {
        data: linhas,
        loading: false,
        error: undefined,
        fromCache: h.colecaoEmCache,
        hasPendingWrites: false,
      };
      const chave = JSON.stringify(estado);
      const ultimo = ultimos.get(col);
      if (ultimo?.chave === chave) return ultimo.estado;
      ultimos.set(col, { chave, estado });
      return estado;
    };
  })(),
}));

vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.occ.runTransaction(fn),
  deleteDoc: vi.fn(),
}));

vi.mock('@delfrance/ui', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/ui')>();
  return {
    ...actual,
    // The REAL ObjectView, its props recorded for the wiring assertions.
    ObjectView: (props: ObjectViewProps<never>) => {
      h.props = props;
      return <actual.ObjectView {...props} />;
    },
  };
});

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: (bit: bigint) => ({ allowed: (h.permissoes & bit) === bit, loading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'conta-1' }),
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/app/(app)/canais/shopee/_components/ContaShopeePanel', () => ({
  ContaShopeePanel: () => null,
}));
vi.mock('@/app/(app)/canais/_components/RecalcularPrecosCanalAction', () => ({
  RecalcularPrecosCanalAction: () => null,
}));
vi.mock('@/app/(app)/canais/shopee/_components/AdicionarMarcasShopeeModal', () => ({
  AdicionarMarcasShopeeModal: (props: AdicionarMarcasShopeeModalProps) => {
    h.modal = props;
    const oferecidas = (h.adicionar as MarcaDto[]).filter(
      (m) => !props.cadastradas.has(m.brandId) && !props.jaSelecionadas.has(m.brandId),
    );
    return (
      <button type="button" onClick={() => props.onAdicionar(oferecidas)}>
        stub adicionar
      </button>
    );
  },
}));
vi.mock('@/components/pickers/FilialPicker', () => ({ filialRefRenderInput: () => () => null }));
vi.mock('@/components/collection-select/refRenderInput', () => ({
  refRenderInput: () => () => null,
}));
vi.mock('@/components/inputs/CorInput', () => ({ CorInput: () => null }));
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

const { default: ContaShopeePage } = await import('./page');

const CONTA_PATH = 'integracao/conta-1';
const marcaPath = (id: string) => `integracao/conta-1/brandshopee/${id}`;

/** The client converters' soft read: the parsed doc, or the raw one when the parse fails. */
h.ler = (path, raw) => {
  const r = (
    path.includes('/brandshopee/') ? marcaShopeeArmazenadaSchema : integracaoSchema
  ).safeParse(raw);
  return (r.success ? r.data : raw) as Doc;
};

/** Legacy auto ids, as the Flutter app wrote them. */
const ID_NIKE = 'a0000000000000000001';
const ID_ADIDAS_1 = 'a0000000000000000002';
const ID_ADIDAS_2 = 'a0000000000000000003';
const legado = (brand_id: number, original_brand_name: string): Doc => ({
  brand_id,
  original_brand_name,
  display_brand_name: null,
});
const PUMA: MarcaDto = { brandId: 3003, originalBrandName: 'Puma', displayBrandName: null };

function conta(): Doc {
  return {
    tipo: 5,
    nome: 'Loja Shopee',
    padrao: false,
    ativo: true,
    shop_id: 987654,
    dataCadastro: 1_700_000_000_000,
    ultimaModificacao: 1_700_000_000_000,
  };
}

/** Store `raw` and serve it to the listeners as server truth. */
function semear(path: string, raw: Doc) {
  h.docs.set(path, structuredClone(raw));
  h.servido.set(path, { raw: structuredClone(raw), fromCache: false });
}

/** Another writer's commit after this page loaded; `listener: false` = not yet seen here. */
function escritaConcorrente(path: string, raw: Doc | null, { listener = true } = {}) {
  if (raw === null) h.docs.delete(path);
  else h.docs.set(path, structuredClone(raw));
  if (!listener) return;
  if (raw === null) h.servido.delete(path);
  else h.servido.set(path, { raw: structuredClone(raw), fromCache: false });
}

/** The listeners catch up with the store — this page's own commit included — as server truth. */
function ecoDoListener() {
  for (const path of [...h.servido.keys()]) {
    if (path.includes('/brandshopee/') && !h.docs.has(path)) h.servido.delete(path);
  }
  for (const [path, raw] of h.docs) {
    if (path.includes('/brandshopee/'))
      h.servido.set(path, { raw: structuredClone(raw), fromCache: false });
  }
}

let rerenderPage: () => void = () => undefined;
async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = () => (
    <QueryClientProvider client={qc}>
      <MantineTestProvider>
        <ContaShopeePage />
      </MantineTestProvider>
    </QueryClientProvider>
  );
  const view = render(arvore());
  rerenderPage = () => view.rerender(arvore());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function clicar(nome: string, dentro?: HTMLElement) {
  await act(async () => {
    fireEvent.click((dentro ? within(dentro) : screen).getByRole('button', { name: nome }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function salvar(rotulo: 'Salvar alterações' | 'Salvar e continuar' = 'Salvar e continuar') {
  await clicar(rotulo);
}

async function abrirAba(nome: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: nome }));
  });
}

async function adicionarPuma() {
  h.adicionar = [PUMA];
  await clicar('Adicionar marcas');
  await clicar('stub adicionar');
}

const linhaDaMarca = (brandId: number) => screen.getByTestId(`shopee-marca-${String(brandId)}`);
const commits = () => h.occ.txLog.filter((e) => e.phase === 'commit').length;
const conflito = () => screen.queryByText('Registro alterado');
const saidaBloqueada = () => {
  const ev = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
};
/** Every write a committed transaction applied, in order. */
const escritas: string[] = [];

beforeEach(() => {
  h.permissoes = PERM.integracao.write | PERM.integracao.delete;
  h.docs.clear();
  h.servido.clear();
  h.toasts.length = 0;
  h.replace.mockReset();
  h.props = null;
  h.adicionar = [];
  h.modal = null;
  h.colecaoEmCache = false;
  escritas.length = 0;
  semear(CONTA_PATH, conta());
  semear(marcaPath(ID_NIKE), legado(1001, 'Nike'));
  semear(marcaPath(ID_ADIDAS_1), legado(1002, 'Adidas'));
  semear(marcaPath(ID_ADIDAS_2), legado(1002, ''));
  h.occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      escritas.push(`${kind} ${path}`);
      const prev = h.docs.get(path) ?? {};
      h.docs.set(
        path,
        kind === 'update' ? { ...prev, ...structuredClone(data) } : structuredClone(data),
      );
    },
    applyDelete: (path) => {
      escritas.push(`delete ${path}`);
      h.docs.delete(path);
    },
  });
});

describe('/canais/shopee/[id] — the Marcas section rides the conta’s save', () => {
  it('two tabs, Marcas kept mounted, and the delta a TRANSIENT key defaulting to null', async () => {
    await renderPage();
    for (const aba of ['Dados gerais', 'Marcas']) {
      expect(screen.getByRole('tab', { name: aba })).toBeTruthy();
    }
    const props = h.props!;
    expect(props.sections).toEqual(['Dados gerais', 'Marcas']);
    expect(props.persistentSections).toEqual(['Marcas']);
    expect(props.transientFields).toEqual(['marcasShopee']);
    const schema = props.schema as unknown as typeof integracaoSchema;
    expect((schema.parse(conta()) as Doc).marcasShopee).toBeNull();
    // The conta's own fields stay on the first tab; the Marcas field on its own.
    expect(props.fields?.marcasShopee?.section).toBe('Marcas');
    expect(props.fields?.nome?.section).toBeUndefined();
  });

  it('a registration writes ONLY the new row, at String(brand_id), and leaves the conta untouched', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`set ${marcaPath('3003')}`]);
    expect(h.docs.get(marcaPath('3003'))).toEqual({
      brand_id: 3003,
      original_brand_name: 'Puma',
      display_brand_name: null,
    });
    // The delta is transient: never a key of the conta, whose stamp did not move.
    expect(h.docs.get(CONTA_PATH)).toEqual(conta());
    expect(h.toasts).toEqual(['Salvo.']);
  });

  it('removing a brand stored as two legacy docs deletes BOTH; the untouched row is byte-identical', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(1002));
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas.sort()).toEqual(
      [`delete ${marcaPath(ID_ADIDAS_1)}`, `delete ${marcaPath(ID_ADIDAS_2)}`].sort(),
    );
    expect(h.docs.has(marcaPath(ID_ADIDAS_1))).toBe(false);
    expect(h.docs.has(marcaPath(ID_ADIDAS_2))).toBe(false);
    expect(h.docs.get(marcaPath(ID_NIKE))).toEqual(legado(1001, 'Nike'));
  });

  it('a save with nothing staged writes nothing', async () => {
    await renderPage();
    await salvar();
    expect(commits()).toBe(0);
    expect(h.toasts).toEqual(['Nenhuma alteração para salvar']);
  });

  it('a conta field and a staged brand commit together, in ONE transaction', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Loja renomeada' } });
    });
    await abrirAba('Marcas');
    await adicionarPuma();
    await salvar('Salvar alterações');
    expect(commits()).toBe(1);
    expect(h.docs.get(CONTA_PATH)?.nome).toBe('Loja renomeada');
    expect(h.docs.get(CONTA_PATH)).not.toHaveProperty('marcasShopee');
    expect(h.docs.has(marcaPath('3003'))).toBe(true);
    expect(h.replace).toHaveBeenCalledWith('/canais/shopee');
  });

  it('the seed is not an edit: a loaded conta does not arm the leave guard; staging does; undoing it disarms it', async () => {
    await renderPage();
    expect(saidaBloqueada()).toBe(false);
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(1001));
    expect(saidaBloqueada()).toBe(true);
    await clicar('Desfazer', linhaDaMarca(1001));
    expect(saidaBloqueada()).toBe(false);
  });

  it('after a commit the delta is gone: nothing staged on screen, and the next save writes nothing', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    await clicar('Remover', linhaDaMarca(1001));
    await salvar();
    expect(commits()).toBe(1);
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
    await salvar();
    expect(commits()).toBe(1);
    expect(h.toasts.at(-1)).toBe('Nenhuma alteração para salvar');
  });

  it('no Remover without PERM.integracao.delete; a registration still saves on the write bit alone', async () => {
    h.permissoes = PERM.integracao.write;
    await renderPage();
    await abrirAba('Marcas');
    expect(within(linhaDaMarca(1001)).queryByRole('button', { name: 'Remover' })).toBeNull();
    expect(screen.getByTestId('shopee-marcas-sem-permissao-remover')).toBeTruthy();
    await adicionarPuma();
    await salvar();
    expect(commits()).toBe(1);
    expect(h.docs.has(marcaPath('3003'))).toBe(true);
  });
});

describe('every write can lose a race: the save conflicts, and writes NOTHING', () => {
  it('another operator registered the same brand meanwhile ⇒ conflict; their row survives; reload drops the stage', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    const deles = { brand_id: 3003, original_brand_name: 'PUMA', display_brand_name: 'Puma BR' };
    escritaConcorrente(marcaPath('3003'), deles, { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(h.docs.get(marcaPath('3003'))).toEqual(deles);
    await clicar('Recarregar do servidor');
    expect(conflito()).toBeNull();
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
  });

  it('…and the SAME race with their row already on this screen is still the conflict, never an overwrite', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    const deles = { brand_id: 3003, original_brand_name: 'PUMA', display_brand_name: 'Puma BR' };
    // The listener shows their row BEFORE this save: a baseline seeded for it
    // would let the registration's `set` overwrite it unguarded.
    escritaConcorrente(marcaPath('3003'), deles);
    await act(async () => rerenderPage());
    expect(
      within(screen.getByTestId('shopee-marca-nova-3003')).getByText(
        'já consta na lista — desfaça esta adição',
      ),
    ).toBeTruthy();
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(h.docs.get(marcaPath('3003'))).toEqual(deles);
    // "Recarregar" drops the stage; their row is now an ordinary, guarded one.
    await clicar('Recarregar do servidor');
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    await clicar('Remover', linhaDaMarca(3003));
    await salvar();
    expect(conflito()).toBeNull();
    expect(escritas).toEqual([`delete ${marcaPath('3003')}`]);
  });

  it('«Salvar mesmo assim» on that conflict is the operator’s explicit overwrite — and it commits, no loop', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    escritaConcorrente(marcaPath('3003'), {
      brand_id: 3003,
      original_brand_name: 'PUMA',
      display_brand_name: 'Puma BR',
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(h.docs.get(marcaPath('3003'))).toEqual({
      brand_id: 3003,
      original_brand_name: 'Puma',
      display_brand_name: null,
    });
  });

  it('a doc staged for removal changed meanwhile ⇒ conflict, NEITHER doc of the brand deleted', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(1002));
    escritaConcorrente(marcaPath(ID_ADIDAS_2), legado(1002, 'adidas'));
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(h.docs.has(marcaPath(ID_ADIDAS_1))).toBe(true);
    expect(h.docs.get(marcaPath(ID_ADIDAS_2))).toEqual(legado(1002, 'adidas'));
  });

  it('a doc staged for removal deleted meanwhile ⇒ conflict, nothing written', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(1002));
    escritaConcorrente(marcaPath(ID_ADIDAS_1), null, { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(h.docs.has(marcaPath(ID_ADIDAS_2))).toBe(true);
  });

  it('a re-registration at ANOTHER id meanwhile survives the removal — the safe direction', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(1001));
    // Another operator registered Nike again, at its deterministic id; this page sees it.
    escritaConcorrente(marcaPath('1001'), legado(1001, 'Nike'));
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeNull();
    expect(escritas).toEqual([`delete ${marcaPath(ID_NIKE)}`]);
    expect(h.docs.get(marcaPath('1001'))).toEqual(legado(1001, 'Nike'));
  });

  it('a doc staged for removal that the listener SHOWS deleted meanwhile is still the conflict — the brand’s other doc survives', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(1002));
    // Seen here this time: the staged removal still names it, so its seed is
    // kept — cleared, the `delete` of the gone doc would be skipped and the
    // save would delete HALF of the brand without a word.
    escritaConcorrente(marcaPath(ID_ADIDAS_1), null);
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(h.docs.get(marcaPath(ID_ADIDAS_2))).toEqual(legado(1002, ''));
  });

  it('a row another operator added after the first seed gets its OWN baseline: removing it is guarded too', async () => {
    await renderPage();
    await abrirAba('Marcas');
    const nova = 'a0000000000000000099';
    escritaConcorrente(marcaPath(nova), legado(4004, 'Fila'));
    await act(async () => rerenderPage());
    await clicar('Remover', linhaDaMarca(4004));
    // …and changed again before this save: the baseline it got is the one seen.
    escritaConcorrente(marcaPath(nova), legado(4004, 'FILA'), { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(h.docs.get(marcaPath(nova))).toEqual(legado(4004, 'FILA'));
  });
});

describe('a doc this page seeded and another tab deleted or re-created: the write lands or conflicts, NEVER dropped', () => {
  /** A NEW-style row, exactly what this section's registration of {@link PUMA} writes. */
  const linhaPuma = (display_brand_name: string | null = null): Doc => ({
    brand_id: 3003,
    original_brand_name: 'Puma',
    display_brand_name,
  });

  /** Puma at its deterministic id, seeded here, then removed in another tab — and seen here. */
  async function pumaSemeadaERemovidaEmOutraAba(display: string | null = null) {
    semear(marcaPath('3003'), linhaPuma(display));
    await renderPage();
    await abrirAba('Marcas');
    expect(linhaDaMarca(3003)).toBeTruthy();
    escritaConcorrente(marcaPath('3003'), null);
    await act(async () => rerenderPage());
    expect(screen.queryByTestId('shopee-marca-3003')).toBeNull();
  }

  it('(A) re-adding it, brand only, WRITES the row — never «Nenhuma alteração» over a dirty form', async () => {
    await pumaSemeadaERemovidaEmOutraAba();
    await adicionarPuma();
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`set ${marcaPath('3003')}`]);
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma());
    expect(h.toasts).toEqual(['Salvo.']);
    expect(saidaBloqueada()).toBe(false);
  });

  it('(B) …and with a conta field, «Salvar alterações» commits BOTH — never the conta alone before leaving', async () => {
    await pumaSemeadaERemovidaEmOutraAba();
    await abrirAba('Dados gerais');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Loja renomeada' } });
    });
    await abrirAba('Marcas');
    await adicionarPuma();
    await salvar('Salvar alterações');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect([...escritas].sort()).toEqual(
      [`set ${marcaPath('3003')}`, `update ${CONTA_PATH}`].sort(),
    );
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma());
    expect(h.docs.get(CONTA_PATH)?.nome).toBe('Loja renomeada');
    expect(h.replace).toHaveBeenCalledWith('/canais/shopee');
  });

  it('near-miss: a stale seed that DIFFERS from the row (a display name) decides nothing — also written', async () => {
    // Before the fix this twin of (A) was the only one that conflicted: the
    // outcome hung on whether the stale seed happened to equal the new row.
    await pumaSemeadaERemovidaEmOutraAba('Puma BR');
    await adicionarPuma();
    await salvar();
    expect(conflito()).toBeNull();
    expect(escritas).toEqual([`set ${marcaPath('3003')}`]);
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma());
  });

  it('near-miss: their row coming BACK before this save (seen here) is the conflict, never an overwrite', async () => {
    await pumaSemeadaERemovidaEmOutraAba();
    await adicionarPuma();
    const deles = { brand_id: 3003, original_brand_name: 'PUMA', display_brand_name: 'Puma BR' };
    escritaConcorrente(marcaPath('3003'), deles);
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(h.docs.get(marcaPath('3003'))).toEqual(deles);
  });

  it('«Salvar mesmo assim» before this page sees their row (listener behind) still commits — no loop', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    escritaConcorrente(
      marcaPath('3003'),
      { brand_id: 3003, original_brand_name: 'PUMA', display_brand_name: 'Puma BR' },
      { listener: false },
    );
    await salvar();
    expect(conflito()).toBeTruthy();
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma());
  });

  /** Puma removed HERE by «Salvar e continuar», then registered again by another tab — both seen here. */
  async function pumaRemovidaAquiERecriadaEmOutraAba() {
    semear(marcaPath('3003'), linhaPuma());
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(3003));
    await salvar();
    expect(escritas).toEqual([`delete ${marcaPath('3003')}`]);
    ecoDoListener();
    await act(async () => rerenderPage());
    expect(screen.queryByTestId('shopee-marca-3003')).toBeNull();
    escritas.length = 0;
    escritaConcorrente(marcaPath('3003'), linhaPuma());
    await act(async () => rerenderPage());
    expect(linhaDaMarca(3003)).toBeTruthy();
  }

  it('(C) removing it AGAIN deletes it — the committed delete’s «absent» baseline never skips the new doc', async () => {
    await pumaRemovidaAquiERecriadaEmOutraAba();
    await clicar('Remover', linhaDaMarca(3003));
    await salvar();
    expect(conflito()).toBeNull();
    expect(escritas).toEqual([`delete ${marcaPath('3003')}`]);
    expect(h.docs.has(marcaPath('3003'))).toBe(false);
  });

  it('(C′) …and with a conta field, «Salvar alterações» deletes it too — never the conta alone', async () => {
    await pumaRemovidaAquiERecriadaEmOutraAba();
    await clicar('Remover', linhaDaMarca(3003));
    await abrirAba('Dados gerais');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Loja renomeada' } });
    });
    await salvar('Salvar alterações');
    expect(conflito()).toBeNull();
    expect([...escritas].sort()).toEqual(
      [`delete ${marcaPath('3003')}`, `update ${CONTA_PATH}`].sort(),
    );
    expect(h.docs.has(marcaPath('3003'))).toBe(false);
  });

  it('near-miss: the re-created doc changed AGAIN before the removal (not seen) is the conflict, nothing deleted', async () => {
    await pumaRemovidaAquiERecriadaEmOutraAba();
    await clicar('Remover', linhaDaMarca(3003));
    escritaConcorrente(marcaPath('3003'), linhaPuma('Puma BR'), { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(1);
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma('Puma BR'));
  });
});

describe('a CACHED emission after the first server snapshot: nothing is staged from it (#2084 review F1)', () => {
  /** A NEW-style row, exactly what this section's registration of {@link PUMA} writes. */
  const linhaPuma = (display_brand_name: string | null = null): Doc => ({
    brand_id: 3003,
    original_brand_name: 'Puma',
    display_brand_name,
  });

  /**
   * Puma at its deterministic id, seeded here from server truth; then another
   * tab deletes it, and this page's listener delivers that FROM CACHE (Watch
   * sent the delete before CURRENT).
   */
  async function pumaRemovidaVistaSoDoCache() {
    semear(marcaPath('3003'), linhaPuma());
    await renderPage();
    await abrirAba('Marcas');
    expect(linhaDaMarca(3003)).toBeTruthy();
    h.colecaoEmCache = true;
    escritaConcorrente(marcaPath('3003'), null);
    await act(async () => rerenderPage());
  }

  it('one that drops a seeded brand leaves it listed and registered: the modal refuses it, nothing is staged — never a re-add the save would skip', async () => {
    await pumaRemovidaVistaSoDoCache();
    // The modal and the list still read the last SERVER truth — the one the
    // save baselines hold — so the brand is not offered while its baseline is
    // still its row (a re-add equal to it would be skipped unread).
    await adicionarPuma();
    expect(h.modal?.cadastradas.has(3003)).toBe(true);
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
    expect(linhaDaMarca(3003)).toBeTruthy();
  });

  it('near-miss: SERVER truth of the same deletion offers it again, and the re-add is WRITTEN with a conta field in ONE commit', async () => {
    await pumaRemovidaVistaSoDoCache();
    h.colecaoEmCache = false;
    await act(async () => rerenderPage());
    expect(screen.queryByTestId('shopee-marca-3003')).toBeNull();
    await abrirAba('Dados gerais');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Loja renomeada' } });
    });
    await abrirAba('Marcas');
    await adicionarPuma();
    expect(h.modal?.cadastradas.has(3003)).toBe(false);
    expect(screen.getByTestId('shopee-marca-nova-3003')).toBeTruthy();
    await salvar('Salvar alterações');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect([...escritas].sort()).toEqual(
      [`set ${marcaPath('3003')}`, `update ${CONTA_PATH}`].sort(),
    );
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma());
    expect(h.replace).toHaveBeenCalledWith('/canais/shopee');
  });

  it('near-miss: a cached emission that changes nothing changes nothing here — Remover still deletes the brand, guarded', async () => {
    semear(marcaPath('3003'), linhaPuma());
    await renderPage();
    await abrirAba('Marcas');
    h.colecaoEmCache = true;
    await act(async () => rerenderPage());
    await clicar('Remover', linhaDaMarca(3003));
    await salvar();
    expect(conflito()).toBeNull();
    expect(escritas).toEqual([`delete ${marcaPath('3003')}`]);
    expect(h.docs.has(marcaPath('3003'))).toBe(false);
  });

  it('the removal mirror: a doc re-created where this page deleted one, seen only FROM CACHE, is not offered for removal — server truth then lets the removal delete it', async () => {
    semear(marcaPath('3003'), linhaPuma());
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(3003));
    await salvar();
    expect(escritas).toEqual([`delete ${marcaPath('3003')}`]);
    ecoDoListener();
    await act(async () => rerenderPage());
    escritas.length = 0;
    // Another tab registers it again; this page hears it from cache first.
    h.colecaoEmCache = true;
    escritaConcorrente(marcaPath('3003'), linhaPuma());
    await act(async () => rerenderPage());
    // Held "absent" (this page's own delete), a removal of it would be skipped unread.
    expect(screen.queryByTestId('shopee-marca-3003')).toBeNull();
    h.colecaoEmCache = false;
    await act(async () => rerenderPage());
    await clicar('Remover', linhaDaMarca(3003));
    await salvar();
    expect(conflito()).toBeNull();
    expect(escritas).toEqual([`delete ${marcaPath('3003')}`]);
    expect(h.docs.has(marcaPath('3003'))).toBe(false);
  });
});

describe('«Salvar mesmo assim» over a row IDENTICAL to the staged registration: it is satisfied, and leaves the stage (#2084 review F2)', () => {
  const linhaPuma = (display_brand_name: string | null = null): Doc => ({
    brand_id: 3003,
    original_brand_name: 'Puma',
    display_brand_name,
  });
  const FILA: MarcaDto = { brandId: 4004, originalBrandName: 'Fila', displayBrandName: null };

  it('brand only: nothing to write, and the form comes back pristine — never «Nenhuma alteração para salvar» over a staged add', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    // Another operator registered the same brand with the same names; not yet seen here.
    escritaConcorrente(marcaPath('3003'), linhaPuma(), { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    // Theirs IS ours: there is nothing left to write.
    expect(commits()).toBe(0);
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma());
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
    // The listener catches up: their row is listed, and nothing is staged.
    ecoDoListener();
    await act(async () => rerenderPage());
    expect(linhaDaMarca(3003)).toBeTruthy();
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
  });

  it('with a conta field, «Salvar e continuar» commits the conta ALONE and leaves no staged add behind in the reset form', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Loja renomeada' } });
    });
    await abrirAba('Marcas');
    await adicionarPuma();
    // Seen here this time: their row is already listed when this page saves.
    escritaConcorrente(marcaPath('3003'), linhaPuma());
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`update ${CONTA_PATH}`]);
    expect(h.docs.get(CONTA_PATH)?.nome).toBe('Loja renomeada');
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma());
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
    expect(h.toasts.at(-1)).toBe('Salvo.');
  });

  it('near-miss: their row differs from ours by the display name alone — «Salvar mesmo assim» still WRITES ours, never cleared as satisfied', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    escritaConcorrente(marcaPath('3003'), linhaPuma('Puma BR'), { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`set ${marcaPath('3003')}`]);
    expect(h.docs.get(marcaPath('3003'))).toEqual(linhaPuma());
    expect(saidaBloqueada()).toBe(false);
  });

  it('near-miss: only the satisfied registration leaves — another staged beside it is WRITTEN by the same save', async () => {
    await renderPage();
    await abrirAba('Marcas');
    h.adicionar = [PUMA, FILA];
    await clicar('Adicionar marcas');
    await clicar('stub adicionar');
    escritaConcorrente(marcaPath('3003'), linhaPuma(), { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`set ${marcaPath('4004')}`]);
    expect(h.docs.get(marcaPath('4004'))).toEqual({
      brand_id: 4004,
      original_brand_name: 'Fila',
      display_brand_name: null,
    });
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    expect(screen.queryByTestId('shopee-marca-nova-4004')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
  });
});

describe('«Salvar mesmo assim» over a staged removal whose document another tab already deleted: it is done, and leaves the stage (#2084 review, the removal mirror of F2)', () => {
  /** Remover on `brandId`, then another tab deletes `docId` — not yet seen here. */
  async function removidaAquiEApagadaEmOutraAba(brandId: number, docId: string) {
    await clicar('Remover', linhaDaMarca(brandId));
    escritaConcorrente(marcaPath(docId), null, { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
  }

  it('brand only: nothing to write, and the form comes back pristine — never «Nenhuma alteração para salvar» over a staged removal', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await removidaAquiEApagadaEmOutraAba(1001, ID_NIKE);
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    // The other tab's delete IS ours: there is nothing left to write.
    expect(commits()).toBe(0);
    expect(h.docs.has(marcaPath(ID_NIKE))).toBe(false);
    expect(within(linhaDaMarca(1001)).queryByText('Será removida')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
    // The listener catches up: the brand is gone, and nothing is staged.
    ecoDoListener();
    await act(async () => rerenderPage());
    expect(screen.queryByTestId('shopee-marca-1001')).toBeNull();
    expect(screen.queryByTestId('shopee-marca-removida-fora-1001')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
  });

  it('with a conta field, «Salvar e continuar» commits the conta ALONE and leaves no staged removal behind in the reset form', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Loja renomeada' } });
    });
    await abrirAba('Marcas');
    await removidaAquiEApagadaEmOutraAba(1001, ID_NIKE);
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`update ${CONTA_PATH}`]);
    expect(h.docs.get(CONTA_PATH)?.nome).toBe('Loja renomeada');
    expect(h.docs.has(marcaPath(ID_NIKE))).toBe(false);
    expect(within(linhaDaMarca(1001)).queryByText('Será removida')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
    expect(h.toasts.at(-1)).toBe('Salvo.');
    // The reset form holds no removal: the next save has nothing to write.
    await salvar();
    expect(commits()).toBe(1);
    expect(h.toasts.at(-1)).toBe('Nenhuma alteração para salvar');
  });

  it('the listener SHOWS the delete first («não está mais na lista»): that line goes with «Salvar mesmo assim», and the form is pristine', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(1001));
    escritaConcorrente(marcaPath(ID_NIKE), null);
    await act(async () => rerenderPage());
    expect(screen.getByTestId('shopee-marca-removida-fora-1001')).toBeTruthy();
    // Still the conflict: the staged removal keeps its seed until accepted.
    await salvar();
    expect(conflito()).toBeTruthy();
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(0);
    expect(screen.queryByTestId('shopee-marca-removida-fora-1001')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
  });

  it('⭐ NEAR-MISS: a brand of TWO docs with only ONE deleted is not done — «Salvar mesmo assim» deletes the other, and the brand goes', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await removidaAquiEApagadaEmOutraAba(1002, ID_ADIDAS_1);
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`delete ${marcaPath(ID_ADIDAS_2)}`]);
    expect(h.docs.has(marcaPath(ID_ADIDAS_1))).toBe(false);
    expect(h.docs.has(marcaPath(ID_ADIDAS_2))).toBe(false);
    expect(h.docs.get(marcaPath(ID_NIKE))).toEqual(legado(1001, 'Nike'));
    expect(saidaBloqueada()).toBe(false);
  });

  it('NEAR-MISS: the doc CHANGED meanwhile, not deleted — «Salvar mesmo assim» WRITES the delete', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await clicar('Remover', linhaDaMarca(1001));
    escritaConcorrente(marcaPath(ID_NIKE), legado(1001, 'NIKE'), { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`delete ${marcaPath(ID_NIKE)}`]);
    expect(h.docs.has(marcaPath(ID_NIKE))).toBe(false);
    expect(saidaBloqueada()).toBe(false);
  });

  it('NEAR-MISS: a registration staged beside the done removal is WRITTEN by the same save', async () => {
    await renderPage();
    await abrirAba('Marcas');
    await adicionarPuma();
    await removidaAquiEApagadaEmOutraAba(1001, ID_NIKE);
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([`set ${marcaPath('3003')}`]);
    expect(h.docs.get(marcaPath('3003'))).toEqual({
      brand_id: 3003,
      original_brand_name: 'Puma',
      display_brand_name: null,
    });
    expect(screen.queryByTestId('shopee-marca-nova-3003')).toBeNull();
    expect(within(linhaDaMarca(1001)).queryByText('Será removida')).toBeNull();
    expect(saidaBloqueada()).toBe(false);
  });
});
