import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import {
  INTEGRACAO_TIPO,
  tabelaDeMedidasSchema,
  type EntradaTabelaShopee,
} from '@delfrance/schemas';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import type { EscolherTabelaShopeeModalProps } from './EscolherTabelaShopeeModal';

/**
 * What this file pins that `tabelasMedidasForm.test.ts` cannot: that the TAB
 * wires the pure helpers to the form — every action reaches `onChange` and
 * nothing else, mounting reaches nothing, the live reads land on the right row —
 * and that `/medidas/[id]` renders the field with the helpers' `prepareForSave`.
 * The helpers' own grids (raw preservation, the selector, mark/unmark) live in
 * their suite; the modal and the browser in theirs (stubbed here).
 */

const h = vi.hoisted(() => ({
  canRead: true,
  permsLoading: false,
  hasClient: true,
  contas: [] as unknown[],
  /** The contas snapshot's own state: still loading, or failed (permission-denied, offline). */
  contasLoading: false,
  contasErro: undefined as Error | undefined,
  consultas: [] as unknown[],
  categorias: vi.fn(),
  detalhe: vi.fn(),
  escolha: null as EntradaTabelaShopee | null,
  setValor: null as ((v: unknown) => void) | null,
  pagina: null as {
    sections?: string[];
    excludedFields?: string[];
    fields?: Record<string, FieldConfig>;
  } | null,
}));

// `ref` runs inside `useMemo` at render time; the real one calls the SDK.
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { ref: () => ({ __col: 'integracao' }) },
}));

// The constraints are recorded so the query SHAPE can be asserted. Partial:
// `@delfrance/ui` and the collection handles import the rest at module scope.
vi.mock('@delfrance/data', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data')>()),
  buildQuery: (base: object, cs: unknown[]) => ({ ...base, cs }),
  limit: (n: number) => ({ op: 'limit', n }),
  whereEqual: (campo: string, valor: unknown) => ({ op: 'where', campo, valor }),
}));

vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useSnapshot: (q: unknown) => {
    h.consultas.push(q);
    if (q == null) return { data: undefined, loading: false, error: undefined };
    if (h.contasLoading) return { data: undefined, loading: true, error: undefined };
    if (h.contasErro !== undefined) return { data: undefined, loading: false, error: h.contasErro };
    return { data: h.contas, loading: false, error: undefined };
  },
}));

// `loading` is answered EXPLICITLY (the ML manager test's note on why).
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: (bit: bigint) => ({
    allowed: bit === PERM.integracao.read ? h.canRead : true,
    loading: h.permsLoading,
  }),
}));

// The REAL error classes stay: `erros.ts` narrows on them.
vi.mock('@/lib/shopee/client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shopee/client')>()),
  useShopeeClient: () =>
    h.hasClient ? { categorias: h.categorias, tabelaMedidasDetalhe: h.detalhe } : null,
}));

/**
 * The modal has its own suite. Here it is a stub showing what the TAB hands it
 * (`alvo`, the rows) and answering with `h.escolha`; the hooks and keys the
 * module exports stay real, so the cards read the same cache the modal fills.
 */
vi.mock('./EscolherTabelaShopeeModal', async (importActual) => ({
  ...(await importActual<typeof import('./EscolherTabelaShopeeModal')>()),
  EscolherTabelaShopeeModal: (props: EscolherTabelaShopeeModalProps) => (
    <div data-testid="modal-stub">
      <span data-testid="modal-alvo">{JSON.stringify(props.alvo)}</span>
      <span data-testid="modal-linhas">
        {props.linhas.map((l) => `${String(l.indice)}:${l.papel}`).join(',')}
      </span>
      <span>{props.contaNome}</span>
      <button type="button" onClick={() => h.escolha && props.onConfirmar(h.escolha)}>
        stub confirmar
      </button>
      <button type="button" onClick={props.onFechar}>
        stub fechar
      </button>
    </div>
  ),
}));

// ── page wiring stubs (the `/medidas/[id]` describe at the end) ──
vi.mock('@delfrance/ui', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/ui')>()),
  ObjectView: (props: NonNullable<typeof h.pagina>) => {
    h.pagina = props;
    return null;
  },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'tab-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
  getFirebaseStorage: () => ({}),
}));
vi.mock('@delfrance/storage', () => ({ uploadTabMediImage: vi.fn() }));
vi.mock('@/components/photo-manager/PhotoManager', () => ({ PhotoManager: () => null }));
vi.mock('./MedidasMercadoLivreManager', () => ({ MedidasMercadoLivreManager: () => null }));

const { MedidasShopeeManager } = await import('./MedidasShopeeManager');
const { ShopeeClientHttpError } = await import('@/lib/shopee/client');
const { MENSAGEM_TABELA_INEXISTENTE } = await import('@/lib/shopee/erros');
const { marcarRemocao, prepararTabelasShopeeParaSalvar } =
  await import('@/lib/shopee/tabelasMedidasForm');
const { MEDIDA_EXCLUDED_FIELDS, MEDIDA_EXCLUDED_FIELDS_EDITAR, MEDIDA_SECTIONS } =
  await import('./medidaFields');
const { default: TabelaDeMedidasPage } = await import('../[id]/page');

// ── fixtures (Shopee's doc-sample ids; contas are fixture ids) ──

const CONTA = 'int-1';
const CONTA_2 = 'int-2';

function conta(id: string, nome: string, ativo = true) {
  return { id, path: `integracao/${id}`, data: { nome, ativo, tipo: INTEGRACAO_TIPO.shopee } };
}

const CAMISETAS: EntradaTabelaShopee = {
  categoryId: 100087,
  size_chart_id: 700024639,
  name: 'Camisetas',
};
const CAMISETAS_COPIA: EntradaTabelaShopee = {
  categoryId: 100087,
  size_chart_id: 700024641,
  name: '(Cópia) Camisetas',
};
const CALCAS: EntradaTabelaShopee = {
  categoryId: 400055,
  size_chart_id: 700024613,
  name: 'Calças',
};

/** Ids the detail mock answers with a FAILURE. */
const ID_INEXISTENTE = CAMISETAS_COPIA.size_chart_id;
const ID_LIMITADO = 700024642;
/** A category id the categorias mock answers 404 `SHOPEE_CATEGORIA_DESCONHECIDA`. */
const CATEGORIA_SUMIDA = 100099;

const resumo = (categoryId: number, name: string, isLeaf: boolean) => ({
  categoryId,
  name,
  originalName: null,
  isLeaf,
});
const ROUPAS = resumo(100011, 'Roupas', false);

function no(categoryId: number, name: string, isLeaf: boolean) {
  const self = resumo(categoryId, name, isLeaf);
  return {
    raizes: null,
    no: { ...self, parentId: ROUPAS.categoryId, pathFromRoot: [ROUPAS, self], children: [] },
  };
}

function tabelaProjetada(sizeChartId: number, sizeChartName: string | null) {
  const celula = (value: number) => ({
    tipo: 'numero',
    option: null,
    value,
    minValue: null,
    maxValue: null,
  });
  return {
    tabela: {
      sizeChartId,
      sizeChartName,
      colunas: [
        {
          displayName: 'Busto',
          inputType: 'Input Single Number',
          unit: 'cm',
          celulas: [celula(90), celula(96), celula(102)],
        },
      ],
      linhas: [[celula(90)], [celula(96)], [celula(102)]],
      problemas: [],
    },
  };
}

function falha(status: number, code: string, kind: string | null = null) {
  return new ShopeeClientHttpError(`HTTP ${String(status)}`, status, code, null, kind);
}

beforeEach(() => {
  h.canRead = true;
  h.permsLoading = false;
  h.hasClient = true;
  h.contas = [conta(CONTA, 'Loja Teste'), conta(CONTA_2, 'Loja Antiga', false)];
  h.contasLoading = false;
  h.contasErro = undefined;
  h.consultas = [];
  h.escolha = null;
  h.setValor = null;
  h.pagina = null;
  h.categorias.mockReset();
  h.detalhe.mockReset();
  h.categorias.mockImplementation(({ categoryId }: { categoryId: number }) => {
    if (categoryId === CATEGORIA_SUMIDA) {
      return Promise.reject(falha(404, 'SHOPEE_CATEGORIA_DESCONHECIDA'));
    }
    if (categoryId === CALCAS.categoryId) return Promise.resolve(no(categoryId, 'Calças', false));
    return Promise.resolve(no(categoryId, 'Camisetas', true));
  });
  h.detalhe.mockImplementation(({ sizeChartId }: { sizeChartId: number }) => {
    if (sizeChartId === ID_INEXISTENTE) {
      return Promise.reject(falha(404, 'SHOPEE_TABELA_MEDIDAS_INEXISTENTE'));
    }
    if (sizeChartId === ID_LIMITADO) {
      return Promise.reject(falha(502, 'SHOPEE_HTTP_ERROR', 'burst'));
    }
    return Promise.resolve(tabelaProjetada(sizeChartId, `Tabela ${String(sizeChartId)}`));
  });
});

function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS }));
  return (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
}

/** A host that OWNS the value like the form does: each `onChange` is recorded, then applied. */
function show(valor: unknown, opts: { disabled?: boolean } = {}) {
  const onChange = vi.fn<(next: unknown) => void>();
  function Host() {
    const [atual, setAtual] = useState<unknown>(valor);
    // The test's handle for "the form was re-seeded from server truth".
    useEffect(() => {
      h.setValor = setAtual;
    }, []);
    return (
      <MedidasShopeeManager
        db={{} as Firestore}
        value={atual}
        onChange={(next) => {
          onChange(next);
          setAtual(next);
        }}
        disabled={opts.disabled}
      />
    );
  }
  const ui: ReactElement = (
    <Providers>
      <Host />
    </Providers>
  );
  return { ...render(ui), onChange };
}

const linhaDe = (conta: string, indice: number) =>
  screen.getByTestId(`shopee-medida-entrada-${conta}-${String(indice)}`);
const botao = (el: HTMLElement, nome: string) =>
  within(el).getByRole('button', { name: nome }) as HTMLButtonElement;
const ultimo = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.at(-1)?.[0];

/** Waits until every queried row has settled (name or failure painted). */
async function esperarDetalhes(n: number) {
  await waitFor(() => expect(h.detalhe).toHaveBeenCalledTimes(n));
}

describe('MedidasShopeeManager — gates', () => {
  it('ranks the permission loading FIRST: a loader, never the permission text, no query', () => {
    h.permsLoading = true;
    h.canRead = false;
    const { container } = show({ [CONTA]: [CAMISETAS] });
    expect(container.querySelector('.mantine-Loader-root')).not.toBeNull();
    expect(screen.queryByText(/Requer permissão/)).toBeNull();
    expect(h.consultas.every((q) => q == null)).toBe(true);
    expect(h.detalhe).not.toHaveBeenCalled();
  });

  it('without integracao.read: the permission text, no contas query, no Shopee read', async () => {
    h.canRead = false;
    show({ [CONTA]: [CAMISETAS] });
    expect(
      await screen.findByText(
        'Requer permissão de leitura em integrações para ver as contas Shopee.',
      ),
    ).toBeTruthy();
    expect(h.consultas.every((q) => q == null)).toBe(true);
    expect(h.categorias).not.toHaveBeenCalled();
    expect(h.detalhe).not.toHaveBeenCalled();
  });

  it('while the contas LOAD: a loader — never a flash of "Nenhuma conta Shopee cadastrada"', () => {
    h.contasLoading = true;
    const { container } = show({ [CONTA]: [CAMISETAS] });
    expect(container.querySelector('.mantine-Loader-root')).not.toBeNull();
    expect(screen.queryByText(/Nenhuma conta Shopee cadastrada/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Cadastrar em Canais de venda' })).toBeNull();
  });

  it('a FAILED contas snapshot is an error — never "Nenhuma conta Shopee cadastrada" inviting a re-register', () => {
    h.contasErro = new Error('Missing or insufficient permissions.');
    show({ [CONTA]: [CAMISETAS] });
    expect(
      screen.getByText('Erro ao carregar as contas Shopee: Missing or insufficient permissions.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Nenhuma conta Shopee cadastrada/)).toBeNull();
  });

  it('signed out (no Shopee client): rows are shown but nothing can be staged', () => {
    h.hasClient = false;
    show({ [CONTA]: [CAMISETAS, { size_chart_id: 1 }] });
    expect(botao(screen.getByTestId(`shopee-medida-conta-${CONTA}`), 'Adicionar').disabled).toBe(
      true,
    );
    expect(botao(linhaDe(CONTA, 0), 'Trocar').disabled).toBe(true);
    expect(botao(linhaDe(CONTA, 0), 'Remover').disabled).toBe(true);
    expect(botao(linhaDe(CONTA, 1), 'Remover').disabled).toBe(true);
    // Near-miss: with a client the same rows are editable.
    cleanup();
    h.hasClient = true;
    show({ [CONTA]: [CAMISETAS] });
    expect(botao(linhaDe(CONTA, 0), 'Trocar').disabled).toBe(false);
  });

  it('asks for EVERY Shopee conta: tipo == shopee, limit 50, no ativo filter', () => {
    show(null);
    const q = h.consultas.find((c) => c != null);
    expect(q).toEqual({
      __col: 'integracao',
      cs: [
        { op: 'where', campo: 'tipo', valor: INTEGRACAO_TIPO.shopee },
        { op: 'limit', n: 50 },
      ],
    });
  });
});

describe('MedidasShopeeManager — cards and rows', () => {
  it('one card per conta; an inactive one is badged "inativa" and still shown', () => {
    show(null);
    const ativa = screen.getByTestId(`shopee-medida-conta-${CONTA}`);
    const inativa = screen.getByTestId(`shopee-medida-conta-${CONTA_2}`);
    expect(within(inativa).getByText('Loja Antiga')).toBeTruthy();
    expect(within(inativa).getByText('inativa')).toBeTruthy();
    // Near-miss: an active conta carries no badge.
    expect(within(ativa).queryByText('inativa')).toBeNull();
    expect(within(ativa).getByText('Nenhuma tabela escolhida para esta conta.')).toBeTruthy();
  });

  it('a pick shows the live category path and template name; a later duplicate reads "ignorada"', async () => {
    show({ [CONTA]: [CAMISETAS, CAMISETAS_COPIA] });
    const primeira = linhaDe(CONTA, 0);
    expect(await within(primeira).findByText('Roupas › Camisetas')).toBeTruthy();
    expect(await within(primeira).findByText('Tabela 700024639')).toBeTruthy();
    expect(within(primeira).getByText('#700024639')).toBeTruthy();
    expect(within(primeira).getByText('#100087')).toBeTruthy();
    expect(primeira.getAttribute('data-papel')).toBe('usada');
    expect(within(primeira).queryByText(/ignorada/)).toBeNull();

    const segunda = linhaDe(CONTA, 1);
    expect(segunda.getAttribute('data-papel')).toBe('ignorada-duplicada');
    expect(
      within(segunda).getByText('ignorada — outra entrada desta categoria vem antes'),
    ).toBeTruthy();
    expect(h.detalhe).toHaveBeenCalledWith({ integracaoId: CONTA, sizeChartId: 700024639 });
    expect(h.categorias).toHaveBeenCalledWith({ integracaoId: CONTA, categoryId: 100087 });
  });

  it('a template the shop no longer has reads "escolha outra" and turns Trocar red; a rate limit does NOT', async () => {
    // Both rows sit in LEAF categories, so only the template read can turn Trocar red.
    show({
      [CONTA]: [
        CAMISETAS_COPIA,
        { categoryId: 100088, size_chart_id: ID_LIMITADO, name: 'Bermudas' },
      ],
    });
    const velha = linhaDe(CONTA, 0);
    // ONE sentence: the constant `descreverFalhaShopee` answers for the same code.
    expect(await within(velha).findByText(MENSAGEM_TABELA_INEXISTENTE)).toBeTruthy();
    expect(botao(velha, 'Trocar').disabled).toBe(false);
    expect(botao(velha, 'Trocar').getAttribute('data-variant')).toBe('filled');
    // Near-miss: a 502 rate limit on a sibling row is the rate-limit copy, never "não existe".
    const limitada = linhaDe(CONTA, 1);
    expect(
      await within(limitada).findByText('A Shopee limitou as consultas — tente em alguns minutos.'),
    ).toBeTruthy();
    expect(within(limitada).queryByText(/não existe mais na loja/)).toBeNull();
    expect(botao(limitada, 'Trocar').getAttribute('data-variant')).toBe('light');
  });

  it('NEAR-MISS: a detail 404 WITHOUT the code (a backend predating the route) is not "não existe mais na loja"', async () => {
    h.detalhe.mockImplementation(() =>
      Promise.reject(
        new ShopeeClientHttpError('A integração não respondeu (HTTP 404).', 404, null),
      ),
    );
    show({ [CONTA]: [CAMISETAS] });
    const linha = linhaDe(CONTA, 0);
    expect(await within(linha).findByText('A integração não respondeu (HTTP 404).')).toBeTruthy();
    expect(within(linha).queryByText(/não existe mais na loja/)).toBeNull();
    expect(botao(linha, 'Trocar').getAttribute('data-variant')).toBe('light');
  });

  it('dead entries (legacy non-leaf, gone from the tree) say what to do and turn Trocar red like a stale chart', async () => {
    show({
      [CONTA]: [
        CALCAS,
        { ...CAMISETAS, categoryId: CATEGORIA_SUMIDA, name: 'Guardada' },
        CAMISETAS,
      ],
    });
    const naoFolha = linhaDe(CONTA, 0);
    expect(await within(naoFolha).findByText('categoria não-folha (legado)')).toBeTruthy();
    expect(
      within(naoFolha).getByText('nunca é usada na publicação — troque ou remova'),
    ).toBeTruthy();
    expect(botao(naoFolha, 'Trocar').getAttribute('data-variant')).toBe('filled');
    const sumida = linhaDe(CONTA, 1);
    expect(
      await within(sumida).findByText('categoria não existe mais na árvore desta conta'),
    ).toBeTruthy();
    expect(within(sumida).getByText('nunca é usada na publicação — troque ou remova')).toBeTruthy();
    expect(botao(sumida, 'Trocar').getAttribute('data-variant')).toBe('filled');
    // The label stored at pick time stands in for the path the tree no longer has.
    expect(within(sumida).getByText('Guardada')).toBeTruthy();
    // Near-miss: a leaf carries no legacy badge, no action line, and a plain Trocar.
    const folha = linhaDe(CONTA, 2);
    expect(await within(folha).findByText('Roupas › Camisetas')).toBeTruthy();
    expect(within(folha).queryByText('categoria não-folha (legado)')).toBeNull();
    expect(within(folha).queryByText(/troque ou remova/)).toBeNull();
    expect(botao(folha, 'Trocar').getAttribute('data-variant')).toBe('light');
  });

  it('NEAR-MISS: a rate-limited CATEGORY read is the rate-limit copy — never "não existe mais na árvore", never a dead entry', async () => {
    h.categorias.mockImplementation(() => Promise.reject(falha(502, 'SHOPEE_HTTP_ERROR', 'burst')));
    show({ [CONTA]: [CAMISETAS] });
    const linha = linhaDe(CONTA, 0);
    expect(
      await within(linha).findByText('A Shopee limitou as consultas — tente em alguns minutos.'),
    ).toBeTruthy();
    expect(within(linha).queryByText(/não existe mais na árvore/)).toBeNull();
    expect(within(linha).queryByText(/troque ou remova/)).toBeNull();
    expect(botao(linha, 'Trocar').getAttribute('data-variant')).toBe('light');
    expect(within(linha).getByText('Camisetas')).toBeTruthy();
  });

  it('a stored EMPTY name stands in as "Categoria <id>" (THE label) when the tree cannot answer', async () => {
    h.categorias.mockImplementation(() =>
      Promise.reject(falha(404, 'SHOPEE_CATEGORIA_DESCONHECIDA')),
    );
    show({
      [CONTA]: [
        { ...CAMISETAS, name: '' },
        { ...CALCAS, name: 'Calças guardada' },
      ],
    });
    const vazia = linhaDe(CONTA, 0);
    expect(
      await within(vazia).findByText('categoria não existe mais na árvore desta conta'),
    ).toBeTruthy();
    expect(within(vazia).getByText('Categoria 100087')).toBeTruthy();
    // Near-miss: a stored name is shown as stored.
    expect(within(linhaDe(CONTA, 1)).getByText('Calças guardada')).toBeTruthy();
  });

  it('a repeatable row failure (503) offers "Tentar de novo", which reads again; an unnamed template reads "Sem nome"', async () => {
    let n = 0;
    h.detalhe.mockImplementation(({ sizeChartId }: { sizeChartId: number }) => {
      n += 1;
      // The predicate's own two retries run first; the operator's click is the 4th read.
      return n <= 3
        ? Promise.reject(falha(503, 'SHOPEE_NETWORK_ERROR'))
        : Promise.resolve(tabelaProjetada(sizeChartId, null));
    });
    show({ [CONTA]: [CAMISETAS] });
    const linha = linhaDe(CONTA, 0);
    fireEvent.click(
      await within(linha).findByRole('button', { name: 'Tentar de novo' }, { timeout: 8000 }),
    );
    expect(await within(linha).findByText('Sem nome')).toBeTruthy();
    expect(n).toBe(4);
  }, 12_000);

  it('NEAR-MISS: a non-repeatable row failure (a rate limit) offers no "Tentar de novo"', async () => {
    show({ [CONTA]: [{ ...CALCAS, size_chart_id: ID_LIMITADO }] });
    const linha = linhaDe(CONTA, 0);
    await within(linha).findByText('A Shopee limitou as consultas — tente em alguns minutos.');
    expect(within(linha).queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('each unreadable motivo has its own operator words', () => {
    show({
      [CONTA]: [
        { categoryId: 100087, size_chart_id: '1', name: 'x' },
        { categoryId: 100087, size_chart_id: 1, name: 2 },
        { size_chart_id: 1 },
      ],
    });
    expect(within(linhaDe(CONTA, 0)).getByText('ilegível (id da tabela inválido)')).toBeTruthy();
    expect(within(linhaDe(CONTA, 1)).getByText('ilegível (nome inválido)')).toBeTruthy();
    expect(within(linhaDe(CONTA, 2)).getByText('ilegível (categoria inválida)')).toBeTruthy();
  });

  it('unreadable entries are shown and kept: an object can be marked, a non-object has no action', async () => {
    const { onChange } = show({ [CONTA]: [{ size_chart_id: 1 }, null, CAMISETAS] });
    const objeto = linhaDe(CONTA, 0);
    expect(within(objeto).getByText('ilegível (categoria inválida)')).toBeTruthy();
    expect(objeto.getAttribute('data-papel')).toBe('ilegivel');
    expect(within(objeto).queryByRole('button', { name: 'Trocar' })).toBeNull();
    const naoObjeto = linhaDe(CONTA, 1);
    expect(within(naoObjeto).getByText('ilegível (mantida)')).toBeTruthy();
    expect(within(naoObjeto).queryAllByRole('button')).toHaveLength(0);
    await esperarDetalhes(1);
    // Only the readable row is read live.
    expect(h.detalhe).toHaveBeenCalledWith({ integracaoId: CONTA, sizeChartId: 700024639 });
    expect(h.categorias).toHaveBeenCalledTimes(1);

    fireEvent.click(botao(objeto, 'Remover'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ultimo(onChange)).toEqual({
      [CONTA]: [{ size_chart_id: 1, _pendingDelete: true }, null, CAMISETAS],
    });
    expect(linhaDe(CONTA, 0).getAttribute('data-papel')).toBe('sera-removida');
  });

  it('entries under keys that name no conta are counted and kept', () => {
    show({ [CONTA]: [CAMISETAS], 'conta-sumida': [CALCAS, CAMISETAS], 'outra-sumida': null });
    expect(screen.getByTestId('shopee-medida-contas-ausentes').textContent).toBe(
      '2 entrada(s) de contas que não existem mais (mantidas)',
    );
  });

  it('a per-conta value it cannot read (lista-invalida) offers no edit, and says — truly — that the save keeps it', () => {
    show({ [CONTA]: 'x', [CONTA_2]: [] });
    const invalida = screen.getByTestId(`shopee-medida-conta-${CONTA}`);
    expect(
      within(invalida).getByText(
        'O valor guardado para esta conta não é legível e não pode ser editado aqui — ao salvar a tabela, ele é gravado de volta como está.',
      ),
    ).toBeTruthy();
    expect(within(invalida).queryByText(/não pode ser salva/)).toBeNull();
    expect(within(invalida).queryByRole('button', { name: 'Adicionar' })).toBeNull();
    // The copy's claim, held against the two rules it depends on: the base
    // schema takes the value, and the field's prepareForSave carries it verbatim.
    const mapa = { [CONTA]: 'x', [CONTA_2]: { a: 1 } };
    expect(tabelaDeMedidasSchema.shape.tabelasMedidasShopee.safeParse(mapa).success).toBe(true);
    expect(prepararTabelasShopeeParaSalvar(mapa)).toEqual(mapa);
    // Near-miss: an EMPTY list is editable.
    const vazia = screen.getByTestId(`shopee-medida-conta-${CONTA_2}`);
    expect(botao(vazia, 'Adicionar').disabled).toBe(false);
  });

  it('a field that is not a map (campo-invalido) offers no edit on any conta, and says it blocks the save', () => {
    show([CAMISETAS]);
    for (const id of [CONTA, CONTA_2]) {
      const card = screen.getByTestId(`shopee-medida-conta-${id}`);
      expect(
        within(card).getByText(
          'O valor guardado para a Shopee nesta tabela não é legível e não pode ser editado aqui — enquanto ele existir, a tabela não pode ser salva. Peça a correção do documento.',
        ),
      ).toBeTruthy();
      expect(within(card).queryByText(/gravado de volta como está/)).toBeNull();
      expect(within(card).queryByRole('button', { name: 'Adicionar' })).toBeNull();
    }
    // The copy's claim, held against the rule it depends on: the base schema
    // still REFUSES a non-map field (so the whole-schema resolver blocks a save).
    for (const valor of [[CAMISETAS], 'x', 42]) {
      expect(tabelaDeMedidasSchema.shape.tabelasMedidasShopee.safeParse(valor).success).toBe(false);
    }
  });

  it('no Shopee conta: the empty copy, and stored entries still counted', () => {
    h.contas = [];
    show({ [CONTA]: [CAMISETAS] });
    expect(screen.getByText(/Nenhuma conta Shopee cadastrada/)).toBeTruthy();
    expect(screen.getByTestId('shopee-medida-contas-ausentes').textContent).toMatch(/^1 /);
  });
});

describe('MedidasShopeeManager — staged edits', () => {
  it('mounting never calls onChange — a null map and a per-key null stay as they are', async () => {
    const nulo = show(null);
    expect(screen.getAllByText('Nenhuma tabela escolhida para esta conta.')).toHaveLength(2);
    nulo.unmount();
    const porChave = show({ [CONTA]: null, [CONTA_2]: [CAMISETAS] });
    await esperarDetalhes(1);
    await screen.findByText('Tabela 700024639');
    expect(nulo.onChange).not.toHaveBeenCalled();
    expect(porChave.onChange).not.toHaveBeenCalled();
  });

  it('Remover stages a mark (dimmed, "Será excluída", Desfazer); Desfazer gives back the loaded value', () => {
    const carregado = { [CONTA]: [CAMISETAS, CALCAS], [CONTA_2]: null };
    const { onChange } = show(carregado);
    fireEvent.click(botao(linhaDe(CONTA, 1), 'Remover'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ultimo(onChange)).toEqual({
      [CONTA]: [CAMISETAS, { ...CALCAS, _pendingDelete: true }],
      [CONTA_2]: null,
    });
    const marcada = linhaDe(CONTA, 1);
    expect(within(marcada).getByText('Será excluída')).toBeTruthy();
    expect(marcada.getAttribute('style')).toMatch(/opacity/);
    expect(within(marcada).queryByRole('button', { name: 'Remover' })).toBeNull();

    fireEvent.click(botao(marcada, 'Desfazer'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(ultimo(onChange)).toEqual(carregado);
    expect(within(linhaDe(CONTA, 1)).queryByText('Será excluída')).toBeNull();
  });

  it('an UNREADABLE row staged for removal can be undone — Desfazer gives back the loaded value (rule 8: a legacy element)', () => {
    const carregado = { [CONTA]: [{ size_chart_id: 1 }, CAMISETAS] };
    const { onChange } = show(carregado);
    fireEvent.click(botao(linhaDe(CONTA, 0), 'Remover'));
    expect(linhaDe(CONTA, 0).getAttribute('data-papel')).toBe('sera-removida');
    expect(within(linhaDe(CONTA, 0)).getByText('Será excluída')).toBeTruthy();

    fireEvent.click(botao(linhaDe(CONTA, 0), 'Desfazer'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(ultimo(onChange)).toEqual(carregado);
    expect(linhaDe(CONTA, 0).getAttribute('data-papel')).toBe('ilegivel');
    expect(within(linhaDe(CONTA, 0)).queryByText('Será excluída')).toBeNull();
  });

  it('the modal gets the rows of the conta whose card was clicked — never a sibling’s', () => {
    show({ [CONTA]: [CAMISETAS, CAMISETAS_COPIA], [CONTA_2]: [CALCAS] });
    fireEvent.click(botao(screen.getByTestId(`shopee-medida-conta-${CONTA_2}`), 'Adicionar'));
    expect(screen.getByTestId('modal-linhas').textContent).toBe('0:usada');
    fireEvent.click(screen.getByRole('button', { name: 'stub fechar' }));
    // …and the first card's, from the first card.
    fireEvent.click(botao(screen.getByTestId(`shopee-medida-conta-${CONTA}`), 'Adicionar'));
    expect(screen.getByTestId('modal-linhas').textContent).toBe('0:usada,1:ignorada-duplicada');
  });

  it('reopening the modal clears the "a lista mudou" notice', () => {
    show({ [CONTA]: [CAMISETAS, CALCAS] });
    h.escolha = { categoryId: 100087, size_chart_id: 700024645, name: 'Camisetas' };
    fireEvent.click(botao(linhaDe(CONTA, 0), 'Trocar'));
    act(() => h.setValor?.({ [CONTA]: [CALCAS, CAMISETAS] }));
    fireEvent.click(screen.getByRole('button', { name: 'stub confirmar' }));
    expect(screen.getByTestId('shopee-medida-aviso')).toBeTruthy();

    fireEvent.click(botao(screen.getByTestId(`shopee-medida-conta-${CONTA}`), 'Adicionar'));
    expect(screen.queryByTestId('shopee-medida-aviso')).toBeNull();
  });

  it('marking the first Camisetas entry promotes the second to usada (the selector, not a local loop)', () => {
    show({ [CONTA]: [CAMISETAS, CAMISETAS_COPIA] });
    expect(linhaDe(CONTA, 1).getAttribute('data-papel')).toBe('ignorada-duplicada');
    fireEvent.click(botao(linhaDe(CONTA, 0), 'Remover'));
    expect(linhaDe(CONTA, 0).getAttribute('data-papel')).toBe('sera-removida');
    expect(linhaDe(CONTA, 1).getAttribute('data-papel')).toBe('usada');
  });

  it('Adicionar on a category the conta covers REPLACES its row (Q6); another category appends', () => {
    const { onChange } = show({ [CONTA]: [CAMISETAS, CALCAS], [CONTA_2]: [CALCAS] });
    const card = screen.getByTestId(`shopee-medida-conta-${CONTA}`);

    fireEvent.click(botao(card, 'Adicionar'));
    expect(screen.getByTestId('modal-alvo').textContent).toBe(
      JSON.stringify({ tipo: 'adicionar' }),
    );
    expect(screen.getByTestId('modal-linhas').textContent).toBe('0:usada,1:usada');
    const slim = { categoryId: 100087, size_chart_id: 700024640, name: 'Camisetas' };
    h.escolha = slim;
    fireEvent.click(screen.getByRole('button', { name: 'stub confirmar' }));
    expect(screen.queryByTestId('modal-stub')).toBeNull();
    expect(ultimo(onChange)).toEqual({ [CONTA]: [slim, CALCAS], [CONTA_2]: [CALCAS] });

    // Near-miss: the neighbouring category id is a NEW row, appended.
    fireEvent.click(botao(card, 'Adicionar'));
    const vizinha = { categoryId: 100088, size_chart_id: 700024641, name: 'Pants' };
    h.escolha = vizinha;
    fireEvent.click(screen.getByRole('button', { name: 'stub confirmar' }));
    expect(ultimo(onChange)).toEqual({ [CONTA]: [slim, CALCAS, vizinha], [CONTA_2]: [CALCAS] });
  });

  it('the first pick on a tabela with no Shopee map creates it for this conta only', () => {
    const { onChange } = show(null);
    fireEvent.click(botao(screen.getByTestId(`shopee-medida-conta-${CONTA_2}`), 'Adicionar'));
    expect(
      screen.getByText('Loja Antiga', { selector: '[data-testid="modal-stub"] span' }),
    ).toBeTruthy();
    h.escolha = CALCAS;
    fireEvent.click(screen.getByRole('button', { name: 'stub confirmar' }));
    expect(ultimo(onChange)).toEqual({ [CONTA_2]: [CALCAS] });
  });

  it('closing the modal stages nothing', () => {
    const { onChange } = show({ [CONTA]: [CAMISETAS] });
    fireEvent.click(botao(screen.getByTestId(`shopee-medida-conta-${CONTA}`), 'Adicionar'));
    fireEvent.click(screen.getByRole('button', { name: 'stub fechar' }));
    expect(screen.queryByTestId('modal-stub')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Trocar opens on the row’s category and replaces it IN PLACE', () => {
    const { onChange } = show({ [CONTA]: [CAMISETAS, CALCAS] });
    fireEvent.click(botao(linhaDe(CONTA, 1), 'Trocar'));
    expect(JSON.parse(screen.getByTestId('modal-alvo').textContent ?? '')).toEqual({
      tipo: 'trocar',
      indice: 1,
      categoriaAtual: CALCAS.categoryId,
    });
    const nova = { categoryId: 400056, size_chart_id: 700024614, name: 'Bermudas' };
    h.escolha = nova;
    fireEvent.click(screen.getByRole('button', { name: 'stub confirmar' }));
    expect(ultimo(onChange)).toEqual({ [CONTA]: [CAMISETAS, nova] });
  });

  it('Trocar refuses when the clicked row changed under the open modal — and applies when it is equal', () => {
    const { onChange } = show({ [CONTA]: [CAMISETAS, CALCAS] });
    const nova = { categoryId: 100087, size_chart_id: 700024645, name: 'Camisetas' };
    h.escolha = nova;

    // EQUAL pair: a re-seed with an equal (fresh-object) list keeps the pick valid.
    fireEvent.click(botao(linhaDe(CONTA, 0), 'Trocar'));
    act(() => h.setValor?.({ [CONTA]: [{ ...CAMISETAS }, { ...CALCAS }] }));
    fireEvent.click(screen.getByRole('button', { name: 'stub confirmar' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ultimo(onChange)).toEqual({ [CONTA]: [nova, CALCAS] });

    // Near-miss: the slot now holds another template (id + 1) — nothing staged, the operator told.
    fireEvent.click(botao(linhaDe(CONTA, 0), 'Trocar'));
    act(() => h.setValor?.({ [CONTA]: [{ ...nova, size_chart_id: 700024646 }, CALCAS] }));
    fireEvent.click(screen.getByRole('button', { name: 'stub confirmar' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('shopee-medida-aviso').textContent).toMatch(/nada foi trocado/);
  });

  it('disabled: no Adicionar / Trocar / Remover / Desfazer — "Ver tabela" still reads', async () => {
    show({ [CONTA]: [CAMISETAS, { ...CALCAS, _pendingDelete: true }] }, { disabled: true });
    const card = screen.getByTestId(`shopee-medida-conta-${CONTA}`);
    expect(botao(card, 'Adicionar').disabled).toBe(true);
    const ativa = linhaDe(CONTA, 0);
    expect(botao(ativa, 'Trocar').disabled).toBe(true);
    expect(botao(ativa, 'Remover').disabled).toBe(true);
    expect(botao(linhaDe(CONTA, 1), 'Desfazer').disabled).toBe(true);
    const ver = await within(ativa).findByRole('button', { name: 'Ver tabela' });
    expect((ver as HTMLButtonElement).disabled).toBe(false);
  });

  it('"Ver tabela" draws the template read-only from the detail already fetched', async () => {
    show({ [CONTA]: [CAMISETAS] });
    const linha = linhaDe(CONTA, 0);
    fireEvent.click(await within(linha).findByRole('button', { name: 'Ver tabela' }));
    const grid = within(linha).getByTestId('shopee-tabela-grid');
    expect(within(grid).getAllByTestId(/^shopee-tabela-grid-linha-/)).toHaveLength(3);
    expect(h.detalhe).toHaveBeenCalledTimes(1);
    fireEvent.click(within(linha).getByRole('button', { name: 'Ocultar tabela' }));
    expect(within(linha).queryByTestId('shopee-tabela-grid')).toBeNull();
  });
});

describe('MedidasShopeeManager — inside the form', () => {
  /** The `FieldRenderer` shape: a `Controller` hands the manager the field's value/onChange. */
  function FormHost({ inicial }: { inicial: unknown }) {
    const form = useForm<{ tabelasMedidasShopee: unknown }>({
      defaultValues: { tabelasMedidasShopee: inicial },
    });
    return (
      <FormProvider {...form}>
        <Controller
          control={form.control}
          name="tabelasMedidasShopee"
          render={({ field }) => (
            <MedidasShopeeManager
              db={{} as Firestore}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <span data-testid="sujo">{String(form.formState.isDirty)}</span>
      </FormProvider>
    );
  }

  it('RT6 — mounting does not dirty the form, and mark → undo leaves it NOT dirty', async () => {
    render(
      <Providers>
        <FormHost inicial={{ [CONTA]: [CAMISETAS, CALCAS], [CONTA_2]: null }} />
      </Providers>,
    );
    await screen.findByText('Tabela 700024639');
    expect(screen.getByTestId('sujo').textContent).toBe('false');
    fireEvent.click(botao(linhaDe(CONTA, 0), 'Remover'));
    await waitFor(() => expect(screen.getByTestId('sujo').textContent).toBe('true'));
    fireEvent.click(botao(linhaDe(CONTA, 0), 'Desfazer'));
    await waitFor(() => expect(screen.getByTestId('sujo').textContent).toBe('false'));
  });
});

describe('/medidas/[id] — the Shopee tab is a form field (reconcile §2.6.6)', () => {
  it('renders tabelasMedidasShopee in a Shopee tab, drops marks on save, hands the manager the form value', async () => {
    render(
      <MantineTestProvider>
        <TabelaDeMedidasPage />
      </MantineTestProvider>,
    );
    const pagina = h.pagina;
    expect(pagina?.sections).toEqual([...MEDIDA_SECTIONS, 'Mercado Livre', 'Shopee']);
    expect(pagina?.excludedFields).toBe(MEDIDA_EXCLUDED_FIELDS_EDITAR);
    const campo = pagina?.fields?.tabelasMedidasShopee;
    expect(campo?.section).toBe('Shopee');
    expect(campo?.label).toBe('Shopee');
    // The SAME function the helper suite pins (marks dropped, everything else verbatim).
    expect(campo?.prepareForSave).toBe(prepararTabelasShopeeParaSalvar);
    const mapa = { [CONTA]: [CAMISETAS, CALCAS], 'conta-irma': [CALCAS] };
    expect(campo?.prepareForSave?.(marcarRemocao(mapa, CONTA, 0, true))).toEqual({
      [CONTA]: [CALCAS],
      'conta-irma': [CALCAS],
    });

    const onChange = vi.fn();
    const props: FieldRenderProps = {
      name: 'tabelasMedidasShopee',
      label: 'Shopee',
      value: mapa,
      onChange,
      onBlur: () => undefined,
      disabled: true,
      descriptor: {} as FieldRenderProps['descriptor'],
    };
    render(<Providers>{campo?.renderInput?.(props)}</Providers>);
    expect(await screen.findByText('Tabela 700024613')).toBeTruthy();
    expect(botao(screen.getByTestId(`shopee-medida-conta-${CONTA}`), 'Adicionar').disabled).toBe(
      true,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('novo keeps the Shopee map excluded; edit excludes exactly the rest', () => {
    expect(MEDIDA_EXCLUDED_FIELDS).toContain('tabelasMedidasShopee');
    expect(MEDIDA_EXCLUDED_FIELDS_EDITAR).not.toContain('tabelasMedidasShopee');
    expect(MEDIDA_EXCLUDED_FIELDS_EDITAR).toEqual(
      MEDIDA_EXCLUDED_FIELDS.filter((f) => f !== 'tabelasMedidasShopee'),
    );
    expect(MEDIDA_EXCLUDED_FIELDS_EDITAR).toContain('tabelasDeMedidasMercadoLivre');
  });
});
