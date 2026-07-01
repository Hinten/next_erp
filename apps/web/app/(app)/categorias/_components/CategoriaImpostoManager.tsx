'use client';

import { useEffect, useMemo, useState } from 'react';
import { Select, Stack, Text } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  impostoCategoriaSchema,
  operacaoIdFromImpostoRef,
  type ImpostoCategoria,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { impostoCategoriaCollection } from '@/lib/data/impostoCategoriaCollection';
import { ImpostoConfigEditor, type ImpostoConfigValue } from '@/components/imposto';

const OPERACAO_LIMIT = 200;
const IMPOSTO_LIMIT = 200;

interface OperacaoRow {
  id: string;
  nome: string;
  padrao: boolean;
}

/** A blank imposto entry scoped to one operação (correct-spelling wire key). */
function emptyImposto(operacaoId: string): ImpostoCategoria {
  return impostoCategoriaSchema.parse({ impostoOperacaoOuterRef: `operacao/${operacaoId}` });
}

export interface CategoriaImpostoManagerProps {
  categoriaId: string | null;
  db: Firestore;
  /** Transient `impostos` form value (null until seeded). */
  value: ImpostoCategoria[] | null;
  onChange: (next: ImpostoCategoria[]) => void;
  errorTree?: unknown;
  disabled?: boolean;
}

/**
 * Categoria impostos tab (#318) — one imposto override per active operação,
 * scoped by `impostoOperacaoOuterRef` and saved at
 * `categorias/<id>/impostocategoria/<operacaoId>` ATOMICALLY with the categoria
 * doc (the page's `transactionWrites`). Mirrors the produto `ImpostoManager`,
 * reusing the shared {@link ImpostoConfigEditor} for the deep tax config.
 */
export function CategoriaImpostoManager({
  categoriaId,
  db,
  value,
  onChange,
  errorTree,
  disabled,
}: CategoriaImpostoManagerProps) {
  const operacoesQuery = useMemo(
    () => buildQuery(operacaoCollection.ref(db, {}), [orderByField('nome'), limit(OPERACAO_LIMIT)]),
    [db],
  );
  const operacoesSnap = useSnapshot(operacoesQuery);
  const operacoes: OperacaoRow[] = useMemo(
    () =>
      (operacoesSnap.data ?? [])
        .filter((o) => o.data.ativo !== false)
        .map((o) => ({ id: o.id, nome: o.data.nome, padrao: o.data.padrao === true })),
    [operacoesSnap.data],
  );

  const impostosQuery = useMemo(
    () =>
      categoriaId
        ? buildQuery(impostoCategoriaCollection.ref(db, { categoriaId }), [limit(IMPOSTO_LIMIT)])
        : null,
    [db, categoriaId],
  );
  const impostosSnap = useSnapshot(impostosQuery);

  useEffect(() => {
    if (value != null) return;
    if (operacoesSnap.loading) return;
    if (categoriaId && impostosSnap.loading) return;
    if (operacoes.length === 0) return;
    const byOperacao = new Map<string, ImpostoCategoria>();
    for (const d of impostosSnap.data ?? []) {
      const opId = operacaoIdFromImpostoRef(d.data.impostoOperacaoOuterRef);
      if (!opId) continue;
      byOperacao.set(opId, { ...d.data, id: d.id, impostoOperacaoOuterRef: `operacao/${opId}` });
    }
    onChange(operacoes.map((op) => byOperacao.get(op.id) ?? emptyImposto(op.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoriaId, operacoesSnap.loading, impostosSnap.loading, operacoes.length, value]);

  const defaultOperacaoId = useMemo(
    () => operacoes.find((o) => o.padrao)?.id ?? operacoes[0]?.id ?? null,
    [operacoes],
  );
  const [pickedId, setPickedId] = useState<string | null>(null);
  const activeId = pickedId ?? defaultOperacaoId;

  const rows = value ?? [];

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
          : 'Cadastre ao menos uma operação para configurar os impostos da categoria.'}
      </Text>
    );
  }

  const activeIndex = rows.findIndex(
    (r) => operacaoIdFromImpostoRef(r.impostoOperacaoOuterRef) === activeId,
  );
  const active = activeIndex >= 0 ? rows[activeIndex] : null;
  const errNode = Array.isArray(errorTree) ? errorTree[activeIndex] : undefined;

  const v = (active ?? emptyImposto(activeId ?? '')) as ImpostoConfigValue;

  const handleChange = (next: ImpostoConfigValue) => {
    if (!activeId) return;
    const nextRows = [...rows];
    if (activeIndex >= 0 && active) {
      nextRows[activeIndex] = { ...active, ...next } as ImpostoCategoria;
    } else {
      nextRows.push({ ...emptyImposto(activeId), ...next } as ImpostoCategoria);
    }
    onChange(nextRows);
  };

  return (
    <Stack>
      <Select
        label="Operação"
        description="Cada operação fiscal pode ter um imposto específico para esta categoria."
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
