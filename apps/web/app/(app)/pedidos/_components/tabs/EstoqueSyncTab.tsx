'use client';

import { useMemo } from 'react';
import {
  Alert,
  Badge,
  Card,
  Group,
  ScrollArea,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  TIPO_MOVIMENTO_ESTOQUE_LABELS,
  type EstoqueAplicado,
  type HistoricoEstoque,
  type TipoMovimentoEstoque,
} from '@delfrance/schemas';
import { PERM } from '@delfrance/auth';
import { buildQuery, groupQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { usePermission } from '@/lib/auth/usePermission';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { historicoEstoqueCollection } from '@/lib/data/historicoEstoqueCollection';
import { incidenteCollection } from '@/lib/data/incidenteCollection';

const MOVIMENTOS_LIMIT = 50;

const fmtQtd = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtDelta = (n: number) => (n > 0 ? `+${fmtQtd(n)}` : fmtQtd(n));
/** historicoEstoque timestamps are ms-epoch. */
const fmtMs = (ms: number | null | undefined) =>
  typeof ms === 'number' ? new Date(ms).toLocaleString('pt-BR') : '—';
/** Pedido datetime fields (markers, atualizadoEm) are µs-epoch. */
const fmtMicros = (us: number | null | undefined) =>
  typeof us === 'number' ? new Date(Math.round(us / 1000)).toLocaleString('pt-BR') : '—';

const TIPO_BADGE_COLOR: Record<TipoMovimentoEstoque, string> = {
  reserva: 'blue',
  ajusteReserva: 'blue',
  liberacaoReserva: 'gray',
  saida: 'orange',
  devolucao: 'teal',
  entrada: 'green',
  estorno: 'gray',
  exclusaoPedido: 'red',
  manual: 'grape',
  balanco: 'grape',
};

/**
 * `produtos/<produtoId>/estoques/<estoqueId>/historicoEstoque/<id>` →
 * produto + depósito (the estoque id is deterministic: `est-<produtoId>-<depositoId>`).
 */
function origemDoMovimento(path: string): { produtoId: string; depositoId: string } {
  const segs = path.split('/');
  const produtoId = segs[1] ?? '';
  const estoqueId = segs[3] ?? '';
  const prefixo = `est-${produtoId}-`;
  return {
    produtoId,
    depositoId: estoqueId.startsWith(prefixo) ? estoqueId.slice(prefixo.length) : estoqueId,
  };
}

export interface EstoqueSyncTabProps {
  /** Absent in create mode — no doc, no sync state yet. */
  pedidoId?: string;
}

/**
 * Read-only view of the pedido's stock footprint (#408): the sync's applied
 * snapshot (`estoqueAplicado`, written only by the `sincronizarEstoquePedido`
 * Cloud Function), the pedido's movement audit records, and any drift
 * incidents. Nothing here is editable — stock moves only via the sync (or the
 * produto screen's manual movements).
 */
export function EstoqueSyncTab({ pedidoId }: EstoqueSyncTabProps) {
  if (!pedidoId) {
    return (
      <Text c="dimmed" size="sm">
        Salve o pedido para acompanhar o estoque.
      </Text>
    );
  }
  return <EstoqueSyncView pedidoId={pedidoId} />;
}

function EstoqueSyncView({ pedidoId }: { pedidoId: string }) {
  const db = getFirebaseFirestore();
  const podeLerEstoque = usePermission(PERM.estoque.read);

  // Live pedido doc — the snapshot/markers come from the doc, not the form:
  // the sync updates them server-side while the editor is open.
  const pedidoRef = useMemo(() => pedidoCollection.docRef(db, {}, pedidoId), [db, pedidoId]);
  const pedidoSnap = useDocSnapshot(pedidoRef);
  const pedido = pedidoSnap.data?.data ?? null;
  const aplicado: EstoqueAplicado | null = pedido?.estoqueAplicado ?? null;

  // Produto display names from the pedido's own items (kit components may not
  // be items — the id is the honest fallback there).
  const nomePorProduto = useMemo(() => {
    const nomes = new Map<string, string>();
    for (const itens of Object.values(pedido?.itens ?? {})) {
      for (const item of itens) {
        if (item.produtoUid && item.nomeDeVenda) nomes.set(item.produtoUid, item.nomeDeVenda);
      }
    }
    return nomes;
  }, [pedido?.itens]);

  const depositoRef = useMemo(
    () => (aplicado?.depositoId ? depositoCollection.docRef(db, {}, aplicado.depositoId) : null),
    [db, aplicado?.depositoId],
  );
  const depositoSnap = useDocSnapshot(depositoRef);
  const depositoNome = depositoSnap.data?.data.nome ?? aplicado?.depositoId ?? '—';

  // Movement audit records across ALL produtos (collection-group; rides the
  // historicoEstoque(pedidoOuterRef, timestamp desc) COLLECTION_GROUP index —
  // see firestore.indexes.json / #408). Gated by the estoque read claim: the
  // {path=**}/historicoEstoque rules block requires it.
  const movimentosQuery = useMemo(
    () =>
      podeLerEstoque.allowed
        ? buildQuery(groupQuery(db, 'historicoEstoque', historicoEstoqueCollection.converter), [
            whereOp('pedidoOuterRef', '==', `documents/pedidos/${pedidoId}`),
            orderByField('timestamp', 'desc'),
            limit(MOVIMENTOS_LIMIT),
          ])
        : null,
    [db, pedidoId, podeLerEstoque.allowed],
  );
  const movimentosSnap = useSnapshot<HistoricoEstoque>(movimentosQuery);

  // Drift incidents (written by the sync when its reservada clamp fires) —
  // bounded subcollection read, filtered by the structured passthrough marker.
  const incidentesQuery = useMemo(
    () =>
      buildQuery(incidenteCollection.ref(db, { pedidoId }), [orderByField('timestamp', 'desc')]),
    [db, pedidoId],
  );
  const incidentesSnap = useSnapshot(incidentesQuery);
  const drifts = useMemo(
    () =>
      (incidentesSnap.data ?? []).filter(
        (i) => (i.data as Record<string, unknown>).subtipo === 'estoque-drift',
      ),
    [incidentesSnap.data],
  );

  const linhasSnapshot = useMemo(() => {
    if (!aplicado) return [];
    const porProduto = new Map<
      string,
      { reservado: number; removido: number; adicionado: number }
    >();
    const soma = (
      mapa: Record<string, number> | null,
      chave: 'reservado' | 'removido' | 'adicionado',
    ) => {
      for (const [produtoId, qtd] of Object.entries(mapa ?? {})) {
        const linha = porProduto.get(produtoId) ?? { reservado: 0, removido: 0, adicionado: 0 };
        linha[chave] += qtd;
        porProduto.set(produtoId, linha);
      }
    };
    soma(aplicado.reservado, 'reservado');
    soma(aplicado.removido, 'removido');
    soma(aplicado.adicionado, 'adicionado');
    return [...porProduto.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [aplicado]);

  if (pedidoSnap.loading) return <Skeleton height={160} />;

  return (
    <Stack gap="md">
      {drifts.length > 0 && (
        <Alert color="orange" icon={<IconAlertTriangle size={16} />} title="Divergência de estoque">
          {drifts.length === 1
            ? 'A sincronização detectou 1 divergência de reserva neste pedido.'
            : `A sincronização detectou ${drifts.length} divergências de reserva neste pedido.`}{' '}
          Veja os detalhes na aba Incidentes e confira o estoque físico.
        </Alert>
      )}

      <Card withBorder>
        <Title order={5} mb="xs">
          Efeito aplicado
        </Title>
        {aplicado ? (
          <Stack gap="xs">
            <Group gap="lg">
              <Text size="sm">
                Depósito:{' '}
                <Text span fw={600}>
                  {depositoNome}
                </Text>
              </Text>
              <Text size="sm">
                Direção:{' '}
                <Text span fw={600}>
                  {aplicado.ehSaida ? 'Saída' : 'Entrada'}
                </Text>
              </Text>
              <Text size="sm" c="dimmed">
                Atualizado em {fmtMicros(aplicado.atualizadoEm)}
              </Text>
            </Group>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Produto</Table.Th>
                  <Table.Th ta="right">Reservado</Table.Th>
                  <Table.Th ta="right">Removido</Table.Th>
                  <Table.Th ta="right">Adicionado</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {linhasSnapshot.map(([produtoId, linha]) => (
                  <Table.Tr key={produtoId}>
                    <Table.Td>{nomePorProduto.get(produtoId) ?? produtoId}</Table.Td>
                    <Table.Td ta="right">{fmtQtd(linha.reservado)}</Table.Td>
                    <Table.Td ta="right">{fmtQtd(linha.removido)}</Table.Td>
                    <Table.Td ta="right">{fmtQtd(linha.adicionado)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        ) : (
          <Text c="dimmed" size="sm">
            Nenhum efeito de estoque aplicado a este pedido.
          </Text>
        )}
        <Group gap="lg" mt="xs">
          <Text size="xs" c="dimmed">
            Indisponibilizado: {fmtMicros(pedido?.dataIndisponivelEstoque)}
          </Text>
          <Text size="xs" c="dimmed">
            Removido: {fmtMicros(pedido?.dataRemocaoEstoque)}
          </Text>
        </Group>
      </Card>

      <Card withBorder>
        <Title order={5} mb="xs">
          Movimentações
        </Title>
        {!podeLerEstoque.allowed ? (
          <Text c="dimmed" size="sm">
            {podeLerEstoque.loading
              ? 'Carregando permissões…'
              : 'Sem permissão de leitura de estoque para listar as movimentações.'}
          </Text>
        ) : movimentosSnap.loading ? (
          <Skeleton height={120} />
        ) : movimentosSnap.error ? (
          <Alert color="red">Falha ao carregar movimentações: {movimentosSnap.error.message}</Alert>
        ) : (movimentosSnap.data ?? []).length === 0 ? (
          <Text c="dimmed" size="sm">
            Nenhuma movimentação de estoque registrada para este pedido.
          </Text>
        ) : (
          <ScrollArea>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Data</Table.Th>
                  <Table.Th>Tipo</Table.Th>
                  <Table.Th>Produto</Table.Th>
                  <Table.Th>Depósito</Table.Th>
                  <Table.Th ta="right">Qtd.</Table.Th>
                  <Table.Th ta="right">Reservada</Table.Th>
                  <Table.Th ta="right">Estoque (antes → depois)</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(movimentosSnap.data ?? []).map((mov) => {
                  const origem = origemDoMovimento(mov.path);
                  const tipo = mov.data.tipo;
                  return (
                    <Table.Tr key={mov.path}>
                      <Table.Td>{fmtMs(mov.data.timestamp)}</Table.Td>
                      <Table.Td>
                        {tipo ? (
                          <Badge size="sm" variant="light" color={TIPO_BADGE_COLOR[tipo]}>
                            {TIPO_MOVIMENTO_ESTOQUE_LABELS[tipo]}
                          </Badge>
                        ) : (
                          <Text size="sm" c="dimmed">
                            {mov.data.motivo ?? '—'}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {nomePorProduto.get(origem.produtoId) ?? origem.produtoId}
                      </Table.Td>
                      <Table.Td>{origem.depositoId}</Table.Td>
                      <Table.Td ta="right">{fmtDelta(mov.data.quantidade)}</Table.Td>
                      <Table.Td ta="right">{fmtDelta(mov.data.quantidadeReservada)}</Table.Td>
                      <Table.Td ta="right">
                        {mov.data.quantidadeAntes != null && mov.data.quantidadeDepois != null
                          ? `${fmtQtd(mov.data.quantidadeAntes)} → ${fmtQtd(mov.data.quantidadeDepois)}`
                          : '—'}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Card>
    </Stack>
  );
}
