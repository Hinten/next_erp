'use client';

import { useMemo } from 'react';
import type { Firestore } from 'firebase/firestore';
import { Alert, Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { TIPO_AVISO, chaveAvisoReceitaKitShopee } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { MENSAGENS_POR_TIPO } from '@/lib/avisos/mensagens';
import { avisoCollection } from '@/lib/data/avisoCollection';

const MENSAGEM = MENSAGENS_POR_TIPO[TIPO_AVISO.shopeeKitReceitaDivergente];

/**
 * The conta's OPEN "kit with an old composition" aviso for this produto, when
 * there is one (`data-testid="shopee-aviso-receita-<contaId>"`) — the server's
 * own verdict that the native kit on Shopee no longer carries the ERP recipe
 * (step 19's L4; its one decision is `reavaliarAvisoDeReceitaKit`). The tab
 * re-derives nothing: it reads that ONE document by its deterministic id
 * (`chaveAvisoReceitaKitShopee`) and words it through the inbox's own copy
 * (`MENSAGENS_POR_TIPO`), so the bell and the tab say the same thing.
 *
 * Read only for a conta holding a native-kit link, and only with the aviso read
 * bit — without it Firestore would answer a raw permission-denied, so the
 * notice is simply absent (the bell is the same).
 */
export function AvisoReceitaKitShopee({
  db,
  contaId,
  produtoId,
}: {
  db: Firestore;
  contaId: string;
  produtoId: string;
}) {
  const { allowed, loading } = usePermission(PERM.aviso.read);
  const ref = useMemo(
    () =>
      !loading && allowed
        ? avisoCollection.docRef(db, {}, chaveAvisoReceitaKitShopee(contaId, produtoId))
        : null,
    [db, contaId, produtoId, allowed, loading],
  );
  const snap = useDocSnapshot(ref);
  const aviso = snap.data?.data;
  if (aviso === undefined || aviso.resolvidoEm != null) return null;
  // A soft-read hands over the RAW document on a parse miss: never index a
  // `params` that is not an object — the copy prints its placeholders instead.
  const params: Record<string, string | number> =
    typeof aviso.params === 'object' && aviso.params !== null ? aviso.params : {};
  return (
    <Alert
      color="yellow"
      variant="light"
      title={MENSAGEM.titulo}
      data-testid={`shopee-aviso-receita-${contaId}`}
    >
      <Text size="sm">{MENSAGEM.corpo(params)}</Text>
    </Alert>
  );
}
