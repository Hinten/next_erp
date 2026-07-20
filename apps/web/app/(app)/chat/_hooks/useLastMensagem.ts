'use client';

import { useQuery } from '@tanstack/react-query';
import { lastMensagemQueryOptions, type LastMensagem } from '@/lib/chat/lastMensagemQuery';

/**
 * The newest message of a conversa, for the tile preview + delivery tick. One
 * cached one-shot `getDocs` per conversa (no per-tile listener); the cache is
 * keyed on `ultimaModificacao`, so it refetches exactly when the conversa gains
 * activity. See `lib/chat/lastMensagemQuery.ts` for why this beats a single
 * Enterprise pipeline for last-message-per-conversa.
 */
export function useLastMensagem(
  conversaId: string,
  ultimaModificacao: number | null | undefined,
): { data: LastMensagem | undefined; loading: boolean } {
  const { data, isLoading } = useQuery(lastMensagemQueryOptions(conversaId, ultimaModificacao));
  return { data, loading: isLoading };
}
