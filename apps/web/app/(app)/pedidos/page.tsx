'use client';

import Link from 'next/link';
import { Badge, Button } from '@mantine/core';
import {
  ESTADO_PEDIDO_LABELS,
  type EstadoPedido,
  type Pedido,
  pedidoMeta,
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
import { ContingenciaBanner } from './_components/ContingenciaBanner';
import { EmitirLoteDialog } from './_components/EmitirLoteDialog';
import { PrintComumDialog } from './_components/print/PrintComumDialog';
import { usePrintComumAction } from './_components/print/usePrintComumAction';

// `dependsOn` lists the schema fields each cell reads from `row.data`, so
// TableView can keep Pipeline projection enabled on this heavy collection
// (it would otherwise read full pedido docs). Keep these in sync with the
// cell implementations in ./_components/PedidoCells.tsx.
const virtualColumns: ReadonlyArray<VirtualColumn<Pedido>> = [
  {
    key: 'nf',
    label: 'NF',
    tooltip: 'Nota Fiscal',
    // Reads only the pedido id (subscribes to the nfev4 subcollection).
    dependsOn: [],
    renderCell: (r) => <NFCell pedidoId={r.id} />,
  },
  {
    key: 'cliente',
    label: 'Cliente',
    dependsOn: ['clientePedidoOuterRef'],
    renderCell: (r) => <ClienteCell pedido={r.data} />,
  },
  {
    key: 'vlr',
    label: 'Vlr',
    // valorCobrado cache, falling back to pedidoTotal over itens.
    dependsOn: ['valorCobrado', 'itens'],
    renderCell: (r) => <VlrCell pedido={r.data} />,
  },
  {
    key: 'expedicao',
    label: 'Expedição',
    dependsOn: ['freteInicial'],
    renderCell: (r) => <ExpedicaoCell pedido={r.data} />,
  },
  {
    key: 'frete',
    label: 'Frete',
    dependsOn: ['freteInicial'],
    renderCell: (r) => <FreteCell pedido={r.data} pedidoId={r.id} />,
  },
  {
    key: 'criacao',
    label: 'Criação',
    dependsOn: ['timestamp'],
    renderCell: (r) => <CriacaoCell pedido={r.data} />,
  },
  {
    key: 'imp',
    label: 'Imp.',
    tooltip: 'Data de Impressão',
    dependsOn: ['dtImpressao'],
    renderCell: (r) => <ImpCell pedido={r.data} />,
  },
];

export default function PedidosPage() {
  const { action: emitNFeAction, loteModal } = useEmitirNFeAction();
  const { action: printAction, printModal } = usePrintComumAction();
  return (
    <>
      <ContingenciaBanner />
      <TableView
        title="Pedidos"
        description="Selecione pedidos e use o botão acima da tabela para emitir NF-e."
        schema={pedidoSchema}
        collection={pedidoCollection}
        db={getFirebaseFirestore()}
        meta={pedidoMeta}
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
              <Badge variant="light">{ESTADO_PEDIDO_LABELS[value as EstadoPedido] ?? '—'}</Badge>
            ),
          },
        }}
        rowHref={(id) => `/pedidos/${id}/editar`}
        renderNewButton={() => (
          <Button component={Link} href="/pedidos/novo">
            Novo pedido
          </Button>
        )}
        selectable
        actions={[emitNFeAction, printAction]}
      />
      <EmitirLoteDialog
        opened={loteModal.opened}
        pedidoIds={loteModal.pedidoIds}
        onClose={loteModal.close}
      />
      <PrintComumDialog
        opened={printModal.opened}
        pedidoIds={printModal.pedidoIds}
        alreadyPrintedCount={printModal.alreadyPrintedCount}
        onClose={printModal.close}
      />
    </>
  );
}
