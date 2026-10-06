'use client';

import { FieldPath, runTransaction, type Firestore } from 'firebase/firestore';
import { valuesEqual } from '@delfrance/core';
import { mlSizeChartsForContaSchema, type MlSizeChart } from '@delfrance/schemas';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { SizeChartConflictError } from './chartConflict';

export interface SaveChartInput {
  db: Firestore;
  tabMediId: string;
  integracaoId: string;
  chart: MlSizeChart;
  chartIndex: number | null;
  original: MlSizeChart | null;
}

export interface SavedChart {
  tabelas: MlSizeChart[];
  index: number;
  chart: MlSizeChart;
}

/** The baseline is the chart the operator reviewed, never a later live snapshot. */
function assertChartUnchanged(
  stored: readonly MlSizeChart[],
  chartIndex: number,
  original: MlSizeChart | null,
): void {
  if (original == null || !valuesEqual(stored[chartIndex], original)) {
    throw new SizeChartConflictError();
  }
}

/**
 * ADR 0011 tier 3: repeat the full-chart guard and rebuild the list from tx.get
 * on every OCC attempt. UI updates and provider calls belong after this returns.
 */
export async function saveChartTransaction(input: SaveChartInput): Promise<SavedChart> {
  const { db, tabMediId, integracaoId, chart, chartIndex, original } = input;
  const ref = tabelaDeMedidasCollection.docRef(db, {}, tabMediId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new SizeChartConflictError('Esta tabela foi excluída enquanto você editava.');
    }
    const entry = snap.data().tabelasDeMedidasMercadoLivre?.[integracaoId];
    const parsed = mlSizeChartsForContaSchema.safeParse(entry ?? {});
    if (!parsed.success) {
      throw new SizeChartConflictError(
        'Não foi possível ler as guias desta conta. Recarregue a tabela antes de salvar.',
      );
    }
    const stored = parsed.data.tabelas ?? [];
    if (chartIndex != null) assertChartUnchanged(stored, chartIndex, original);
    const tabelas =
      chartIndex == null
        ? [...stored, chart]
        : stored.map((current, index) => (index === chartIndex ? chart : current));
    const index = chartIndex ?? tabelas.length - 1;

    // update bypasses the full-document converter. FieldPath also keeps dots
    // in an integração id literal, while preserving every sibling and metadata key.
    tx.update(
      ref,
      new FieldPath('tabelasDeMedidasMercadoLivre', integracaoId, 'tabelas'),
      tabelas,
      'ultimaModificacao',
      Date.now(),
    );
    return { tabelas, index, chart };
  });
}
