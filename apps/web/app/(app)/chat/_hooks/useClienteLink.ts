'use client';

import { useQuery } from '@tanstack/react-query';
import { getDoc, getDocs } from 'firebase/firestore';
import { buildQuery, limit, whereOp } from '@delfrance/data';
import { idFromRef } from '@delfrance/schemas';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * The cliente behind a conversa's `usarioOuterRef` (legacy `conversa.dart:85-130`
 * — tap the avatar → `Cliente.documents.userCliente__isEqualTo(user).first()` →
 * open the cliente, or `novoClienteDialog` prefilled with `userCliente`).
 */
export type ClienteLink =
  | { status: 'loading' }
  | { status: 'no-user' }
  | { status: 'found'; clienteId: string; nome: string }
  | { status: 'not-found' }
  | { status: 'error' };

/**
 * The `cliente.userCliente` values to match a conversa's `usarioOuterRef`
 * against, or `null` when the conversa has no linked user (anonymous). This is
 * the INVERSE of C2's `ClientePickerModal.normalizeUsarioRef`: that canonicalizes
 * a possibly-bare `userCliente` UP to the `documents/usuarios/<uid>` form the
 * conversa carries; here we take the conversa's `usarioOuterRef`, extract the
 * uid, and query BOTH stored shapes (`documents/usuarios/<uid>` — what the #527
 * `discoverUser` writer + `usuarioOuterRef()` use — and the bare `usuarios/<uid>`
 * a legacy Flutter write may carry) so either round-trips. Firestore can't
 * normalize the stored value in a `where`, so we match both with an `in`.
 */
export function clienteUserRefCandidates(
  usarioOuterRef: string | null | undefined,
): string[] | null {
  if (!usarioOuterRef) return null;
  const uid = idFromRef(usarioOuterRef);
  if (!uid) return null;
  return [`documents/usuarios/${uid}`, `usuarios/${uid}`];
}

/**
 * @param clienteOuterRef `conversa.clienteOuterRef` — the direct link. When
 *   present it wins and the query below becomes a single `getDoc`, skipping the
 *   `usuarios` hop entirely.
 * @param usarioOuterRef `conversa.usarioOuterRef` — the legacy path, still the
 *   only link on Flutter-written and WhatsApp conversas.
 *
 * ⚠️ Direct ref FIRST, and the order is load-bearing rather than cosmetic. Doc
 * ids for ML conversas are byte-exact legacy digests, so the first post-cutover
 * redelivery for an old thread `merge()`s onto the Flutter-written document —
 * and a merge does not clear `usarioOuterRef`. Those docs therefore carry BOTH
 * fields, and only preferring the direct one resolves them to the right cliente.
 */
export function useClienteLink(
  clienteOuterRef: string | null | undefined,
  usarioOuterRef: string | null | undefined,
): ClienteLink {
  const clienteId = clienteOuterRef ? idFromRef(clienteOuterRef) : null;
  const candidates = clienteId ? null : clienteUserRefCandidates(usarioOuterRef);
  const enabled = clienteId != null || candidates !== null;

  const { data, isFetching, isError } = useQuery({
    queryKey: ['clienteLink', clienteId ?? usarioOuterRef ?? null],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<{ clienteId: string; nome: string } | null> => {
      const db = getFirebaseFirestore();
      const pickNome = (raw: unknown): string =>
        typeof raw === 'string' && raw.trim() !== '' ? raw : '(sem nome)';

      // Direct ref — one doc read, no query, so no index question arises.
      if (clienteId) {
        const snap = await getDoc(clienteCollection.docRef(db, {}, clienteId));
        if (!snap.exists()) return null;
        return { clienteId: snap.id, nome: pickNome(snap.data()?.nome) };
      }

      const snap = await getDocs(
        buildQuery(clienteCollection.ref(db, {}), [
          whereOp('userCliente', 'in', candidates!),
          limit(1),
        ]),
      );
      const doc = snap.docs[0];
      if (!doc) return null;
      return { clienteId: doc.id, nome: pickNome(doc.data().nome) };
    },
  });

  if (!enabled) return { status: 'no-user' };
  // A query FAILURE (permissions/network) must NOT read as 'not-found' — that
  // would offer "Criar cliente" and risk a duplicate. Surface it as 'error'.
  if (isError && data === undefined) return { status: 'error' };
  if (isFetching && data === undefined) return { status: 'loading' };
  if (data) return { status: 'found', clienteId: data.clienteId, nome: data.nome };
  return { status: 'not-found' };
}
