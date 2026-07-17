/**
 * Resolve the non-chave filter modes of /nfe/comunicacoes to a list of NF-e
 * chaves, all via server-side Firebase client-SDK queries (no client-side
 * filtering — CLAUDE.md "Key fixed decisions"):
 *
 *  - `nnf`          → `collectionGroup('nfev4') where numeracao == N && filialId == <filial>`
 *  - `pedidoId`     → the `pedidos/{id}/nfev4` subcollection
 *  - `pedidoNumero` → `pedidos where numero == term limit 10` → per-pedido nfev4 reads
 *
 * The resolved chaves feed a `targetsChnfe array-contains-any` extraFilter,
 * which Firestore caps at 30 values — so the result is capped at MAX_CHAVES
 * (fetching cap+1 to detect overflow → `truncated`). Chaves are deduped and
 * null chaves dropped (pre-emission nfev4 docs carry `chave: null`).
 *
 * Caveat: legacy nfev4 docs without the denormalized `filialId` aren't found
 * by the `nnf` mode (the collection-group query filters on it).
 *
 * FirebaseError propagates to the caller (TanStack useQuery) — no catch here.
 */
import { type Firestore, getDocs } from 'firebase/firestore';
import { buildQuery, groupQuery, limit, whereEqual } from '@delfrance/data';

import { NFEV4_COLLECTION_GROUP, nfeCollection } from '@/lib/data/nfeCollection';
import { pedidoCollection } from '@/lib/data/pedidoCollection';

/** `array-contains-any` cap (Firestore) — also the classic-path cap in TableView. */
export const MAX_CHAVES = 30;

/** `pedidos where numero ==` fan-out cap — numero collisions are pathological. */
const MAX_PEDIDOS_POR_NUMERO = 10;

export type EnviNfeFilterMode = 'chave' | 'nnf' | 'pedidoNumero' | 'pedidoId';

export interface EnviNfeFilter {
  readonly mode: EnviNfeFilterMode;
  readonly term: string;
}

/** The modes that need chave resolution — `chave` filters `targetsChnfe` directly. */
export type ResolvableEnviNfeFilter = EnviNfeFilter & {
  readonly mode: Exclude<EnviNfeFilterMode, 'chave'>;
};

export interface ResolvedChaves {
  readonly chaves: ReadonlyArray<string>;
  /** `true` when more than MAX_CHAVES distinct chaves matched (result capped). */
  readonly truncated: boolean;
}

/** Dedupe + drop null/empty chaves, cap at MAX_CHAVES with the truncated flag. */
function collect(rawChaves: ReadonlyArray<string | null | undefined>): ResolvedChaves {
  const unique = [...new Set(rawChaves.filter((c): c is string => !!c))];
  return {
    chaves: unique.slice(0, MAX_CHAVES),
    truncated: unique.length > MAX_CHAVES,
  };
}

export async function resolveChaves(
  db: Firestore,
  filialId: string,
  filter: ResolvableEnviNfeFilter,
): Promise<ResolvedChaves> {
  if (filter.mode === 'nnf') {
    // Fetch cap+1 so an over-cap match set flips `truncated` instead of
    // silently dropping chaves.
    const snap = await getDocs(
      buildQuery(groupQuery(db, NFEV4_COLLECTION_GROUP, nfeCollection.converter), [
        whereEqual('numeracao', Number(filter.term)),
        whereEqual('filialId', filialId),
        limit(MAX_CHAVES + 1),
      ]),
    );
    return collect(snap.docs.map((d) => d.data().chave));
  }

  if (filter.mode === 'pedidoId') {
    const snap = await getDocs(
      buildQuery(nfeCollection.ref(db, { pedidoId: filter.term }), [limit(MAX_CHAVES + 1)]),
    );
    return collect(snap.docs.map((d) => d.data().chave));
  }

  // pedidoNumero — two hops: pedidos by numero (a STRING field — never coerce),
  // then each pedido's nfev4 subcollection.
  const pedidos = await getDocs(
    buildQuery(pedidoCollection.ref(db, {}), [
      whereEqual('numero', filter.term),
      limit(MAX_PEDIDOS_POR_NUMERO),
    ]),
  );
  const perPedido = await Promise.all(
    pedidos.docs.map((p) =>
      getDocs(buildQuery(nfeCollection.ref(db, { pedidoId: p.id }), [limit(MAX_CHAVES + 1)])),
    ),
  );
  return collect(perPedido.flatMap((snap) => snap.docs.map((d) => d.data().chave)));
}
