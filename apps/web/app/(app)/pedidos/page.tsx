'use client';

import Link from 'next/link';
import { Badge, Button } from '@mantine/core';
import {
  ESTADO_PEDIDO_LABELS,
  type EstadoPedido,
  type Pedido,
  pedidoSchema,
} from '@delfrance/schemas';
import { TableView, type VirtualColumn } from '@delfrance/ui';

import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useEmitirNFeAction } from '@/lib/nfe/bulkEmit';

import {
  ClienteCell,
  CriacaoCell,
  ExpedicaoCell,
  FreteCell,
  ImpCell,
  NFCell,
  VlrCell,
} from './_components/PedidoCells';
import { EmitirLoteDialog } from './_components/EmitirLoteDialog';

const virtualColumns: ReadonlyArray<VirtualColumn<Pedido>> = [
  { key: 'nf',        label: 'NF',        tooltip: 'Nota Fiscal',       renderCell: (r) => <NFCell pedidoId={r.id} /> },
  { key: 'cliente',   label: 'Cliente',   renderCell: (r) => <ClienteCell pedido={r.data} /> },
  { key: 'vlr',       label: 'Vlr',       renderCell: (r) => <VlrCell pedido={r.data} /> },
  { key: 'expedicao', label: 'Expedição', renderCell: (r) => <ExpedicaoCell pedido={r.data} /> },
  { key: 'frete',     label: 'Frete',     renderCell: (r) => <FreteCell pedido={r.data} /> },
  { key: 'criacao',   label: 'Criação',   renderCell: (r) => <CriacaoCell pedido={r.data} /> },
  { key: 'imp',       label: 'Imp.',      tooltip: 'Data de Impressão', renderCell: (r) => <ImpCell pedido={r.data} /> },
];

export default function PedidosPage() {
  const { action: emitNFeAction, loteModal } = useEmitirNFeAction();
  return (
    <>
      <TableView
        title="Pedidos"
        description="Selecione pedidos e use o botão acima da tabela para emitir NF-e."
        schema={pedidoSchema}
        collection={pedidoCollection}
        db={getFirebaseFirestore()}
        defaultColumns={[
          'numero',
          'estado',
          'nf',
          'cliente',
          'vlr',
          'expedicao',
          'frete',
          'criacao',
          'imp',
        ]}
        virtualColumns={virtualColumns}
        fields={{
          estado: {
            label: 'Pagamento',
            renderCell: (value) => (
              <Badge variant="light">
                {ESTADO_PEDIDO_LABELS[value as EstadoPedido] ?? '—'}
              </Badge>
            ),
          },
        }}
        orderBy={{ field: 'numero', direction: 'desc' }}
        pageSize={50}
        rowHref={(id) => `/pedidos/${id}/editar`}
        renderNewButton={() => (
          <Button component={Link} href="/pedidos/novo">
            Novo pedido
          </Button>
        )}
        selectable
        actions={[emitNFeAction]}
      />
      <EmitirLoteDialog
        opened={loteModal.opened}
        pedidoIds={loteModal.pedidoIds}
        onClose={loteModal.close}
      />
    </>
  );
}
