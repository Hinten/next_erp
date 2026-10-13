import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';

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
 * `ObjectView` is stubbed to capture its props; only the I/O edges are doubled
 * (the snapshot hooks, the kit-status use-case, the Shopee link hook).
 */

interface Capturado {
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
  useSnapshot: () => ({ data: [], loading: false, error: undefined }),
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

import EditarProdutoPage from './page';

function montar(): void {
  h.captured = null;
  render(
    <MantineTestProvider>
      <EditarProdutoPage />
    </MantineTestProvider>,
  );
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
