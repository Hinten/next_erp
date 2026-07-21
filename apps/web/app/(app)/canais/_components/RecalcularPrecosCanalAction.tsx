'use client';

/**
 * Channel-agnostic "Recalcular preços em massa" entry point (#544), mounted on
 * every canal account page (/canais/mercado-livre/[id], /canais/balcao/[id],
 * /canais/whatsapp/[id]). Reads the integração doc's two price-table refs
 * (`tabelaNormalOuterRef` / `tabelaPromocionalOuterRef`) and adapts:
 *  - neither set (or the doc is still loading) → nothing rendered
 *  - exactly one set → a single button straight to that lista
 *  - both set → a menu to pick which lista to recalculate
 *
 * The target screen (`/produtos/recalcular-precos`) is owned by a sibling
 * module in this PR — this component only navigates to it via `?listaId=`.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { Button, Menu } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { idFromRef, type Integracao } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export function RecalcularPrecosCanalAction({ integracaoId }: { integracaoId: string }) {
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();
  const docRef = useMemo(
    () => integracaoCollection.docRef(db, {}, integracaoId),
    [db, integracaoId],
  );
  const { data, loading } = useDocSnapshot<Integracao>(docRef);

  if (!canWrite || loading || !data) return null;

  const normalRef = data.data.tabelaNormalOuterRef;
  const promocionalRef = data.data.tabelaPromocionalOuterRef;

  if (!normalRef && !promocionalRef) return null;

  if (normalRef && promocionalRef) {
    return (
      <Menu withinPortal position="bottom-end" shadow="md">
        <Menu.Target>
          <Button variant="default">Recalcular preços</Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            component={Link}
            href={`/produtos/recalcular-precos?listaId=${idFromRef(normalRef)}`}
          >
            Tabela normal
          </Menu.Item>
          <Menu.Item
            component={Link}
            href={`/produtos/recalcular-precos?listaId=${idFromRef(promocionalRef)}`}
          >
            Tabela promocional
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  }

  // Exactly one of the two refs is set at this point (the "both" case
  // returned above and the "neither" case returned earlier).
  const onlyRef = normalRef ?? promocionalRef;
  if (!onlyRef) return null;

  return (
    <Button
      variant="default"
      component={Link}
      href={`/produtos/recalcular-precos?listaId=${idFromRef(onlyRef)}`}
    >
      Recalcular preços
    </Button>
  );
}
