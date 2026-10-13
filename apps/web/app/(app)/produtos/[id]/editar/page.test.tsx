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
 *  1. `deriveOnSave` switches «É kit virtual» off when «É kit» is off, and the
 *     children kit-status sync uses that DERIVED value (O-8; M159's editar half,
 *     also pinned end-to-end by `produto-kit.cadastros`);
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
  onAfterSave?: (id: string, values: Record<string, unknown>) => Promise<void>;
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

  it('the children kit-status sync uses the DERIVED flag, never the raw switch', async () => {
    await capturado().onAfterSave!('p1', { ehKit: false, ehKitVirtual: true });
    expect(h.propagacoes).toHaveLength(1);
    expect(h.propagacoes[0]).toMatchObject({
      ehKit: false,
      ehKitVirtual: false,
      oldEhKit: true,
      oldEhKitVirtual: true,
    });
  });

  it('a kit that keeps «É kit virtual» propagates it unchanged (near-miss)', async () => {
    await capturado().onAfterSave!('p1', { ehKit: true, ehKitVirtual: true });
    expect(h.propagacoes[0]).toMatchObject({ ehKit: true, ehKitVirtual: true });
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
