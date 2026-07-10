'use client';

import { useMemo, useState } from 'react';
import { Center, Image, Loader, Modal, Skeleton, UnstyledButton } from '@mantine/core';
import { IconPhotoOff } from '@tabler/icons-react';
import { type Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';
import { useDocSnapshot } from '@delfrance/data/hooks';

const ARQUIVOS_PREFIX = 'arquivos/';

/** Accessible label for the broken-image placeholder (missing or failed load). */
const BROKEN_LABEL = 'Foto indisponível';

/** Derive the arquivo doc id from a `Foto` ref string (`arquivos/<id>`). */
function idFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const id = ref.startsWith(ARQUIVOS_PREFIX) ? ref.slice(ARQUIVOS_PREFIX.length) : ref;
  return id || null;
}

/** A centered broken-image icon shown when a photo is missing or fails to load. */
function BrokenImage({ size }: { size: number }) {
  return (
    <Center
      w={size}
      h={size}
      bg="var(--mantine-color-gray-1)"
      role="img"
      aria-label={BROKEN_LABEL}
      data-testid="produto-thumbnail-broken"
      style={{ borderRadius: 'var(--mantine-radius-sm)' }}
    >
      <IconPhotoOff size={Math.round(size * 0.5)} color="var(--mantine-color-gray-5)" aria-hidden />
    </Center>
  );
}

export interface ProdutoThumbnailProps {
  db: Firestore;
  produto: Produto | null;
  /** Rendered box edge in px. Default 40. */
  size?: number;
  /**
   * When true (default), clicking the thumbnail opens the produto's original
   * photo in a zoom modal. Ignored when the produto has no photo.
   */
  zoomable?: boolean;
}

/**
 * A shared, size-configurable product thumbnail. Resolves the first foto's
 * 400px derivative (falling back to the original `arquivoOuterRef`), live-reads
 * its `arquivos/` doc for the public `url`, and renders a Mantine `Image`.
 * Shows a placeholder while the arquivo doc loads and a **broken-image icon**
 * when the produto has no foto, the arquivo doc is missing, or the image fails
 * to load. When `zoomable`, clicking opens the original photo in a modal.
 *
 * Promoted from the pedido-local copy (#297) so produtos list, the
 * ProdutoPicker dropdown and pedido item rows share one consistent thumbnail.
 */
export function ProdutoThumbnail({
  db,
  produto,
  size = 40,
  zoomable = true,
}: ProdutoThumbnailProps) {
  const foto = produto?.fotos?.[0] ?? null;
  const alt = produto?.nome ?? 'Produto';
  // Track failed loads BY url, not a single boolean: the component instance is
  // reused across produto swaps (pedido item rows), so a boolean would leave a
  // stale broken state on the next produto. Keying by url auto-clears when the
  // resolved url changes and covers the modal's original image too.
  const [erroredUrls, setErroredUrls] = useState<ReadonlySet<string>>(() => new Set());
  const markErrored = (u: string) => setErroredUrls((prev) => new Set(prev).add(u));
  const [opened, setOpened] = useState(false);

  // Thumbnail source: the 400px derivative, falling back to the original ref.
  const thumbRef = useMemo(() => {
    const id = idFromRef(foto?.arquivo400pxOuterRef ?? foto?.arquivoOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, foto?.arquivo400pxOuterRef, foto?.arquivoOuterRef]);
  const thumb = useDocSnapshot(thumbRef);

  // The original (full-res) photo for the zoom modal — only subscribed while the
  // modal is open, so a list of thumbnails holds one live listener each, not two.
  const originalRef = useMemo(() => {
    const id = idFromRef(foto?.arquivoOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, foto?.arquivoOuterRef]);
  const original = useDocSnapshot(opened ? originalRef : null);

  const url = thumb.data?.data?.url ?? null;
  // Prefer the original in the modal; fall back to the thumbnail url if the
  // original doc has no url yet.
  const originalUrl = original.data?.data?.url ?? url;
  const canZoom = zoomable && foto !== null;

  // `thumb.data === null` means the arquivo doc does not exist (a missing photo);
  // `undefined` means it is still loading.
  const missing = foto === null || thumb.data === null;
  const thumbErrored = url !== null && erroredUrls.has(url);

  let content: React.ReactNode;
  if (missing || thumbErrored) {
    content = <BrokenImage size={size} />;
  } else if (url === null) {
    content = <Skeleton w={size} h={size} radius="sm" data-testid="produto-thumbnail-loading" />;
  } else {
    content = (
      <Image
        w={size}
        h={size}
        radius="sm"
        fit="cover"
        src={url}
        alt={alt}
        onError={() => markErrored(url)}
      />
    );
  }

  if (!canZoom) {
    return content;
  }

  return (
    <>
      <UnstyledButton
        onClick={() => setOpened(true)}
        aria-label={`Ampliar foto de ${alt}`}
        style={{ display: 'inline-flex', lineHeight: 0 }}
      >
        {content}
      </UnstyledButton>
      <Modal opened={opened} onClose={() => setOpened(false)} title={alt} size="lg" centered>
        {originalUrl !== null && !erroredUrls.has(originalUrl) ? (
          <Image
            src={originalUrl}
            alt={alt}
            fit="contain"
            mah="70vh"
            onError={() => markErrored(originalUrl)}
          />
        ) : original.loading ? (
          <Center h={200}>
            <Loader />
          </Center>
        ) : (
          <Center h={200}>
            <BrokenImage size={120} />
          </Center>
        )}
      </Modal>
    </>
  );
}
