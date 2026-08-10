'use client';

import Link from 'next/link';
import { Badge, Button } from '@mantine/core';
import {
  ESTADO_BALANCO_VISIVEL_LABELS,
  balancoMeta,
  balancoSchema,
  estadoBalanco,
  type EstadoBalanco,
} from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { balancoCollection } from '@/lib/data/balancoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const COR_ESTADO: Record<string, string> = {
  aberto: 'blue',
  finalizando: 'yellow',
  finalizado: 'green',
  erro: 'red',
};

export default function BalancoPage() {
  return (
    <TableView
      title="Balanço de estoque"
      description="Contagens de inventário por depósito."
      schema={balancoSchema}
      collection={balancoCollection}
      db={getFirebaseFirestore()}
      meta={balancoMeta}
      defaultColumns={['nome', 'estado', 'timestamp', 'dataFinalizado']}
      rowHref={(id) => `/balanco/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/balanco/novo">
          Novo balanço
        </Button>
      )}
      fields={{
        estado: {
          // An open balanço stores `estado: null` — the workflow lock is
          // server-owned, so "aberto" has no stored value and the default cell
          // renderer would show a blank.
          renderCell: (value: unknown) => {
            const estado = estadoBalanco({ estado: (value ?? null) as EstadoBalanco | null });
            return (
              <Badge variant="light" color={COR_ESTADO[estado]}>
                {ESTADO_BALANCO_VISIVEL_LABELS[estado]}
              </Badge>
            );
          },
        },
      }}
    />
  );
}
