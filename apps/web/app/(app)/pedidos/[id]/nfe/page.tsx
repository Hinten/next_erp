'use client';

/**
 * Per-pedido NF-e screen: lists every NF-e of the pedido (a pedido can hold
 * more than one — e.g. a contingency NF-e), each with its SEFAZ communication
 * history and, when aprovada, an inline cancelamento form. The pedidos table's
 * "Cancelar NF-e" action redirects here. Replaces the old inline dialog
 * (matching the old Flutter dedicated screen).
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Anchor,
  Badge,
  Card,
  Group,
  type MantineColor,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import {
  ESTADO_NFE,
  ESTADO_NFE_LABELS,
  type EstadoNFe,
  type Integracao,
  type Pedido,
} from '@delfrance/schemas';

import { RequirePerm } from '@/lib/auth';
import { DanfeMenu } from '@/components/DanfeMenu';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { nfeCollection } from '@/lib/data/nfeCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';

import { NfeHistory } from './_components/NfeHistory';
import { CancelarNFeForm } from './_components/CancelarNFeForm';
import { useCancelarPedidoPrompt } from './_components/useCancelarPedidoPrompt';

function estadoColor(estado: EstadoNFe): MantineColor {
  switch (estado) {
    case ESTADO_NFE.gerado:
    case ESTADO_NFE.enviando:
    case ESTADO_NFE.aguardandoResposta:
    case ESTADO_NFE.processamentoCompleto:
    case ESTADO_NFE.processamentoCancelado:
    case ESTADO_NFE.aprovada:
    case ESTADO_NFE.epecAprovado:
      return 'green';
    case ESTADO_NFE.rejeitada:
    case ESTADO_NFE.error:
      return 'red';
    case ESTADO_NFE.cancelada:
    case ESTADO_NFE.numeracaoInutilizada:
      return 'gray';
    default:
      return 'yellow';
  }
}

function PedidoNfeContent() {
  const params = useParams<{ id: string }>();
  const pedidoId = params.id;
  const db = getFirebaseFirestore();

  const pedidoRef = useMemo(() => pedidoCollection.docRef(db, {}, pedidoId), [db, pedidoId]);
  const { data: pedidoDoc } = useDocSnapshot(pedidoRef);
  // The issuing filial lives on the pedido's integração, not the pedido itself.
  const integracaoRef = useMemo(() => {
    const ref = pedidoDoc
      ? dereferenceOuterRef(db, (pedidoDoc.data as Pedido).integracaoPedidoOuterRef)
      : null;
    return ref ? integracaoCollection.docRef(db, {}, ref.id) : null;
  }, [db, pedidoDoc]);
  const { data: integracaoDoc } = useDocSnapshot(integracaoRef);
  const filialId = useMemo(() => {
    const ref = integracaoDoc
      ? dereferenceOuterRef(db, (integracaoDoc.data as Integracao).filialIntegracaoPedidoOuterRef)
      : null;
    return ref?.id ?? null;
  }, [db, integracaoDoc]);

  const nfeQuery = useMemo(() => nfeCollection.ref(db, { pedidoId }), [db, pedidoId]);
  const { data: nfes, loading } = useSnapshot(nfeQuery);

  // Owned here, not by CancelarNFeForm: a homologated cancelamento flips the
  // NF-e to `cancelada` through the snapshot above, which unmounts the form. A
  // dialog living inside it would vanish before the operator could answer.
  const { promptCancelarPedido, element: cancelarPedidoDialog } = useCancelarPedidoPrompt();

  return (
    <Stack p="md" gap="lg">
      {cancelarPedidoDialog}
      <Group justify="space-between" align="center">
        <Title order={2}>Notas Fiscais do pedido</Title>
        <Anchor component={Link} href={`/pedidos/${pedidoId}/editar`}>
          Voltar ao pedido
        </Anchor>
      </Group>

      {loading && <Skeleton height={140} />}
      {!loading && (nfes ?? []).length === 0 && (
        <Text c="dimmed">Nenhuma NF-e emitida para este pedido.</Text>
      )}

      {(nfes ?? []).map((row) => {
        const nfe = row.data;
        const estado = nfe.estado as EstadoNFe;
        return (
          <Card key={row.id} withBorder>
            <Stack gap="sm">
              <Group justify="space-between" align="center" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  <Badge color={estadoColor(estado)}>{ESTADO_NFE_LABELS[estado] ?? estado}</Badge>
                  <Text fw={500}>
                    NF-e nº {nfe.numeracao} · série {nfe.serie}
                  </Text>
                </Group>
                {nfe.chave && (
                  <Text size="xs" ff="monospace" c="dimmed" truncate maw={360}>
                    {nfe.chave}
                  </Text>
                )}
              </Group>

              {filialId && nfe.chave ? (
                <NfeHistory filialId={filialId} chave={nfe.chave} />
              ) : (
                <Text size="sm" c="dimmed">
                  Sem chave — histórico de comunicações indisponível.
                </Text>
              )}

              {estado === ESTADO_NFE.epecAprovado && (
                <Text size="sm" c="orange">
                  EPEC aprovado — aguardando a transmissão da NF-e completa à SEFAZ (automática
                  quando a contingência for desligada). Cancelamento e carta de correção ficam
                  disponíveis após a autorização.
                </Text>
              )}

              {(estado === ESTADO_NFE.aprovada ||
                estado === ESTADO_NFE.cancelada ||
                estado === ESTADO_NFE.epecAprovado) && (
                <Group gap="xs">
                  <DanfeMenu pedidoId={pedidoId} nfeId={row.id} />
                </Group>
              )}

              {estado === ESTADO_NFE.aprovada && (
                <CancelarNFeForm
                  pedidoId={pedidoId}
                  nfeId={row.id}
                  numero={nfe.numeracao}
                  onCancelamentoConcluido={() => promptCancelarPedido(pedidoId)}
                />
              )}
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}

export default function PedidoNfePage() {
  return (
    <RequirePerm bit={PERM.nfe.read} redirectTo="/inicio">
      <PedidoNfeContent />
    </RequirePerm>
  );
}
