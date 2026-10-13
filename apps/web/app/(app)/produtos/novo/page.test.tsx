import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * `/produtos/novo` — the create page's `deriveOnSave` switches «É kit virtual»
 * off when «É kit» is off (step 19, #1527, reconcile §2.10 / O-8 / M159's novo
 * half). The editar half is pinned by `[id]/editar/page.test.tsx` and by the
 * `produto-kit.cadastros` e2e.
 *
 * `ObjectView` is stubbed to capture the props the page hands it; the
 * derivation is then called the way `ObjectView` calls it (post-
 * `prepareForSave` values in, top-level keys out — a key that comes back
 * `undefined` is IGNORED by the save, so the flag must come back as a boolean).
 */

interface Capturado {
  deriveOnSave?: (values: Record<string, unknown>) => Record<string, unknown>;
}

const h = vi.hoisted(() => ({ captured: null as Capturado | null }));

vi.mock('@delfrance/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/ui')>()),
  ObjectView: (props: Capturado) => {
    h.captured = props;
    return null;
  },
}));
vi.mock('next/navigation', () => ({
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
}));

const db = getFirestore(
  initializeApp({ projectId: 'demo-produto-novo' }, 'produto-novo'),
  'default',
);

import NovoProdutoPage from './page';

function derivar(values: Record<string, unknown>): Record<string, unknown> {
  const derive = h.captured?.deriveOnSave;
  if (!derive) throw new Error('the page handed ObjectView no deriveOnSave');
  return derive({ fotos: null, componentesKit: null, ...values });
}

beforeEach(() => {
  h.captured = null;
  render(
    <MantineTestProvider>
      <NovoProdutoPage />
    </MantineTestProvider>,
  );
});

describe('produtos/novo — «É kit virtual» needs «É kit» (step 19, O-8, M159)', () => {
  it('«É kit» OFF + «É kit virtual» ON ⇒ the produto is created with the flag OFF', () => {
    const out = derivar({ ehKit: false, ehKitVirtual: true });
    expect(out.ehKitVirtual).toBe(false);
  });

  it('a kit keeps its «É kit virtual» (the near-miss: the flag is not always switched off)', () => {
    const out = derivar({
      ehKit: true,
      ehKitVirtual: true,
      componentesKit: { c1: { quantidade: 2, limitarEstoque: true } },
    });
    expect(out.ehKitVirtual).toBe(true);
  });

  it.each([
    [true, false, false],
    [false, false, false],
    // Strict booleans: a stray non-boolean «É kit» is not a kit.
    [null, true, false],
    ['true', true, false],
  ])(
    'ehKit %j + ehKitVirtual %j ⇒ %j (always a boolean, never undefined)',
    (ehKit, ehKitVirtual, esperado) => {
      const out = derivar({ ehKit, ehKitVirtual });
      expect(out).toHaveProperty('ehKitVirtual');
      expect(out.ehKitVirtual).toBe(esperado);
    },
  );

  it('keeps the existing kit denorm: a non-kit clears componentesKit and its keys', () => {
    const out = derivar({
      ehKit: false,
      ehKitVirtual: true,
      componentesKit: { c1: { quantidade: 2, limitarEstoque: true } },
    });
    expect(out).toMatchObject({
      componentesKit: null,
      componentesKitKeys: null,
      ehKitVirtual: false,
    });
  });
});
