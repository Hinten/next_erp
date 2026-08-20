'use client';

import Link from 'next/link';
import { Badge, Button, Group, Title } from '@mantine/core';
import {
  ESTADO_FRETE_LABELS,
  ESTADO_PEDIDO_LABELS,
  type EstadoPedido,
  type Pedido,
  pedidoMeta,
  pedidoSchema,
} from '@delfrance/schemas';
import { TableView, type ActionConfig, type VirtualColumn } from '@delfrance/ui';

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
} from './PedidoCells';
import { ContingenciaBanner } from './ContingenciaBanner';
import { ClienteColumnFilter } from './ClienteColumnFilter';
import { EmitirLoteDialog } from './EmitirLoteDialog';
import { NfColumnFilter } from './NfColumnFilter';
import { PrintComumDialog } from './print/PrintComumDialog';
import { usePrintComumAction } from './print/usePrintComumAction';
import { useDownloadAnexosAction } from './useDownloadAnexosAction';
import { useDuplicarPedidoAction } from './useDuplicarPedidoAction';
import { DIRECAO, type Direcao } from './direcao';
import { DirecaoBadge } from './DirecaoBadge';
import { DirecaoSurface } from './DirecaoSurface';

// Frete-state enum options for the Frete column's `eq` filter.
const FRETE_ESTADO_OPTIONS = Object.entries(ESTADO_FRETE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

// `dependsOn` lists the schema fields each cell reads from `row.data`, so
// TableView can keep Pipeline projection enabled on this heavy collection
// (it would otherwise read full pedido docs). Keep these in sync with the
// cell implementations in ./PedidoCells.tsx.
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
    // `ehSaida` feeds the etiqueta direction-mismatch confirm (EtiquetaRowAction)
    // — Pipeline projection would otherwise strip it from `row.data`.
    dependsOn: ['freteInicial', 'ehSaida'],
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

export interface PedidosListViewProps {
  direcao: Direcao;
  /** Seam for direction-specific actions (e.g. a future saída-only "Devolução integral"). */
  extraActions?: Array<ActionConfig<Pedido>>;
}

/**
 * The pedidos list, parametrized by direction. `/pedidos` renders the saída
 * slice; `/pedidos/entradas` the entrada slice — same columns, actions and
 * cells, differing only in the `ehSaida` query binding, routes/labels and the
 * entrada-tinted surface.
 */
export function PedidosListView({ direcao, extraActions = [] }: PedidosListViewProps) {
  const cfg = DIRECAO[direcao];
  const { action: emitNFeAction, loteModal } = useEmitirNFeAction();
  const { action: printAction, printModal } = usePrintComumAction();
  const { action: downloadAnexosAction } = useDownloadAnexosAction();
  const { action: duplicarAction } = useDuplicarPedidoAction(direcao);
  return (
    <DirecaoSurface direcao={direcao}>
      <ContingenciaBanner />
      <TableView
        title={
          direcao === 'entrada' ? (
            <Group gap="xs" align="center">
              <Title order={2}>{cfg.listTitle}</Title>
              <DirecaoBadge direcao={direcao} />
            </Group>
          ) : (
            cfg.listTitle
          )
        }
        description={cfg.listDescription}
        schema={pedidoSchema}
        collection={pedidoCollection}
        db={getFirebaseFirestore()}
        meta={pedidoMeta}
        queryParams={{ ehSaida: cfg.ehSaida }}
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
        rowHref={(id) => cfg.editarPath(id)}
        renderNewButton={() => (
          <Button component={Link} href={cfg.novoPath}>
            {cfg.newButtonLabel}
          </Button>
        )}
        selectable
        // 5 actions on saída (emit + print + download anexos + duplicar +
        // devolução integral). Default ActionBar threshold is 3 → overflow
        // menu, which hid labeled buttons and broke every pedidos
        // bulk-action e2e.
        overflowThreshold={5}
        actions={[
          emitNFeAction,
          printAction,
          downloadAnexosAction,
          duplicarAction,
          ...extraActions,
        ]}
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
    </DirecaoSurface>
  );
}
