'use client';

import { useMemo, useState } from 'react';
import { Center, Image, Loader, Modal, Skeleton, UnstyledButton } from '@mantine/core';
import { IconPhotoOff } from '@tabler/icons-react';
import { type Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { useFirstExistingArquivoUrl } from '@/lib/produtos/fotoCapa';
import {
  type FotoVariante,
  arquivoIdFromRef,
  fotoArquivoIdCandidates,
} from '@/lib/produtos/fotoRefs';

/** Accessible label for the broken-image placeholder (missing or failed load). */
const BROKEN_LABEL = 'Foto indisponível';

/**
 * 400px first here, unlike the list's 200px default: this thumbnail is
 * click-to-zoom and renders up to `size` px, so the extra detail is worth the
 * bytes. The 200px rung stays as a middle step because a partially-written
 * derivative set is possible — `processProductOriginal` writes the three
 * variants in a loop and a failure between them leaves some present.
 */
const PREFERENCIA_THUMBNAIL: readonly FotoVariante[] = ['400', '200', 'original'];

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
 * A shared, size-configurable product thumbnail. Resolves the first foto down
 * the 400px → 200px → original ladder — falling through on a **missing
 * document**, not on a null ref — live-reads that `arquivos/` doc for the
 * public `url`, and renders a Mantine `Image`. Shows a placeholder while a
 * candidate is still resolving and a **broken-image icon** only when the
 * produto has no foto, EVERY candidate document is missing, or the image fails
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

  // Thumbnail source: the 400px derivative, then 200px, then the original —
  // resolved by DOCUMENT EXISTENCE, not by which ref string is non-null.
  // `buildFotoRefs` writes every derivative ref optimistically at upload time,
  // so a `??` over the refs always picks the 400px one and then resolves it to
  // nothing whenever the resize function has not produced it; that is what used
  // to render this as a permanent broken image. See `lib/produtos/fotoCapa.ts`.
  const thumbIds = useMemo(() => fotoArquivoIdCandidates(foto, PREFERENCIA_THUMBNAIL), [foto]);
  const thumb = useFirstExistingArquivoUrl(db, thumbIds);

  // The original (full-res) photo for the zoom modal — only subscribed while the
  // modal is open, so a list of thumbnails holds one live listener each, not two.
  const originalRef = useMemo(() => {
    const id = arquivoIdFromRef(foto?.arquivoOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, foto?.arquivoOuterRef]);
  const original = useDocSnapshot(opened ? originalRef : null);

  const url = thumb.url;
  // Prefer the original in the modal; fall back to the thumbnail url if the
  // original doc has no url yet.
  const originalUrl = original.data?.data?.url ?? url;
  const canZoom = zoomable && foto !== null;

  // Broken means EVERY candidate resolved to nothing — the produto has no foto,
  // or none of its arquivo docs exists. While a candidate is still being read,
  // `resolved` is false and the skeleton shows instead.
  const missing = foto === null || (thumb.resolved && url === null);
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
        type="button"
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
