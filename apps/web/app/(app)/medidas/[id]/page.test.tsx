import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import {
  INTEGRACAO_TIPO,
  tabelaDeMedidasSchema,
  type EntradaTabelaShopee,
} from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import type { EscolherTabelaShopeeModalProps } from '../_components/EscolherTabelaShopeeModal';

/**
 * `/medidas/[id]` saving the Shopee tab's STAGED picks through the REAL page,
 * the REAL `ObjectView` + `saveRecord` and the REAL `MedidasShopeeManager`, over
 * an OCC FakeDb (`@delfrance/data/testing`). Reconcile L6: the pick has no
 * transaction of its own — the tabela's save writes the whole
 * `tabelasMedidasShopee` map (`pickDirty`), so #1757's baseline guard is the
 * ONLY thing between operator B's pick on conta X and operator A's concurrent
 * pick on conta Y (root CLAUDE.md rule 7, tier 3; the #824 `precos` loss).
 * The component suites stub `ObjectView`, so only this file can fail when the
 * page switches the guard off or ignores the field.
 *
 * Doubled are only the I/O edges: the doc-snapshot hook, `runTransaction`, the
 * collection handle's ref (its `get` runs the converter's soft parse), the
 * contas snapshot, the Shopee HTTP client (never answers — rows show the
 * stored label), and the modal (answers with `h.escolha`; it has its own suite).
 */

const PATH = 'tabMedi/tab-1';
type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  occ: null as unknown as import('@delfrance/data/testing').OccEngine,
  patches: [] as Record<string, unknown>[],
  snap: null as unknown,
  contas: [] as unknown[],
  escolha: null as unknown,
  toasts: [] as string[],
}));

/** The converter's read: the parsed doc, or the raw one when the parse fails (`parseSoftRead`). */
function lerComoOConversor(raw: unknown): Doc {
  const r = tabelaDeMedidasSchema.safeParse(raw);
  return (r.success ? r.data : raw) as Doc;
}

vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.occ.runTransaction(fn),
}));

vi.mock('@/lib/data/tabelaDeMedidasCollection', () => ({
  tabelaDeMedidasCollection: {
    resolvePath: () => 'tabMedi',
    ref: () => ({}),
    docRef: () => ({
      path: PATH,
      id: 'tab-1',
      get: async () => ({
        exists: () => h.docs.has(PATH),
        data: () => lerComoOConversor(structuredClone(h.docs.get(PATH))),
      }),
    }),
    converter: {},
    merge: vi.fn(),
  },
}));

vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { ref: () => ({ __col: 'integracao' }) },
}));

vi.mock('@delfrance/data', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data')>()),
  buildQuery: (base: object, cs: unknown[]) => ({ ...base, cs }),
  limit: (n: number) => ({ op: 'limit', n }),
  whereEqual: (campo: string, valor: unknown) => ({ op: 'where', campo, valor }),
}));

vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useDocSnapshot: (ref: unknown) =>
    ref == null ? { data: null, loading: false, error: undefined } : h.snap,
  useSnapshot: (q: unknown) =>
    q == null
      ? { data: undefined, loading: false, error: undefined }
      : { data: h.contas, loading: false, error: undefined },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true, loading: false }),
}));

vi.mock('@/lib/shopee/client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shopee/client')>()),
  useShopeeClient: () => ({
    categorias: () => new Promise(() => undefined),
    tabelaMedidasDetalhe: () => new Promise(() => undefined),
  }),
}));

vi.mock('../_components/EscolherTabelaShopeeModal', async (importActual) => ({
  ...(await importActual<typeof import('../_components/EscolherTabelaShopeeModal')>()),
  EscolherTabelaShopeeModal: (props: EscolherTabelaShopeeModalProps) => (
    <div data-testid="modal-stub">
      <button type="button" onClick={() => props.onConfirmar(h.escolha as EntradaTabelaShopee)}>
        stub confirmar
      </button>
    </div>
  ),
}));

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

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'tab-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
  getFirebaseStorage: () => ({}),
}));
vi.mock('@delfrance/storage', () => ({ uploadTabMediImage: vi.fn() }));
vi.mock('@/components/photo-manager/PhotoManager', () => ({ PhotoManager: () => null }));
vi.mock('../_components/MedidasMercadoLivreManager', () => ({
  MedidasMercadoLivreManager: () => null,
}));

const { default: TabelaDeMedidasPage } = await import('./page');

// ── fixtures (Shopee doc-sample ids; contas are fixture ids) ──

const CONTA = 'int-1';
const IRMA = 'int-2';
const conta = (id: string) => ({
  id,
  path: `integracao/${id}`,
  data: { nome: `Loja ${id}`, ativo: true, tipo: INTEGRACAO_TIPO.shopee },
});

const NOVA: EntradaTabelaShopee = { categoryId: 100088, size_chart_id: 700024640, name: 'Regatas' };
const CALCAS: EntradaTabelaShopee = {
  categoryId: 400055,
  size_chart_id: 700024613,
  name: 'Calças',
};

/** The odd-but-valid corpus rule 8 says can arrive: every shape is kept verbatim. */
function corpus(): Doc {
  return {
    nome: 'Camisetas',
    codigo: null,
    descricao: 'antiga',
    fotos: null,
    tabelasDeMedidasMercadoLivre: { 'ml-1': [{ id: 'ML-GUIA', estranho: true }], 'ml-2': null },
    tabelasMedidasShopee: {
      [CONTA]: [
        { categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas', extra: 'x' },
        { categoryId: '400055', size_chart_id: '700024641', name: 'Calças' },
        null,
        'x',
        { categoryId: 100087, size_chart_id: 700024641, name: '(Cópia) Camisetas' },
        { size_chart_id: 1 },
      ],
      [IRMA]: null,
      'int-sem-conta': [CALCAS],
    },
    campoLegadoDesconhecido: { a: 1 },
    ultimaModificacao: 1_700_000_000_000,
  };
}

/** Stores `raw` and serves it as the server-truth snapshot the form loads from. */
function semear(raw: Doc) {
  h.docs.set(PATH, structuredClone(raw));
  h.snap = {
    data: { id: 'tab-1', data: lerComoOConversor(structuredClone(raw)) },
    loading: false,
    error: undefined,
    fromCache: false,
  };
}

/** Another writer's save, landing AFTER this page loaded and BEFORE it saves. */
function escritaConcorrente(alterar: (doc: Doc) => void): Doc {
  const remoto = structuredClone(h.docs.get(PATH)!);
  alterar(remoto);
  h.docs.set(PATH, remoto);
  return remoto;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MantineTestProvider>
        <TabelaDeMedidasPage />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
}

async function salvar(rotulo = 'Salvar alterações') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: rotulo }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function editarDescricao(valor: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: valor } });
  });
}

async function abrirAbaShopee() {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: /Shopee/ }));
  });
}

async function adicionarNaConta(contaId: string, entrada: EntradaTabelaShopee) {
  h.escolha = entrada;
  const card = await screen.findByTestId(`shopee-medida-conta-${contaId}`);
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: 'Adicionar' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'stub confirmar' }));
  });
}

const commits = () => h.occ.txLog.filter((e) => e.phase === 'commit').length;
const shopeeGuardado = () => h.docs.get(PATH)!.tabelasMedidasShopee as Record<string, unknown>;

beforeEach(() => {
  h.docs.clear();
  h.patches.length = 0;
  h.toasts.length = 0;
  h.escolha = null;
  h.contas = [conta(CONTA), conta(IRMA)];
  h.occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      const prev = h.docs.get(path) ?? {};
      h.patches.push(structuredClone(data));
      h.docs.set(
        path,
        kind === 'update' ? { ...prev, ...structuredClone(data) } : structuredClone(data),
      );
    },
  });
});

describe('/medidas/[id] — a staged Shopee pick is written by the tabela’s save', () => {
  it('a pick writes the WHOLE map: every odd element and sibling key verbatim, the new entry = 3 keys; the ML map untouched', async () => {
    const raw = corpus();
    semear(raw);
    renderPage();
    await abrirAbaShopee();
    await adicionarNaConta(CONTA, NOVA);
    await salvar();

    expect(h.toasts).toEqual([]);
    expect(h.patches).toHaveLength(1);
    expect(Object.keys(h.patches[0]!).sort()).toEqual([
      'tabelasMedidasShopee',
      'ultimaModificacao',
    ]);
    const antes = raw.tabelasMedidasShopee as Record<string, unknown[] | null>;
    const depois = shopeeGuardado() as Record<string, unknown[] | null>;
    expect(Object.keys(depois).sort()).toEqual(Object.keys(antes).sort());
    for (const k of Object.keys(antes)) {
      if (k !== CONTA) expect(JSON.stringify(depois[k])).toBe(JSON.stringify(antes[k]));
    }
    const lista = depois[CONTA]!;
    expect(lista).toHaveLength(antes[CONTA]!.length + 1);
    antes[CONTA]!.forEach((el, i) => expect(JSON.stringify(lista[i])).toBe(JSON.stringify(el)));
    expect(lista.at(-1)).toStrictEqual(NOVA);
    expect(Object.keys(lista.at(-1) as object)).toEqual(['categoryId', 'size_chart_id', 'name']);
    expect(JSON.stringify(h.docs.get(PATH)!.tabelasDeMedidasMercadoLivre)).toBe(
      JSON.stringify(raw.tabelasDeMedidasMercadoLivre),
    );
  });

  it('a staged removal drops ONLY that element on save; no marker reaches the store', async () => {
    const raw = corpus();
    semear(raw);
    renderPage();
    await abrirAbaShopee();
    const linha = await screen.findByTestId(`shopee-medida-entrada-${CONTA}-0`);
    await act(async () => {
      fireEvent.click(within(linha).getByRole('button', { name: 'Remover' }));
    });
    await salvar();

    const orig = (raw.tabelasMedidasShopee as Record<string, unknown[]>)[CONTA]!;
    expect(JSON.stringify(shopeeGuardado()[CONTA] as unknown[])).toBe(
      JSON.stringify(orig.slice(1)),
    );
    expect(JSON.stringify(h.docs.get(PATH)).includes('_pendingDelete')).toBe(false);
  });

  it('an UNRELATED edit never writes the Shopee map (or the ML map): both stay byte-identical', async () => {
    const raw = corpus();
    semear(raw);
    renderPage();
    await abrirAbaShopee();
    await screen.findByTestId(`shopee-medida-conta-${CONTA}`);
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Dados gerais/ }));
    });
    await editarDescricao('nova');
    await salvar();

    expect(h.patches).toHaveLength(1);
    expect(Object.keys(h.patches[0]!).sort()).toEqual(['descricao', 'ultimaModificacao']);
    const guardado = h.docs.get(PATH)!;
    expect(JSON.stringify(guardado.tabelasMedidasShopee)).toBe(
      JSON.stringify(raw.tabelasMedidasShopee),
    );
    expect(JSON.stringify(guardado.tabelasDeMedidasMercadoLivre)).toBe(
      JSON.stringify(raw.tabelasDeMedidasMercadoLivre),
    );
    expect(guardado.campoLegadoDesconhecido).toEqual({ a: 1 });
  });
});

describe('/medidas/[id] — a concurrent writer is never silently overwritten (#1757, rule 7 tier 3)', () => {
  it('⭐ a SIBLING conta changed between load and save ⇒ the conflict modal; the winner is NOT overwritten', async () => {
    semear(corpus());
    renderPage();
    const remoto = escritaConcorrente((doc) => {
      (doc.tabelasMedidasShopee as Record<string, unknown>)[IRMA] = [CALCAS];
    });
    await abrirAbaShopee();
    await adicionarNaConta(CONTA, NOVA);
    await salvar();

    expect(await screen.findByText('Registro alterado')).toBeTruthy();
    expect(h.patches).toHaveLength(0);
    expect(commits()).toBe(0);
    expect(h.docs.get(PATH)).toStrictEqual(remoto);
  });

  it('the SAME conta changed between load and save ⇒ the conflict modal, nothing written', async () => {
    semear(corpus());
    renderPage();
    const remoto = escritaConcorrente((doc) => {
      (doc.tabelasMedidasShopee as Record<string, unknown[]>)[CONTA]!.splice(2, 1);
    });
    await abrirAbaShopee();
    await adicionarNaConta(CONTA, NOVA);
    await salvar();

    expect(await screen.findByText('Registro alterado')).toBeTruthy();
    expect(h.patches).toHaveLength(0);
    expect(h.docs.get(PATH)).toStrictEqual(remoto);
  });

  it('a change landing INSIDE the transaction window ⇒ the OCC retry re-reads ⇒ the conflict modal; ours never commits', async () => {
    semear(corpus());
    renderPage();
    let disparou = false;
    h.occ.beforeCommit = async () => {
      if (disparou) return;
      disparou = true;
      const mapa = structuredClone(shopeeGuardado());
      mapa[IRMA] = [];
      await h.occ.runTransaction(async (tx) => {
        tx.update({ path: PATH }, { tabelasMedidasShopee: mapa as never });
      });
    };
    await abrirAbaShopee();
    await adicionarNaConta(CONTA, NOVA);
    await salvar();

    expect(await screen.findByText('Registro alterado')).toBeTruthy();
    expect(h.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    expect(shopeeGuardado()[IRMA]).toEqual([]);
    // The competitor's write is the only one; ours never committed.
    expect(h.patches).toHaveLength(1);
    expect(Object.keys(h.patches[0]!)).toEqual(['tabelasMedidasShopee']);
  });

  it('NEAR-MISS (disjoint): the ML map changed between load and save ⇒ no conflict, the ML winner kept', async () => {
    semear(corpus());
    renderPage();
    escritaConcorrente((doc) => {
      doc.tabelasDeMedidasMercadoLivre = { 'ml-1': [{ id: 'OUTRA' }] };
    });
    await abrirAbaShopee();
    await adicionarNaConta(CONTA, NOVA);
    await salvar();

    expect(screen.queryByText('Registro alterado')).toBeNull();
    expect(h.docs.get(PATH)!.tabelasDeMedidasMercadoLivre).toEqual({ 'ml-1': [{ id: 'OUTRA' }] });
    expect((shopeeGuardado()[CONTA] as unknown[]).at(-1)).toStrictEqual(NOVA);
  });

  it('NEAR-MISS (disjoint): an unrelated edit while the Shopee map changed remotely ⇒ no conflict, the remote map kept', async () => {
    semear(corpus());
    renderPage();
    const remoto = escritaConcorrente((doc) => {
      (doc.tabelasMedidasShopee as Record<string, unknown>)[IRMA] = [NOVA];
    });
    await editarDescricao('nova');
    await salvar();

    expect(screen.queryByText('Registro alterado')).toBeNull();
    expect(h.docs.get(PATH)!.tabelasMedidasShopee).toStrictEqual(remoto.tabelasMedidasShopee);
    expect(h.docs.get(PATH)!.descricao).toBe('nova');
  });

  it('"Salvar e continuar" twice raises NO false conflict — the baseline is re-based on our own write', async () => {
    semear(corpus());
    renderPage();
    await abrirAbaShopee();
    await adicionarNaConta(CONTA, NOVA);
    await salvar('Salvar e continuar');
    await adicionarNaConta(IRMA, NOVA);
    await salvar('Salvar e continuar');

    expect(screen.queryByText('Registro alterado')).toBeNull();
    expect(h.patches).toHaveLength(2);
    expect(shopeeGuardado()[IRMA]).toStrictEqual([NOVA]);
    expect((shopeeGuardado()[CONTA] as unknown[]).at(-1)).toStrictEqual(NOVA);
  });
});

describe('/medidas/[id] — what the tab’s copy promises about an unreadable stored value', () => {
  it('a per-conta value that is not a list (lista-invalida) no longer blocks a save, and rides through it verbatim', async () => {
    const valor = { [CONTA]: 'x', [IRMA]: { a: 1 }, 'int-3': [CALCAS] };
    semear({ ...corpus(), tabelasMedidasShopee: valor });
    renderPage();
    await editarDescricao('nova');
    await salvar();

    expect(h.toasts).toEqual([]);
    expect(commits()).toBe(1);
    expect(h.docs.get(PATH)!.descricao).toBe('nova');
    expect(h.docs.get(PATH)!.tabelasMedidasShopee).toStrictEqual(valor);
  });

  it('…and a pick on ANOTHER conta of that tabela keeps the unreadable value as stored', async () => {
    semear({ ...corpus(), tabelasMedidasShopee: { [CONTA]: 'x' } });
    renderPage();
    await abrirAbaShopee();
    await adicionarNaConta(IRMA, NOVA);
    await salvar();

    expect(h.toasts).toEqual([]);
    expect(h.docs.get(PATH)!.tabelasMedidasShopee).toStrictEqual({ [CONTA]: 'x', [IRMA]: [NOVA] });
  });

  it('NEAR-MISS: a field that is not a map (campo-invalido) still blocks every save — as the tab says', async () => {
    semear({ ...corpus(), tabelasMedidasShopee: [CALCAS] });
    renderPage();
    await editarDescricao('nova');
    await salvar();

    expect(commits()).toBe(0);
    expect(h.toasts.length).toBeGreaterThan(0);
    expect(h.docs.get(PATH)!.descricao).toBe('antiga');
    await abrirAbaShopee();
    expect(
      (await screen.findAllByText(/enquanto ele existir, a tabela não pode ser salva/)).length,
    ).toBeGreaterThan(0);
  });
});
