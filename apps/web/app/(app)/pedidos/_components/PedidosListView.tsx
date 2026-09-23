'use client';

import { useMemo } from 'react';
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
import { useIntegracoes } from '@/lib/data/useIntegracoes';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useEmitirNFeAction } from '@/lib/nfe/bulkEmit';

import {
  ClienteCell,
  CriacaoCell,
  DisputaCell,
  ExpedicaoCell,
  FreteCell,
  ImpCell,
  IntegracaoCell,
  NFCell,
  VlrCell,
} from './PedidoCells';
import { ContingenciaBanner } from './ContingenciaBanner';
import { ClienteColumnFilter, formatClienteFilterValue } from './ClienteColumnFilter';
import { EmitirLoteDialog } from './EmitirLoteDialog';
import { IntegracaoColumnFilter } from './IntegracaoColumnFilter';
import { formatIntegracaoFilterValue, type IntegracaoLookup } from './integracaoLookup';
import { NfColumnFilter } from './NfColumnFilter';
import { PedidoRowReadsContext, usePedidoRowReadPrefetch } from './rowReadPrefetch';
import { PrintComumDialog } from './print/PrintComumDialog';
import { usePrintComumAction } from './print/usePrintComumAction';
import { useConfirmarEntregaAction } from './useConfirmarEntregaAction';
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
// Exported so `PedidosListView.columns.test.ts` can assert every declared column
// actually reaches the screen. `disputa` was declared here and absent from
// `pedidoMeta.defaultQuery.columns`, so it rendered on no fresh browser (#1322).
/**
 * The column whose cell carries the row link (#1503). Hoisted so
 * `PedidosListView.columns.test.ts` can assert it is actually in the visible
 * set — restating the literal on both sides would let the prop change to a key
 * `columns` never lists while the test still passed. `TableView` warns about an
 * inert `rowLinkColumn`, but NOT about that case: `rowLinkInertReason` checks
 * that the key resolves to a descriptor or a virtual column, never that it is
 * among the visible ones.
 */
export const PEDIDO_ROW_LINK_COLUMN = 'numero';

/**
 * The pedidos list's virtual columns.
 *
 * A FUNCTION rather than a module constant, because the Canal column has to
 * close over the shared `integracao` lookup: its cell renders a channel NAME,
 * and so must its active-filter chip — `formatValue` is a synchronous pure
 * callback with no way to reach a hook result on its own. `/produtos` builds its
 * virtual columns the same way and for the same reason.
 *
 * Safe against `useTableUrlState`'s one-shot hydration (it reads the filterable
 * fields in a `useState` initializer): every column KEY is present from the
 * first render, and only the closures change once the lookup resolves.
 */
export function pedidoVirtualColumns(
  integracoes: IntegracaoLookup,
): ReadonlyArray<VirtualColumn<Pedido>> {
  return [
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
      // The marketplace dispute overlay (#1322). Deliberately narrow and next to
      // NF, because this list IS the dispatch surface: an operator picks orders to
      // ship from here, and during a mediation ML keeps the order `paid` — so the
      // "Pagamento" column reads a healthy "Pago" and every other cell looks
      // normal. Without this the only warning lives inside a tab nobody opens.
      //
      // ⚠️ Reads two scalars off the pedido doc, so it costs NO extra read and
      // needs NO index — it rides the projection the list already fetches. A
      // FILTER on it would need one (`pedidos(disputaAbertaEm, …)`); deliberately
      // not offered here, so the column cannot quietly become an unindexed query.
      key: 'disputa',
      label: '',
      tooltip: 'Reclamação / devolução no marketplace',
      dependsOn: ['disputaAbertaEm', 'devolucaoAbertaEm', 'bloqueiosLiberados'],
      renderCell: (r) => <DisputaCell pedido={r.data} />,
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
        // Without this the chip printed the stored value verbatim — either the
        // whole `documents/clientes/<id>` path, or (for the Anônimo filter, which
        // carries `null`) the word `null`.
        formatValue: formatClienteFilterValue,
      },
    },
    {
      // The canal de venda. This list is the dispatch surface and a marketplace
      // operator works one channel at a time, so the column exists mainly to
      // carry its filter — a TableView filter affordance lives in a column
      // header, and there is no other way to offer one.
      //
      // ⚠️ Reads ONE scalar off the pedido doc and resolves it against the
      // page-wide `useIntegracoes` map, so it costs no extra Firestore read —
      // explicitly not a per-row `getDoc` (#1216/#1303).
      key: 'integracao',
      label: 'Canal',
      tooltip: 'Canal de venda (integração)',
      dependsOn: ['integracaoPedidoOuterRef'],
      renderCell: (r) => <IntegracaoCell pedido={r.data} lookup={integracoes} />,
      // ⚠️ Deliberately NO `sortField`, same call `/produtos` made on its
      // integrações column. The stored value is `documents/integracao/<random
      // doc id>`, so `orderBy` on it groups rows by channel in random channel
      // order and orders by nothing within a channel — a sort no operator can
      // predict. Ordering by channel NAME would need a denormalized field kept
      // in sync by a trigger plus a backfill, the trade #869 worked and rejected.
      filter: {
        field: 'integracaoPedidoOuterRef',
        label: 'Canal',
        renderFilter: ({ value, onChange }) => (
          <IntegracaoColumnFilter
            integracoes={integracoes.rows}
            status={integracoes.status}
            value={value}
            onChange={onChange}
          />
        ),
        // The stored value is an opaque doc path, so without this the chip would
        // read `Canal: documents/integracao/xR2k9…`.
        formatValue: (value) => formatIntegracaoFilterValue(value, integracoes),
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
}

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
  const { action: confirmarEntregaAction } = useConfirmarEntregaAction();
  // One batched read per collection for the whole page, instead of one `getDoc`
  // per row from `ClienteCell` and `FreteCell` (#1216). The provider only ever
  // makes those cells' reads cheaper — see `rowReadPrefetch` for why it can
  // never withhold one.
  const rowReads = usePedidoRowReadPrefetch();
  // ONE shared `['integracoes']` read for the whole page (cached 5 min), handed
  // to every Canal cell and to the column's chip formatter — see
  // `integracaoLookup`. The collection is a cadastro with a handful of rows.
  const {
    rows: integracaoRows,
    byId: integracaoById,
    status: integracaoStatus,
  } = useIntegracoes(getFirebaseFirestore());
  const virtualColumns = useMemo(
    () =>
      pedidoVirtualColumns({
        rows: integracaoRows,
        byId: integracaoById,
        status: integracaoStatus,
      }),
    [integracaoRows, integracaoById, integracaoStatus],
  );
  return (
    <PedidoRowReadsContext.Provider value={rowReads.status}>
      <DirecaoSurface direcao={direcao}>
        <ContingenciaBanner />
        <TableView
          onRowsChange={rowReads.onRows}
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
          // The column set is FIXED here, and that is what makes
          // `defaultQuery.columns` authoritative. Left at the default `true`,
          // `TableView` reads the per-browser `localStorage` set instead
          // (`visibleKeysArr = showColumnPicker ? storedKeysArr : …`) — and
          // Mantine's `useLocalStorage` WRITES `defaultValue` to storage on
          // mount, with no user interaction at all. So every browser that has
          // ever opened this list carries a set frozen at that visit, and a
          // newly declared column (`disputa`) would reach only a browser that
          // had never been here. Same reasoning as `/produtos`.
          showColumnPicker={false}
          rowLinkColumn={PEDIDO_ROW_LINK_COLUMN}
          renderNewButton={() => (
            <Button component={Link} href={cfg.novoPath}>
              {cfg.newButtonLabel}
            </Button>
          )}
          selectable
          // 6 actions on saída (emit + print + download anexos + duplicar +
          // confirmar entrega + devolução integral). Default ActionBar
          // threshold is 3 → overflow menu, which hid labeled buttons and
          // broke every pedidos bulk-action e2e.
          overflowThreshold={6}
          actions={[
            emitNFeAction,
            printAction,
            downloadAnexosAction,
            duplicarAction,
            confirmarEntregaAction,
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
    </PedidoRowReadsContext.Provider>
  );
}
