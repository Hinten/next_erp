'use client';

/**
 * Per-filial inutilização history — every burned número range (homologada or
 * rejeitada), newest first. Each row expands to the sent / received XML.
 * Mirrors the old Flutter `InutNFeTable` (`filiais/{filialId}/inutilizacao`,
 * ordered by timestamp desc; série / início–fim / estado / data).
 */
import { useMemo } from 'react';
import { Accordion, Badge, Code, Group, Stack, Text, Title } from '@mantine/core';
import { ESTADO_ENVI_NFE_MSG } from '@delfrance/schemas';
import { useSnapshot } from '@delfrance/data/hooks';

import { inutilizacaoCollection } from '@/lib/data/inutilizacaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('pt-BR');
}

export function InutilizacaoHistory({ filialId }: { filialId: string }) {
  const db = getFirebaseFirestore();
  const ref = useMemo(() => inutilizacaoCollection.ref(db, { filialId }), [db, filialId]);
  const { data, loading } = useSnapshot(ref);

  // Sort newest-first client-side (the list per filial is small → no index).
  const rows = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) =>
        String(b.data.timestamp ?? '').localeCompare(String(a.data.timestamp ?? '')),
      ),
    [data],
  );

  return (
    <Stack gap="sm" maw={720}>
      <Title order={4}>Inutilizações da filial</Title>
      {loading && (
        <Text size="sm" c="dimmed">
          Carregando inutilizações…
        </Text>
      )}
      {!loading && rows.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhuma inutilização registrada para esta filial.
        </Text>
      )}
      {rows.length > 0 && (
        <Accordion variant="separated" chevronPosition="left">
          {rows.map((row) => {
            const m = row.data;
            const homologada = m.estado === ESTADO_ENVI_NFE_MSG.concluido;
            return (
              <Accordion.Item key={row.id} value={row.id}>
                <Accordion.Control>
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      <Badge color={homologada ? 'teal' : 'red'} variant="light">
                        {homologada ? `homologada${m.cStat ? ` ${m.cStat}` : ''}` : `erro${m.cStat ? ` ${m.cStat}` : ''}`}
                      </Badge>
                      <Text size="sm" truncate style={{ minWidth: 0 }}>
                        Série {m.serie} · números {m.nNFIni}–{m.nNFFin}
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
