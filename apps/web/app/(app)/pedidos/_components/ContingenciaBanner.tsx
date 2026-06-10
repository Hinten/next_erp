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
import { getDoc, getDocs } from 'firebase/firestore';

import type { ContingenciaModo } from '@delfrance/schemas';

import { filialCollection } from '@/lib/data/filialCollection';
import { NFE_CONFIG_DOC_ID, nfeConfigCollection } from '@/lib/data/nfeConfigCollection';
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
      // One parallel `nfeconfig/default` read per filial. Deliberately NOT a
      // collectionGroup('nfeconfig') filter: that would require a
      // collection-group index AND a `{path=**}/nfeconfig` rules match, and a
      // tenant has a handful of filiais — the fan-out is bounded and cached
      // (staleTime below), so the simpler reads win.
      const filiais = await getDocs(filialCollection.ref(db, {}));
      const checks = filiais.docs.map(async (f): Promise<ActiveContingency | null> => {
        const cfgSnap = await getDoc(
          nfeConfigCollection.docRef(db, { filialId: f.id }, NFE_CONFIG_DOC_ID),
        );
        const cfg = cfgSnap.exists() ? cfgSnap.data() : null;
        if (!cfg || cfg.contingencia_modo === 'none') return null;
        return {
          filialId: f.id,
          filialNome: f.data().fantasia ?? f.data().razaoSocial,
          modo: cfg.contingencia_modo,
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
