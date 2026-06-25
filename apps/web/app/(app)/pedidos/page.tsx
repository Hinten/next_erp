'use client';

import Link from 'next/link';
import { Badge, Button } from '@mantine/core';
import {
  ESTADO_FRETE_LABELS,
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
import { ClienteColumnFilter } from './_components/ClienteColumnFilter';
import { EmitirLoteDialog } from './_components/EmitirLoteDialog';
import { NfColumnFilter } from './_components/NfColumnFilter';

// Frete-state enum options for the Frete column's `eq` filter.
const FRETE_ESTADO_OPTIONS = Object.entries(ESTADO_FRETE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

// `dependsOn` lists the schema fields each cell reads from `row.data`, so
// TableView can keep Pipeline projection enabled on this heavy collection
// (it would otherwise read full pedido docs). Keep these in sync with the
// cell implementations in ./_components/PedidoCells.tsx.
//
// `sortField` / `filter` back each virtual column with a (possibly nested)
// document field so it sorts/filters server-side via the Pipeline. NF and
// Cliente are filter-only: NF resolves through the `nfev4` subcollection
// (collection-group lookup), Cliente matches the stored ref path — neither has
// a sortable value on the pedido doc.
const virtualColumns: ReadonlyArray<VirtualColumn<Pedido>> = [
  {
    key: 'nf',
    label: 'NF',
    tooltip: 'Nota Fiscal',
    // Reads only the pedido id (subscribes to the nfev4 subcollection).
    dependsOn: [],
    renderCell: (r) => <NFCell pedidoId={r.id} />,
    filter: {
      field: 'nf',
      label: 'NF',
      subcollectionLookup: {
        subcollection: 'nfev4',
        fields: [
          { value: 'numeracao', label: 'Número', numeric: true },
          { value: 'chave', label: 'Chave' },
        ],
      },
      renderFilter: ({ value, onChange }) => <NfColumnFilter value={value} onChange={onChange} />,
    },
  },
  {
    key: 'cliente',
    label: 'Cliente',
    dependsOn: ['clientePedidoOuterRef'],
    renderCell: (r) => <ClienteCell pedido={r.data} />,
    filter: {
      field: 'clientePedidoOuterRef',
      label: 'Cliente',
      renderFilter: ({ value, onChange }) => (
        <ClienteColumnFilter value={value} onChange={onChange} />
      ),
    },
  },
  {
    key: 'vlr',
    label: 'Vlr',
    // valorCobrado cache, falling back to pedidoTotal over itens.
    dependsOn: ['valorCobrado', 'itens'],
    renderCell: (r) => <VlrCell pedido={r.data} />,
    sortField: 'valorCobrado',
    filter: { field: 'valorCobrado', label: 'Valor', kind: 'currency' },
  },
  {
    key: 'expedicao',
    label: 'Expedição',
    dependsOn: ['freteInicial'],
    renderCell: (r) => <ExpedicaoCell pedido={r.data} />,
    sortField: 'freteInicial.prazoDespacho',
    filter: {
      field: 'freteInicial.prazoDespacho',
      label: 'Expedição',
      kind: 'datetime',
      dateUnit: 'us',
    },
  },
  {
    key: 'frete',
    label: 'Frete',
    dependsOn: ['freteInicial'],
    renderCell: (r) => <FreteCell pedido={r.data} pedidoId={r.id} />,
    sortField: 'freteInicial.estado',
    filter: {
      field: 'freteInicial.estado',
      label: 'Frete',
      kind: 'enum',
      options: FRETE_ESTADO_OPTIONS,
    },
  },
  {
    key: 'criacao',
    label: 'Criação',
    dependsOn: ['timestamp'],
    renderCell: (r) => <CriacaoCell pedido={r.data} />,
    sortField: 'timestamp',
    filter: { field: 'timestamp', label: 'Criação', kind: 'datetime', dateUnit: 'us' },
  },
  {
    key: 'imp',
    label: 'Imp.',
    tooltip: 'Data de Impressão',
    dependsOn: ['dtImpressao'],
    renderCell: (r) => <ImpCell pedido={r.data} />,
    sortField: 'dtImpressao',
    filter: { field: 'dtImpressao', label: 'Impressão', kind: 'datetime', dateUnit: 'us' },
  },
];

export default function PedidosPage() {
  const { action: emitNFeAction, loteModal } = useEmitirNFeAction();
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
          'expedicao',
          'vlr',
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
