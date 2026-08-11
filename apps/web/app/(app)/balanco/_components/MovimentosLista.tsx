'use client';

import { useMemo } from 'react';
import type { Firestore } from 'firebase/firestore';
import { ActionIcon, Badge, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import type { MovimentoBalanco } from '@delfrance/schemas';
import { movimentoBalancoCollection } from '@/lib/data/movimentoBalancoCollection';

const PAGINA = 100;

export interface MovimentosListaProps {
  db: Firestore;
  balancoId: string;
  /** `'meus'` filters to the current user; `'erros'` shows every user's errors. */
  variante: 'meus' | 'erros';
  usuarioOuterRef: string;
  podeEscrever: boolean;
  onAlternarRemovido: (id: string, removido: boolean) => void;
}

function Linha({
  id,
  movimento,
  podeEscrever,
  onAlternarRemovido,
}: {
  id: string;
  movimento: MovimentoBalanco;
  podeEscrever: boolean;
  onAlternarRemovido: (id: string, removido: boolean) => void;
}) {
  const removido = movimento.removido === true;
  const erro = movimento.error === true;
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      p="xs"
      bg={erro ? 'var(--mantine-color-red-light)' : undefined}
      style={{ opacity: removido ? 0.5 : 1 }}
    >
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size="sm" fw={500} td={removido ? 'line-through' : undefined} truncate>
          {erro ? (movimento.errorInput ?? 'Leitura sem identificação') : movimento.produtoId}
        </Text>
        <Text size="xs" c={erro ? 'red' : 'dimmed'} td={removido ? 'line-through' : undefined}>
          {erro
            ? (movimento.errorMessage ?? 'Erro desconhecido')
            : `${movimento.quantidade} un.${removido ? ' — cancelado' : ''}`}
        </Text>
      </Stack>
      {!erro && podeEscrever ? (
        <ActionIcon
          variant="subtle"
          color={removido ? 'blue' : 'red'}
          aria-label={removido ? `Desfazer cancelamento ${id}` : `Cancelar lançamento ${id}`}
          onClick={() => onAlternarRemovido(id, !removido)}
        >
          {removido ? '↺' : '✕'}
        </ActionIcon>
      ) : null}
    </Group>
  );
}

/**
 * A live list of lançamentos, straight off `onSnapshot`.
 *
 * `'erros'` deliberately shows EVERY user's errors, not just the current one.
 * Legacy scoped both panels to the logged-in user, which hid a colleague's bad
 * scans from whoever was reviewing the count — and a balanço is aggregated
 * across all counters at finalize time regardless.
 */
export function MovimentosLista({
  db,
  balancoId,
  variante,
  usuarioOuterRef,
  podeEscrever,
  onAlternarRemovido,
}: MovimentosListaProps) {
  const q = useMemo(
    () =>
      buildQuery(movimentoBalancoCollection.ref(db, { balancoId }), [
        variante === 'meus'
          ? whereEqual('usuarioOuterRef', usuarioOuterRef)
          : whereEqual('error', true),
        orderByField('timestamp', 'desc'),
        limit(PAGINA),
      ]),
    [db, balancoId, variante, usuarioOuterRef],
  );
  const { data, loading, error } = useSnapshot<MovimentoBalanco>(q);

  const titulo = variante === 'meus' ? 'Meus produtos lançados' : 'Erros';
  const linhas = data ?? [];

  return (
    <Paper withBorder p="md" h="100%">
      <Group justify="space-between" mb="xs">
        <Title order={5}>{titulo}</Title>
        <Badge variant="light">{linhas.length}</Badge>
      </Group>
      {loading ? <Loader size="sm" /> : null}
      {error ? (
        <Text size="sm" c="red">
          Não foi possível carregar: {error.message}
        </Text>
      ) : null}
      {!loading && linhas.length === 0 ? (
        <Text size="sm" c="dimmed">
          {variante === 'meus' ? 'Nenhum lançamento ainda.' : 'Nenhum erro registrado.'}
        </Text>
      ) : null}
      <Stack gap={2}>
        {linhas.map((row) => (
          <Linha
            key={row.id}
            id={row.id}
            movimento={row.data}
            podeEscrever={podeEscrever}
            onAlternarRemovido={onAlternarRemovido}
          />
        ))}
      </Stack>
    </Paper>
  );
}
