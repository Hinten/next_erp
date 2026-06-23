'use client';

/**
 * Resolves a filial id to authenticate the SEFAZ Consulta Cadastro mTLS call
 * from the cliente screens (which, unlike the NF-e screens, have no filial
 * context). The cert identifies the *requester*, not the queried CNPJ, so any
 * authorized filial works — we pick the most recently touched one. When the
 * grupo has no filial (or the read fails) the hook returns `undefined` and the
 * caller simply skips the SEFAZ leg (the public CNPJ API still fills nome +
 * endereço).
 */

import { useQuery } from '@tanstack/react-query';
import { getDocs, limit, query } from 'firebase/firestore';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

async function fetchDefaultFilialId(): Promise<string | null> {
  const db = getFirebaseFirestore();
  // Any authorized filial works (its cert only identifies the requester, not the
  // queried CNPJ), so a bare `limit(1)` — no `orderBy`, which would exclude
  // legacy docs missing the sort field — is enough.
  const snap = await getDocs(query(filialCollection.ref(db, {}), limit(1)));
  return snap.docs[0]?.id ?? null;
}

export function useDefaultFilialId(): string | undefined {
  const { data } = useQuery({
    queryKey: ['default-filial-id'],
    queryFn: fetchDefaultFilialId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return data ?? undefined;
}
