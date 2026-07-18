'use client';

import { useQuery } from '@tanstack/react-query';
import { getDocs } from 'firebase/firestore';
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

export function useClienteLink(usarioOuterRef: string | null | undefined): ClienteLink {
  const candidates = clienteUserRefCandidates(usarioOuterRef);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['clienteLink', usarioOuterRef ?? null],
    enabled: candidates !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<{ clienteId: string; nome: string } | null> => {
      const db = getFirebaseFirestore();
      const snap = await getDocs(
        buildQuery(clienteCollection.ref(db, {}), [
          whereOp('userCliente', 'in', candidates!),
          limit(1),
        ]),
      );
      const doc = snap.docs[0];
      if (!doc) return null;
      const nome = doc.data().nome;
      return { clienteId: doc.id, nome: nome && nome.trim() !== '' ? nome : '(sem nome)' };
    },
  });

  if (candidates === null) return { status: 'no-user' };
  // A query FAILURE (permissions/network) must NOT read as 'not-found' — that
  // would offer "Criar cliente" and risk a duplicate. Surface it as 'error'.
  if (isError && data === undefined) return { status: 'error' };
  if (isFetching && data === undefined) return { status: 'loading' };
  if (data) return { status: 'found', clienteId: data.clienteId, nome: data.nome };
  return { status: 'not-found' };
}
