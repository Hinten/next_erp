'use client';

/**
 * Per-cell components for the Pedidos TableView's virtual columns.
 *
 * The NF column subscribes to the latest NFe doc in `pedidos/{pedidoId}/nfev4`
 * via `useSnapshot` — one Firestore listener per rendered row — so the cell
 * reflects async state transitions (SEFAZ replies authoring `estado` from
 * the orchestrator in `apps/integrations`) without a page refresh.
 * "Visible rows only" is satisfied by TableView's page-level pagination
 * (default `limit(50)` on the query); cells unmount on page change and
 * their listeners tear down with them.
 *
 * The other cells are static — `ClienteCell` does a one-shot cached read
 * via TanStack Query + `getDoc`, `FreteCell` and `ImpCell` are passthroughs.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { getDoc, type DocumentReference } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import { useSnapshot } from '@delfrance/data/hooks';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import {
  ESTADO_FRETE_LABELS,
  ESTADO_NFE,
  ESTADO_NFE_LABELS,
  type EstadoNFe,
  type NotaFiscalEletronica,
  type Pedido,
  TIPO_CLIENTE_LABELS,
  type TipoCliente,
  pedidoTotal,
} from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  CopyButton,
  Group,
  HoverCard,
  type MantineColor,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconBan, IconCheck, IconCopy } from '@tabler/icons-react';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { nfeCollection } from '@/lib/data/nfeCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

import { CancelarNFeDialog } from './CancelarNFeDialog';

const DASH = '—';

/**
 * Pretty-print a millisecond-since-epoch value as a Brazilian date+time.
 * Returns `DASH` when null/undefined.
 */
function formatMillis(ms: number | null | undefined): string {
  if (ms == null) return DASH;
  return new Date(ms).toLocaleString('pt-BR', {
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
/*  Subscribes to the latest doc in `pedidos/{pedidoId}/nfev4` (ordered by    */
/*  timestamp desc, limit 1) and renders a colored badge per estado. Hovering */
/*  the badge opens a HoverCard with the Estado, cStat, xMotivo, Número,      */
/*  Chave, and Erro fields — each copyable via an icon button when present.   */
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

function CopyIconButton({ value, label }: { value: string; label: string }) {
  return (
    <CopyButton value={value} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copiado!' : label} withArrow withinPortal position="top">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            onClick={copy}
            aria-label={label}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}

export function NFCell({ pedidoId }: { pedidoId: string }) {
  const db = getFirebaseFirestore();
  const q = useMemo(() => {
    const base = nfeCollection.ref(db, { pedidoId });
    // `ultima_modificacao` is set on every nfev4 write by the orchestrator
    // (both the initial `tx.set` and `persistPatch`). Ordering by it
    // ensures the doc actually appears in the snapshot — Firestore
    // excludes docs whose ordered field is absent, and the schema's
    // generic `timestamp` field is never set in Phase A.
    return buildQuery(base, [orderByField('ultima_modificacao', 'desc'), limit(1)]);
  }, [db, pedidoId]);
  const { data, loading } = useSnapshot(q);
  const [cancelOpen, setCancelOpen] = useState(false);

  if (loading) return <Skeleton height={20} width={70} />;
  const latest = data?.[0]?.data;
  if (!latest) return <Text c="dimmed">{DASH}</Text>;
  // Only an authorized NF-e can be cancelled (RecepcaoEvento tpEvento=110111).
  const isAprovada = latest.estado === ESTADO_NFE.aprovada;
  const color = NFE_STATE_COLOR[latest.estado] ?? 'gray';
  const label = ESTADO_NFE_LABELS[latest.estado] ?? latest.estado;
  // tpEmis === 1 is the normal (SEFAZ síncrono) path. Anything else
  // (2 EPEC, 9 SVC-RS, 7 SVC-AN, etc.) is a contingência variant — use
  // the outline variant so the operator can tell at a glance.
  const variant = latest.tpEmis !== 1 ? 'outline' : 'light';
  const hasCStatMsg = latest.cStat != null && latest.xMotivo != null;
  const messageCopyValue = latest.error ?? (hasCStatMsg ? `${latest.cStat} - ${latest.xMotivo}` : null);
  return (
    <>
    <HoverCard
      withinPortal
      shadow="md"
      openDelay={150}
      closeDelay={100}
      position="bottom-start"
      width={360}
    >
      <HoverCard.Target>
        <Badge
          variant={variant}
          color={color}
          style={{ cursor: 'help' }}
          tabIndex={0}
        >
          {label}
        </Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        {/* Dropdown content is portaled but React-bubbles to the row's
            onClick — stop it so the copy/cancelar controls don't navigate. */}
        <Stack gap="xs" onClick={(e) => e.stopPropagation()}>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" fw={500}>Estado:</Text>
            <Text size="sm">{label}</Text>
          </Group>

          {latest.cStat != null && (
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" fw={500}>cStat:</Text>
              <Text size="sm">{latest.cStat}</Text>
            </Group>
          )}

          {latest.xMotivo != null && (
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Text size="sm" fw={500} style={{ flexShrink: 0 }}>xMotivo:</Text>
              <Text size="sm" style={{ wordBreak: 'break-word' }}>
                {latest.xMotivo}
              </Text>
            </Group>
          )}

          <Group gap="xs" wrap="nowrap" justify="space-between">
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" fw={500}>Número:</Text>
              <Text size="sm">{latest.numeracao}</Text>
            </Group>
            <CopyIconButton
              value={String(latest.numeracao)}
              label="Copiar número"
            />
          </Group>

          {latest.chave != null && (
            <Group
              gap="xs"
              wrap="nowrap"
              justify="space-between"
              align="center"
            >
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} style={{ flexShrink: 0 }}>Chave:</Text>
                <Text
                  ff="monospace"
                  size="xs"
                  truncate
                  style={{ minWidth: 0 }}
                >
                  {latest.chave}
                </Text>
              </Group>
              <CopyIconButton value={latest.chave} label="Copiar chave" />
            </Group>
          )}

          {messageCopyValue != null && (
            <Group
              gap="xs"
              wrap="nowrap"
              justify="space-between"
              align="flex-start"
            >
              <Group
                gap="xs"
                wrap="nowrap"
                align="flex-start"
                style={{ minWidth: 0 }}
              >
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

          {isAprovada && (
            <Button
              color="red"
              variant="light"
              size="xs"
              leftSection={<IconBan size={14} />}
              mt="xs"
              onClick={(e) => {
                // Stop the row's navigate-onClick from firing.
                e.stopPropagation();
                setCancelOpen(true);
              }}
            >
              Cancelar NF-e
            </Button>
          )}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
    {isAprovada && (
      <CancelarNFeDialog
        opened={cancelOpen}
        pedidoId={pedidoId}
        numero={latest.numeracao}
        onClose={() => setCancelOpen(false)}
      />
    )}
    </>
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
  const ref = useMemo(
    () => dereferenceOuterRef(db, pedido.clientePedidoOuterRef),
    [db, pedido.clientePedidoOuterRef],
  ) as DocumentReference<ClienteDoc> | null;
  const path = ref?.path ?? null;

  const { data, isLoading } = useQuery<ClienteDoc | null>({
    queryKey: ['cliente', path],
    queryFn: async () => {
      if (!ref) return null;
      const snap = await getDoc(ref);
      return (snap.data() as ClienteDoc | undefined) ?? null;
    },
    enabled: !!ref,
    staleTime: 5 * 60 * 1000,
  });

  if (!ref) return <Text c="dimmed">Anônimo</Text>;
  if (isLoading) return <Skeleton height={20} width={120} />;
  const nome = data?.nome ?? 'Anônimo';
  const cpfCnpj = data?.cpf_cnpj ? formatCpfCnpj(data.cpf_cnpj) : null;
  const tipoLabel = data?.tipo ? TIPO_CLIENTE_LABELS[data.tipo] : null;
  const tooltip =
    cpfCnpj && tipoLabel ? `${tipoLabel}: ${cpfCnpj}` : cpfCnpj ?? tipoLabel ?? nome;
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
  return <Text fw={500}>{format(money(Math.round(value * 100)))}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                               ExpedicaoCell                                */
/*                                                                            */
/*  Reads pedido.freteInicial?.prazoDespacho (ms since epoch).                */
/* -------------------------------------------------------------------------- */

export function ExpedicaoCell({ pedido }: { pedido: Pedido }) {
  return <Text>{formatMillis(pedido.freteInicial?.prazoDespacho)}</Text>;
}

/* -------------------------------------------------------------------------- */
/*                                 FreteCell                                  */
/*                                                                            */
/*  Reads pedido.freteInicial?.estado (typed enum). Shows the tracking code   */
/*  in a tooltip when set. The click-for-history dialog from the legacy UX    */
/*  waits on the historicoFrete subcollection — deferred per issue #52.       */
/* -------------------------------------------------------------------------- */

export function FreteCell({ pedido }: { pedido: Pedido }) {
  const frete = pedido.freteInicial;
  const estado = frete?.estado;
  if (!estado) return <Text c="dimmed">{DASH}</Text>;
  const label = ESTADO_FRETE_LABELS[estado] ?? estado;
  const tooltipParts: string[] = [];
  if (frete?.codRastreio) tooltipParts.push(`Rastreio: ${frete.codRastreio}`);
  if (frete?.prazoDespacho)
    tooltipParts.push(`Prazo: ${formatMillis(frete.prazoDespacho)}`);
  if (tooltipParts.length === 0) return <Text>{label}</Text>;
  return (
    <Tooltip label={tooltipParts.join(' • ')} withinPortal>
      <Text style={{ cursor: 'help' }}>{label}</Text>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/*                                CriacaoCell                                 */
/* -------------------------------------------------------------------------- */

export function CriacaoCell({ pedido }: { pedido: Pedido }) {
  return <Text>{formatMillis(pedido.timestamp)}</Text>;
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
    <Tooltip label={formatMillis(pedido.dtImpressao)} withinPortal>
      <IconCheck
        size={18}
        color="var(--mantine-color-teal-6)"
        aria-label="Impresso"
      />
    </Tooltip>
  );
}
