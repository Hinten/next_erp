'use client';

/**
 * Mass NF-e export (#11) — the port of the old Flutter `exportarNfeMass`.
 *
 * Pick a period (+ filial / operação / estado), preview the matched notes, then
 * download a ZIP of every procNFe XML or a CSV report. Everything runs in the
 * browser (Firebase client SDK + fflate); see `@/lib/nfe/export/*`. The two
 * downloads stream with bounded memory and only produce a file once the complete
 * Blob is built — the old data-URL truncation can't recur.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  MultiSelect,
  Paper,
  Progress,
  SegmentedControl,
  Skeleton,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconDownload, IconFileSpreadsheet, IconFileZip } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import type { DocumentReference } from 'firebase/firestore';
import { PageHeader } from '@delfrance/ui';
import { ESTADO_NFE_LABELS, type EstadoNFe, type Operacao } from '@delfrance/schemas';

import { getFirebaseFirestore } from '@/lib/firebase/client';
import { FilialPicker } from '@/components/pickers/FilialPicker';
import { OperacaoPicker } from '@/components/pickers/OperacaoPicker';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { saveBlob } from '@/lib/nfe/saveBlob';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';
import { buildExportSource, previewExport } from '@/lib/nfe/export/exportQuery';
import { formatDateBr } from '@/lib/nfe/export/csv';
import { buildXmlZip } from '@/lib/nfe/export/buildXmlZip';
import { buildCsvReport } from '@/lib/nfe/export/buildCsvReport';
import { ExportIncompleteError, type ExportFilter, type ProgressFn } from '@/lib/nfe/export/types';

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function dayStartMs(str: string): number {
  const [y = 0, m = 1, d = 1] = str.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function dayEndMs(str: string): number {
  const [y = 0, m = 1, d = 1] = str.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

const ESTADO_COLORS: Partial<Record<EstadoNFe, string>> = {
  a: 'teal',
  c: 'orange',
  n: 'red',
  e: 'red',
  p: 'yellow',
  i: 'gray',
};

export function ExportarNfeScreen() {
  const db = useMemo(() => getFirebaseFirestore(), []);

  const defaultRange = useMemo<[string, string]>(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return [toDateStr(first), toDateStr(now)];
  }, []);

  const [range, setRange] = useState<[string | null, string | null]>(defaultRange);
  const [filialRef, setFilialRef] = useState<unknown>(null);
  const [ehSaida, setEhSaida] = useState(true);
  const [operacaoRef, setOperacaoRef] = useState<DocumentReference<Operacao> | null>(null);
  const [estados, setEstados] = useState<string[]>(['a']);
  const [applied, setApplied] = useState<ExportFilter | null>(null);
  const [running, setRunning] = useState<'zip' | 'csv' | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const estadoOptions = useMemo(
    () => Object.entries(ESTADO_NFE_LABELS).map(([value, label]) => ({ value, label })),
    [],
  );

  const buildFilter = useCallback((): ExportFilter | null => {
    const [start, end] = range;
    if (!start || !end) return null;
    return {
      startMs: dayStartMs(start),
      endMs: dayEndMs(end),
      filialId: dereferenceOuterRef(db, filialRef)?.id ?? null,
      estados: estados as EstadoNFe[],
      operacaoId: operacaoRef?.id ?? null,
    };
  }, [range, filialRef, estados, operacaoRef, db]);

  const preview = useQuery({
    queryKey: ['nfe-export-preview', applied],
    enabled: applied != null,
    queryFn: () => previewExport(db, applied as ExportFilter),
  });

  const runExport = useCallback(
    async (kind: 'zip' | 'csv') => {
      const filter = applied ?? buildFilter();
      if (!filter) {
        showErrorNotification({
          title: 'Período obrigatório',
          message: 'Selecione a data inicial e a data final do período.',
        });
        return;
      }
      setRunning(kind);
      setProgress({ done: 0, total: 0 });
      try {
        const source = await buildExportSource(db, filter);
        setProgress({ done: 0, total: source.preCount });
        const onProgress: ProgressFn = (done, total) => setProgress({ done, total });
        const result =
          kind === 'zip'
            ? await buildXmlZip(source, onProgress)
            : await buildCsvReport(source, onProgress);
        saveBlob(result.blob, result.filename);
        showCopyableNotification({
          color: 'teal',
          title: 'Exportação concluída',
          message:
            kind === 'zip'
              ? `${result.included} XML(s) de ${result.processed} nota(s) — ${result.filename}.`
              : `${result.processed} nota(s) — ${result.filename}.`,
        });
      } catch (err) {
        if (err instanceof ExportIncompleteError) {
          showErrorNotification({ title: 'Exportação incompleta', message: err.message });
          return;
        }
        if (err instanceof FirebaseError) {
          showErrorNotification({
            title: 'Falha na exportação',
            message: `${err.code} — ${err.message}`,
          });
          return;
        }
        // Anything else is an unexpected bug — surface it (apps/web rule: narrow
        // + rethrow, never swallow). `finally` resets the button.
        throw err;
      } finally {
        setRunning(null);
      }
    },
    [applied, buildFilter, db],
  );

  const busy = running != null;
  const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <Stack>
      <PageHeader
        title="Exportar NF-e"
        description="Exportação em massa: baixe o ZIP com todos os XMLs e o relatório CSV do período."
      />

      <Paper withBorder p="md" radius="md">
        <Stack>
          <Group grow align="flex-start">
            <DatePickerInput
              type="range"
              label="Período (emissão)"
              placeholder="Selecione o período"
              value={range}
              onChange={setRange}
              valueFormat="DD/MM/YYYY"
              allowSingleDateInRange
              required
            />
            <FilialPicker
              fieldName="filial"
              label="Filial (todas)"
              value={filialRef}
              onChange={setFilialRef}
            />
          </Group>

          <Group grow align="flex-start">
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Operação (opcional)
              </Text>
              <SegmentedControl
                value={ehSaida ? 'saida' : 'entrada'}
                onChange={(v) => {
                  setEhSaida(v === 'saida');
                  setOperacaoRef(null);
                }}
                data={[
                  { value: 'saida', label: 'Saída' },
                  { value: 'entrada', label: 'Entrada' },
                ]}
              />
              <OperacaoPicker
                db={db}
                ehSaida={ehSaida}
                label=""
                value={operacaoRef}
                onChange={setOperacaoRef}
              />
            </Stack>
            <MultiSelect
              label="Estados (status)"
              placeholder="Todos"
              data={estadoOptions}
              value={estados}
              onChange={setEstados}
              clearable
              searchable
            />
          </Group>

          {operacaoRef && (
            <Alert color="yellow" variant="light">
              O filtro por operação resolve o pedido de cada nota — pode ser mais lento em períodos
              grandes.
            </Alert>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={() => setApplied(buildFilter())} disabled={busy}>
              Aplicar / pré-visualizar
            </Button>
          </Group>
        </Stack>
      </Paper>

      {applied && (
        <Paper withBorder p="md" radius="md">
          <Stack>
            {preview.isLoading && (
              <Stack>
                <Skeleton height={20} width={240} />
                <Skeleton height={32} />
                <Skeleton height={32} />
              </Stack>
            )}
            {preview.error instanceof FirebaseError && (
              <Alert color="red">{preview.error.message}</Alert>
            )}
            {preview.data && (
              <>
                <Group justify="space-between">
                  <Text fw={600}>
                    {preview.data.preCount} nota(s) no período
                    {(estados.length > 0 || operacaoRef) && ' (antes do filtro de estado/operação)'}
                  </Text>
                  <Text size="sm" c="dimmed">
                    pré-visualização: {preview.data.sample.length} primeira(s)
                  </Text>
                </Group>
                <Table.ScrollContainer minWidth={640}>
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Número/Série</Table.Th>
                        <Table.Th>Status</Table.Th>
                        <Table.Th>Emissão</Table.Th>
                        <Table.Th>Chave</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {preview.data.sample.length === 0 && (
                        <Table.Tr>
                          <Table.Td colSpan={4} align="center">
                            Nenhuma nota com os filtros atuais.
                          </Table.Td>
                        </Table.Tr>
                      )}
                      {preview.data.sample.map((n) => (
                        <Table.Tr key={n.path}>
                          <Table.Td>
                            {n.numeracao}/{n.serie}
                          </Table.Td>
                          <Table.Td>
                            <Badge color={ESTADO_COLORS[n.estado] ?? 'blue'} variant="light">
                              {ESTADO_NFE_LABELS[n.estado] ?? n.estado}
                            </Badge>
                          </Table.Td>
                          <Table.Td>{formatDateBr(n.dataEmissao) || '—'}</Table.Td>
                          <Table.Td>
                            <Code fz={11}>{n.chave ?? n.id}</Code>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </>
            )}
          </Stack>
        </Paper>
      )}

      <Paper withBorder p="md" radius="md">
        <Stack>
          <Group>
            <Button
              leftSection={<IconFileZip size={18} />}
              onClick={() => runExport('zip')}
              loading={running === 'zip'}
              disabled={busy}
            >
              Baixar XMLs (ZIP)
            </Button>
            <Button
              variant="light"
              leftSection={<IconFileSpreadsheet size={18} />}
              onClick={() => runExport('csv')}
              loading={running === 'csv'}
              disabled={busy}
            >
              Baixar relatório (CSV)
            </Button>
            <Text size="sm" c="dimmed">
              <IconDownload size={14} style={{ verticalAlign: 'middle' }} /> períodos grandes podem
              levar alguns minutos.
            </Text>
          </Group>
          {busy && progress && (
            <Stack gap={4}>
              <Progress value={pct} animated />
              <Text size="sm" c="dimmed">
                {progress.done}
                {progress.total > 0 ? ` / ${progress.total}` : ''} nota(s) processada(s)…
              </Text>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
