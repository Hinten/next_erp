import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import { CODIGO_ERRO_LI, INTEGRACAO_TIPO, grupoDeVariacoesSchema } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * `/variacoes/[id]` with its "Loja Integrada" tab (master plan step 10), through
 * the REAL page, the REAL `ObjectView` + `saveRecord`, the REAL tab and the
 * REAL `validate`, over an OCC FakeDb (`@delfrance/data/testing`).
 *
 * What only this file can show: that the edited-vs-untouched chain BLOCKS an
 * invalid edit through the form's own machinery — RHF clones a kept edit on
 * "Recarregar do servidor", a staged removal undone is a copy, and `validate`
 * sees the prepared value — so a classification by object identity would let
 * each of (a)–(c) through. And that an untouched stored defect never blocks.
 *
 * Doubled are only the I/O edges: the snapshot hook (`h.servido` is what the
 * listener shows, `h.docs` what the store holds — they differ exactly when a
 * test says another writer moved the store), `runTransaction`, the collection
 * handle (its `get` runs the converter's soft parse), the conta list, and the
 * Loja Integrada backend (switched off: every catalogue read answers 503).
 */

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  servido: new Map<string, { raw: Record<string, unknown>; fromCache: boolean }>(),
  occ: null as unknown as import('@delfrance/data/testing').OccEngine,
  ler: (raw: Record<string, unknown>): Record<string, unknown> => raw,
  replace: vi.fn(),
  toasts: [] as string[],
  grades: vi.fn(),
  grade: vi.fn(),
}));

function refFalso(path: string) {
  const ref = {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => ({
      exists: () => h.docs.has(path),
      data: () => h.ler(structuredClone(h.docs.get(path)!)),
    }),
    withConverter: () => ref,
  };
  return ref;
}

vi.mock('@/lib/data/grupoDeVariacoesCollection', () => ({
  grupoDeVariacoesCollection: {
    resolvePath: () => 'grupoDeVariacoes',
    ref: () => ({ __col: 'grupoDeVariacoes' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => refFalso(`grupoDeVariacoes/${id}`),
    converter: {},
    merge: vi.fn(),
  },
}));

vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useDocSnapshot: (ref: { path: string } | null) => {
    const servido = ref == null ? undefined : h.servido.get(ref.path);
    if (ref == null || servido === undefined)
      return { data: undefined, loading: ref != null, error: undefined };
    return {
      data: { id: ref.path.split('/')[1], data: h.ler(structuredClone(servido.raw)) },
      loading: false,
      error: undefined,
      fromCache: servido.fromCache,
      hasPendingWrites: false,
      documentPath: ref.path,
    };
  },
}));

vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.occ.runTransaction(fn),
  deleteDoc: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true, loading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'g1' }),
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/useIntegracoes', () => {
  const rows = [
    { id: 'CONTA1', data: { tipo: INTEGRACAO_TIPO.lojaIntegrada, nome: 'Loja A', ativo: true } },
  ];
  return {
    useIntegracoes: () => ({
      rows,
      byId: new Map(rows.map((r) => [r.id, r.data])),
      status: 'success',
    }),
  };
});
vi.mock('@/lib/loja-integrada/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/loja-integrada/client')>();
  const { lojaIntegradaClientFalso } = await import('@/lib/testing/lojaIntegradaClientFalso');
  const client = lojaIntegradaClientFalso({ grades: h.grades, grade: h.grade });
  return { ...actual, useBackendLojaIntegrada: () => ({ client, indisponivel: null }) };
});
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

const { default: GrupoVariacaoPage } = await import('./page');
const { LojaIntegradaClientHttpError } = await import('@/lib/loja-integrada/client');

const PATH = 'grupoDeVariacoes/g1';

/** The client converter's soft read: the parsed doc, or the raw one when the parse fails. */
h.ler = (raw) => {
  const r = grupoDeVariacoesSchema.safeParse(raw);
  return (r.success ? r.data : raw) as Doc;
};

const opcao = (id: number, variantes: string[], nome: string): Doc => ({
  li_option_id: id,
  li_option_name: nome,
  arakene_variation_id: variantes,
});
const variante = (id: string, nome: string) => ({ id, nome, codigo: null });
const P = variante('v1', 'P');
const M = variante('v2', 'M');
const G = variante('v3', 'G');

/** The active conta's link: grade 8946, three options, one variante each. */
const LINK: Doc = {
  name: 'Tamanho',
  grade_id: 8946,
  integracaoLiId: 'CONTA1',
  variationOptions: [
    opcao(37097, ['v1'], 'P'),
    opcao(37098, ['v2'], 'M'),
    opcao(37099, ['v3'], 'G'),
  ],
};
/** A half-made legacy entry (no grade): invalid, carried back as stored. */
const MEIA_BOCA: Doc = { integracaoLiId: 'CONTA1' };
/** Another conta's link. */
const OUTRA_CONTA: Doc = {
  name: 'Cor',
  grade_id: 9001,
  integracaoLiId: 'CONTA2',
  variationOptions: [opcao(1, ['v1'], 'Azul')],
};

function grupo(extra: Doc = {}): Doc {
  return {
    nome: 'Tamanhos',
    codigo: null,
    ordem: 1,
    tipo: 1,
    permiteFotos: false,
    timestamp: 1_700_000_000_000,
    ultimaModificacao: 1_700_000_000_000,
    variacoesIds: ['v1', 'v2', 'v3'],
    variacoes: [P, M, G],
    linksVariacoesli: [LINK],
    ...extra,
  };
}

function semear(raw: Doc) {
  h.docs.set(PATH, structuredClone(raw));
  h.servido.set(PATH, { raw: structuredClone(raw), fromCache: false });
}

/** Another writer's commit, landing after this page loaded (the listener sees it too). */
function escritaConcorrente(alterar: (doc: Doc) => void): Doc {
  const remoto = structuredClone(h.docs.get(PATH)!);
  alterar(remoto);
  h.docs.set(PATH, remoto);
  h.servido.set(PATH, { raw: structuredClone(remoto), fromCache: false });
  return remoto;
}

let rerenderPage: () => void = () => undefined;
async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = () => (
    <QueryClientProvider client={qc}>
      <MantineTestProvider>
        <GrupoVariacaoPage />
      </MantineTestProvider>
    </QueryClientProvider>
  );
  const view = render(arvore());
  rerenderPage = () => view.rerender(arvore());
  await esperar();
}

async function esperar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function clicar(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
  await esperar();
}

async function abrirAba(nome: string) {
  await clicar(screen.getByRole('tab', { name: nome }));
}

const cartao = () => screen.getByTestId('vinculo-li-CONTA1-8946');

/** Toggle `rotulo` in the option's MultiSelect (a selected one is deselected). */
async function alternarVariante(opcaoNome: string, rotulo: string) {
  await clicar(within(cartao()).getAllByLabelText(`Variantes da opção ${opcaoNome}`)[0]!);
  await clicar(await within(cartao()).findByRole('option', { name: rotulo }));
}

async function renomear(nome: string) {
  await abrirAba('Dados gerais');
  await act(async () => {
    // The grupo's own "Nome" comes first; every variante row has one too.
    fireEvent.change(screen.getAllByLabelText('Nome')[0]!, { target: { value: nome } });
  });
}

async function salvar(rotulo: 'Salvar alterações' | 'Salvar e continuar' = 'Salvar e continuar') {
  await clicar(screen.getByRole('button', { name: rotulo }));
  await esperar();
}

const commits = () => h.occ.txLog.filter((e) => e.phase === 'commit').length;
const guardado = () => h.docs.get(PATH)!;
const conflito = () => screen.queryByText('Registro alterado');
/** The page refused the save with its "fix the tab" toast. */
const recusado = () => h.toasts.some((t) => t.startsWith('Corrija os campos inválidos'));

beforeEach(() => {
  h.docs.clear();
  h.servido.clear();
  h.toasts.length = 0;
  h.replace.mockReset();
  const desligado = () =>
    new LojaIntegradaClientHttpError('desligadas', 503, CODIGO_ERRO_LI.chamadasDesligadas);
  h.grades.mockReset().mockRejectedValue(desligado());
  h.grade.mockReset().mockRejectedValue(desligado());
  h.occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      const prev = h.docs.get(path) ?? {};
      h.docs.set(path, kind === 'update' ? { ...prev, ...structuredClone(data) } : data);
    },
  });
});

describe('/variacoes/[id] — the Loja Integrada tab rides the grupo’s save', () => {
  it('shows the tab with the stored link under the switch-off answer', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Loja Integrada');

    expect(within(cartao()).getByText('Tamanho (8946)')).toBeTruthy();
    expect(screen.getByText(/as chamadas estão desligadas/)).toBeTruthy();
  });

  it('EQUAL: renaming a grupo with untouched stored defects saves — and writes nothing to the links', async () => {
    // An invalid half-made entry, and v1 in two options of ONE conta (the
    // per-store rule) — both stored, both untouched.
    const legado = [LINK, MEIA_BOCA, { ...LINK, grade_id: 8950 }, OUTRA_CONTA];
    semear(grupo({ linksVariacoesli: legado }));
    await renderPage();

    await renomear('Tamanhos renomeado');
    await salvar();

    expect(recusado()).toBe(false);
    expect(commits()).toBe(1);
    expect(guardado().nome).toBe('Tamanhos renomeado');
    expect(guardado().linksVariacoesli).toEqual(legado);
  });

  it('an edit writes the edited link and carries every other entry back byte-identical', async () => {
    semear(grupo({ linksVariacoesli: [MEIA_BOCA, LINK, OUTRA_CONTA] }));
    await renderPage();
    await abrirAba('Loja Integrada');

    // Option G loses its only variante, so the option leaves the link.
    await alternarVariante('G', 'G');
    await salvar();

    expect(recusado()).toBe(false);
    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesli).toEqual([
      MEIA_BOCA,
      { ...LINK, variationOptions: [opcao(37097, ['v1'], 'P'), opcao(37098, ['v2'], 'M')] },
      OUTRA_CONTA,
    ]);
  });
});

describe('/variacoes/[id] — each of these must BLOCK, through ObjectView', () => {
  it('(a) an edit that turns invalid after "Recarregar do servidor" on another field (nome) is refused', async () => {
    // The link starts with option G empty, so assigning G to it is a VALID edit.
    semear(
      grupo({
        linksVariacoesli: [
          { ...LINK, variationOptions: [opcao(37097, ['v1'], 'P'), opcao(37099, [], 'G')] },
        ],
      }),
    );
    await renderPage();
    await abrirAba('Loja Integrada');
    await alternarVariante('G', 'G');
    await renomear('Tamanhos (meu)');

    // Meanwhile another operator renamed the grupo AND deleted variante G.
    escritaConcorrente((doc) => {
      doc.nome = 'Tamanhos (outro)';
      doc.variacoes = [P, M];
      doc.variacoesIds = ['v1', 'v2'];
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();

    // The kept link edit is re-applied through the form (a CLONE), over a seed
    // that no longer has G: it now names a variante the grupo does not have.
    await clicar(screen.getByRole('button', { name: 'Recarregar do servidor' }));
    const antes = structuredClone(guardado());
    await salvar();

    expect(recusado()).toBe(true);
    expect(commits()).toBe(0);
    expect(guardado()).toEqual(antes);
    // Refused for the right reason: the EDITED link names a variante gone from the grupo.
    expect(screen.getAllByText(/"v3" não existe mais neste grupo/).length).toBeGreaterThan(0);
  });

  it('(b) an invalid edit after remove-then-undo is refused', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Loja Integrada');
    // v1 now in options P AND M of the same conta: the per-store rule, on an edited entry.
    await alternarVariante('M', 'P');
    await clicar(within(cartao()).getByRole('button', { name: 'Remover vínculo' }));
    await clicar(within(cartao()).getByRole('button', { name: 'Desfazer remoção' }));
    await salvar();

    expect(recusado()).toBe(true);
    expect(commits()).toBe(0);
    // On the tab's error and on the link itself.
    expect(screen.getAllByText(/"P" está em mais de uma opção desta loja/)).toHaveLength(2);
  });

  it('(c) an edited link with an emptied option AND one variante in two options is refused', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Loja Integrada');
    await alternarVariante('P', 'P'); // P emptied: the option leaves the link
    await alternarVariante('G', 'M'); // v2 now in M and G
    await salvar();

    expect(recusado()).toBe(true);
    expect(commits()).toBe(0);
    expect(screen.getAllByText(/"M" está em mais de uma opção desta loja/)).toHaveLength(2);
  });

  it('(d) a variante removed while an UNTOUCHED link names it is refused, on the Variantes tab', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Variantes');
    await clicar(screen.getAllByRole('button', { name: 'Remover variante' })[2]!);
    await salvar();

    expect(commits()).toBe(0);
    expect(h.toasts.at(-1)).toContain('"Variantes"');
    // On the Variantes tab's error, and on the link that names it.
    expect(
      screen.getAllByText(
        'a variante "G" está vinculada à Loja Integrada; desvincule-a antes de excluir',
      ),
    ).toHaveLength(2);
  });
});

describe('/variacoes/[id] — a conflicting save merges link by link (rebaseOnConflict)', () => {
  it('another conta’s link added meanwhile is KEPT: "Salvar mesmo assim" saves both', async () => {
    semear(
      grupo({ linksVariacoesli: [{ ...LINK, variationOptions: [opcao(37097, ['v1'], 'P')] }] }),
    );
    await renderPage();
    await abrirAba('Loja Integrada');
    await alternarVariante('P', 'M'); // a valid edit: P holds v1 and v2 (a warning only)

    escritaConcorrente((doc) => {
      doc.linksVariacoesli = [...(doc.linksVariacoesli as Doc[]), OUTRA_CONTA];
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    expect(screen.getByText('mescla por vínculo')).toBeTruthy();

    await clicar(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await esperar();

    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesli).toEqual([
      { ...LINK, variationOptions: [opcao(37097, ['v1', 'v2'], 'P')] },
      OUTRA_CONTA,
    ]);
  });

  it('⚠️ NEAR-MISS: both changed the SAME link ⇒ the other version stays, marked, and NOTHING is saved', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Loja Integrada');
    await alternarVariante('G', 'G'); // mine: G emptied

    const remoto = escritaConcorrente((doc) => {
      doc.linksVariacoesli = [{ ...LINK, variationOptions: [opcao(37097, ['v1', 'v2'], 'P')] }];
    });
    await act(async () => rerenderPage());
    await salvar();
    await clicar(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await esperar();

    expect(commits()).toBe(0);
    expect(guardado()).toEqual(remoto);
    expect(within(cartao()).getByText(/Alterado por outra pessoa/)).toBeTruthy();
  });

  it('⭐ the other writer’s entries are judged UNTOUCHED after the merge: a half-made one does not block "Salvar mesmo assim"', async () => {
    semear(
      grupo({ linksVariacoesli: [{ ...LINK, variationOptions: [opcao(37097, ['v1'], 'P')] }] }),
    );
    await renderPage();
    await abrirAba('Loja Integrada');
    await alternarVariante('P', 'M'); // a valid edit

    // The other writer's version holds a half-made entry: this save never touched it.
    escritaConcorrente((doc) => {
      doc.linksVariacoesli = [...(doc.linksVariacoesli as Doc[]), MEIA_BOCA, OUTRA_CONTA];
    });
    await act(async () => rerenderPage());
    await salvar();
    expect(conflito()).toBeTruthy();
    await clicar(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await esperar();

    expect(recusado()).toBe(false);
    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesli).toEqual([
      { ...LINK, variationOptions: [opcao(37097, ['v1', 'v2'], 'P')] },
      MEIA_BOCA,
      OUTRA_CONTA,
    ]);
  });

  it('⚠️ a collision met while saving from ANOTHER tab takes the operator to the links and says nothing was saved', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Loja Integrada');
    await alternarVariante('G', 'G'); // mine: G emptied
    await renomear('Tamanhos (meu)'); // …and the save is clicked from "Dados gerais"

    const remoto = escritaConcorrente((doc) => {
      doc.linksVariacoesli = [{ ...LINK, variationOptions: [opcao(37097, ['v1', 'v2'], 'P')] }];
    });
    await act(async () => rerenderPage());
    await salvar();
    await clicar(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await esperar();

    expect(commits()).toBe(0);
    expect(guardado()).toEqual(remoto);
    expect(screen.getByRole('tab', { name: 'Loja Integrada' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(h.toasts.at(-1)).toContain('Nada foi salvo');
    expect(h.toasts.at(-1)).toContain('“Vínculos da Loja Integrada”');
    expect(within(cartao()).getByText(/Alterado por outra pessoa/)).toBeTruthy();
  });

  it('⚠️ remove-then-undo of a link the other writer REMOVED does not bring it back on save', async () => {
    semear(grupo());
    await renderPage();
    await abrirAba('Loja Integrada');
    await alternarVariante('G', 'G'); // mine: G emptied

    // The other writer removed the very link this operator changed.
    escritaConcorrente((doc) => {
      doc.linksVariacoesli = [OUTRA_CONTA];
    });
    await act(async () => rerenderPage());
    await salvar();
    await clicar(screen.getByRole('button', { name: 'Recarregar do servidor' }));
    expect(within(cartao()).getByText(/Removido por outra pessoa/)).toBeTruthy();

    // Trash, then undo: not an edit — the note stays, so the save still drops it.
    await clicar(within(cartao()).getByRole('button', { name: 'Remover vínculo' }));
    await clicar(within(cartao()).getByRole('button', { name: 'Desfazer remoção' }));
    expect(within(cartao()).getByText(/Removido por outra pessoa/)).toBeTruthy();
    await renomear('Tamanhos (meu)');
    await salvar();

    expect(commits()).toBe(1);
    expect(guardado().linksVariacoesli).toEqual([OUTRA_CONTA]);
  });
});
