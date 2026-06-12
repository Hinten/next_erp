'use client';

import { useMemo } from 'react';
import { Select } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { getDocs, type Firestore } from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { INTEGRACAO_FRETE_LABELS } from '@delfrance/schemas';
import { intFreteCollection } from '@/lib/data/intFreteCollection';

function tipoLabel(tipo: string | null | undefined): string {
  return (INTEGRACAO_FRETE_LABELS as Record<string, string>)[tipo ?? ''] ?? tipo ?? '';
}

export interface IntegracaoFreteSelectProps {
  db: Firestore;
  /** Currently selected `int_frete` doc id (derived from the outer ref). */
  value: string | null;
  /**
   * Resolved current doc when it isn't in the active list (inactive or
   * deleted integração) — keeps the stored selection visible, like the
   * legacy dropdown kept the ref on the doc.
   */
  currentFallback?: { id: string; nome: string; tipo: string } | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  error?: string;
}

/**
 * "Integração de Frete" dropdown — one-shot load of
 * `int_frete where ativo == true orderBy nome`, the same query the legacy
 * widget ran (`.old/lib/pedido/widgets/frete_inicial_widget.dart:221-224`).
 * Labels mirror `IntegracaoFrete.toString`: `nome (tipo)`.
 */
export function IntegracaoFreteSelect({
  db,
  value,
  currentFallback,
  onChange,
  disabled,
  error,
}: IntegracaoFreteSelectProps) {
  const list = useQuery({
    queryKey: ['intFreteAtivosPicker'],
    queryFn: async () => {
      const snap = await getDocs(
        buildQuery(intFreteCollection.ref(db, {}), [
          whereOp('ativo', '==', true),
          orderByField('nome'),
          limit(100),
        ]),
      );
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    },
  });

  const data = useMemo(() => {
    const rows = (list.data ?? []).map((r) => ({
      value: r.id,
      label: `${r.data.nome} (${tipoLabel(r.data.tipo)})`,
    }));
    if (value && currentFallback && !rows.some((r) => r.value === value)) {
      rows.unshift({
        value: currentFallback.id,
        label: `${currentFallback.nome} (${tipoLabel(currentFallback.tipo)})`,
      });
    }
    return rows;
  }, [list.data, value, currentFallback]);

  return (
    <Select
      label="Integração de frete"
      data={data}
      value={value}
      onChange={onChange}
      placeholder="Selecione uma integração de frete"
      nothingFoundMessage="Nenhuma integração de frete ativa."
      clearable
      searchable
      disabled={disabled}
      error={error}
    />
  );
}
