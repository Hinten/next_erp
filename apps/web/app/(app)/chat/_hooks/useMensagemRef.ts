'use client';

import { useQuery } from '@tanstack/react-query';
import { getDoc } from 'firebase/firestore';
import { type Mensagem, idFromRef, mensagemSchema } from '@delfrance/schemas';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export interface ReferencedMensagem {
  id: string;
  mensagem: Mensagem;
}

/**
 * Resolve a referenced mensagem (a quote's `context.mensagemOuterRef` or a
 * reaction's `reaction.mensagemOuterRef`) by its outer-ref path — one cached
 * one-shot `getDoc`. The ref is a full doc path
 * (`documents/chat/<conversaId>/mensagem/<msgId>`); `dereferenceOuterRef`
 * strips the `documents/` prefix and builds the ref. Returns `undefined` while
 * loading / when the ref is absent / the doc is missing (soft-parse tolerant).
 */
export function useMensagemRef(ref: string | null | undefined): {
  referenced: ReferencedMensagem | undefined;
  loading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: ['chatMensagemRef', ref ?? null],
    enabled: !!ref,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ReferencedMensagem | null> => {
      if (!ref) return null;
      const docRef = dereferenceOuterRef(getFirebaseFirestore(), ref);
      if (!docRef) return null;
      const snap = await getDoc(docRef);
      const raw = snap.data();
      if (raw === undefined) return null;
      const parsed = mensagemSchema.safeParse(raw);
      if (!parsed.success) return null;
      return { id: idFromRef(ref), mensagem: parsed.data };
    },
  });
  return { referenced: data ?? undefined, loading: isLoading };
}
