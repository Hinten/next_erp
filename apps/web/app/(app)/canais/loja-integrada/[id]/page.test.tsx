import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import { PERM } from '@delfrance/auth';
import { intFreteSchema, integracaoSchema } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * `/canais/loja-integrada/[id]` with its two freight tabs (step 20, #1826),
 * through the REAL page, the REAL `ObjectView` + `saveRecord`, the REAL
 * managers and the REAL seed, over an OCC FakeDb (`@delfrance/data/testing`).
 *
 * What only this file can show: that the conta's ONE save writes the freight
 * doc as a guarded sibling — only when a tab changed, only the changed field,
 * and never over a change made since the tabs were seeded from server truth
 * (root `CLAUDE.md` rule 7, tier 3).
 *
 * Doubled are only the I/O edges: the two snapshot hooks (`h.servido` is what
 * the listeners show, `h.docs` what the store holds — they differ exactly when
 * a test says another writer moved the store), `runTransaction`, the two
 * collection handles (their `get` runs the converter's soft parse), the target
 * list read, the Melhor Envio client, and the unrelated pickers and panels.
 */

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  servido: new Map<string, { raw: Record<string, unknown>; fromCache: boolean }>(),
  consultaDoCache: false,
  occ: null as unknown as import('@delfrance/data/testing').OccEngine,
  ler: (_path: string, raw: Record<string, unknown>): Record<string, unknown> => raw,
  alvos: [] as { id: string; data: Record<string, unknown> }[],
  /** How many times the target list was read (`getDocs`). */
  leiturasAlvos: 0,
  permissoes: 0n,
  replace: vi.fn(),
  toasts: [] as string[],
  /** The Melhor Envio service list read (never answers: the select stays loading). */
  servicos: vi.fn((_intFreteId: string) => new Promise<never>(() => undefined)),
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
vi.mock('@/lib/data/intFreteCollection', () => ({
  intFreteCollection: {
    ref: () => ({ withConverter: () => ({ __col: 'int_frete' }) }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => refFalso(`int_frete/${id}`),
  },
}));

vi.mock('@delfrance/data', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data')>()),
  buildQuery: (base: object, cs: unknown[]) => ({ ...base, cs }),
  whereEqual: (campo: string, valor: unknown) => ({ campo, valor }),
  whereOp: (campo: string, op: string, valor: unknown) => ({ campo, op, valor }),
  orderByField: (campo: string) => ({ orderBy: campo }),
  limit: (n: number) => ({ limit: n }),
}));

vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useDocSnapshot: (ref: { path: string } | null) => {
    const servido = ref == null ? undefined : h.servido.get(ref.path);
    if (ref == null || servido === undefined)
      return { data: undefined, loading: ref != null, error: undefined };
    return {
      data: { id: ref.path.split('/')[1], data: h.ler(ref.path, structuredClone(servido.raw)) },
      loading: false,
      error: undefined,
      fromCache: servido.fromCache,
      hasPendingWrites: false,
      documentPath: ref.path,
    };
  },
  useSnapshot: (q: { __col?: string } | null) => {
    if (q?.__col !== 'int_frete') return { data: [], loading: false, error: undefined };
    const linhas = [...h.servido.entries()]
      .filter(([path]) => path.startsWith('int_frete/'))
      .map(([path, s]) => ({ id: path.split('/')[1]!, path, data: structuredClone(s.raw) }));
    return { data: linhas, loading: false, error: undefined, fromCache: h.consultaDoCache };
  },
}));

vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.occ.runTransaction(fn),
  getDocs: async () => {
    h.leiturasAlvos += 1;
    return { docs: h.alvos.map((a) => ({ id: a.id, data: () => structuredClone(a.data) })) };
  },
  getDoc: async (ref: { path: string }) => ({ data: () => h.docs.get(ref.path) }),
  deleteDoc: vi.fn(),
}));

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
vi.mock('@/lib/freight/client', () => ({
  useFreightClient: () => ({ servicos: h.servicos }),
}));
vi.mock('@/app/(app)/canais/loja-integrada/_components/ContaLojaIntegradaPanel', () => ({
  ContaLojaIntegradaPanel: () => null,
}));
vi.mock('@/app/(app)/canais/_components/RecalcularPrecosCanalAction', () => ({
  RecalcularPrecosCanalAction: () => null,
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

const { default: ContaLojaIntegradaPage } = await import('./page');

const CONTA_PATH = 'integracao/conta-1';
const FRETE_PATH = 'int_frete/lojaIntegrada-conta-1';

/** The client converters' soft read: the parsed doc, or the raw one when the parse fails. */
h.ler = (path, raw) => {
  const r = (path.startsWith('integracao/') ? integracaoSchema : intFreteSchema).safeParse(raw);
  return (r.success ? r.data : raw) as Doc;
};

const linha = (n: number, extra: Doc = {}): Doc => ({
  nomeOriginal: `Forma ${n}`,
  idOriginal: `100${n}---X`,
  observacao: `Origem: Pedido ${n}`,
  nomeTarget: null,
  targetData: null,
  integracaoUid: null,
  targetTipoIntegracao: 'outros',
  ...extra,
});
const SEGUNDA = {
  diaDaSemana: 1,
  horaDeCorte: 16,
  minutosDeCorte: 0,
  prazoDePostagem: 0,
  horaPostagem: 18,
  minutosPostagem: 0,
};
/** {@link SEGUNDA} as another writer changed it after the page loaded. */
const SEGUNDA_REMOTA = { ...SEGUNDA, horaDeCorte: 10 };

function conta(): Doc {
  return {
    tipo: 3,
    nome: 'Conta 1',
    padrao: false,
    ativo: true,
    filialIntegracaoPedidoOuterRef: 'documents/filiais/f1',
    dataCadastro: 1_700_000_000_000,
    ultimaModificacao: 1_700_000_000_000,
  };
}
function frete(extra: Doc = {}): Doc {
  return {
    tipo: 'lojaIntegrada',
    nome: 'Conta 1',
    ativo: true,
    filialIntegracaoFreteOuterRef: 'documents/filiais/f1',
    contaLojaIntegradaEnviosOuterRef: 'documents/integracao/conta-1',
    dataCadastro: 1_700_000_000_000,
    ultimaModificacao: 1_700_000_000_000,
    mapa: [linha(1), linha(2, { integracaoUid: 'moto-1', targetTipoIntegracao: 'motoboy' })],
    horarioDeCorte: null,
    prazoExtra: 0,
    ...extra,
  };
}

/** Store `raw` and serve it to the listeners as server truth. */
function semear(path: string, raw: Doc, fromCache = false) {
  h.docs.set(path, structuredClone(raw));
  h.servido.set(path, { raw: structuredClone(raw), fromCache });
}

/** Another writer's commit, landing after this page loaded. */
function escritaConcorrente(alterar: (doc: Doc) => void, { listener = true } = {}): Doc {
  const remoto = structuredClone(h.docs.get(FRETE_PATH)!);
  alterar(remoto);
  h.docs.set(FRETE_PATH, remoto);
  if (listener) h.servido.set(FRETE_PATH, { raw: structuredClone(remoto), fromCache: false });
  return remoto;
}

let rerenderPage: () => void = () => undefined;
async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = () => (
    <QueryClientProvider client={qc}>
      <MantineTestProvider>
        <ContaLojaIntegradaPage />
      </MantineTestProvider>
    </QueryClientProvider>
  );
  const view = render(arvore());
  rerenderPage = () => view.rerender(arvore());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function abrirAba(nome: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: nome }));
  });
}

const destino = (i: number) =>
  within(screen.getByTestId(`mapa-frete-linha-${i}`)).getAllByLabelText(
    `Destino da forma de envio ${i + 1}`,
  )[0] as HTMLInputElement;

async function escolherDestino(i: number, rotulo: string) {
  await act(async () => {
    fireEvent.click(destino(i));
  });
  const opcao = await screen.findByRole('option', { name: rotulo });
  await act(async () => {
    fireEvent.click(opcao);
  });
}

async function salvar(rotulo: 'Salvar alterações' | 'Salvar e continuar' = 'Salvar e continuar') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: rotulo }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function clicar(nome: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: nome }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renomearConta(nome: string) {
  await abrirAba('Dados gerais');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: nome } });
  });
}

/** The conflict modal's name for the freight doc. */
const ROTULO = 'Frete da conta';

const commits = () => h.occ.txLog.filter((e) => e.phase === 'commit').length;
const mapaGuardado = () => h.docs.get(FRETE_PATH)!.mapa as Doc[];
const conflito = () => screen.queryByText('Registro alterado');
/** Every path a committed transaction wrote, in order. */
const escritas: string[] = [];

beforeEach(() => {
  h.permissoes =
    PERM.integracao.write | PERM.integracao.delete | PERM.frete.read | PERM.frete.write;
  h.docs.clear();
  h.servido.clear();
  h.consultaDoCache = false;
  h.toasts.length = 0;
  h.servicos.mockClear();
  h.leiturasAlvos = 0;
  h.replace.mockReset();
  escritas.length = 0;
  h.alvos = [
    { id: 'moto-1', data: { tipo: 'motoboy', nome: 'Moto Centro', ativo: true } },
    { id: 'moto-2', data: { tipo: 'motoboy', nome: 'Moto Norte', ativo: true } },
  ];
  semear(CONTA_PATH, conta());
  semear(FRETE_PATH, frete());
  h.occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      escritas.push(path);
      const prev = h.docs.get(path) ?? {};
      h.docs.set(path, kind === 'update' ? { ...prev, ...structuredClone(data) } : data);
    },
  });
});

describe('/canais/loja-integrada/[id] — the freight tabs ride the conta’s save', () => {
  it('shows the conta in tabs, with the two freight tabs beside its data', async () => {
    await renderPage();
    for (const aba of ['Dados gerais', 'Mapeamento do Frete', 'Horário de Corte']) {
      expect(screen.getByRole('tab', { name: aba })).toBeTruthy();
    }
  });

  it('a save with only a freight tab dirty writes ONLY the int_frete doc, and only its mapa', async () => {
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(h.docs.get(CONTA_PATH)).toEqual(conta());
    expect(mapaGuardado()).toEqual([
      { ...linha(1), integracaoUid: 'moto-2', targetTipoIntegracao: 'motoboy' },
      (frete().mapa as Doc[])[1],
    ]);
    // Everything else on the freight doc — its stamp included — is untouched.
    const { mapa: _mapa, ...resto } = h.docs.get(FRETE_PATH)!;
    const { mapa: _antes, ...restoAntes } = frete();
    expect(resto).toEqual(restoAntes);
    expect(h.toasts).toEqual(['Salvo.']);
  });

  it('a conta field and a freight tab commit together, in ONE transaction', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Conta renomeada' } });
    });
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Centro (Motoboy)');
    await salvar('Salvar alterações');
    expect(commits()).toBe(1);
    expect(h.docs.get(CONTA_PATH)?.nome).toBe('Conta renomeada');
    expect(mapaGuardado()[0]?.integracaoUid).toBe('moto-1');
    expect(h.replace).toHaveBeenCalledWith('/canais/loja-integrada');
  });

  it('the seed is not an edit: a freshly loaded conta does not arm the leave guard, an edit does', async () => {
    const saidaBloqueada = () => {
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    // The freight doc's server truth lands AFTER the conta's own (which resets
    // the form): only then could a seed that marked the fields dirty survive.
    semear(FRETE_PATH, frete(), true);
    await renderPage();
    h.servido.set(FRETE_PATH, { raw: frete(), fromCache: false });
    await act(async () => rerenderPage());
    await abrirAba('Mapeamento do Frete');
    expect(destino(0).disabled).toBe(false);
    expect(saidaBloqueada()).toBe(false);
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    expect(saidaBloqueada()).toBe(true);
  });

  it('a save that changed nothing writes nothing', async () => {
    await renderPage();
    await salvar();
    expect(commits()).toBe(0);
    expect(h.toasts).toEqual(['Nenhuma alteração para salvar']);
  });

  it('(a) a remote change to the mapa while the tab is dirty ⇒ the conflict modal, NOTHING written', async () => {
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    const remoto = escritaConcorrente((doc) => {
      (doc.mapa as Doc[])[1] = linha(2);
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(mapaGuardado()).toEqual(remoto.mapa);
  });

  it('(b) a later emission moves neither the form nor the baseline: a remote change while pristine still conflicts', async () => {
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    expect(destino(0).value).toBe('Nenhum');
    const remoto = escritaConcorrente((doc) => {
      (doc.mapa as Doc[])[0] = linha(1, {
        integracaoUid: 'moto-1',
        targetTipoIntegracao: 'motoboy',
      });
    });
    await act(async () => rerenderPage());
    // The form still shows what was seeded — the listener did not re-seed it.
    expect(destino(0).value).toBe('Nenhum');
    await escolherDestino(1, 'Moto Norte (Motoboy)');
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(mapaGuardado()).toEqual(remoto.mapa);
  });

  it('(d) save, edit the same row, save: the commit rebases, so no conflict', async () => {
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    await salvar();
    await escolherDestino(0, 'Moto Centro (Motoboy)');
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(2);
    expect(mapaGuardado()[0]?.integracaoUid).toBe('moto-1');
  });

  it('the importer appending a newly seen method after load ⇒ conflict, and the append survives', async () => {
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    const nova = linha(3, { idOriginal: '1003---null' });
    escritaConcorrente((doc) => (doc.mapa as Doc[]).push(nova), { listener: false });
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(commits()).toBe(0);
    expect(mapaGuardado()).toEqual([...(frete().mapa as Doc[]), nova]);
  });

  it('"Salvar mesmo assim" on a mapa conflict never writes back the horário it did not show', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA] }));
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    escritaConcorrente((doc) => {
      (doc.mapa as Doc[])[1] = linha(2);
      doc.horarioDeCorte = [SEGUNDA_REMOTA];
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    // The modal names only what this save writes: the mapa.
    expect(screen.getByText(`${ROTULO} — mapa`)).toBeTruthy();
    expect(screen.queryByText(`${ROTULO} — horarioDeCorte`)).toBeNull();
    await clicar('Salvar mesmo assim');
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    // The operator kept THEIR mapa over the one the modal showed…
    expect(mapaGuardado()).toEqual([
      { ...linha(1), integracaoUid: 'moto-2', targetTipoIntegracao: 'motoboy' },
      (frete().mapa as Doc[])[1],
    ]);
    // …and accepted nothing about the horário, which the modal never showed.
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA_REMOTA]);
    // …nor on the save after it: the commit carried the remote horário into the form.
    await renomearConta('Conta renomeada');
    await salvar();
    expect(conflito()).toBeNull();
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA_REMOTA]);
  });

  it('a remote horário change is not undone by the SECOND mapa save after it', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA] }));
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    escritaConcorrente((doc) => {
      doc.horarioDeCorte = [SEGUNDA_REMOTA];
    });
    await act(async () => rerenderPage());
    await salvar();
    // Disjoint fields: the first save commits and keeps the remote horário…
    expect(conflito()).toBeNull();
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA_REMOTA]);
    // …and so must the next one.
    await escolherDestino(0, 'Moto Centro (Motoboy)');
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(2);
    expect(mapaGuardado()[0]?.integracaoUid).toBe('moto-1');
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA_REMOTA]);
  });

  it('a conta-only save after a freight commit leaves the remote horário alone', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA] }));
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    escritaConcorrente((doc) => {
      doc.horarioDeCorte = [SEGUNDA_REMOTA];
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(commits()).toBe(1);
    await renomearConta('Conta renomeada');
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(2);
    expect(h.docs.get(CONTA_PATH)?.nome).toBe('Conta renomeada');
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA_REMOTA]);
  });

  it('"Recarregar do servidor" on a mapa conflict reloads the horário too, so the next save keeps it', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA] }));
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    const remoto = escritaConcorrente((doc) => {
      (doc.mapa as Doc[])[1] = linha(2);
      doc.horarioDeCorte = [SEGUNDA_REMOTA];
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    await clicar('Recarregar do servidor');
    expect(conflito()).toBeNull();
    // The contested mapa is the server's again; the operator re-applies the edit.
    expect(destino(0).value).toBe('Nenhum');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(mapaGuardado()).toEqual([
      { ...linha(1), integracaoUid: 'moto-2', targetTipoIntegracao: 'motoboy' },
      (remoto.mapa as Doc[])[1],
    ]);
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA_REMOTA]);
  });

  it('"Recarregar do servidor" keeps the freight edit that did NOT collide', async () => {
    // Both tabs edited; only the horário collided. Reload takes the server's
    // horário and keeps the operator's mapa edit, which the next save writes.
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA] }));
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    await abrirAba('Horário de Corte');
    await act(async () => {
      fireEvent.change(screen.getAllByLabelText('Corte (h) 1')[0]!, { target: { value: '15' } });
    });
    escritaConcorrente((doc) => {
      doc.horarioDeCorte = [SEGUNDA_REMOTA];
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(screen.getByText(`${ROTULO} — horarioDeCorte`)).toBeTruthy();
    expect(screen.queryByText(`${ROTULO} — mapa`)).toBeNull();
    await clicar('Recarregar do servidor');
    expect((screen.getAllByLabelText('Corte (h) 1')[0] as HTMLInputElement).value).toBe('10');
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA_REMOTA]);
    expect(mapaGuardado()[0]?.integracaoUid).toBe('moto-2');
  });

  it('(c) no edit before server truth: a cache-only freight doc offers nothing to edit', async () => {
    semear(FRETE_PATH, frete(), true);
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    expect(screen.queryByTestId('mapa-frete-linha-0')).toBeNull();
    expect(screen.getAllByText('Carregando o frete da conta do servidor…').length).toBeGreaterThan(
      0,
    );
  });

  it('(e) a stored target outside the list is read BY ID: deleted, inactive or simply further down', async () => {
    h.docs.set('int_frete/ret-velha', { tipo: 'retiradaNaLoja', nome: 'Balcão', ativo: false });
    h.docs.set('int_frete/moto-longe', { tipo: 'motoboy', nome: 'Moto Sul', ativo: true });
    semear(
      FRETE_PATH,
      frete({
        mapa: [
          linha(1, {
            integracaoUid: 'sumiu',
            targetTipoIntegracao: 'motoboy',
            nomeTarget: 'Moto antiga',
          }),
          linha(2, { integracaoUid: 'ret-velha', targetTipoIntegracao: 'retiradaNaLoja' }),
          linha(3, { integracaoUid: 'moto-longe', targetTipoIntegracao: 'motoboy' }),
        ],
      }),
    );
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    // Two reads in sequence: the list, then the ids it did not hold.
    await waitFor(() => expect(destino(0).value).toBe('Moto antiga (excluída)'));
    expect(destino(1).value).toBe('Balcão (Retirar na Loja) (inativa)');
    expect(destino(2).value).toBe('Moto Sul (Motoboy)');
  });

  it('the target list is read only once the mapping tab is opened', async () => {
    // The tab is mounted from page load; a conta screen opened for anything else
    // must not pay for the freight picker.
    await renderPage();
    expect(screen.getByTestId('mapa-frete-linha-0')).toBeTruthy();
    expect(h.leiturasAlvos).toBe(0);
    await abrirAba('Mapeamento do Frete');
    await waitFor(() => expect(h.leiturasAlvos).toBe(1));
  });

  it('a stored Melhor Envio row asks the backend for its services only once the tab is opened', async () => {
    // The tabs are mounted from page load; a conta screen opened for its token
    // alone must not call the Melhor Envio backend once per stored account.
    h.alvos.push({
      id: 'me-conta',
      data: { tipo: 'melhorEnvios', nome: 'Conta ME', ativo: true },
    });
    semear(
      FRETE_PATH,
      frete({
        mapa: [
          linha(1, {
            integracaoUid: 'me-conta',
            targetTipoIntegracao: 'melhorEnvios',
            nomeTarget: 'Correios — PAC',
            targetData: { id: 1, name: 'PAC', company: { id: 1, name: 'Correios' } },
          }),
        ],
      }),
    );
    await renderPage();
    expect(screen.getByTestId('mapa-frete-linha-0')).toBeTruthy();
    expect(h.servicos).not.toHaveBeenCalled();
    await abrirAba('Mapeamento do Frete');
    await waitFor(() => expect(h.servicos).toHaveBeenCalledWith('me-conta'));
  });

  it('(i) a mapa whose rows fail the row schema keeps EVERY row through a save', async () => {
    const cru = [{ idOriginal: '1009---Y' }, linha(1), 'lixo'];
    semear(FRETE_PATH, frete({ mapa: cru }));
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(1, 'Moto Centro (Motoboy)');
    await salvar();
    expect(conflito()).toBeNull();
    expect(mapaGuardado()).toEqual([
      cru[0],
      { ...linha(1), integracaoUid: 'moto-1', targetTipoIntegracao: 'motoboy' },
      'lixo',
    ]);
  });
});

describe('/canais/loja-integrada/[id] — Horário de Corte', () => {
  it('a new horário row saves, and only horarioDeCorte is written', async () => {
    await renderPage();
    await abrirAba('Horário de Corte');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Adicionar horário' }));
    });
    await act(async () => {
      fireEvent.change(screen.getAllByLabelText('Corte (h) 1')[0]!, { target: { value: '15' } });
    });
    await salvar();
    expect(conflito()).toBeNull();
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([
      {
        diaDaSemana: 1,
        horaDeCorte: 15,
        minutosDeCorte: null,
        prazoDePostagem: null,
        horaPostagem: null,
        minutosPostagem: null,
      },
    ]);
    expect(mapaGuardado()).toEqual(frete().mapa);
  });

  it('the importer appending after load does not stop a horário save, and the append survives the NEXT save', async () => {
    // A horário-only save does not write the mapa, so the append is no conflict;
    // its commit must then carry the appended row into the form too, or a later
    // conta-only save would read the stale mapa as an edit and write it back.
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA] }));
    await renderPage();
    await abrirAba('Horário de Corte');
    await act(async () => {
      fireEvent.change(screen.getAllByLabelText('Corte (h) 1')[0]!, { target: { value: '15' } });
    });
    const nova = linha(3, { idOriginal: '1003---null' });
    escritaConcorrente((doc) => (doc.mapa as Doc[]).push(nova), { listener: false });
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(mapaGuardado()).toEqual([...(frete().mapa as Doc[]), nova]);
    await renomearConta('Conta renomeada');
    await salvar();
    expect(conflito()).toBeNull();
    expect(h.docs.get(CONTA_PATH)?.nome).toBe('Conta renomeada');
    expect(mapaGuardado()).toEqual([...(frete().mapa as Doc[]), nova]);
    expect((h.docs.get(FRETE_PATH)?.horarioDeCorte as Doc[])[0]?.horaDeCorte).toBe(15);
  });

  it('(h) a duplicated weekday shows inline and blocks the save', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA] }));
    await renderPage();
    await abrirAba('Horário de Corte');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Adicionar horário' }));
    });
    await salvar();
    expect(screen.getAllByText('Dia da semana duplicado').length).toBeGreaterThan(0);
    expect(commits()).toBe(0);
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA]);
  });
});

/** Type `valor` into the cut-off hour of horário row `linha` (1-based). */
async function digitarCorte(linha: number, valor: string) {
  await act(async () => {
    fireEvent.change(screen.getAllByLabelText(`Corte (h) ${linha}`)[0]!, {
      target: { value: valor },
    });
  });
}

const abaHorario = () => screen.getByRole('tab', { name: /Horário de Corte/ });
const RECUSA_NA_ABA_HORARIO = 'Corrija os campos inválidos na aba "Horário de Corte".';

describe('/canais/loja-integrada/[id] — a stored horário is validated only once the operator changes it', () => {
  // The imported corpus carries rows these schemas do not model (root CLAUDE.md
  // rule 8). A horário nobody touched is not this save's to judge: it is not
  // written, so it must not refuse a save of the conta either.
  it.each([
    ['a weekday stored twice', [SEGUNDA, SEGUNDA]],
    ['a cut-off hour out of range', [{ ...SEGUNDA, horaDeCorte: 30 }]],
    ['a weekday stored as text', [{ ...SEGUNDA, diaDaSemana: 'segunda' }]],
    ['a value that is not a list', { 1: SEGUNDA }],
    // The tab is mounted from page load: an editor that crashed on these would
    // take the whole conta screen down with it.
    ['rows that are not objects', [null, 'texto', SEGUNDA]],
  ])('untouched, %s does not block a conta-only save, and is not written', async (_c, horario) => {
    semear(FRETE_PATH, frete({ horarioDeCorte: horario }));
    await renderPage();
    await renomearConta('Conta renomeada');
    await salvar();
    expect(commits()).toBe(1);
    expect(h.docs.get(CONTA_PATH)?.nome).toBe('Conta renomeada');
    expect(escritas).toEqual([CONTA_PATH]);
    expect(h.docs.get(FRETE_PATH)).toEqual(frete({ horarioDeCorte: horario }));
    expect(h.toasts).toEqual(['Salvo.']);
  });

  it('untouched, a weekday stored twice does not block a mapa edit, which writes only the mapa', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA, SEGUNDA] }));
    await renderPage();
    await abrirAba('Mapeamento do Frete');
    await escolherDestino(0, 'Moto Norte (Motoboy)');
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([FRETE_PATH]);
    expect(mapaGuardado()[0]?.integracaoUid).toBe('moto-2');
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA, SEGUNDA]);
  });

  it('an edit undone before saving is no edit: no error, and the freight doc is not written', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA, SEGUNDA] }));
    await renderPage();
    await abrirAba('Horário de Corte');
    await digitarCorte(1, '15');
    await digitarCorte(1, '16');
    await renomearConta('Conta renomeada');
    await salvar();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([CONTA_PATH]);
    expect(screen.queryByText('Dia da semana duplicado')).toBeNull();
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA, SEGUNDA]);
  });

  it('an edit that removes the stored duplicate saves it', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA, SEGUNDA] }));
    await renderPage();
    await abrirAba('Horário de Corte');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Excluir horário 2' }));
    });
    await salvar();
    expect(conflito()).toBeNull();
    expect(commits()).toBe(1);
    expect(escritas).toEqual([FRETE_PATH]);
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA]);
  });

  it('an edit that LEAVES the stored duplicate is refused, and the refusal lands on the Horário tab', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA, SEGUNDA] }));
    await renderPage();
    await abrirAba('Horário de Corte');
    await digitarCorte(1, '15');
    // Saved from ANOTHER tab: the form must jump back and say why.
    await renomearConta('Conta renomeada');
    await salvar();
    expect(commits()).toBe(0);
    expect(escritas).toEqual([]);
    expect(abaHorario().getAttribute('aria-selected')).toBe('true');
    expect(h.toasts).toEqual([RECUSA_NA_ABA_HORARIO]);
    expect(screen.getAllByText('Dia da semana duplicado').length).toBeGreaterThan(0);
  });

  it('an out-of-range cut-off hour typed by the operator is refused', async () => {
    semear(FRETE_PATH, frete({ horarioDeCorte: [SEGUNDA] }));
    await renderPage();
    await abrirAba('Horário de Corte');
    await digitarCorte(1, '30');
    await salvar();
    expect(commits()).toBe(0);
    expect(escritas).toEqual([]);
    expect(h.toasts).toEqual([RECUSA_NA_ABA_HORARIO]);
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual([SEGUNDA]);
  });
});
