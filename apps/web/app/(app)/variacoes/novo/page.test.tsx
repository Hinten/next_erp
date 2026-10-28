import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import { CODIGO_ERRO_LI, INTEGRACAO_TIPO, grupoDeVariacoesSchema } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * `/variacoes/novo?copyFrom=<id>` — the list's "copiar" action — through the
 * REAL page, the REAL `ObjectView` + `saveRecord` and the REAL Loja Integrada
 * tab and `validate`, over an OCC FakeDb (`@delfrance/data/testing`).
 *
 * A copy starts with NO Loja Integrada links. A create writes every field, so a
 * copied link would be CREATED by that save — yet it would arrive as the form's
 * seed, count as untouched and skip every check a created link must pass; and a
 * valid one would put the same store grade and options in two grupos, which the
 * publish and the import treat as ambiguous for BOTH. The operator links the new
 * grupo instead.
 *
 * Doubled are only the I/O edges: the snapshot hook (the copy source), the
 * create's new document ref, `runTransaction`, the conta list, and the Loja
 * Integrada backend (switched off).
 */

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  occ: null as unknown as import('@delfrance/data/testing').OccEngine,
  replace: vi.fn(),
  toasts: [] as string[],
  grades: vi.fn(),
  grade: vi.fn(),
}));

const ORIGEM = 'grupoDeVariacoes/origem';
const NOVO = 'grupoDeVariacoes/novo1';

vi.mock('@/lib/data/grupoDeVariacoesCollection', () => ({
  grupoDeVariacoesCollection: {
    resolvePath: () => 'grupoDeVariacoes',
    ref: () => ({ __col: 'grupoDeVariacoes' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({
      path: `grupoDeVariacoes/${id}`,
      id,
    }),
    converter: {},
    merge: vi.fn(),
  },
}));

vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useDocSnapshot: (ref: { path: string } | null) => {
    const raw = ref == null ? undefined : h.docs.get(ref.path);
    if (ref == null || raw === undefined) return { data: undefined, loading: false };
    return {
      data: {
        id: ref.path.split('/')[1],
        data: grupoDeVariacoesSchema.parse(structuredClone(raw)),
      },
      loading: false,
      error: undefined,
      fromCache: false,
      hasPendingWrites: false,
      documentPath: ref.path,
    };
  },
}));

vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.occ.runTransaction(fn),
  // The create's freshly minted document.
  collection: (_db: unknown, path: string) => ({
    path,
    withConverter() {
      return this;
    },
  }),
  doc: (col: { path: string }) => ({ path: `${col.path}/novo1`, id: 'novo1' }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true, loading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('copyFrom=origem'),
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
      query: { error: null },
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

const { default: NovoGrupoVariacaoPage } = await import('./page');
const { LojaIntegradaClientHttpError } = await import('@/lib/loja-integrada/client');

const variante = (id: string, nome: string) => ({ id, nome, codigo: null });

/** A valid link of the active conta. */
const LINK: Doc = {
  name: 'Tamanho',
  grade_id: 8946,
  integracaoLiId: 'CONTA1',
  variationOptions: [{ li_option_id: 37097, li_option_name: 'P', arakene_variation_id: ['v1'] }],
};
/** A half-made legacy entry (no grade). */
const MEIA_BOCA: Doc = { integracaoLiId: 'CONTA1' };

const ORIGINAL: Doc = {
  nome: 'Tamanhos',
  codigo: null,
  ordem: 1,
  tipo: 1,
  permiteFotos: false,
  timestamp: 1_700_000_000_000,
  ultimaModificacao: 1_700_000_000_000,
  variacoesIds: ['v1', 'v2'],
  variacoes: [variante('v1', 'P'), variante('v2', 'M')],
  linksVariacoesli: [MEIA_BOCA, LINK],
};

async function esperar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  h.docs.clear();
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

describe('/variacoes/novo?copyFrom — a copy never carries the Loja Integrada links', () => {
  it('the copy is created with every other field copied, and NO Loja Integrada link', async () => {
    h.docs.set(ORIGEM, structuredClone(ORIGINAL));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MantineTestProvider>
          <NovoGrupoVariacaoPage />
        </MantineTestProvider>
      </QueryClientProvider>,
    );
    await esperar();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    });
    await esperar();

    const criado = h.docs.get(NOVO);
    expect(criado).toBeDefined();
    // EQUAL: the rest of the grupo is copied.
    expect(criado?.nome).toBe('Tamanhos');
    expect(criado?.variacoes).toEqual(ORIGINAL.variacoes);
    // NEAR-MISS: the links are not — neither the valid one nor the half-made one.
    expect(criado?.linksVariacoesli).toBeNull();
    // …and the source is untouched.
    expect(h.docs.get(ORIGEM)?.linksVariacoesli).toEqual([MEIA_BOCA, LINK]);
  });
});
