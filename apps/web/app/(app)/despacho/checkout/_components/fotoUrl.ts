'use client';

import { useMemo } from 'react';
import { getDoc, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import type { EngineProduto } from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';

/**
 * Lazy product-photo URL resolution for the checkout panes. A produto's `fotos`
 * carry only arquivo REFS (`arquivos/<id>`); the public download `url` lives on
 * the arquivo doc. We resolve it per VISIBLE row (the virtualized panes only
 * mount on-screen rows) with a one-shot cached `useQuery` — not a realtime
 * listener per row, since a produto's photo never changes during a scan session.
 * Mirrors `pedidos/_components/ProdutoThumbnail`, but read-once + on-demand.
 */

const ARQUIVOS_PREFIX = 'arquivos/';

/** Bare `<id>` from a `Foto` ref string (`arquivos/<id>` or `documents/arquivos/<id>`). */
function arquivoIdFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const segs = ref.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  return last && last.length > 0 ? last : null;
}

/** The cover foto's small-derivative ref (200 → 400 → original) of an engine produto, or null. */
export function coverArquivoId(
  produto: Pick<EngineProduto, 'fotos'> | null | undefined,
): string | null {
  const foto = produto?.fotos?.[0];
  if (!foto) return null;
  return arquivoIdFromRef(
    foto.arquivo200pxOuterRef ?? foto.arquivo400pxOuterRef ?? foto.arquivoOuterRef,
  );
}

/**
 * The public URL of a produto's cover photo, or `null` while loading / when the
 * produto has none. Keyed by arquivo id so two rows sharing a photo share one
 * fetch; `enabled` gates the query so produtos without a foto never read.
 */
export function useProdutoFotoUrl(db: Firestore, produto: EngineProduto | null): string | null {
  const arquivoId = useMemo(() => coverArquivoId(produto), [produto]);
  const query = useQuery({
    queryKey: ['checkout-foto', arquivoId],
    enabled: arquivoId !== null,
    // Photos are immutable within a session — cache aggressively.
    staleTime: Infinity,
    queryFn: async (): Promise<string | null> => {
      const snap = await getDoc(arquivoCollection.docRef(db, {}, arquivoId!));
      return snap.exists() ? (snap.data().url ?? null) : null;
    },
  });
  return query.data ?? null;
}
