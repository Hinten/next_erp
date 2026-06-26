'use client';

import { useEffect, useMemo, useState } from 'react';
import { Select, Stack, Text } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  impostoProdutoSchema,
  operacaoIdFromImpostoRef,
  type ImpostoProduto,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { impostoProdutoCollection } from '@/lib/data/impostoProdutoCollection';
import { ImpostoConfigEditor, type ImpostoConfigValue } from '@/components/imposto';

// Operações are few (fiscal operations); a bounded, name-ordered query suffices.
const OPERACAO_LIMIT = 200;
const IMPOSTO_LIMIT = 200;

interface OperacaoRow {
  id: string;
  nome: string;
  padrao: boolean;
}

/** A blank imposto entry scoped to one operação (Flutter typo wire key). */
function emptyImposto(operacaoId: string): ImpostoProduto {
  return impostoProdutoSchema.parse({ impostoOpercaoOuterRef: `operacao/${operacaoId}` });
}

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
    () =>
      (operacoesSnap.data ?? [])
        .filter((o) => o.data.ativo !== false)
        .map((o) => ({ id: o.id, nome: o.data.nome, padrao: o.data.padrao === true })),
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

  // Seed the transient array once operações (and, in edit mode, the imposto
  // docs) have loaded — one entry per active operação merged with its saved doc.
  useEffect(() => {
    if (value != null) return;
    if (operacoesSnap.loading) return;
    if (produtoId && impostosSnap.loading) return;
    if (operacoes.length === 0) return;
    const byOperacao = new Map<string, ImpostoProduto>();
    for (const d of impostosSnap.data ?? []) {
      const opId = operacaoIdFromImpostoRef(d.data.impostoOpercaoOuterRef);
      // Skip a null-scoped (default-fallback) imposto — it is not a per-operação
      // entry; leaving it out of the form keeps it untouched on save (rather than
      // rewriting its scope to a fake `operacao/<docId>`).
      if (!opId) continue;
      byOperacao.set(opId, { ...d.data, id: d.id, impostoOpercaoOuterRef: `operacao/${opId}` });
    }
    onChange(operacoes.map((op) => byOperacao.get(op.id) ?? emptyImposto(op.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [produtoId, operacoesSnap.loading, impostosSnap.loading, operacoes.length, value]);

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
