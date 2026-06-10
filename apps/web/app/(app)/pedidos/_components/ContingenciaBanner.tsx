'use client';

/**
 * Orange warning banner shown above the pedidos table while any filial has
 * NF-e contingency active (`nfeconfig.contingencia_modo !== 'none'`) — every
 * emission from that filial will go out as tpEmis 6/7 (SVC), so the operator
 * should know at a glance, and remember to switch back after the outage.
 */
import Link from 'next/link';
import { Alert, Anchor } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { collectionGroup, getDoc, getDocs, query as fsQuery, where } from 'firebase/firestore';

import type { ContingenciaModo } from '@delfrance/schemas';

import { filialCollection } from '@/lib/data/filialCollection';
import { nfeConfigCollection } from '@/lib/data/nfeConfigCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

interface ActiveContingency {
  readonly filialId: string;
  readonly filialNome: string;
  readonly modo: ContingenciaModo;
}

export function ContingenciaBanner() {
  const db = getFirebaseFirestore();
  const query = useQuery({
    queryKey: ['contingencia-banner'],
    queryFn: async (): Promise<ActiveContingency[]> => {
      // One collection-group query for ACTIVE configs only (modo != 'none' —
      // docs that never got the field are normal-mode by definition and are
      // excluded by Firestore's != semantics). Only the matched configs
      // (usually zero) trigger a filial read for the display name.
      // NOTE: runs index-free on Firestore Enterprise; the index audit for
      // the NF-e module's queries is a tracked follow-up.
      const activeSnap = await getDocs(
        fsQuery(
          collectionGroup(db, 'nfeconfig').withConverter(nfeConfigCollection.converter),
          where('contingencia_modo', '!=', 'none'),
        ),
      );
      const checks = activeSnap.docs.map(async (cfgDoc): Promise<ActiveContingency | null> => {
        // `filiais/{filialId}/nfeconfig/{id}` → the filial doc is the
        // grandparent of the config doc.
        const filialRef = cfgDoc.ref.parent.parent;
        if (!filialRef) return null;
        const filial = await getDoc(filialCollection.docRef(db, {}, filialRef.id));
        if (!filial.exists()) return null;
        return {
          filialId: filialRef.id,
          filialNome: filial.data().fantasia ?? filial.data().razaoSocial,
          modo: cfgDoc.data().contingencia_modo,
        };
      });
      return (await Promise.all(checks)).filter((c): c is ActiveContingency => c !== null);
    },
    // The toggle flips rarely (an outage event); a stale banner for a few
    // minutes is fine and keeps the per-navigation read cost at zero.
    staleTime: 5 * 60_000,
  });

  const active = query.data ?? [];
  if (active.length === 0) return null;

  return (
    <Alert color="orange" title="Contingência NF-e ativa" mb="sm">
      {active.map((a) => (
        <span key={a.filialId}>
          <Anchor component={Link} href={`/configuracoes/filiais/${a.filialId}`} size="sm">
            {a.filialNome}
          </Anchor>{' '}
          está emitindo em modo {a.modo.toUpperCase()}.{' '}
        </span>
      ))}
      Novas NF-e sairão como contingência — desligue o modo quando a SEFAZ voltar.
    </Alert>
  );
}
