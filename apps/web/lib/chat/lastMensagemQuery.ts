/**
 * Shared TanStack Query options for "the newest message of a conversa" — one
 * cached one-shot `getDocs` (orderBy timestamp desc, limit 1) per conversa,
 * keyed so both the tile preview (`useLastMensagem`) and the Atendimento badge
 * (`useChatBadges`) read the SAME cache entry (no duplicate fetch).
 *
 * ── Why per-tile cached one-shots, not a single Enterprise pipeline ─────────
 * A "last-message-per-conversa for the visible set" pipeline was evaluated
 * (`@delfrance/data` `buildPipeline` / `usePipelineSnapshot`) and rejected:
 *   1. `buildPipeline` exposes only collection/documents source + where/sort/
 *      select/limit — there is NO group-by-parent + max(timestamp) aggregate
 *      stage, so a collection-group `mensagem` query returns every message
 *      interleaved, not one-per-conversa;
 *   2. `mensagem` docs don't carry their parent `conversaId` as a field (it is
 *      only in the path), so even a grouping stage would have nothing to group
 *      on; and
 *   3. `usePipelineSnapshot` is one-shot (no realtime) and flat-rowed.
 * Correctness first: the cached per-conversa fetches are the approved baseline.
 * The `ultima_modificacao` key busts the cache exactly when the conversa gains
 * activity, so previews stay fresh without a per-tile listener.
 */
import { getDocs } from 'firebase/firestore';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import type { Mensagem } from '@delfrance/schemas';
import { mensagemCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export type LastMensagem = Mensagem | null;

/** Query key: cache is busted only when the conversa's recency stamp changes. */
export function lastMensagemQueryKey(
  conversaId: string,
  ultimaModificacao: number | null | undefined,
): (string | number | null)[] {
  return ['lastMsg', conversaId, ultimaModificacao ?? null];
}

export function lastMensagemQueryOptions(
  conversaId: string,
  ultimaModificacao: number | null | undefined,
) {
  return {
    queryKey: lastMensagemQueryKey(conversaId, ultimaModificacao),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<LastMensagem> => {
      const q = buildQuery(mensagemCollection.ref(getFirebaseFirestore(), { conversaId }), [
        orderByField('timestamp', 'desc'),
        limit(1),
      ]);
      const snap = await getDocs(q);
      return snap.docs[0]?.data() ?? null;
    },
  };
}
