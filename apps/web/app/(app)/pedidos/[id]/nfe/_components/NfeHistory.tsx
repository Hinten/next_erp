'use client';

/**
 * Communication history for one NF-e — every SEFAZ round-trip whose
 * `targetsChnfe` includes this NF-e's chave, newest first. Each row expands to
 * show the sent / received XML. Mirrors the old Flutter `CancelamentoTableView`
 * (estado + cStat/xMotivo + date; tap → detail), but unified across all
 * round-trip types (emission, consult, cancelamento).
 */
import { useMemo } from 'react';
import { Accordion, Badge, Code, Group, Stack, Text } from '@mantine/core';
import { useSnapshot } from '@delfrance/data/hooks';
import { buildQuery, whereOp } from '@delfrance/data';

import { enviNfeCollection } from '@/lib/data/enviNfeCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('pt-BR');
}

export function NfeHistory({ filialId, chave }: { filialId: string; chave: string }) {
  const db = getFirebaseFirestore();
  const q = useMemo(
    () =>
      buildQuery(enviNfeCollection.ref(db, { filialId }), [
        whereOp('targetsChnfe', 'array-contains', chave),
      ]),
    [db, filialId, chave],
  );
  const { data, loading } = useSnapshot(q);

  // Sort newest-first client-side (small set → no composite index needed).
  const rows = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) =>
        String(b.data.timestamp ?? '').localeCompare(String(a.data.timestamp ?? '')),
      ),
    [data],
  );

  if (loading) {
    return (
      <Text size="sm" c="dimmed">
        Carregando comunicações…
      </Text>
    );
  }
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Nenhuma comunicação registrada para esta NF-e.
      </Text>
    );
  }

  return (
    <Accordion variant="separated" chevronPosition="left">
      {rows.map((row) => {
        const m = row.data;
        const failed = m.error != null;
        return (
          <Accordion.Item key={row.id} value={row.id}>
            <Accordion.Control>
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Badge color={failed ? 'red' : 'blue'} variant="light">
                    {m.cStat ?? (failed ? 'erro' : '—')}
                  </Badge>
                  <Text size="sm" truncate style={{ minWidth: 0 }}>
                    {m.xMotivo ?? m.error ?? '—'}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  {formatTs(m.timestamp)}
                </Text>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
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
                {m.error && (
                  <Text size="sm" c="red">
                    {m.error}
                  </Text>
                )}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );
}
