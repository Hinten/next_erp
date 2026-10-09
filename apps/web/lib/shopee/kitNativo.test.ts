import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';

/**
 * `useKitNativoShopee` (step 19, #1527, reconcile §2.10 / R-v / M160): the
 * editor's pre-save notice keys on the root produto's `prodshopee` LINKS through
 * the shared `ehKitNativoAtivo`, never on the produto's `ehKitVirtual`/`ehKit`.
 *
 * Only the I/O edge is doubled: `getDocs`/`getDoc` answer from an in-memory
 * store keyed by PATH. The store also holds each produto's own doc with its kit
 * flags, so an implementation that consulted the produto (the M160 mutant)
 * would read the flag and answer the wrong way. The Firestore instance is real
 * (offline, never contacted), so the handle's `ref()` builds the real path.
 */

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  /** `produtos/{id}` → the produto doc. */
  produtos: new Map<string, Record<string, unknown>>(),
  /** `produtos/{id}/prodshopee` (or any collection path) → its docs. */
  colecoes: new Map<string, Record<string, unknown>[]>(),
  /** Every collection path `getDocs` was asked for. */
  lidas: [] as string[],
  /** Each `getDocs` argument's converter, to prove the handle (not raw `collection()`) was used. */
  conversores: [] as unknown[],
  /** When set, `getDocs` waits on it (the in-flight state). */
  pendente: null as Promise<void> | null,
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  getDocs: async (ref: { path: string; converter: unknown }) => {
    h.lidas.push(ref.path);
    h.conversores.push(ref.converter);
    if (h.pendente) await h.pendente;
    const docs = (h.colecoes.get(ref.path) ?? []).map((data, i) => ({
      id: `l${i}`,
      data: () => data,
    }));
    return { docs, empty: docs.length === 0, size: docs.length };
  },
  getDoc: async (ref: { path: string }) => ({
    exists: () => h.produtos.has(ref.path),
    data: () => h.produtos.get(ref.path),
  }),
}));

import { lerTemKitNativoShopee, useKitNativoShopee } from './kitNativo';

const db = getFirestore(initializeApp({ projectId: 'demo-kit-nativo' }, 'kit-nativo'), 'default');

/** Fixture ids (s19-ctx): the kit role and an ordinary listing. */
const KIT_ITEM = 2500139870;
const ITEM_COMUM = 2500139861;

/** A live native-kit link, as step 9 / step 19 write it. */
const NATIVO_ATIVO: Doc = {
  item_id: KIT_ITEM,
  kitNativo: true,
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
  substituidoPorLinkDocId: null,
};

function wrapper() {
  // The app's own defaults (`retry: 1` etc.), with retries off so a test never waits.
  const client = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULT_OPTIONS.queries, retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

/** Seed produto `id` with its kit flags and its `prodshopee` links. */
function semear(id: string, flags: Doc, links: Doc[]): void {
  h.produtos.set(`produtos/${id}`, flags);
  h.colecoes.set(`produtos/${id}/prodshopee`, links);
}

async function temKitNativo(id: string): Promise<boolean> {
  const { result } = renderHook(() => useKitNativoShopee(db, id), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.carregando).toBe(false));
  return result.current.temKitNativo;
}

beforeEach(() => {
  h.produtos.clear();
  h.colecoes.clear();
  h.lidas.length = 0;
  h.conversores.length = 0;
  h.pendente = null;
});

describe('useKitNativoShopee — the LINK decides, never the produto flags (M160)', () => {
  it('flag OFF + an active native-kit link ⇒ shown (an imported native kit carries ehKitVirtual false)', async () => {
    semear('k1', { ehKit: true, ehKitVirtual: false }, [NATIVO_ATIVO]);
    expect(await temKitNativo('k1')).toBe(true);
  });

  it('flag ON + NO link ⇒ hidden (intent for a first publish is not a live kit)', async () => {
    semear('k2', { ehKit: true, ehKitVirtual: true }, []);
    expect(await temKitNativo('k2')).toBe(false);
  });

  it('flag ON + only an ORDINARY listing ⇒ hidden (an old-model kit, L0)', async () => {
    semear('k3', { ehKit: true, ehKitVirtual: true }, [
      { item_id: ITEM_COMUM, kitNativo: false, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo },
      // A link no import or publish has stamped yet: null is NOT a native kit.
      { item_id: ITEM_COMUM, kitNativo: null, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo },
    ]);
    expect(await temKitNativo('k3')).toBe(false);
  });

  it('a SUPERSEDED native kit ⇒ hidden (no live recipe to diverge from, §9 Q4(a))', async () => {
    semear('k4', { ehKit: true, ehKitVirtual: true }, [
      { ...NATIVO_ATIVO, substituidoPorLinkDocId: 'outro-link' },
    ]);
    expect(await temKitNativo('k4')).toBe(false);
  });

  it('a REMOVED native kit ⇒ hidden', async () => {
    semear('k5', { ehKit: true, ehKitVirtual: true }, [
      { ...NATIVO_ATIVO, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido },
    ]);
    expect(await temKitNativo('k5')).toBe(false);
  });

  it('a native link without an addressable item_id ⇒ hidden (the shared predicate, not a copy)', async () => {
    semear('k6', { ehKit: true, ehKitVirtual: true }, [
      { ...NATIVO_ATIVO, item_id: 0 },
      { ...NATIVO_ATIVO, item_id: null },
    ]);
    expect(await temKitNativo('k6')).toBe(false);
  });

  it('ANY active link counts, wherever it sorts (removed first, active second, and the reverse)', async () => {
    const removido = { ...NATIVO_ATIVO, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido };
    semear('k7', { ehKit: true }, [removido, NATIVO_ATIVO]);
    semear('k8', { ehKit: true }, [NATIVO_ATIVO, removido]);
    expect(await temKitNativo('k7')).toBe(true);
    expect(await temKitNativo('k8')).toBe(true);
  });
});

describe('useKitNativoShopee — the read', () => {
  it('reads the root produto’s prodshopee through the converter-bound handle, unfiltered', async () => {
    semear('raiz', { ehKit: true }, [NATIVO_ATIVO]);
    expect(await temKitNativo('raiz')).toBe(true);
    expect(h.lidas).toEqual(['produtos/raiz/prodshopee']);
    expect(h.conversores[0]).not.toBeNull();
  });

  it('a native link on ANOTHER produto (or in variashopee) is not this produto’s', async () => {
    semear('outro', { ehKit: true }, [NATIVO_ATIVO]);
    h.colecoes.set('produtos/este/variashopee', [NATIVO_ATIVO]);
    semear('este', { ehKit: true }, []);
    expect(await temKitNativo('este')).toBe(false);
  });

  it('a null root reads nothing and shows nothing', () => {
    semear('k1', { ehKit: true }, [NATIVO_ATIVO]);
    const { result } = renderHook(() => useKitNativoShopee(db, null), { wrapper: wrapper() });
    expect(result.current).toEqual({ temKitNativo: false, carregando: false });
    expect(h.lidas).toEqual([]);
  });

  it('is `carregando` (and shows nothing) while the read is in flight', async () => {
    semear('k1', { ehKit: true }, [NATIVO_ATIVO]);
    let soltar: () => void = () => undefined;
    h.pendente = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const { result } = renderHook(() => useKitNativoShopee(db, 'k1'), { wrapper: wrapper() });
    await waitFor(() => expect(h.lidas).toEqual(['produtos/k1/prodshopee']));
    expect(result.current).toEqual({ temKitNativo: false, carregando: true });
    soltar();
    await waitFor(() => expect(result.current).toEqual({ temKitNativo: true, carregando: false }));
  });

  it('lerTemKitNativoShopee answers the same question without React', async () => {
    semear('k1', { ehKit: true, ehKitVirtual: false }, [NATIVO_ATIVO]);
    semear('k2', { ehKit: true, ehKitVirtual: true }, []);
    await expect(lerTemKitNativoShopee(db, 'k1')).resolves.toBe(true);
    await expect(lerTemKitNativoShopee(db, 'k2')).resolves.toBe(false);
  });
});
