'use client';

import { useMemo } from 'react';
import { Image } from '@mantine/core';
import { type Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';
import { useDocSnapshot } from '@delfrance/data/hooks';

const ARQUIVOS_PREFIX = 'arquivos/';

// In-app placeholder (inline SVG data-URI) — no external network dependency
// (avoids a third-party request + CSP/privacy concerns for missing thumbnails).
const PLACEHOLDER_SRC =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2040%2040%22%3E%3Crect%20width%3D%2240%22%20height%3D%2240%22%20fill%3D%22%23e9ecef%22%2F%3E%3C%2Fsvg%3E';

/** Derive the arquivo doc id from a `Foto` ref string (`arquivos/<id>`). */
function idFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const id = ref.startsWith(ARQUIVOS_PREFIX) ? ref.slice(ARQUIVOS_PREFIX.length) : ref;
  return id || null;
}

export interface ProdutoThumbnailProps {
  db: Firestore;
  produto: Produto | null;
  size?: number;
}

/**
 * A small product thumbnail (40px by default) for the pedido item rows. Resolves
 * the first foto's 400px derivative (falling back to the original), live-reads
 * its arquivo doc for the public `url`, and renders a Mantine `Image` with a
 * placeholder fallback. Renders the placeholder while loading or when the
 * produto has no foto.
 */
export function ProdutoThumbnail({ db, produto, size = 40 }: ProdutoThumbnailProps) {
  const foto = produto?.fotos?.[0] ?? null;
  const ref = useMemo(() => {
    const id = idFromRef(foto?.arquivo400pxOuterRef ?? foto?.arquivoOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, foto?.arquivo400pxOuterRef, foto?.arquivoOuterRef]);
  const { data } = useDocSnapshot(ref);
  const url = data?.data?.url ?? null;

  return (
    <Image
      w={size}
      h={size}
      radius="sm"
      fit="cover"
      src={url}
      fallbackSrc={PLACEHOLDER_SRC}
      alt={produto?.nome ?? 'Produto'}
    />
  );
}
