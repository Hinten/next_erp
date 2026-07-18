'use client';

import { useQuery } from '@tanstack/react-query';
import { getDoc } from 'firebase/firestore';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Resolve a conversa's display name from its `chat` doc — one cached one-shot
 * `getDoc` per conversa id, shared across every match row in a global-search
 * group. Keyed `['conversa', id]` with a 5-minute `staleTime` so re-searching or
 * re-rendering the results list never re-reads. Falls back to the conversa id
 * while loading / when the doc is missing (deleted), so a header always renders.
 */
export function useConversaNome(conversaId: string): string {
  const { data } = useQuery({
    queryKey: ['conversa', conversaId],
    enabled: conversaId !== '',
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<string | null> => {
      const snap = await getDoc(conversaCollection.docRef(getFirebaseFirestore(), {}, conversaId));
      const nome = snap.data()?.nome;
      return typeof nome === 'string' && nome.trim() !== '' ? nome : null;
    },
  });
  return data ?? conversaId;
}
