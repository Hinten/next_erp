'use client';

import { useQuery } from '@tanstack/react-query';
import { getDoc } from 'firebase/firestore';
import { type Arquivo, idFromRef } from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Resolve the `Arquivo` a mensagem media sub-object points at — one cached
 * one-shot `getDoc` per arquivo id. The media sub-objects (`image`/`video`/
 * `audio`/`sticker`/`genericDocument`) and the legacy `anexoStorage` all carry
 * an outer-ref string (`documents/arquivos/<id>` or a bare `<col>/<id>`);
 * {@link idFromRef} extracts the id regardless of form. Returns `undefined`
 * while loading / when the ref is absent.
 */
export function useArquivo(ref: string | null | undefined): {
  arquivo: Arquivo | undefined;
  loading: boolean;
} {
  const arquivoId = ref ? idFromRef(ref) : '';
  const { data, isLoading } = useQuery({
    queryKey: ['chatArquivo', arquivoId],
    enabled: arquivoId !== '',
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<Arquivo | null> => {
      const snap = await getDoc(arquivoCollection.docRef(getFirebaseFirestore(), {}, arquivoId));
      return snap.data() ?? null;
    },
  });
  return { arquivo: data ?? undefined, loading: isLoading };
}
