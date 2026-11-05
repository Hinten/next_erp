import {
  Children,
  isValidElement,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { initializeApp } from 'firebase/app';
import { getFirestore, queryEqual, type Query } from 'firebase/firestore';
import { buildQuery, whereEqual } from '@delfrance/data';
import { AfterSaveBlockedError, type FieldConfig, type FieldRenderProps } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { MENSAGEM_RASCUNHO_SHOPEE_PENDENTE } from '@/lib/produtos/rascunhoShopeePendente';

/**
 * `/produtos/[id]/editar` — step 19's two web pieces (#1527, reconcile §2.10):
 *
 *  1. `deriveOnSave` switches «É kit virtual» off when «É kit» is off (O-8;
 *     M159's editar half, also pinned end-to-end by `produto-kit.cadastros`); the
 *     save transaction's `deriveTransactionPatch` re-applies the rule over the
 *     STORED doc, which is what holds when the form was painted from a stale
 *     cache copy — and the children kit-status sync reads the flip from that
 *     same transaction (`committed`), never from the form;
 *  2. the «É kit» field's NON-BLOCKING Shopee notice is fed by
 *     `useKitNativoShopee` over the kit ROOT (`paiId ?? id`) — the link decides,
 *     never the produto's `ehKitVirtual` (R-v; M160's page half).
 *
 * Plus #1911's leave-guard for the Shopee DRAFTS (P10, DC §2.8): the tab's
 * `onDirtyChange` arms `extraDirty`, and `onAfterSave` stops the navigation
 * AFTER the Mercado Livre flush — never flushing a draft.
 *
 * `ObjectView` is stubbed to capture its props; only the I/O edges are doubled
 * (the snapshot hooks, the kit-status use-case, the Shopee link hook, the two
 * channel tabs).
 */

interface Capturado {
  extraDirty?: boolean;
  fields?: Record<string, FieldConfig>;
  deriveOnSave?: (values: Record<string, unknown>) => Record<string, unknown>;
  deriveTransactionPatch?: (
    current: Record<string, unknown> | null,
    patch: Record<string, unknown>,
  ) => Record<string, unknown>;
  onAfterSave?: (
    id: string,
    values: Record<string, unknown>,
    committed?: { before: Record<string, unknown> | null; patch: Record<string, unknown> },
  ) => Promise<void>;
}

interface Snap {
  data: { id: string; data: Record<string, unknown> } | null;
  loading: boolean;
  error: undefined;
  fromCache: boolean;
}

const h = vi.hoisted(() => ({
  captured: null as Capturado | null,
  /** `produtos/{id}` → the doc-snapshot the page reads. */
  docs: new Map<string, Record<string, unknown>>(),
  /** Every root id the page asked `useKitNativoShopee` about, in order. */
  raizes: [] as (string | null)[],
  /** What the stubbed link hook answers. */
  temKitNativo: false,
  propagacoes: [] as Record<string, unknown>[],
  /** How many of the next propagations the stubbed use-case fails. */
  falhasDePropagacao: 0,
  /** The props the page handed the (stubbed) Shopee tab, last render. */
  shopeeTab: null as Record<string, unknown> | null,
  /** The props the page handed the (stubbed) Mercado Livre tab, last render. */
  mlTab: null as Record<string, unknown> | null,
  /**
   * The STORED variation children the page's `paiId == p1` query answers
   * (KNOWN #9 round 2); every other live query answers `[]`. Replace the
   * array (never mutate it) so the page's memo sees a new emission.
   */
  filhos: [] as { id: string; data: Record<string, unknown> }[],
}));

vi.mock('@delfrance/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/ui')>()),
  ObjectView: (props: Capturado) => {
    h.captured = props;
    return null;
  },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'p1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true }),
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => db,
  getFirebaseStorage: () => ({}),
}));
vi.mock('@delfrance/data/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data/hooks')>()),
  useSnapshot: (q: Query) => ({
    data: queryEqual(q, consultaDosFilhos()) ? h.filhos : [],
    loading: false,
    error: undefined,
  }),
  useDocSnapshot: (ref: { path: string } | null): Snap => {
    const data = ref ? h.docs.get(ref.path) : undefined;
    return {
      data: ref && data ? { id: ref.path.split('/').at(-1)!, data } : null,
      loading: false,
      error: undefined,
      fromCache: false,
    };
  },
}));
vi.mock('@delfrance/data/produto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data/produto')>()),
  propagateKitStatusToChildren: async (
    _port: unknown,
    _id: string,
    change: Record<string, unknown>,
  ) => {
    h.propagacoes.push(change);
    if (h.falhasDePropagacao > 0) {
      h.falhasDePropagacao -= 1;
      throw new Error('rede caiu no meio da propagação');
    }
    return [];
  },
}));
vi.mock('../../_components/shopee/ShopeeTab', () => ({
  ShopeeTab: (props: Record<string, unknown>) => {
    h.shopeeTab = props;
    return <div data-testid="shopee-tab-stub" />;
  },
}));
vi.mock('../../_components/mercado-livre/MercadoLivreTab', () => ({
  MercadoLivreTab: (props: Record<string, unknown>) => {
    h.mlTab = props;
    return <div data-testid="ml-tab-stub" />;
  },
}));
vi.mock('@/lib/shopee/kitNativo', () => ({
  useKitNativoShopee: (_db: unknown, raiz: string | null) => {
    h.raizes.push(raiz);
    return { temKitNativo: raiz !== null && h.temKitNativo, carregando: false };
  },
}));

const db = getFirestore(
  initializeApp({ projectId: 'demo-produto-editar' }, 'produto-editar'),
  'default',
);
/** The page's children query, built as the page builds it. */
const consultaDosFilhos = () =>
  buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', 'p1')]);

import EditarProdutoPage from './page';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { SECTION_SHOPEE } from '../../_components/produtoFields';
import type { VariationRow } from '../../_components/VariationManager';
import { KitVariacoesManager } from '../../_components/KitVariacoesManager';

/** Mounts the page; the returned function re-renders it (a new `h.filhos` emission reaches it). */
function montar(): () => void {
  h.captured = null;
  const arvore = () => (
    <MantineTestProvider>
      <EditarProdutoPage />
    </MantineTestProvider>
  );
  const { rerender } = render(arvore());
  return () => rerender(arvore());
}

function capturado(): Capturado {
  if (!h.captured) throw new Error('the page rendered no ObjectView');
  return h.captured;
}

/** Render the page's «É kit» input as ObjectView would, with the form's value. */
function renderEhKit(value: boolean): void {
  const renderInput = capturado().fields?.ehKit?.renderInput;
  if (!renderInput) throw new Error('the page overrides no «É kit» input');
  const props: FieldRenderProps = {
    name: 'ehKit',
    label: 'É kit',
    value,
    onChange: vi.fn(),
    onBlur: vi.fn(),
    descriptor: {} as FieldRenderProps['descriptor'],
  };
  render(<MantineTestProvider>{renderInput(props) as ReactNode}</MantineTestProvider>);
}

const aviso = () => screen.queryByTestId('aviso-kit-nativo-shopee');

beforeEach(() => {
  h.docs.clear();
  h.raizes.length = 0;
  h.temKitNativo = false;
  h.propagacoes.length = 0;
  h.falhasDePropagacao = 0;
  h.shopeeTab = null;
  h.mlTab = null;
  h.filhos = [];
});

describe('produtos/[id]/editar — «É kit virtual» needs «É kit» (step 19, O-8, M159)', () => {
  beforeEach(() => {
    h.docs.set('produtos/p1', { nome: 'Kit', paiId: null, ehKit: true, ehKitVirtual: true });
    montar();
  });

  it('deriveOnSave: «É kit» OFF + «É kit virtual» ON ⇒ the flag is saved OFF', () => {
    const out = capturado().deriveOnSave!({ ehKit: false, ehKitVirtual: true, fotos: null });
    expect(out.ehKitVirtual).toBe(false);
    expect(out).toMatchObject({ componentesKit: null, componentesKitKeys: null });
  });

  it('deriveOnSave: a kit keeps its «É kit virtual» (near-miss), and a non-kit OFF stays OFF', () => {
    const kit = { c1: { quantidade: 2, limitarEstoque: true } };
    expect(
      capturado().deriveOnSave!({
        ehKit: true,
        ehKitVirtual: true,
        componentesKit: kit,
        fotos: null,
      }).ehKitVirtual,
    ).toBe(true);
    expect(
      capturado().deriveOnSave!({
        ehKit: true,
        ehKitVirtual: false,
        componentesKit: kit,
        fotos: null,
      }).ehKitVirtual,
    ).toBe(false);
    expect(
      capturado().deriveOnSave!({ ehKit: false, ehKitVirtual: false, fotos: null }).ehKitVirtual,
    ).toBe(false);
  });

  it('the children kit-status sync reads the flip the TRANSACTION wrote, never the raw switch', async () => {
    await capturado().onAfterSave!(
      'p1',
      { ehKit: false, ehKitVirtual: true },
      {
        before: { ehKit: true, ehKitVirtual: true },
        patch: {
          ehKit: false,
          ehKitVirtual: false,
          componentesKit: null,
          componentesKitKeys: null,
        },
      },
    );
    expect(h.propagacoes).toHaveLength(1);
    expect(h.propagacoes[0]).toMatchObject({
      ehKit: false,
      ehKitVirtual: false,
      oldEhKit: true,
      oldEhKitVirtual: true,
    });
  });

  it('a kit that keeps «É kit virtual» reports no flip (near-miss)', async () => {
    await capturado().onAfterSave!(
      'p1',
      { ehKit: true, ehKitVirtual: true },
      { before: { ehKit: true, ehKitVirtual: true }, patch: { nome: 'x' } },
    );
    expect(h.propagacoes[0]).toMatchObject({
      ehKit: true,
      ehKitVirtual: true,
      oldEhKit: true,
      oldEhKitVirtual: true,
    });
  });

  // ⚠️ The bug this replaced: a form painted from a stale cache copy (here «É kit»
  // OFF) and saved with an unrelated edit used to diff that FORM against server
  // truth and un-kit every child while the parent stayed a kit.
  it('a STALE form that never touched «É kit» propagates no flip', async () => {
    await capturado().onAfterSave!(
      'p1',
      { ehKit: false, ehKitVirtual: false, componentesKit: null, nome: 'x' },
      {
        before: { ehKit: true, ehKitVirtual: true, componentesKit: { c1: { quantidade: 1 } } },
        patch: { nome: 'x' },
      },
    );
    expect(h.propagacoes[0]).toMatchObject({
      ehKit: true,
      ehKitVirtual: true,
      oldEhKit: true,
      oldEhKitVirtual: true,
      componentesKit: { c1: { quantidade: 1 } },
    });
  });

  it('the sole member mirrors the COMMITTED map and pointer, not the form’s', async () => {
    const gravado = { c1: { quantidade: 2, limitarEstoque: true } };
    await capturado().onAfterSave!(
      'p1',
      { ehKit: true, componentesKit: { velho: { quantidade: 9 } } },
      {
        before: { ehKit: false, filhoUnicoId: 'm1' },
        patch: { ehKit: true, componentesKit: gravado },
      },
    );
    expect(h.propagacoes[0]).toMatchObject({
      ehKit: true,
      oldEhKit: false,
      componentesKit: gravado,
      membroUnicoId: 'm1',
    });
  });

  it('no transaction ran ("nothing changed") and nothing pending ⇒ no propagation', async () => {
    // The form disagrees with the stored doc, but this save wrote nothing.
    await capturado().onAfterSave!('p1', { ehKit: false, ehKitVirtual: false });
    expect(h.propagacoes).toHaveLength(0);
  });

  it('a FAILED propagation is retried by the next save, even a "nothing changed" one, then cleared', async () => {
    const unkit = {
      before: { ehKit: true, ehKitVirtual: false },
      patch: { ehKit: false, componentesKit: null, componentesKitKeys: null },
    };
    h.falhasDePropagacao = 1;
    await expect(capturado().onAfterSave!('p1', { ehKit: false }, unkit)).rejects.toThrow(
      'rede caiu',
    );
    await capturado().onAfterSave!('p1', { ehKit: false });
    expect(h.propagacoes).toHaveLength(2);
    expect(h.propagacoes[1]).toEqual(h.propagacoes[0]);
    expect(h.propagacoes[1]).toMatchObject({ ehKit: false, oldEhKit: true });
    // Succeeded ⇒ cleared: the next pristine save propagates nothing.
    await capturado().onAfterSave!('p1', { ehKit: false });
    expect(h.propagacoes).toHaveLength(2);
  });

  it('a pending retry keeps its OLD side when the next save writes the doc', async () => {
    h.falhasDePropagacao = 1;
    await expect(
      capturado().onAfterSave!(
        'p1',
        {},
        { before: { ehKit: true }, patch: { ehKit: false, componentesKit: null } },
      ),
    ).rejects.toThrow('rede caiu');
    // The un-kit never reached the children, so they are still kits: the next
    // save (an unrelated edit) must still un-kit them…
    await capturado().onAfterSave!('p1', {}, { before: { ehKit: false }, patch: { nome: 'x' } });
    expect(h.propagacoes[1]).toMatchObject({ ehKit: false, oldEhKit: true });
  });

  it('NEAR-MISS: a pending retry the next save reverted propagates no flip', async () => {
    h.falhasDePropagacao = 1;
    await expect(
      capturado().onAfterSave!(
        'p1',
        {},
        { before: { ehKit: true }, patch: { ehKit: false, componentesKit: null } },
      ),
    ).rejects.toThrow('rede caiu');
    // …but turning «É kit» back ON leaves the children exactly where they are.
    await capturado().onAfterSave!('p1', {}, { before: { ehKit: false }, patch: { ehKit: true } });
    expect(h.propagacoes[1]).toMatchObject({ ehKit: true, oldEhKit: true });
  });

  // The `produto-kit.cadastros` flake: the form painted a stale cache copy
  // («É kit virtual» OFF) while the server held it ON, so `deriveOnSave` saw "no
  // change" and the patch never carried the flag. The transaction hook decides
  // over the doc it READ, so the switch-off reaches Firestore anyway.
  it('the save transaction switches «É kit virtual» off over the STORED doc, not the form', () => {
    const derivar = capturado().deriveTransactionPatch;
    expect(derivar).toBeDefined();
    expect(
      derivar!(
        {
          ehKit: true,
          ehKitVirtual: true,
          componentesKit: { c1: { quantidade: 2, limitarEstoque: true } },
          componentesKitKeys: ['c1'],
        },
        { ehKit: false, componentesKit: null, componentesKitKeys: null },
      ),
    ).toEqual({ ehKitVirtual: false });
  });

  it('the save transaction leaves a kit that stays a kit alone (near-miss)', () => {
    expect(
      capturado().deriveTransactionPatch!({ ehKit: true, ehKitVirtual: true }, { nome: 'x' }),
    ).toEqual({});
  });
});

describe('produtos/[id]/editar — the Shopee native-kit notice (step 19, R-v, M160)', () => {
  it('asks about the produto itself when it is a root', () => {
    h.docs.set('produtos/p1', { nome: 'Kit', paiId: null, ehKit: true });
    montar();
    expect(h.raizes.at(-1)).toBe('p1');
  });

  it('asks about the kit ROOT when the produto is a family child (paiId)', () => {
    h.docs.set('produtos/p1', { nome: 'Kit P', paiId: 'k1', ehKit: true });
    h.docs.set('produtos/k1', { nome: 'Kit', paiId: null, ehKit: true });
    montar();
    expect(h.raizes.at(-1)).toBe('k1');
    expect(h.raizes).not.toContain('p1');
  });

  it('asks nothing until the produto doc has loaded', () => {
    montar();
    expect(h.raizes.length).toBeGreaterThan(0);
    expect(h.raizes.every((r) => r === null)).toBe(true);
  });

  it('flag OFF + an active native link ⇒ the notice shows', () => {
    h.docs.set('produtos/p1', { nome: 'Kit', paiId: null, ehKit: true, ehKitVirtual: false });
    h.temKitNativo = true;
    montar();
    renderEhKit(true);
    expect(aviso()).not.toBeNull();
  });

  it('flag ON + no native link ⇒ no notice (the flag is intent, not a live kit)', () => {
    h.docs.set('produtos/p1', { nome: 'Kit', paiId: null, ehKit: true, ehKitVirtual: true });
    h.temKitNativo = false;
    montar();
    renderEhKit(true);
    expect(aviso()).toBeNull();
  });
});

/** Render one of the page's self-contained tabs as ObjectView would. */
function renderAba(nome: 'shopee' | 'mercadoLivre', disabled = false): void {
  const renderInput = capturado().fields?.[nome]?.renderInput;
  if (!renderInput) throw new Error(`the page gives the ${nome} tab no input`);
  const props: FieldRenderProps = {
    name: nome,
    label: nome,
    value: null,
    onChange: vi.fn(),
    onBlur: vi.fn(),
    descriptor: {} as FieldRenderProps['descriptor'],
    disabled,
  };
  render(<MantineTestProvider>{renderInput(props) as ReactNode}</MantineTestProvider>);
}

/** The Shopee tab's dirty reporter, as the (stubbed) tab received it on its last render. */
function reporterShopee(): (dirty: boolean) => void {
  const reporter = h.shopeeTab?.onDirtyChange;
  if (typeof reporter !== 'function') throw new Error('the Shopee tab got no onDirtyChange');
  return reporter as (dirty: boolean) => void;
}

/** What the Shopee editor does on a keystroke / after a save: report, outside any render. */
function reportarShopee(dirty: boolean): void {
  act(() => reporterShopee()(dirty));
}

/**
 * Registers `flush` as the Mercado Livre tab's flush, the way the real tab
 * fills the page's `flushRef` once it has been opened.
 */
function registrarFlushMl(flush: () => Promise<void>): void {
  renderAba('mercadoLivre');
  const ref = h.mlTab?.flushRef as MutableRefObject<(() => Promise<void>) | null> | undefined;
  if (!ref) throw new Error('the page gives the Mercado Livre tab no flushRef');
  ref.current = flush;
}

/** Settles `p` into an observable state without awaiting it. */
function observar(p: Promise<void>): { estado: 'pendente' | 'ok' | 'erro'; erro: unknown } {
  const obs = { estado: 'pendente' as 'pendente' | 'ok' | 'erro', erro: undefined as unknown };
  void p.then(
    () => {
      obs.estado = 'ok';
    },
    (err: unknown) => {
      obs.estado = 'erro';
      obs.erro = err;
    },
  );
  return obs;
}

/** Lets every already-queued microtask (and the next macrotask) run. */
const drenar = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('produtos/[id]/editar — the Shopee tab (step 21, #1529; drafts #1911)', () => {
  it('renders the tab for THIS produto with a dirty reporter and still no flush', () => {
    montar();
    expect(capturado().fields?.shopee?.section).toBe(SECTION_SHOPEE);
    renderAba('shopee', true);
    expect(screen.getByTestId('shopee-tab-stub')).toBeDefined();
    expect(h.shopeeTab).toMatchObject({ produtoId: 'p1', disabled: true });
    // #1911 P10 inverts the dirty-reporter half ON PURPOSE (DC §2.8): the tab
    // now holds unsaved drafts the leave-guard must see. A flush stays absent —
    // drafts are written only by their own «Salvar rascunho», and a flush here
    // would be a fourth registration the persistent-section backstop
    // (`produtoFields.test.ts`) does not know about.
    expect(h.shopeeTab).not.toHaveProperty('flushRef');
    expect(h.shopeeTab).toHaveProperty('onDirtyChange');
    expect(typeof h.shopeeTab?.onDirtyChange).toBe('function');
  });
});

describe('produtos/[id]/editar — the Shopee drafts leave-guard (#1911 P10, DC §2.8)', () => {
  beforeEach(() => {
    h.docs.set('produtos/p1', { nome: 'Camiseta', paiId: null, ehKit: false });
    montar();
    renderAba('shopee');
  });

  it('a dirty report arms ObjectView’s extraDirty, and a clean one disarms it', () => {
    expect(capturado().extraDirty).toBe(false);
    reportarShopee(true);
    expect(capturado().extraDirty).toBe(true);
    reportarShopee(false);
    expect(capturado().extraDirty).toBe(false);
  });

  it('NEAR-MISS: the Mercado Livre flag still arms the guard on its own (an OR, not a replacement)', () => {
    renderAba('mercadoLivre');
    const ml = h.mlTab?.onDirtyChange as (dirty: boolean) => void;
    act(() => ml(true));
    expect(capturado().extraDirty).toBe(true);
    // …and a clean Shopee report never clears another tab's pending work.
    reportarShopee(false);
    expect(capturado().extraDirty).toBe(true);
  });

  it('the reporter keeps ONE identity across page renders (the editor’s report effect depends on it)', () => {
    const antes = reporterShopee();
    reportarShopee(true);
    renderAba('shopee');
    expect(reporterShopee()).toBe(antes);
  });

  it('dirty ⇒ onAfterSave rejects with AfterSaveBlockedError only AFTER the Mercado Livre flush settled', async () => {
    let liberarMl!: () => void;
    const flushMl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          liberarMl = resolve;
        }),
    );
    registrarFlushMl(flushMl);
    reportarShopee(true);

    // The "nothing changed" path (no `committed`): ObjectView runs it too.
    const obs = observar(capturado().onAfterSave!('p1', {}));
    await drenar();
    // The ML flush was reached and is still running: the Shopee check has not
    // fired before it (blocking first would skip the ML writes).
    expect(flushMl).toHaveBeenCalledTimes(1);
    expect(obs.estado).toBe('pendente');

    liberarMl();
    await drenar();
    expect(obs.estado).toBe('erro');
    expect(obs.erro).toBeInstanceOf(AfterSaveBlockedError);
    expect((obs.erro as Error).message).toBe(MENSAGEM_RASCUNHO_SHOPEE_PENDENTE);
  });

  it('dirty ⇒ the block holds on a save that WROTE the produto too (committed present)', async () => {
    const flushMl = vi.fn(async () => {});
    registrarFlushMl(flushMl);
    reportarShopee(true);
    await expect(
      capturado().onAfterSave!(
        'p1',
        { nome: 'Camiseta nova' },
        { before: { nome: 'Camiseta', ehKit: false }, patch: { nome: 'Camiseta nova' } },
      ),
    ).rejects.toBeInstanceOf(AfterSaveBlockedError);
    expect(flushMl).toHaveBeenCalledTimes(1);
  });

  it('NEAR-MISS: clean ⇒ onAfterSave resolves (the navigation goes ahead) after the same ML flush', async () => {
    const flushMl = vi.fn(async () => {});
    registrarFlushMl(flushMl);
    reportarShopee(true);
    reportarShopee(false);
    await expect(capturado().onAfterSave!('p1', {})).resolves.toBeUndefined();
    expect(flushMl).toHaveBeenCalledTimes(1);
  });

  it('a Mercado Livre block keeps its OWN message — the Shopee check sits after it', async () => {
    registrarFlushMl(async () => {
      throw new AfterSaveBlockedError('Mercado Livre: conflito');
    });
    reportarShopee(true);
    await expect(capturado().onAfterSave!('p1', {})).rejects.toThrow('Mercado Livre: conflito');
  });

  it('the check reads the flag WHEN IT RUNS: a closure taken while clean still blocks once the tab turns dirty', async () => {
    // ObjectView may hold the `onAfterSave` of an earlier render while its save
    // transaction is in flight; the operator can type in the tab meanwhile.
    const anterior = capturado().onAfterSave!;
    reportarShopee(true);
    await expect(anterior('p1', {})).rejects.toBeInstanceOf(AfterSaveBlockedError);
  });

  it('NEAR-MISS: a closure taken while dirty lets the save navigate once the draft was saved', async () => {
    reportarShopee(true);
    const anterior = capturado().onAfterSave!;
    reportarShopee(false);
    await expect(anterior('p1', {})).resolves.toBeUndefined();
  });
});

/** The VariationManager element the page's «Variações» input builds — its callbacks, never rendered. */
function variationManager(): {
  onPriceDirtyChange: (dirty: boolean) => void;
  onRowsChange: (rows: VariationRow[]) => void;
} {
  const renderInput = capturado().fields?.variacoesUid?.renderInput;
  if (!renderInput) throw new Error('the page gives «Variações» no input');
  const el = renderInput({
    name: 'variacoesUid',
    label: 'Variações',
    value: null,
    onChange: vi.fn(),
    onBlur: vi.fn(),
    descriptor: {} as FieldRenderProps['descriptor'],
  }) as ReactElement<{
    onPriceDirtyChange: (dirty: boolean) => void;
    onRowsChange: (rows: VariationRow[]) => void;
  }>;
  return el.props;
}

/**
 * The KitVariacoesManager element the page's «Componentes do kit» input builds
 * (the second child of its `Stack`, beside the parent's `KitManager`) — its
 * props, never rendered.
 */
function kitVariacoesManager(): { onDirtyChange?: (dirty: boolean) => void } {
  const renderInput = capturado().fields?.componentesKit?.renderInput;
  if (!renderInput) throw new Error('the page gives «Componentes do kit» no input');
  const pilha = renderInput({
    name: 'componentesKit',
    label: 'Componentes do kit',
    value: null,
    onChange: vi.fn(),
    onBlur: vi.fn(),
    descriptor: {} as FieldRenderProps['descriptor'],
  }) as ReactElement<{ children: ReactNode }>;
  const grade = Children.toArray(pilha.props.children).find(
    (c): c is ReactElement<{ onDirtyChange?: (dirty: boolean) => void }> =>
      isValidElement(c) && c.type === KitVariacoesManager,
  );
  if (!grade) throw new Error('the Kit tab renders no KitVariacoesManager');
  return grade.props;
}

/** What the grid does when a composition is staged / flushed: report, outside any render. */
function reportarKitVariacoes(dirty: boolean): void {
  const reporter = kitVariacoesManager().onDirtyChange;
  if (typeof reporter !== 'function') throw new Error('the page gives the grid no onDirtyChange');
  act(() => reporter(dirty));
}

describe('produtos/[id]/editar — staged variation edits reach a Shopee draft’s «Publicar» gate (#1911 P11 review, KNOWN #9)', () => {
  const salvo: VariationRow = {
    key: 'c1',
    id: 'c1',
    nome: 'Camiseta P',
    sku: 'CAM-P',
    variacoesUid: [],
    precos: null,
    deleteMark: false,
  };
  /** What the page handed the (stubbed) Shopee tab on its last render. */
  const fora = () => {
    renderAba('shopee');
    return h.shopeeTab?.produtoSujoForaDoFormulario;
  };
  /** `salvo` as the page's `paiId` query stores it. */
  const gravado = (dados: Partial<Record<'nome' | 'sku', string>> = {}) => ({
    id: 'c1',
    data: { nome: salvo.nome, sku: salvo.sku, paiId: 'p1', ordem: 0, precos: null, ...dados },
  });
  let reRenderizar: () => void;

  beforeEach(() => {
    h.docs.set('produtos/p1', { nome: 'Camiseta', paiId: null, ehKit: false });
    h.filhos = [gravado()];
    reRenderizar = montar();
  });

  it('a staged independent variation price ⇒ `true`; cleared again ⇒ `false`', () => {
    expect(fora()).toBe(false);
    act(() => variationManager().onPriceDirtyChange(true));
    expect(fora()).toBe(true);
    act(() => variationManager().onPriceDirtyChange(false));
    expect(fora()).toBe(false);
  });

  it('a child staged as NEW (no document yet) or marked for deletion ⇒ `true` ⟷ NEAR-MISS the saved children alone ⇒ `false`', () => {
    act(() => variationManager().onRowsChange([salvo]));
    expect(fora()).toBe(false);
    act(() => variationManager().onRowsChange([salvo, { ...salvo, key: 'n1', id: null }]));
    expect(fora()).toBe(true);
    act(() => variationManager().onRowsChange([{ ...salvo, deleteMark: true }]));
    expect(fora()).toBe(true);
    act(() => variationManager().onRowsChange([salvo]));
    expect(fora()).toBe(false);
  });

  // Round 2 (KNOWN #9 PARTIAL): `VariationRow` has no per-row dirty flag, so a
  // staged patch of a SAVED child is read by comparing the published row with
  // the stored child. Exact, no fold: each patch below is something the flush
  // WRITES, so each must hold the gate.
  it.each<[string, Partial<VariationRow>]>([
    ['its SKU', { sku: 'CAM-P-NOVO' }],
    ['its SKU by a trailing space only', { sku: 'CAM-P ' }],
    ['its name', { nome: 'Camiseta P (nova)' }],
    ['its options', { variacoesUid: ['cor/azul'] }],
  ])(
    'a staged patch of a SAVED child — %s — ⇒ `true` ⟷ NEAR-MISS the same rows unchanged ⇒ `false`',
    (_caso, patch) => {
      act(() => variationManager().onRowsChange([salvo]));
      expect(fora()).toBe(false);
      act(() => variationManager().onRowsChange([{ ...salvo, ...patch }]));
      expect(fora()).toBe(true);
      // Undone in the editor: a NEW array of the same values, never the gate's own memo.
      act(() => variationManager().onRowsChange([{ ...salvo }]));
      expect(fora()).toBe(false);
    },
  );

  it('NEAR-MISS: a stored child with no SKU and no options (`null`) reads as the published `""` / `[]` — no dirt', () => {
    h.filhos = [{ ...gravado(), data: { ...gravado().data, sku: null, variacoesUid: null } }];
    reRenderizar();
    act(() => variationManager().onRowsChange([{ ...salvo, sku: '', variacoesUid: [] }]));
    expect(fora()).toBe(false);
    act(() => variationManager().onRowsChange([{ ...salvo, sku: 'CAM-P', variacoesUid: [] }]));
    expect(fora()).toBe(true);
  });

  it('the same options in ANOTHER order hold the gate (no re-derived normalisation: it errs closed until the save) ⟷ NEAR-MISS the stored order ⇒ `false`', () => {
    h.filhos = [{ ...gravado(), data: { ...gravado().data, variacoesUid: ['cor/azul', 'tam/p'] } }];
    reRenderizar();
    const comOpcoes = { ...salvo, variacoesUid: ['cor/azul', 'tam/p'] };
    act(() => variationManager().onRowsChange([comOpcoes]));
    expect(fora()).toBe(false);
    act(() =>
      variationManager().onRowsChange([{ ...comOpcoes, variacoesUid: ['tam/p', 'cor/azul'] }]),
    );
    expect(fora()).toBe(true);
  });

  it('a snapshot LAG only closes the gate: the stored child still old, or not there yet ⇒ `true`, then the echo alone reopens it', () => {
    // After the save: the VariationManager already publishes the written SKU,
    // the page's own listener still holds the old one.
    act(() => variationManager().onRowsChange([{ ...salvo, sku: 'CAM-P-NOVO' }]));
    expect(fora()).toBe(true);
    h.filhos = [gravado({ sku: 'CAM-P-NOVO' })];
    reRenderizar();
    expect(fora()).toBe(false);
    // A saved id the page's snapshot does not hold yet.
    act(() =>
      variationManager().onRowsChange([
        { ...salvo, sku: 'CAM-P-NOVO' },
        { ...salvo, key: 'c2', id: 'c2', sku: 'CAM-M' },
      ]),
    );
    expect(fora()).toBe(true);
    h.filhos = [
      gravado({ sku: 'CAM-P-NOVO' }),
      { id: 'c2', data: { nome: salvo.nome, sku: 'CAM-M', paiId: 'p1', ordem: 1, precos: null } },
    ];
    reRenderizar();
    expect(fora()).toBe(false);
  });

  // Round 3 (KNOWN #9 PARTIAL): the Kit tab's per-variation grid keeps each
  // child's staged `componentesKit` in its own state, flushed only by the
  // produto's save — and the publish derives each kit model's `seller_stock`
  // from the STORED child composition.
  it('a per-variation kit composition staged in the Kit tab ⇒ `true` and the leave-guard armed; the report clearing after the flush ⇒ both `false` again ⟷ NEAR-MISS nothing staged ⇒ `false`', () => {
    // Nothing staged: never reported, then reported clean (the grid's mount).
    expect(fora()).toBe(false);
    expect(capturado().extraDirty).toBe(false);
    reportarKitVariacoes(false);
    expect(fora()).toBe(false);
    expect(capturado().extraDirty).toBe(false);

    reportarKitVariacoes(true);
    expect(fora()).toBe(true);
    expect(capturado().extraDirty).toBe(true);

    // The save's flush wrote every staged map: the grid reports clean.
    reportarKitVariacoes(false);
    expect(fora()).toBe(false);
    expect(capturado().extraDirty).toBe(false);
  });

  it('NEAR-MISS: the kit report is an OR — its clean report never reopens a gate another staged edit holds', () => {
    act(() => variationManager().onPriceDirtyChange(true));
    reportarKitVariacoes(true);
    reportarKitVariacoes(false);
    expect(fora()).toBe(true);
    expect(capturado().extraDirty).toBe(true);
    act(() => variationManager().onPriceDirtyChange(false));
    expect(fora()).toBe(false);
    expect(capturado().extraDirty).toBe(false);
  });

  it('NEAR-MISS: the Mercado Livre flag arms the leave-guard but is NOT handed to the Shopee gate (the Shopee publish reads no ML edit), nor is the tab’s own draft flag fed back', () => {
    renderAba('mercadoLivre');
    act(() => (h.mlTab?.onDirtyChange as (dirty: boolean) => void)(true));
    expect(capturado().extraDirty).toBe(true);
    expect(fora()).toBe(false);
    act(() => (h.shopeeTab?.onDirtyChange as (dirty: boolean) => void)(true));
    expect(fora()).toBe(false);
  });
});
