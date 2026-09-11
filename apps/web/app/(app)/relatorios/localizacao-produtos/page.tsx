'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Button,
  Group,
  Loader,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { PageHeader } from '@delfrance/ui';
import { FirebaseError } from 'firebase/app';
import { DepositoPicker } from '@/components/pickers/DepositoPicker';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  loadProductLocationReport,
  type ProductLocationProgress,
  type ProductLocationRow,
} from '@/lib/reports/productLocation';
import { downloadProductLocationCsv } from '@/lib/reports/productLocationCsv';

export type ProductLocationLoader = typeof loadProductLocationReport;

function formatQuantity(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 }).format(value);
}

function progressValue(progress: Extract<ProductLocationProgress, { phase: 'produtos' }>): number {
  if (progress.total === 0) return 100;
  return (progress.done / progress.total) * 100;
}

function progressLabel(progress: ProductLocationProgress): string {
  return progress.phase === 'estoques'
    ? `Consultando estoques… ${progress.loaded} carregados`
    : `Carregando produtos… ${progress.done} de ${progress.total}`;
}

export function ProductLocationReportScreen({
  loadReport = loadProductLocationReport,
}: {
  loadReport?: ProductLocationLoader;
}) {
  const db = getFirebaseFirestore();
  const [depositoOuterRef, setDepositoOuterRef] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProductLocationProgress | null>(null);
  const [rows, setRows] = useState<ProductLocationRow[] | null>(null);

  const report = useMutation({
    mutationFn: (selected: string) => loadReport(db, selected, setProgress),
    onSuccess: (nextRows) => {
      setRows(nextRows);
      setProgress(null);
    },
    onError: () => setProgress(null),
  });

  const errorMessage = useMemo(() => {
    if (report.error === null) return null;
    if (report.error instanceof FirebaseError || report.error instanceof RangeError) {
      return report.error.message;
    }
    return 'Não foi possível gerar o relatório.';
  }, [report.error]);

  function selectDeposito(next: unknown) {
    setDepositoOuterRef(typeof next === 'string' ? next : '');
    setValidationError(null);
    setRows(null);
    setProgress(null);
    report.reset();
  }

  function runReport() {
    if (depositoOuterRef === '') {
      setValidationError('Selecione um depósito antes de gerar o relatório.');
      return;
    }
    setValidationError(null);
    setRows(null);
    setProgress({ phase: 'estoques', loaded: 0 });
    report.mutate(depositoOuterRef);
  }

  return (
    <Stack>
      <PageHeader
        title="Localização de produtos"
        description="Produtos com localização cadastrada no depósito selecionado"
      />

      <Paper withBorder p="md">
        <Stack gap="md">
          <Group align="flex-end">
            <DepositoPicker
              fieldName="depositoOuterRef"
              label="Depósito"
              value={depositoOuterRef}
              onChange={selectDeposito}
              required
              disabled={report.isPending}
              error={validationError ?? undefined}
            />
            <Button onClick={runReport} loading={report.isPending}>
              Gerar relatório
            </Button>
            <Button
              variant="default"
              disabled={rows === null || rows.length === 0 || report.isPending}
              onClick={() => downloadProductLocationCsv(rows ?? [], depositoOuterRef)}
            >
              Baixar CSV
            </Button>
          </Group>

          {progress !== null && report.isPending ? (
            progress.phase === 'estoques' ? (
              <Group gap="xs">
                <Loader aria-label="Progresso do relatório" size="sm" />
                <Text size="sm">{progressLabel(progress)}</Text>
              </Group>
            ) : (
              <Stack gap={6}>
                <Text size="sm">{progressLabel(progress)}</Text>
                <Progress
                  aria-label="Progresso do relatório"
                  value={progressValue(progress)}
                  animated
                />
              </Stack>
            )
          ) : null}
        </Stack>
      </Paper>

      {errorMessage !== null ? (
        <Alert color="red" title="Não foi possível gerar o relatório">
          {errorMessage}
        </Alert>
      ) : null}

      {rows !== null && rows.length === 0 ? (
        <Text c="dimmed">Nenhum estoque com localização encontrado</Text>
      ) : null}

      {rows !== null && rows.length > 0 ? (
        <Paper withBorder>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>SKU</Table.Th>
                <Table.Th>Produto</Table.Th>
                <Table.Th>Localização</Table.Th>
                <Table.Th ta="right">Total</Table.Th>
                <Table.Th ta="right">Reservado</Table.Th>
                <Table.Th ta="right">Disponível</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.key}>
                  <Table.Td>{row.sku ?? '—'}</Table.Td>
                  <Table.Td>
                    <Anchor component={Link} href={`/produtos/${row.produtoId}/editar`}>
                      {row.produto}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{row.localizacao}</Table.Td>
                  <Table.Td ta="right">{formatQuantity(row.total)}</Table.Td>
                  <Table.Td ta="right">{formatQuantity(row.reservado)}</Table.Td>
                  <Table.Td ta="right">{formatQuantity(row.disponivel)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      ) : null}

      <Anchor component={Link} href="/relatorios" size="sm">
        ← Voltar a Relatórios
      </Anchor>
    </Stack>
  );
}

export default function LocalizacaoProdutosPage() {
  return <ProductLocationReportScreen />;
}
