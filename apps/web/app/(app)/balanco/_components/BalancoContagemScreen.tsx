'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { Alert, Anchor, Badge, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import { ESTADO_BALANCO_VISIVEL_LABELS } from '@delfrance/schemas';
import { movimentoBalancoCollection } from '@/lib/data/movimentoBalancoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

import { LancamentoForm } from './LancamentoForm';
import { MovimentosLista } from './MovimentosLista';
import { useBalanco } from './useBalanco';
import { MENSAGEM_SKU } from './resolveSkuBalanco';

/**
 * The counting screen ("lançar"). Read-only the moment the balanço leaves
 * `aberto` — and that is enforced server-side too: once the finalize takes the
 * lock it aggregates the movimentos as they stood, so a late lançamento simply
 * would not be counted.
 */
export function BalancoContagemScreen({ balancoId }: { balancoId: string }) {
  const db = getFirebaseFirestore();
  const { user } = useAuth();
  const { allowed: podeEscrever } = usePermission(PERM.estoque.write);
  const { balanco, estado, loading, error } = useBalanco(balancoId);

  const usuarioOuterRef = `documents/usuarios/${user?.uid ?? ''}`;
  const aberto = estado === 'aberto';

  const alternarRemovido = useCallback(
    (id: string, removido: boolean) => {
      // A soft cancel, never a delete: the withdrawal itself stays auditable,
      // and the total simply stops counting the row.
      void movimentoBalancoCollection.merge(db, { balancoId }, id, { removido });
    },
    [db, balancoId],
  );

  const aoLancar = useCallback((kind: string) => {
    if (kind === 'produto') return;
    notifications.show({
      color: 'red',
      title: 'Lançamento com erro',
      message: MENSAGEM_SKU[kind as keyof typeof MENSAGEM_SKU],
    });
  }, []);

  if (loading) return <Loader />;
  if (error) return <Alert color="red">Não foi possível carregar o balanço: {error.message}</Alert>;
  if (!balanco) return <Alert color="red">Balanço não encontrado.</Alert>;

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Group gap="sm">
          <Title order={2}>{balanco.nome}</Title>
          <Badge variant="light" color={aberto ? 'blue' : 'gray'}>
            {ESTADO_BALANCO_VISIVEL_LABELS[estado]}
          </Badge>
        </Group>
        <Group gap="md">
          <Anchor component={Link} href="/balanco" size="sm">
            ← Voltar à lista
          </Anchor>
          <Button component={Link} href={`/balanco/${balancoId}/revisao`}>
            Revisar e finalizar
          </Button>
        </Group>
      </Group>

      {!aberto ? (
        <Alert color="gray" title="Balanço encerrado para contagem">
          Este balanço está {ESTADO_BALANCO_VISIVEL_LABELS[estado].toLowerCase()}. Novos lançamentos
          não são aceitos — abra a revisão para ver o resultado.
        </Alert>
      ) : null}

      {aberto && !podeEscrever ? (
        <Alert color="yellow">Você tem acesso de leitura: não é possível lançar produtos.</Alert>
      ) : null}

      <Group align="flex-start" gap="md" wrap="wrap">
        <Stack style={{ flex: '2 1 480px', minWidth: 0 }}>
          <LancamentoForm
            db={db}
            balancoId={balancoId}
            usuarioOuterRef={usuarioOuterRef}
            disabled={!aberto || !podeEscrever || !user}
            onLancado={aoLancar}
          />
          <MovimentosLista
            db={db}
            balancoId={balancoId}
            variante="meus"
            usuarioOuterRef={usuarioOuterRef}
            podeEscrever={aberto && podeEscrever}
            onAlternarRemovido={alternarRemovido}
          />
        </Stack>
        <Stack style={{ flex: '1 1 280px', minWidth: 0 }}>
          <MovimentosLista
            db={db}
            balancoId={balancoId}
            variante="erros"
            usuarioOuterRef={usuarioOuterRef}
            podeEscrever={false}
            onAlternarRemovido={alternarRemovido}
          />
          <Text size="xs" c="dimmed" mt="xs">
            Os erros de todos os usuários aparecem aqui — a contagem é somada entre todos ao
            finalizar.
          </Text>
        </Stack>
      </Group>
    </Stack>
  );
}
