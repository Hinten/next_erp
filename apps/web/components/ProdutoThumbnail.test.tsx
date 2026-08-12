import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import type { SnapshotState } from '@delfrance/data/hooks';

type Snap = SnapshotState<{ id: string; data: { url: string | null } } | null>;

// The component calls `useDocSnapshot` twice (thumbnail + modal original). The
// mocked `arquivoCollection.docRef` returns `{ id }`, so we key the snapshot per
// doc id — stable across re-renders, unlike call-order. A `null` ref (the modal
// original while closed) yields the empty default.
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
const LOADING: Snap = { data: undefined, loading: true, error: undefined };
const MISSING: Snap = { data: null, loading: false, error: undefined };

/** `arquivo400pxOuterRef` → id `deriv1`; `arquivoOuterRef` → id `orig1`. */
function setSnaps(byId: Record<string, Snap>) {
  snapById.current = byId;
}

const db = {} as Firestore;

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
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

afterEach(() => {
  snapById.current = {};
  vi.clearAllMocks();
});

describe('ProdutoThumbnail', () => {
  it('renders the broken-image placeholder when the produto has no foto', () => {
    wrap(<ProdutoThumbnail db={db} produto={{ nome: 'X', fotos: null } as unknown as Produto} />);
    expect(screen.getByLabelText('Foto indisponível')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'X' })).toBeNull();
  });

  it('renders the broken-image placeholder when the arquivo doc is missing', () => {
    setSnaps({ deriv1: MISSING });
    wrap(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.getByLabelText('Foto indisponível')).toBeTruthy();
  });

  it('shows the loading skeleton while the arquivo doc resolves', () => {
    setSnaps({ deriv1: LOADING });
    wrap(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.getByTestId('produto-thumbnail-loading')).toBeTruthy();
    expect(screen.queryByLabelText('Foto indisponível')).toBeNull();
  });

  it('renders the image with the resolved url and produto name as alt', () => {
    setSnaps({ deriv1: loaded('https://cdn/deriv1.jpg') });
    wrap(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    const img = screen.getByRole('img', { name: 'Camiseta' });
    expect(img.getAttribute('src')).toBe('https://cdn/deriv1.jpg');
  });

  it('falls back to the broken-image placeholder when the image fails to load', () => {
    setSnaps({ deriv1: loaded('https://cdn/broken.jpg') });
    wrap(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    const img = screen.getByRole('img', { name: 'Camiseta' });
    fireEvent.error(img);
    expect(screen.getByLabelText('Foto indisponível')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Camiseta' })).toBeNull();
  });

  it('clears the failed-load state when the produto (url) changes', () => {
    // The instance is reused across produto swaps (pedido item rows): a prior
    // produto's failed image must not leave the next produto broken.
    setSnaps({
      deriv1: loaded('https://cdn/deriv1.jpg'),
      deriv2: loaded('https://cdn/deriv2.jpg'),
    });
    const { rerender } = wrap(
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
    rerender(
      <MantineProvider env="test">
        <ProdutoThumbnail db={db} produto={other} zoomable={false} />
      </MantineProvider>,
    );
    const img = screen.getByRole('img', { name: 'Boné' });
    expect(img.getAttribute('src')).toBe('https://cdn/deriv2.jpg');
    expect(screen.queryByLabelText('Foto indisponível')).toBeNull();
  });

  it('resolves the canonical Flutter `documents/arquivos/<id>` outer-ref form', () => {
    setSnaps({ deriv1: loaded('https://cdn/deriv1.jpg') });
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
    wrap(<ProdutoThumbnail db={db} produto={produto} zoomable={false} />);
    // idFromRef must take the last path segment (`deriv1`), not the whole string.
    expect(screen.getByRole('img', { name: 'Camiseta' }).getAttribute('src')).toBe(
      'https://cdn/deriv1.jpg',
    );
  });

  it('opens the original photo in a zoom modal when zoomable and clicked', () => {
    setSnaps({
      deriv1: loaded('https://cdn/deriv1.jpg'),
      orig1: loaded('https://cdn/orig1.jpg'),
    });
    wrap(<ProdutoThumbnail db={db} produto={produtoWithFoto()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto de Camiseta' }));
    const dialog = screen.getByRole('dialog');
    const zoomed = within(dialog).getByRole('img', { name: 'Camiseta' });
    expect(zoomed.getAttribute('src')).toBe('https://cdn/orig1.jpg');
  });

  it('does not wrap in a zoom button when zoomable is false', () => {
    setSnaps({ deriv1: loaded('https://cdn/deriv1.jpg') });
    wrap(<ProdutoThumbnail db={db} produto={produtoWithFoto()} zoomable={false} />);
    expect(screen.queryByRole('button', { name: /Ampliar/ })).toBeNull();
  });
});
