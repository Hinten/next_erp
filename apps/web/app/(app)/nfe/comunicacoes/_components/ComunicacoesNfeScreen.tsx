'use client';

/**
 * /nfe/comunicacoes — the `filiais/{filialId}/enviNfe` audit log (every SEFAZ
 * round-trip) with filters by chave / nNF / pedido, plus the "Verificar
 * novamente" action.
 *
 * All four filter modes funnel into ONE server-side `targetsChnfe` predicate
 * (TableView `extraFilters`, pipeline path): the chave mode filters directly
 * (`array-contains`); the other modes resolve chaves first (`resolveChaves`,
 * TanStack useQuery) and filter `array-contains-any` — an empty resolved list
 * short-circuits to an empty table (never an unfiltered flash: the table is
 * replaced by a Skeleton while resolving).
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Alert, Badge, Code, Group, Paper, Skeleton, Stack } from '@mantine/core';
import { skipToken, useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import type { PipelineFieldFilter } from '@delfrance/data';
import { enviNfeMsgSchema } from '@delfrance/schemas';
import { PageHeader, TableView, type FieldConfig } from '@delfrance/ui';

import { enviNfeCollection } from '@/lib/data/enviNfeCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { FilialPicker } from '@/components/pickers/FilialPicker';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

import {
  MAX_CHAVES,
  resolveChaves,
  type EnviNfeFilter,
  type ResolvableEnviNfeFilter,
} from '../_lib/resolveChaves';
import { EnviNfeFilterBar } from './EnviNfeFilterBar';
import { useVerificarEnviNfeAction } from './useVerificarEnviNfeAction';
import { VerificarResultadosModal } from './VerificarResultadosModal';

// Kept local rather than moved to `defaultQuery.columns`: this screen passes no
// `meta` — `enviNfe` has no CollectionMetadata — so there is nowhere to declare
// it. The sort/limit are page-owned for the same reason.
const DEFAULT_COLUMNS = [
  'timestamp',
  'estado',
  'cStat',
  'xMotivo',
  'targetsChnfe',
  'nRec',
  'idLote',
  'error',
];

const FIELDS: Record<string, FieldConfig> = {
  targetsChnfe: {
    // First chave + a "+N" badge; the full list lives on the detail page.
    renderCell: (value) => {
      const chaves = Array.isArray(value) ? (value as string[]) : [];
      if (chaves.length === 0) return '—';
      return (
        <Group gap={4} wrap="nowrap">
          <Code fz={11}>{chaves[0]}</Code>
          {chaves.length > 1 && (
            <Badge size="xs" variant="light">
              +{chaves.length - 1}
            </Badge>
          )}
        </Group>
      );
    },
  },
  // Multi-KB payloads — detail-page-only (XmlBlock).
  xml_enviado: { hidden: true },
  xml_retorno: { hidden: true },
};

export function ComunicacoesNfeScreen() {
  const db = useMemo(() => getFirebaseFirestore(), []);

  const [filialRef, setFilialRef] = useState<unknown>(null);
  const filialId = dereferenceOuterRef(db, filialRef)?.id ?? null;

  const [applied, setApplied] = useState<EnviNfeFilter | null>(null);

  const { action: verificarAction, modal } = useVerificarEnviNfeAction(filialId);

  // The chave mode filters `targetsChnfe` directly — only the other modes
  // need a resolution round-trip (nfev4 / pedidos reads).
  const resolvable: ResolvableEnviNfeFilter | null =
    applied != null && applied.mode !== 'chave' ? { mode: applied.mode, term: applied.term } : null;
  const resolve = useQuery({
    queryKey: ['envinfe-chaves', filialId, resolvable],
    // `skipToken` disables the query while narrowing both nullables for TS.
    queryFn:
      filialId != null && resolvable != null
        ? () => resolveChaves(db, filialId, resolvable)
        : skipToken,
  });

  // permission-denied renders as the Alert below; everything else surfaces as
  // a copyable toast so the term/filial stays on screen for a retry.
  useEffect(() => {
    const err = resolve.error;
    if (!err) return;
    if (err instanceof FirebaseError && err.code === 'permission-denied') return;
    showErrorNotification({
      title: 'Falha ao resolver as chaves do filtro',
      message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }, [resolve.error]);

  const extraFilters = useMemo<ReadonlyArray<PipelineFieldFilter> | undefined>(() => {
    if (!applied) return undefined;
    if (applied.mode === 'chave') {
      return [{ field: 'targetsChnfe', op: 'array-contains', value: applied.term }];
    }
    // Still resolving (or errored) — no filter yet; the table stays hidden.
    if (!resolve.data) return undefined;
    return [{ field: 'targetsChnfe', op: 'array-contains-any', value: resolve.data.chaves }];
  }, [applied, resolve.data]);

  const pathContext = useMemo(() => ({ filialId: filialId ?? '' }), [filialId]);

  const permissionDenied =
    resolve.error instanceof FirebaseError && resolve.error.code === 'permission-denied';
  const resolving = resolvable != null && resolve.isFetching;
  // Never render an unfiltered table while a non-chave filter is applied.
  const tableReady = filialId != null && (applied == null || extraFilters !== undefined);

  return (
    <Stack>
      <PageHeader
        title="Comunicações NF-e"
        description="Registro de cada comunicação com a SEFAZ (envio de lote, consultas). Selecione uma linha e use “Verificar novamente” para reconsultar a situação da NF-e."
      />

      <Paper withBorder p="md" radius="md">
        <Stack>
          <FilialPicker fieldName="filial" value={filialRef} onChange={setFilialRef} required />
          <EnviNfeFilterBar onApply={setApplied} disabled={filialId == null} />
        </Stack>
      </Paper>

      {filialId == null && (
        <Alert color="blue">Selecione uma filial para listar as comunicações NF-e.</Alert>
      )}

      {permissionDenied && (
        <Alert color="red" title="Sem permissão">
          Este filtro consulta NF-es e pedidos — é preciso permissão de leitura de NF-e (nfe.read)
          e, para o filtro por número de pedido, de pedidos (pedido.read).
        </Alert>
      )}

      {resolve.data?.truncated && (
        <Alert color="yellow" title="Filtro truncado">
          Mais de {MAX_CHAVES} NF-es correspondem ao filtro — mostrando as comunicações das{' '}
          {MAX_CHAVES} primeiras chaves.
        </Alert>
      )}

      {filialId != null && resolving && (
        <Stack>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </Stack>
      )}

      {tableReady && !resolving && (
        <TableView<typeof enviNfeMsgSchema>
          key={filialId}
          schema={enviNfeMsgSchema}
          collection={enviNfeCollection}
          db={db}
          pathContext={pathContext}
          extraFilters={extraFilters}
          defaultColumns={DEFAULT_COLUMNS}
          orderBy={{ field: 'timestamp', direction: 'desc' }}
          fields={FIELDS}
          rowHref={(id) => `/nfe/comunicacoes/${filialId}/${id}`}
          renderRowLink={(href, content) => <Link href={href as Route}>{content}</Link>}
          selectable
          actions={[verificarAction]}
        />
      )}

      <VerificarResultadosModal opened={modal.opened} onClose={modal.close} result={modal.result} />
    </Stack>
  );
}
