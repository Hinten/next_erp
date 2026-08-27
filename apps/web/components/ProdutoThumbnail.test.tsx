import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import type { SnapshotState } from '@delfrance/data/hooks';

type Snap = SnapshotState<{ id: string; data: { url: string | null } } | null>;

/**
 * `useFirstExistingArquivoUrl` walks the candidate ladder with ONE `onSnapshot`
 * at a time, so the thumbnail is driven by mocking `onSnapshot` itself. The
 * registry records every subscribe and unsubscribe by doc id, which is what
 * lets the listener-count tests below assert the invariant the hook claims.
 *
 * `docs.current[id]` is the stored document: `undefined` means the doc does not
 * exist. Snapshots are delivered synchronously at subscribe time — the hook
 * defers each advance a microtask precisely so that is safe.
 */
const { subs, docs, cacheFirst } = vi.hoisted(() => ({
  subs: { current: [] as { id: string; open: boolean }[] },
  docs: { current: {} as Record<string, { url: string | null } | undefined> },
  /** Emit a `fromCache: true` snapshot before the server one, like the real SDK. */
  cacheFirst: { current: false },
}));

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return {
    ...actual,
    // Signature is `onSnapshot(ref, options, onNext, onError)` — the hook must
    // pass `SnapshotListenOptions`, so `options` is asserted, not ignored.
    onSnapshot: (
      ref: { id: string },
      options: { includeMetadataChanges?: boolean },
      onNext: (s: { data: () => unknown; metadata: { fromCache: boolean } }) => void,
    ) => {
      if (options?.includeMetadataChanges !== true) {
        throw new Error('onSnapshot must opt into metadata changes — see fotoCapa.ts');
      }
      const entry = { id: ref.id, open: true };
      subs.current.push(entry);
      const emitir = (fromCache: boolean) =>
        onNext({ data: () => docs.current[ref.id], metadata: { fromCache } });
      // The real SDK emits the cached view first, then the server's.
      if (cacheFirst.current) emitir(true);
      emitir(false);
      return () => {
        entry.open = false;
      };
    },
  };
});

/** The modal's original still rides `useDocSnapshot`; keyed per doc id. */
const { snapById } = vi.hoisted(() => ({
  snapById: { current: {} as Record<string, Snap> },
}));

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    useDocSnapshot: (ref: { id: string } | null) => {
      const empty: Snap = { data: undefined, loading: false, error: undefined };
      if (!ref) return empty;
      return snapById.current[ref.id] ?? empty;
    },
  };
});

vi.mock('@delfrance/storage', () => ({
  arquivoCollection: {
    docRef: (_db: unknown, _scope: unknown, id: string) => ({ id }),
  },
}));

import { ProdutoThumbnail } from './ProdutoThumbnail';

function loaded(url: string | null): Snap {
  return { data: { id: 'a1', data: { url } }, loading: false, error: undefined };
}

/** Set the stored `arquivos` docs. Any id left out does not exist. */
function setDocs(byId: Record<string, { url: string | null } | undefined>) {
  docs.current = byId;
}
/** Ids currently subscribed, in order. */
const openSubs = () => subs.current.filter((s) => s.open).map((s) => s.id);
/** Every id ever subscribed, in order — including ones since released. */
const allSubs = () => subs.current.map((s) => s.id);

const db = {} as Firestore;

/** `arquivo400pxOuterRef` → `deriv1`; `arquivoOuterRef` → `orig1`. */
function produtoWithFoto(): Produto {
  return {
    nome: 'Camiseta',
    fotos: [
      {
        arquivoOuterRef: 'arquivos/orig1',
        arquivo400pxOuterRef: 'arquivos/deriv1',
        arquivo200pxOuterRef: null,
        arquivoJpegOuterRef: null,
        grupoDeVariacoesOuterRef: null,
        variantePath: null,
      },
    ],
  } as unknown as Produto;
}

function wrap(node: React.ReactNode) {
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

/** Render and let the hook's deferred rung advances drain. */
async function renderThumb(node: React.ReactNode) {
  const r = wrap(node);
  await act(async () => {});
  return r;
}

afterEach(() => {
  subs.current = [];
  docs.current = {};
  cacheFirst.current = false;
  snapById.current = {};
  vi.clearAllMocks();
});

describe('ProdutoThumbnail', () => {
  it('renders the broken-image placeholder when the produto has no foto', async () => {
    await renderThumb(
      <ProdutoThumbnail db={db} produto={{ nome: 'X', fotos: null } as unknown as Produto} />,
    );
    expect(screen.getByLabelText('Foto indisponível')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'X' })).toBeNull();
    // Nothing to resolve → nothing subscribed.
    expect(allSubs()).toEqual([]);
  });

  it('renders the broken-image placeholder when EVERY candidate doc is missing', async () => {
    setDocs({});
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.getByLabelText('Foto indisponível')).toBeTruthy();
    expect(allSubs()).toEqual(['deriv1', 'orig1']);
    expect(openSubs()).toEqual([]); // both rungs released once exhausted
  });

  it('falls back to the ORIGINAL when the derivative doc was never created', async () => {
    // The bug this ladder exists for. `buildFotoRefs` writes
    // `arquivo400pxOuterRef` optimistically at upload time, so the ref string is
    // always non-null; when `resizeProductImage` has not produced the document
    // it names, a `??` over the REFS never reaches the original and the row
    // renders a permanent broken image even though the photo is perfectly fine.
    setDocs({ orig1: { url: 'https://cdn/orig1.jpg' } });
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.getByRole('img', { name: 'Camiseta' }).getAttribute('src')).toBe(
      'https://cdn/orig1.jpg',
    );
    expect(screen.queryByLabelText('Foto indisponível')).toBeNull();
  });

  it('holds ONE listener at a time — the healthy case never opens the lower rungs', async () => {
    // Reviewed on #1315: the earlier chained-`useDocSnapshot` shape opened all
    // three rungs on mount, because `url === null` also means "still loading".
    setDocs({ deriv1: { url: 'https://cdn/deriv1.jpg' }, orig1: { url: 'https://cdn/orig1.jpg' } });
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(allSubs()).toEqual(['deriv1']); // `orig1` never subscribed at all
    expect(openSubs()).toEqual(['deriv1']); // the winner stays live
    expect(screen.getByRole('img', { name: 'Camiseta' }).getAttribute('src')).toBe(
      'https://cdn/deriv1.jpg',
    );
  });

  it('releases a rejected rung — the degraded case also settles at ONE listener', async () => {
    // The other half of the same finding: a LATER rung producing the url used to
    // release nothing, so a 20-item pedido held 60 live watches instead of 20.
    setDocs({ orig1: { url: 'https://cdn/orig1.jpg' } });
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(allSubs()).toEqual(['deriv1', 'orig1']);
    expect(openSubs()).toEqual(['orig1']); // `deriv1` was released on advance
  });

  it('never advances on a cache-only miss — the derivative wins once the server answers', async () => {
    // The hazard `includeMetadataChanges` exists for. A never-cached document
    // reports as ABSENT in the first (`fromCache: true`) snapshot; advancing on
    // that would release the rung and settle on the original for good, even
    // though the 400px derivative is right there on the server.
    cacheFirst.current = true;
    setDocs({ deriv1: { url: 'https://cdn/deriv1.jpg' }, orig1: { url: 'https://cdn/orig1.jpg' } });
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.getByRole('img', { name: 'Camiseta' }).getAttribute('src')).toBe(
      'https://cdn/deriv1.jpg',
    );
    expect(allSubs()).toEqual(['deriv1']); // never fell through to the original
  });

  it('treats a doc that exists with a null url as an empty rung', async () => {
    // The transient state of a create-first upload: the doc is written before
    // the bytes, so `url` is null until it is patched.
    setDocs({ deriv1: { url: null }, orig1: { url: 'https://cdn/orig1.jpg' } });
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.getByRole('img', { name: 'Camiseta' }).getAttribute('src')).toBe(
      'https://cdn/orig1.jpg',
    );
  });

  it('shows the loading skeleton while the first candidate is still resolving', async () => {
    // No snapshot delivered: the registry has no entry, so nothing calls back.
    subs.current = [];
    wrap(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.getByTestId('produto-thumbnail-loading')).toBeTruthy();
    expect(screen.queryByLabelText('Foto indisponível')).toBeNull();
  });

  it('falls back to the broken-image placeholder when the image fails to load', async () => {
    setDocs({ deriv1: { url: 'https://cdn/broken.jpg' } });
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    const img = screen.getByRole('img', { name: 'Camiseta' });
    fireEvent.error(img);
    expect(screen.getByLabelText('Foto indisponível')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Camiseta' })).toBeNull();
  });

  it('clears the failed-load state when the produto (url) changes', async () => {
    // The instance is reused across produto swaps (pedido item rows): a prior
    // produto's failed image must not leave the next produto broken.
    setDocs({
      deriv1: { url: 'https://cdn/deriv1.jpg' },
      deriv2: { url: 'https://cdn/deriv2.jpg' },
    });
    const { rerender } = await renderThumb(
      <ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'Camiseta' }));
    expect(screen.getByLabelText('Foto indisponível')).toBeTruthy();

    const other = {
      nome: 'Boné',
      fotos: [
        {
          arquivoOuterRef: 'arquivos/orig2',
          arquivo400pxOuterRef: 'arquivos/deriv2',
          arquivo200pxOuterRef: null,
          arquivoJpegOuterRef: null,
          grupoDeVariacoesOuterRef: null,
          variantePath: null,
        },
      ],
    } as unknown as Produto;
    await act(async () => {
      rerender(
        <MantineTestProvider>
          <ProdutoThumbnail db={db} produto={other} zoomable={false} />
        </MantineTestProvider>,
      );
    });
    const img = screen.getByRole('img', { name: 'Boné' });
    expect(img.getAttribute('src')).toBe('https://cdn/deriv2.jpg');
    expect(screen.queryByLabelText('Foto indisponível')).toBeNull();
    // The previous produto's listener must not survive the swap.
    expect(openSubs()).toEqual(['deriv2']);
  });

  it('resolves the canonical Flutter `documents/arquivos/<id>` outer-ref form', async () => {
    setDocs({ deriv1: { url: 'https://cdn/deriv1.jpg' } });
    const produto = {
      nome: 'Camiseta',
      fotos: [
        {
          arquivoOuterRef: 'documents/arquivos/orig1',
          arquivo400pxOuterRef: 'documents/arquivos/deriv1',
          arquivo200pxOuterRef: null,
          arquivoJpegOuterRef: null,
          grupoDeVariacoesOuterRef: null,
          variantePath: null,
        },
      ],
    } as unknown as Produto;
    await renderThumb(<ProdutoThumbnail db={db} produto={produto} zoomable={false} />);
    // arquivoIdFromRef must take the last path segment (`deriv1`).
    expect(screen.getByRole('img', { name: 'Camiseta' }).getAttribute('src')).toBe(
      'https://cdn/deriv1.jpg',
    );
  });

  it('opens the original photo in a zoom modal when zoomable and clicked', async () => {
    setDocs({ deriv1: { url: 'https://cdn/deriv1.jpg' } });
    snapById.current = { orig1: loaded('https://cdn/orig1.jpg') };
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto de Camiseta' }));
    const dialog = screen.getByRole('dialog');
    const zoomed = within(dialog).getByRole('img', { name: 'Camiseta' });
    expect(zoomed.getAttribute('src')).toBe('https://cdn/orig1.jpg');
  });

  it('does not wrap in a zoom button when zoomable is false', async () => {
    setDocs({ deriv1: { url: 'https://cdn/deriv1.jpg' } });
    await renderThumb(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.queryByRole('button', { name: /Ampliar/ })).toBeNull();
  });
});
