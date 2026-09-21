'use client';

import { useQuery } from '@tanstack/react-query';
import { getDoc } from 'firebase/firestore';
import { idFromRef } from '@delfrance/schemas';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Resolve a message author's display name from their `usuarios` doc — one cached
 * one-shot `getDoc` per uid (shared across every bubble by the same author).
 * Falls back to `'Anônimo'` when the uid is absent or the doc is missing
 * (legacy `getUserName` default). Used to label OTHER attendants' bubbles in a
 * multi-operator conversa.
 */
export function useAutorNome(
  userId: string | null | undefined,
  clienteRef?: string | null,
): string {
  const clienteId = clienteRef ? idFromRef(clienteRef) : null;
  const { data } = useQuery({
    queryKey: ['chatAutorNome', clienteId ? `cliente:${clienteId}` : (userId ?? null)],
    enabled: !!clienteId || !!userId,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<string> => {
      if (clienteId) {
        const snap = await getDoc(clienteCollection.docRef(getFirebaseFirestore(), {}, clienteId));
        return snap.data()?.nome || 'Cliente';
      }
      if (!userId) return 'Anônimo';
      const snap = await getDoc(usuarioCollection.docRef(getFirebaseFirestore(), {}, userId));
      const nome = snap.data()?.nome;
      return typeof nome === 'string' && nome.trim() !== '' ? nome : 'Anônimo';
    },
  });
  return data ?? (clienteId ? 'Cliente' : 'Anônimo');
}
