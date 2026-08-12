'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { deleteDoc } from 'firebase/firestore';
import { Badge, Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import {
  type MetodoPagamento,
  metodoPagamentoMeta,
  metodoPagamentoSchema,
} from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { metodoPagamentoCollection } from '@/lib/data/pagamentoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { usePermission } from '@/lib/auth';

export default function MercadoPagoPage() {
  const db = getFirebaseFirestore();
  const { allowed: canDelete } = usePermission(PERM.metodoPagamento.delete);
  const searchParams = useSearchParams();

  // The OAuth callback redirects here (not to /[id]) when it fails BEFORE a
  // trustworthy metodoId is known (missing params / bad state / no secret) —
  // surface that instead of silently dropping the error.
  useEffect(() => {
    if (searchParams.get('mp') === 'error') {
      notifications.show({
        color: 'red',
        message: `Falha ao conectar a conta Mercado Pago (${searchParams.get('reason') ?? 'erro'}).`,
      });
    }
  }, [searchParams]);

  // `metodo_pgto` holds one config doc per payment-gateway account (today
  // only Mercado Pago). `metodoPagamentoMeta.defaultQuery` orders by `nome`.
  return (
    <TableView<typeof metodoPagamentoSchema>
      title="Mercado Pago"
      description="Contas e configurações da integração com Mercado Pago."
      schema={metodoPagamentoSchema}
      collection={metodoPagamentoCollection}
      db={db}
      meta={metodoPagamentoMeta}
      defaultColumns={['nome', 'hasLinkPagamento', 'user_id']}
      rowHref={(id) => `/pagamentos/mercado-pago/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/pagamentos/mercado-pago/novo">
          Nova conta
        </Button>
      )}
      fields={{
        hasLinkPagamento: {
          label: 'Link de pagamento',
          renderCell: (value) =>
            value ? (
              <Badge color="green" variant="light">
                Habilitado
              </Badge>
            ) : (
              <Badge color="gray" variant="light">
                Desabilitado
              </Badge>
            ),
        },
        user_id: {
          label: 'Conexão',
          // `user_id` is stamped at OAuth exchange and never cleared, so it
          // means "was linked", not "credential currently valid" — the live
          // check is the detail page's ContaMercadoPagoPanel. Null-compare:
          // 0 is a set value, only null means never linked.
          renderCell: (value) =>
            value != null ? (
              <Badge color="green" variant="outline">
                Vinculada
              </Badge>
            ) : (
              <Badge color="gray" variant="outline">
                Não vinculada
              </Badge>
            ),
        },
      }}
      selectable
      actions={
        canDelete
          ? [
              {
                id: 'delete',
                label: 'Excluir',
                color: 'red',
                requiresSelection: true,
                refreshOnComplete: true,
                confirm: {
                  title: 'Excluir contas Mercado Pago',
                  message:
                    'Excluir a conta remove a configuração do Mercado Pago. Confirmar exclusão?',
                },
                run: async (rows) => {
                  await Promise.all(
                    rows.map((r: { id: string; data: MetodoPagamento }) =>
                      deleteDoc(metodoPagamentoCollection.docRef(db, {}, r.id)),
                    ),
                  );
                },
              },
            ]
          : []
      }
    />
  );
}
