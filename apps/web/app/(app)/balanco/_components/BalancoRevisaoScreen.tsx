'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { PERM } from '@delfrance/auth';
import { ESTADO_BALANCO_VISIVEL_LABELS, podeFinalizarBalanco } from '@delfrance/schemas';
import { finalizarBalanco } from '@/lib/balanco/clientPort';
import { saveBlob } from '@/lib/nfe/saveBlob';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { usePermission } from '@/lib/auth';

import { balancoCsvFilename, buildBalancoCsv } from './balancoCsv';
import {
  carregarRelatorioFinalizado,
  carregarRevisaoAoVivo,
  diferenca,
  type LinhaRevisao,
} from './balancoTotais';
import { useBalanco } from './useBalanco';

function CorDiferenca({ valor }: { valor: number | null }) {
  if (valor == null) return <Text size="sm">—</Text>;
  return (
    <Text size="sm" c={valor < 0 ? 'red' : valor > 0 ? 'green' : undefined} fw={valor ? 600 : 400}>
      {valor > 0 ? `+${valor}` : valor}
    </Text>
  );
}

/**
 * Review + finalize + CSV.
 *
 * Two data sources, chosen by state and NOT interchangeable:
 *  - open → computed live from the movimentos, joined against current stock;
 *  - finalized → read from the stored `relatorios` shards, whose `estoque` is
 *    the value the applying transaction actually replaced. Reading live stock
 *    for a finalized balanço (legacy did) shows a difference against whatever
 *    has moved since, which is not what the count found.
 */
export function BalancoRevisaoScreen({ balancoId }: { balancoId: string }) {
  const db = getFirebaseFirestore();
  const { allowed: podeEscrever } = usePermission(PERM.estoque.write);
  const { balanco, estado, depositoId, loading, error } = useBalanco(balancoId);
  const [confirmando, setConfirmando] = useState(false);
  const [zerar, setZerar] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const finalizado = estado === 'finalizado';
  const finalizacao = balanco?.finalizacao ?? null;

  const linhas = useQuery<LinhaRevisao[]>({
    queryKey: ['balanco-revisao', balancoId, finalizado, depositoId],
    enabled: Boolean(balanco) && (finalizado || depositoId !== ''),
    queryFn: () =>
      finalizado
        ? carregarRelatorioFinalizado(db, balancoId)
        : carregarRevisaoAoVivo(db, balancoId, depositoId),
  });

  const baixarCsv = useCallback(() => {
    const csv = buildBalancoCsv(linhas.data ?? []);
    saveBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      balancoCsvFilename(balanco?.nome ?? '', new Date()),
    );
  }, [linhas.data, balanco?.nome]);

  async function aplicar() {
    setEnviando(true);
    try {
      await finalizarBalanco({ balancoId, zerarNaoContados: zerar });
      setConfirmando(false);
      notifications.show({
        color: 'blue',
        title: 'Finalização iniciada',
        message: 'O estoque está sendo aplicado. Acompanhe o progresso nesta tela.',
      });
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
      notifications.show({
        color: 'red',
        title: 'Não foi possível finalizar',
        message: err.message,
      });
    } finally {
      setEnviando(false);
    }
  }

  if (loading) return <Loader />;
  if (error) return <Alert color="red">Não foi possível carregar o balanço: {error.message}</Alert>;
  if (!balanco) return <Alert color="red">Balanço não encontrado.</Alert>;

  const podeAplicar = podeEscrever && podeFinalizarBalanco(balanco);
  const total = finalizacao?.shards ?? 0;
  const feitos = finalizacao?.shardCursor ?? 0;

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Group gap="sm">
          <Title order={2}>{balanco.nome}</Title>
          <Badge variant="light" color={finalizado ? 'green' : estado === 'erro' ? 'red' : 'blue'}>
            {ESTADO_BALANCO_VISIVEL_LABELS[estado]}
          </Badge>
        </Group>
        <Group gap="md">
          <Anchor component={Link} href={`/balanco/${balancoId}`} size="sm">
            ← Voltar à contagem
          </Anchor>
          <Button variant="default" onClick={baixarCsv} disabled={!linhas.data}>
            Baixar CSV
          </Button>
          {podeAplicar ? (
            <Button color="red" onClick={() => setConfirmando(true)}>
              {estado === 'erro' ? 'Retomar finalização' : 'Aplicar contagem no estoque'}
            </Button>
          ) : null}
        </Group>
      </Group>

      {estado === 'finalizando' ? (
        <Paper withBorder p="md">
          <Text size="sm" mb="xs">
            Aplicando o estoque… {feitos} de {total || '?'} blocos ·{' '}
            {finalizacao?.produtosAplicados ?? 0} produto(s) ajustado(s).
          </Text>
          <Progress value={total ? (feitos / total) * 100 : 0} animated />
        </Paper>
      ) : null}

      {estado === 'erro' ? (
        <Alert color="red" title="A finalização parou com erro">
          {finalizacao?.erro ?? 'Erro desconhecido.'} O estoque já aplicado foi preservado — retomar
          continua de onde parou, sem aplicar nada duas vezes.
        </Alert>
      ) : null}

      {finalizado ? (
        <Alert color="green" title="Balanço aplicado">
          Os valores abaixo são o relatório gravado no momento da finalização — a coluna
          &quot;Estoque&quot; é o que havia antes da contagem ser aplicada, não o estoque de agora.
        </Alert>
      ) : null}

      {linhas.isLoading ? <Loader /> : null}
      {linhas.error ? (
        <Alert color="red">Não foi possível montar a revisão: {String(linhas.error)}</Alert>
      ) : null}

      {linhas.data ? (
        <Paper withBorder p="md">
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>SKU</Table.Th>
                <Table.Th>Nome</Table.Th>
                <Table.Th>Estoque</Table.Th>
                <Table.Th>Lançado</Table.Th>
                <Table.Th>Diferença</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {linhas.data.map((linha) => (
                <Table.Tr key={linha.produtoId}>
                  <Table.Td>{linha.sku ?? '—'}</Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm">{linha.nome ?? linha.produtoId}</Text>
                      {linha.estoquesExtras ? (
                        <Badge color="yellow" variant="light" size="xs">
                          {linha.estoquesExtras} estoque(s) extra(s)
                        </Badge>
                      ) : null}
                    </Group>
                  </Table.Td>
                  <Table.Td>{linha.estoque ?? '—'}</Table.Td>
                  <Table.Td>{linha.contado ?? '—'}</Table.Td>
                  <Table.Td>
                    <CorDiferenca valor={diferenca(linha)} />
                  </Table.Td>
                </Table.Tr>
              ))}
              {linhas.data.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text size="sm" c="dimmed">
                      Nenhum produto lançado neste balanço.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ) : null}
            </Table.Tbody>
          </Table>
        </Paper>
      ) : null}

      <Modal
        opened={confirmando}
        onClose={() => setConfirmando(false)}
        title="Aplicar contagem no estoque"
      >
        <Stack>
          <Checkbox
            label="Zerar o estoque dos produtos não lançados"
            description="Produtos que têm estoque neste depósito e não foram contados passam a 0. Kits nunca são alterados."
            checked={zerar}
            onChange={(e) => setZerar(e.currentTarget.checked)}
          />
          <Alert color="red" title="Esta ação é irreversível">
            O estoque de cada produto contado passa a valer exatamente a quantidade lançada. Um
            relatório do que havia antes fica gravado no balanço.
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmando(false)} disabled={enviando}>
              Cancelar
            </Button>
            <Button color="red" loading={enviando} onClick={() => void aplicar()}>
              Confirmar e aplicar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
