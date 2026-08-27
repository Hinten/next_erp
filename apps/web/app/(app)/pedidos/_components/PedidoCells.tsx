'use client';

/**
 * Per-cell components for the Pedidos TableView's virtual columns.
 *
 * The NF column stays realtime — it reflects async state transitions (SEFAZ
 * replies authoring `estado` from the orchestrator) without a page refresh —
 * but its listener is GATED on the row being on screen and torn down once the
 * row scrolls away, so the list's page size is no longer its concurrent-
 * listener count. `useLatestNfe` owns that mechanism and documents why (#1216).
 *
 * The other cells are static — `ClienteCell` does a one-shot cached read
 * via TanStack Query + `getDoc`, `FreteCell` and `ImpCell` are passthroughs.
 */
import { type ReactNode, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getDoc, type DocumentReference } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import {
  ESTADO_FRETE_LABELS,
  ESTADO_NFE,
  ESTADO_NFE_LABELS,
  type EstadoNFe,
  type IntegracaoFrete,
  type NotaFiscalEletronica,
  type Pedido,
  TIPO_CLIENTE_LABELS,
  type TipoCliente,
  freightCapsFor,
  pedidoTotal,
} from '@delfrance/schemas';
import { microsToMillis } from '@delfrance/core/datetime';
import { formatReais } from '@delfrance/core/money';
import {
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  HoverCard,
  type MantineColor,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconBan, IconCheck, IconFileDownload, IconFileText } from '@tabler/icons-react';

import { CopyIconButton } from '@/components/CopyIconButton';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { downloadNfeXml, selectNfeXml } from '@/lib/nfe/downloadXml';
import { DanfeMenu } from '@/components/DanfeMenu';
import { EtiquetaRowAction } from './EtiquetaRowAction';
import { useLatestNfe } from './useLatestNfe';
import { clienteQueryKey, intFreteTipoQueryKey, usePedidoRowReads } from './rowReadPrefetch';

const DASH = '—';

/**
 * Pretty-print a microsecond-since-epoch value as a Brazilian date+time.
 * Returns `DASH` when null/undefined.
 */
function formatMicros(us: number | null | undefined): string {
  if (us == null) return DASH;
  return new Date(microsToMillis(us)).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* -------------------------------------------------------------------------- */
/*                                  NFCell                                    */
/*                                                                            */
/*  Renders a colored badge for the latest doc in `pedidos/{pedidoId}/nfev4`  */
/*  (ordered by `ultima_modificacao` desc, limit 1 — see `useLatestNfe`, which */
/*  owns the query and its viewport gate). Hovering the badge opens a          */
/*  HoverCard with the Estado, cStat, xMotivo, Número, Chave and Erro fields — */
/*  each copyable via an icon button when present.                            */
/* -------------------------------------------------------------------------- */

const NFE_STATE_COLOR: Record<EstadoNFe, MantineColor> = {
  [ESTADO_NFE.gerado]: 'gray',
  [ESTADO_NFE.enviando]: 'yellow',
  [ESTADO_NFE.aguardandoResposta]: 'yellow',
  [ESTADO_NFE.processamentoCompleto]: 'blue',
  [ESTADO_NFE.processamentoCancelado]: 'gray',
  [ESTADO_NFE.aprovada]: 'green',
  [ESTADO_NFE.epecAprovado]: 'green',
  [ESTADO_NFE.rejeitada]: 'red',
  [ESTADO_NFE.cancelada]: 'gray',
  [ESTADO_NFE.numeracaoInutilizada]: 'gray',
  [ESTADO_NFE.error]: 'red',
};

export function NFCell({ pedidoId }: { pedidoId: string }) {
  const { ref, status, badge: latest, doc, latestId } = useLatestNfe(pedidoId);
  const router = useRouter();

  // EVERY branch renders through this wrapper. The IntersectionObserver needs a
  // non-zero box BEFORE any data exists, so an unresolved cell must still hold
  // the badge's space instead of collapsing — a zero-height target never
  // intersects, and the row would stay unsubscribed forever.
  const wrap = (children: ReactNode) => (
    <Box ref={ref} display="inline-block" mih={20} miw={70}>
      {children}
    </Box>
  );

  // `idle` (not subscribed, nothing remembered) and `loading` are both "we do
  // not know yet" — never the dash below, which asserts the pedido HAS no NF-e.
  if (status !== 'ready') return wrap(<Skeleton height={20} width={70} />);
  if (!latest) return wrap(<Text c="dimmed">{DASH}</Text>);
  // Only an authorized NF-e can be cancelled (110111) or corrected (CC-e, 110110).
  const isAprovada = latest.estado === ESTADO_NFE.aprovada;
  // A DANFE can be printed for an authorized NF-e, a cancelada one (it
  // retains its procNFe and prints with a CANCELADO overlay) and an
  // EPEC-approved one (plain-paper DANFE with the EPEC protocolo box) — same
  // set the per-NF-e screen + the danfeArtifactService allow.
  const canPrintDanfe =
    isAprovada ||
    latest.estado === ESTADO_NFE.cancelada ||
    latest.estado === ESTADO_NFE.epecAprovado;
  // The XML download reads straight from the nfev4 doc (no HTTP round-trip),
  // so it's available whenever any XML has been persisted — authorized,
  // EPEC, or the signed pre-transmission anchor.
  //
  // ⚠️ `doc` is the LIVE document and is undefined for a memo-backed render
  // (`useLatestNfe`). Every action below hangs off it rather than off the badge:
  // handing the operator a remembered `procNFe` would serve a stale fiscal
  // document, and `xml_assinado` is nulled by the same write that persists
  // `xml_nfe_proc`, so a remembered copy can disagree about which XML exists.
  const hasXml = doc != null && selectNfeXml(doc) != null;
  const color = NFE_STATE_COLOR[latest.estado] ?? 'gray';
  const label = ESTADO_NFE_LABELS[latest.estado] ?? latest.estado;
  // tpEmis === 1 is the normal (SEFAZ síncrono) path. Anything else
  // (4 EPEC, 6 SVC-AN, 7 SVC-RS, 2/5 FS) is a contingência variant — use
  // the outline variant so the operator can tell at a glance.
  const variant = latest.tpEmis !== 1 ? 'outline' : 'light';
  const hasCStatMsg = latest.cStat != null && latest.xMotivo != null;
  const messageCopyValue =
    latest.error ?? (hasCStatMsg ? `${latest.cStat} - ${latest.xMotivo}` : null);
  return wrap(
    <HoverCard
      withinPortal
      shadow="md"
      openDelay={150}
      closeDelay={100}
      position="bottom-start"
      width={360}
    >
      <HoverCard.Target>
        <Badge variant={variant} color={color} style={{ cursor: 'help' }} tabIndex={0}>
          {label}
        </Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        {/* Dropdown content is portaled but React-bubbles to the row's
            onClick — stop it so the copy/cancelar controls don't navigate. */}
        <Stack gap="xs" onClick={(e) => e.stopPropagation()}>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" fw={500}>
              Estado:
            </Text>
            <Text size="sm">{label}</Text>
          </Group>

          {latest.cStat != null && (
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" fw={500}>
                cStat:
              </Text>
              <Text size="sm">{latest.cStat}</Text>
            </Group>
          )}

          {latest.xMotivo != null && (
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
                xMotivo:
              </Text>
              <Text size="sm" style={{ wordBreak: 'break-word' }}>
                {latest.xMotivo}
              </Text>
            </Group>
          )}

          <Group gap="xs" wrap="nowrap" justify="space-between">
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" fw={500}>
                Número:
              </Text>
              <Text size="sm">{latest.numeracao}</Text>
            </Group>
            <CopyIconButton value={String(latest.numeracao)} label="Copiar número" />
          </Group>

          {latest.chave != null && (
            <Group gap="xs" wrap="nowrap" justify="space-between" align="center">
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
                  Chave:
                </Text>
                <Text ff="monospace" size="xs" truncate style={{ minWidth: 0 }}>
                  {latest.chave}
                </Text>
              </Group>
              <CopyIconButton value={latest.chave} label="Copiar chave" />
            </Group>
          )}

          {messageCopyValue != null && (
            <Group gap="xs" wrap="nowrap" justify="space-between" align="flex-start">
              <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
                  {latest.error != null ? 'Erro:' : 'Mensagem:'}
                </Text>
                <Text size="sm" style={{ wordBreak: 'break-word' }}>
                  {messageCopyValue}
                </Text>
              </Group>
              <CopyIconButton value={messageCopyValue} label="Copiar mensagem" />
            </Group>
          )}

          {doc != null && latestId && (canPrintDanfe || hasXml) && (
            <Group gap="xs" mt="xs">
              {canPrintDanfe && <DanfeMenu pedidoId={pedidoId} nfeId={latestId} />}
              {hasXml && (
                <Button
                  color="gray"
                  variant="light"
                  size="xs"
                  leftSection={<IconFileDownload size={14} />}
                  onClick={(e) => {
                    // Stop the row's navigate-onClick; download the XML
                    // straight from the doc already in hand.
                    e.stopPropagation();
                    downloadNfeXml(doc);
                  }}
                >
                  Baixar XML
                </Button>
              )}
              {isAprovada && (
                <>
                  <Button
                    color="blue"
                    variant="light"
                    size="xs"
                    leftSection={<IconFileText size={14} />}
                    onClick={(e) => {
                      // Stop the row's navigate-onClick; go straight to this NF-e's
                      // carta de correção screen (form + history of CC-e).
                      e.stopPropagation();
                      router.push(`/pedidos/${pedidoId}/nfe/${latestId}/carta-correcao`);
                    }}
                  >
                    Carta de correção
                  </Button>
                  <Button
                    color="red"
                    variant="light"
                    size="xs"
                    leftSection={<IconBan size={14} />}
                    onClick={(e) => {
                      // Stop the row's navigate-onClick; go to the per-NF-e screen
                      // (communication history + cancelamento form).
                      e.stopPropagation();
                      router.push(`/pedidos/${pedidoId}/nfe`);
                    }}
                  >
                    Cancelar NF-e
                  </Button>
                </>
              )}
            </Group>
          )}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>,
  );
}

/* -------------------------------------------------------------------------- */
/*                                ClienteCell                                 */
/*                                                                            */
/*  Dereferences pedido.clientePedidoOuterRef and reads the cliente doc once  */
/*  (one-shot `getDoc`, cached by TanStack Query and Firestore's in-memory    */
/*  cache). Cliente data rarely changes within a pedido row's lifecycle, so   */
/*  no live listener is justified — multiple rows referencing the same       */
/*  cliente share the cached fetch.                                           */
/* -------------------------------------------------------------------------- */

interface ClienteDoc {
  readonly nome?: string | null;
  readonly cpf_cnpj?: string | null;
  readonly tipo?: TipoCliente | null;
}

/**
 * Format a CPF (11 digits) or CNPJ (14 digits) for display. Falls back to
 * the raw value when the length doesn't match either pattern.
 */
function formatCpfCnpj(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return raw;
}

export function ClienteCell({ pedido }: { pedido: Pedido }) {
  const db = getFirebaseFirestore();
  const rowReads = usePedidoRowReads();
  const ref = useMemo(
    () => dereferenceOuterRef(db, pedido.clientePedidoOuterRef),
    [db, pedido.clientePedidoOuterRef],
  ) as DocumentReference<ClienteDoc> | null;
  const path = ref?.path ?? null;

  const { data, isLoading } = useQuery<ClienteDoc | null>({
    queryKey: clienteQueryKey(path ?? ''),
    queryFn: async () => {
      if (!ref) return null;
      // ⚠️ Read through the COLLECTION HANDLE, matching how `rowReadPrefetch`
      // batch-reads the same documents. Both paths must produce the same value:
      // a converter-parsed document and a raw `snap.data()` differ wherever the
      // schema has a `.default()`, and seeding one into a key the other reads is
      // how #1303 broke `pedidos-etiqueta-ml` on the int_frete side.
      const snap = await getDoc(clienteCollection.docRef(db, {}, ref.id));
      return (snap.data() as ClienteDoc | undefined) ?? null;
    },
    // Wait for the page-level batch to seed this key, then read whatever it
    // did not cover. `rowReads` is `'settled'` outside the provider and after
    // PREFETCH_MAX_WAIT_MS regardless, so this can only ever DELAY the read
    // briefly — never withhold it.
    enabled: !!ref && rowReads === 'settled',
    staleTime: 5 * 60 * 1000,
  });

  if (!ref) return <Text c="dimmed">Anônimo</Text>;
  if (isLoading) return <Skeleton height={20} width={120} />;
  const nome = data?.nome ?? 'Anônimo';
  const cpfCnpj = data?.cpf_cnpj ? formatCpfCnpj(data.cpf_cnpj) : null;
  const tipoLabel = data?.tipo ? TIPO_CLIENTE_LABELS[data.tipo] : null;
  const tooltip =
    cpfCnpj && tipoLabel ? `${tipoLabel}: ${cpfCnpj}` : (cpfCnpj ?? tipoLabel ?? nome);
  return (
    <Tooltip label={tooltip} withinPortal>
      <Anchor
        component={Link}
        href={`/clientes/${ref.id}`}
        // Stop the row's onClick (which navigates to the pedido detail page)
        // from firing when the user clicks the cliente link.
        onClick={(e) => e.stopPropagation()}
        underline="hover"
        c="inherit"
      >
        {nome}
      </Anchor>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  VlrCell                                   */
/*                                                                            */
/*  Uses the cached `valorCobrado` if set; falls back to a fresh              */
/*  `pedidoTotal(pedido)` over the itens record.                              */
/* -------------------------------------------------------------------------- */

export function VlrCell({ pedido }: { pedido: Pedido }) {
  const value = pedido.valorCobrado ?? pedidoTotal(pedido);
  if (value === 0 && pedido.valorCobrado == null) {
    return <Text c="dimmed">{DASH}</Text>;
  }
  return <Text fw={500}>{formatReais(value)}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                               ExpedicaoCell                                */
/*                                                                            */
/*  Reads pedido.freteInicial?.prazoDespacho (ms since epoch).                */
/* -------------------------------------------------------------------------- */

export function ExpedicaoCell({ pedido }: { pedido: Pedido }) {
  return <Text>{formatMicros(pedido.freteInicial?.prazoDespacho)}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                                 FreteCell                                  */
/*                                                                            */
/*  Reads pedido.freteInicial?.estado (typed enum). With no bought ME label   */
/*  it stays a lightweight tracking tooltip; when `printLabelId` is set it     */
/*  opens a HoverCard with an "Imprimir etiqueta" action (re-print, no spend)  */
/*  via `client.imprimir`. The click-for-history dialog from the legacy UX     */
/*  waits on the historicoFrete subcollection — deferred per issue #52.        */
/* -------------------------------------------------------------------------- */

export function FreteCell({ pedido, pedidoId }: { pedido: Pedido; pedidoId: string }) {
  const db = getFirebaseFirestore();
  const frete = pedido.freteInicial;
  const estado = frete?.estado;

  // A generic-label tipo (motoboy/outros) has no denormalized marker on
  // `freteInicial` the way `externalOptionIntegracao` marks a fetch-label
  // marketplace frete — its tipo lives only on the `int_frete` doc. Resolve
  // it the same way `EtiquetaRowAction` does; the query is cached and keyed
  // by the int_frete path, so rows sharing an integração (and this cell's
  // own later mount of `EtiquetaRowAction`) share one read.
  const intRef = useMemo(
    () => dereferenceOuterRef(db, frete?.integracaoFreteOuterRef) as DocumentReference | null,
    [db, frete?.integracaoFreteOuterRef],
  );
  // A bought label, a selected quote or a fetch-label marketplace frete
  // already answers `hasEtiquetaAction` without knowing the tipo — skip the
  // int_frete read entirely for those rows (most of a page of already-bought
  // ME/ML pedidos never needs it).
  const canFetchLabel =
    frete?.externalOptionIntegracao != null &&
    freightCapsFor(frete.externalOptionIntegracao).canFetchLabel;
  const knownEtiquetaAction =
    frete?.printLabelId != null || frete?.externalOptionId != null || canFetchLabel;
  const { data: intTipo } = useQuery<IntegracaoFrete | null>({
    queryKey: intFreteTipoQueryKey(intRef?.path ?? ''),
    // NOT batch-gated: `int_frete` is deliberately left out of the page-level
    // prefetch (see `intFreteTipoQueryKey`), so there is nothing to wait for.
    enabled: intRef != null && !knownEtiquetaAction,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDoc(intRef!);
      return snap.exists() ? ((snap.data() as { tipo?: IntegracaoFrete }).tipo ?? null) : null;
    },
  });

  if (!estado) return <Text c="dimmed">{DASH}</Text>;
  const label = ESTADO_FRETE_LABELS[estado] ?? estado;

  // Show the etiqueta HoverCard when there's something to act on — a bought
  // label (reprint/track), a selected quote (buy), a fetch-label marketplace
  // frete (real ML pedidos carry NEITHER printLabelId nor externalOptionId —
  // only externalOptionIntegracao identifies them), or a generic-label tipo
  // (its on-demand PDF needs no prior state). Otherwise keep the lightweight
  // tracking tooltip.
  const isGenericLabel = intTipo != null && freightCapsFor(intTipo).labelMode === 'generic';
  const hasEtiquetaAction = knownEtiquetaAction || isGenericLabel;
  if (!hasEtiquetaAction) {
    const tooltipParts: string[] = [];
    if (frete?.codRastreio) tooltipParts.push(`Rastreio: ${frete.codRastreio}`);
    if (frete?.prazoDespacho != null)
      tooltipParts.push(`Prazo: ${formatMicros(frete.prazoDespacho)}`);
    if (tooltipParts.length === 0) return <Text>{label}</Text>;
    return (
      <Tooltip label={tooltipParts.join(' • ')} withinPortal>
        <Text style={{ cursor: 'help' }}>{label}</Text>
      </Tooltip>
    );
  }

  return (
    <HoverCard withinPortal shadow="md" openDelay={150} closeDelay={100} position="bottom-start">
      <HoverCard.Target>
        <Badge variant="light" color="gray" style={{ cursor: 'help' }} tabIndex={0}>
          {label}
        </Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        {/* Portaled but React-bubbles to the row onClick — stop it so the
            controls don't navigate to the pedido detail. */}
        <Stack gap="xs" onClick={(e) => e.stopPropagation()}>
          {frete?.codRastreio && (
            <Group gap="xs" wrap="nowrap" justify="space-between">
              <Text size="sm">
                <Text span fw={500}>
                  Rastreio:
                </Text>{' '}
                {frete.codRastreio}
              </Text>
              <CopyIconButton value={frete.codRastreio} label="Copiar rastreio" />
            </Group>
          )}
          {frete?.prazoDespacho != null && (
            <Text size="sm">
              <Text span fw={500}>
                Prazo:
              </Text>{' '}
              {formatMicros(frete.prazoDespacho)}
            </Text>
          )}
          <EtiquetaRowAction pedido={pedido} pedidoId={pedidoId} />
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/* -------------------------------------------------------------------------- */
/*                                CriacaoCell                                 */
/* -------------------------------------------------------------------------- */

export function CriacaoCell({ pedido }: { pedido: Pedido }) {
  return <Text>{formatMicros(pedido.timestamp)}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                                  ImpCell                                   */
/*                                                                            */
/*  "Printed yes/no" indicator. Shows a check icon with the print             */
/*  timestamp in a Tooltip when `pedido.dtImpressao` is set; empty otherwise. */
/* -------------------------------------------------------------------------- */

export function ImpCell({ pedido }: { pedido: Pedido }) {
  if (pedido.dtImpressao == null) return null;
  return (
    <Tooltip label={formatMicros(pedido.dtImpressao)} withinPortal>
      <IconCheck size={18} color="var(--mantine-color-teal-6)" aria-label="Impresso" />
    </Tooltip>
  );
}
