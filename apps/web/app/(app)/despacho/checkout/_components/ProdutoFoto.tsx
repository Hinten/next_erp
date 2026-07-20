'use client';

import { memo } from 'react';
import { Image } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { EngineProduto } from '@delfrance/schemas';
import { useProdutoFotoUrl } from './fotoUrl';

// Inline SVG placeholder (data-URI) — no network request for a missing photo.
const PLACEHOLDER_SRC =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2040%2040%22%3E%3Crect%20width%3D%2240%22%20height%3D%2240%22%20fill%3D%22%23e9ecef%22%2F%3E%3C%2Fsvg%3E';

export interface ProdutoFotoProps {
  db: Firestore;
  produto: EngineProduto | null;
  size?: number;
}

/**
 * A produto thumbnail for the expected/scan rows — resolves the cover photo URL
 * lazily (only the virtualized rows on screen mount, so only those read). Memoed
 * on the produto reference so a scan that replaces ONE expected item doesn't
 * re-resolve every other row's photo.
 */
export const ProdutoFoto = memo(function ProdutoFoto({ db, produto, size = 48 }: ProdutoFotoProps) {
  const url = useProdutoFotoUrl(db, produto);
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
});
