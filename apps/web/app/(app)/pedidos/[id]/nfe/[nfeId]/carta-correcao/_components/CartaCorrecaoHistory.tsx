'use client';

/**
 * Per-NF-e Carta de Correção history — every CC-e issued for this NF-e
 * (registrada or rejeitada), newest first. Each row expands to the sent /
 * received XML. Mirrors the old Flutter `CartaCorrecaoTableView`
 * (`…/cartadecorrecao`, ordered by timestamp desc; estado / nSeqEvento / date).
 */
import { useMemo } from 'react';
import { Accordion, Badge, Code, Group, Stack, Text, Title } from '@mantine/core';
import { ESTADO_ENVI_NFE_MSG } from '@delfrance/schemas';
import { useSnapshot } from '@delfrance/data/hooks';

import { cartaCorrecaoCollection } from '@/lib/data/cartaCorrecaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('pt-BR');
}

export function CartaCorrecaoHistory({
  pedidoId,
  nfeId,
}: {
  pedidoId: string;
  nfeId: string;
}) {
  const db = getFirebaseFirestore();
  const ref = useMemo(
    () => cartaCorrecaoCollection.ref(db, { pedidoId, nfeId }),
    [db, pedidoId, nfeId],
  );
  const { data, loading } = useSnapshot(ref);

  // Sort newest-first client-side (the list per NF-e is small → no index).
  const rows = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) =>
        String(b.data.timestamp ?? '').localeCompare(String(a.data.timestamp ?? '')),
      ),
    [data],
  );

  return (
    <Stack gap="sm" maw={720}>
      <Title order={4}>Cartas de correção desta NF-e</Title>
      {loading && (
        <Text size="sm" c="dimmed">
          Carregando cartas de correção…
        </Text>
      )}
      {!loading && rows.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhuma carta de correção registrada para esta NF-e.
        </Text>
      )}
      {rows.length > 0 && (
        <Accordion variant="separated" chevronPosition="left">
          {rows.map((row) => {
            const m = row.data;
            const registrada = m.estado === ESTADO_ENVI_NFE_MSG.concluido;
            return (
              <Accordion.Item key={row.id} value={row.id}>
                <Accordion.Control>
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      <Badge color={registrada ? 'teal' : 'red'} variant="light">
                        {registrada
                          ? `registrada${m.cStat ? ` ${m.cStat}` : ''}`
                          : `erro${m.cStat ? ` ${m.cStat}` : ''}`}
                      </Badge>
                      <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
                        nº seq {m.nSeqEvento}
                      </Text>
                      <Text size="sm" truncate style={{ minWidth: 0 }}>
                        {m.xCorrecao}
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {formatTs(m.timestamp)}
                    </Text>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    <Text size="sm">{m.xMotivo ?? m.error ?? '—'}</Text>
                    {m.nProt && (
                      <Text size="sm">
                        Protocolo:{' '}
                        <Text span ff="monospace">
                          {m.nProt}
                        </Text>
                      </Text>
                    )}
                    {m.xml_enviado && (
                      <>
                        <Text size="xs" fw={500}>
                          Enviado
                        </Text>
                        <Code block style={{ maxHeight: 240, overflow: 'auto' }}>
                          {m.xml_enviado}
                        </Code>
                      </>
                    )}
                    {m.xml_retorno && (
                      <>
                        <Text size="xs" fw={500}>
                          Retorno
                        </Text>
                        <Code block style={{ maxHeight: 240, overflow: 'auto' }}>
                          {m.xml_retorno}
                        </Code>
                      </>
                    )}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
        </Accordion>
      )}
    </Stack>
  );
}
