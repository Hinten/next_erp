'use client';

import { useEffect, useMemo, useState } from 'react';
import { Select, Stack, Text } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { operacaoIdFromImpostoRef, type ImpostoProduto } from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  useObjectViewTransactionDocuments,
  useObjectViewTransactionDocumentSeed,
} from '@delfrance/ui';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { impostoProdutoCollection } from '@/lib/data/impostoProdutoCollection';
import {
  emptyImposto,
  IMPOSTO_LIMIT,
  montarLinhasImposto,
  OPERACAO_LIMIT,
  operacoesAtivas,
  type OperacaoRow,
} from '@/lib/produtos/impostoRows';
import { ImpostoConfigEditor, type ImpostoConfigValue } from '@/components/imposto';

export interface ImpostoManagerProps {
  produtoId: string | null;
  db: Firestore;
  /** Transient `impostos` form value (null until seeded). */
  value: ImpostoProduto[] | null;
  onChange: (next: ImpostoProduto[]) => void;
  errorTree?: unknown;
  disabled?: boolean;
}

/**
 * Impostos tab (Flutter `ImpostoManager`). One imposto override per active
 * operação, scoped by `impostoOpercaoOuterRef` and saved at
 * `produtos/<id>/imposto/<operacaoId>` ATOMICALLY with the produto doc (the
 * page's `transactionWrites`). The deep tax config (ICMS/IPI/PIS/COFINS/ISSQN/
 * retenção + Reforma Tributária) is edited via the shared
 * {@link ImpostoConfigEditor} — the same editor behind the operação, Macros and
 * categoria screens.
 *
 * The user picks an operação, then edits its fiscal config; the value is held in
 * the form and persisted on save. Seeds the transient field from the loaded
 * imposto subcollection merged with the active operações, re-seeding if
 * ObjectView's produto-doc reset wipes it back to null.
 */
export function ImpostoManager({
  produtoId,
  db,
  value,
  onChange,
  errorTree,
  disabled,
}: ImpostoManagerProps) {
  // Active operações (bounded, name-ordered; `ativo` filtered client-side).
  const operacoesQuery = useMemo(
    () => buildQuery(operacaoCollection.ref(db, {}), [orderByField('nome'), limit(OPERACAO_LIMIT)]),
    [db],
  );
  const operacoesSnap = useSnapshot(operacoesQuery);
  const operacoes: OperacaoRow[] = useMemo(
    () => operacoesAtivas(operacoesSnap.data ?? []),
    [operacoesSnap.data],
  );

  // Existing imposto docs (edit mode), keyed by operação id (= doc id).
  const impostosQuery = useMemo(
    () =>
      produtoId
        ? buildQuery(impostoProdutoCollection.ref(db, { produtoId }), [limit(IMPOSTO_LIMIT)])
        : null,
    [db, produtoId],
  );
  const impostosSnap = useSnapshot(impostosQuery);
  const documents = useObjectViewTransactionDocuments();

  // Seed the transient array once operações (and, in edit mode, the imposto
  // docs) have loaded — one entry per active operação merged with its saved doc.
  useEffect(() => {
    if (value != null) return;
    if (operacoesSnap.loading) return;
    if (produtoId && impostosSnap.loading) return;
    if (
      documents &&
      (operacoesSnap.fromCache !== false ||
        operacoesSnap.hasPendingWrites ||
        (produtoId && (impostosSnap.fromCache !== false || impostosSnap.hasPendingWrites)))
    )
      return;
    if (operacoes.length === 0) return;
    const initial = montarLinhasImposto(operacoes, impostosSnap.data ?? []);
    if (documents && produtoId)
      for (const row of impostosSnap.data ?? [])
        documents.seedBaseline(
          impostoProdutoCollection.docRef(db, { produtoId }, row.id).path,
          row.data,
        );
    documents?.seedFormField('impostos', initial);
    onChange(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    produtoId,
    operacoesSnap.loading,
    impostosSnap.loading,
    operacoesSnap.fromCache,
    impostosSnap.fromCache,
    operacoesSnap.hasPendingWrites,
    impostosSnap.hasPendingWrites,
    operacoes.length,
    value,
  ]);

  // The picked operação tab (default = padrão, else the first active operação).
  const defaultOperacaoId = useMemo(
    () => operacoes.find((o) => o.padrao)?.id ?? operacoes[0]?.id ?? null,
    [operacoes],
  );
  // Explicit user pick (null until they switch); falls back to the default
  // operação — derived, so no setState-in-effect / cascading render.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const activeId = pickedId ?? defaultOperacaoId;

  const rows = value ?? [];
  const hasRows = value !== null;
  const activeRef = useMemo(
    () =>
      produtoId && activeId && hasRows
        ? impostoProdutoCollection.docRef(db, { produtoId }, activeId)
        : null,
    [db, produtoId, activeId, hasRows],
  );
  const activeSeed = useObjectViewTransactionDocumentSeed(activeRef, (data) => {
    if (!activeId) return;
    const next = data
      ? { ...data, id: activeId, impostoOpercaoOuterRef: `operacao/${activeId}` }
      : emptyImposto(activeId);
    const replace = (list: ImpostoProduto[]) =>
      list.map((row) =>
        operacaoIdFromImpostoRef(row.impostoOpercaoOuterRef) === activeId ? next : row,
      );
    documents?.rebaseFormField(
      'impostos',
      replace((documents.getFormBaseline('impostos') as ImpostoProduto[] | undefined) ?? rows),
    );
    onChange(replace(rows));
  });
  disabled = disabled || Boolean(documents && (value === null || !activeSeed.ready));

  if (activeSeed.error)
    return (
      <Text c="red" size="sm">
        Falha ao carregar imposto: {activeSeed.error.message}
      </Text>
    );

  if (operacoesSnap.error) {
    return (
      <Text c="red" size="sm">
        Falha ao carregar operações: {operacoesSnap.error.message}
      </Text>
    );
  }
  if (operacoes.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        {operacoesSnap.loading
          ? 'Carregando operações…'
          : 'Cadastre ao menos uma operação para poder cadastrar os impostos do produto.'}
      </Text>
    );
  }

  const activeIndex = rows.findIndex(
    (r) => operacaoIdFromImpostoRef(r.impostoOpercaoOuterRef) === activeId,
  );
  const active = activeIndex >= 0 ? rows[activeIndex] : null;
  const errNode = Array.isArray(errorTree) ? errorTree[activeIndex] : undefined;

  const v = (active ?? emptyImposto(activeId ?? '')) as ImpostoConfigValue;

  const handleChange = (next: ImpostoConfigValue) => {
    if (!activeId) return;
    const nextRows = [...rows];
    if (activeIndex >= 0 && active) {
      nextRows[activeIndex] = { ...active, ...next } as ImpostoProduto;
    } else {
      // Operação not yet in the array (e.g. added after the seed) — append it.
      nextRows.push({ ...emptyImposto(activeId), ...next } as ImpostoProduto);
    }
    onChange(nextRows);
  };

  return (
    <Stack>
      {!activeSeed.ready && (
        <Text c="dimmed" size="sm">
          Carregando imposto do servidor…
        </Text>
      )}
      <Select
        label="Operação"
        description="Cada operação fiscal pode ter um imposto específico."
        data={operacoes.map((o) => ({ value: o.id, label: o.nome }))}
        value={activeId}
        onChange={setPickedId}
        allowDeselect={false}
        disabled={disabled}
      />

      <ImpostoConfigEditor
        value={v}
        onChange={handleChange}
        disabled={disabled}
        errorTree={errNode}
      />
    </Stack>
  );
}
