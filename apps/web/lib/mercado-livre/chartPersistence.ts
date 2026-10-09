'use client';

import { FieldPath, runTransaction, type Firestore } from 'firebase/firestore';
import { valuesEqual } from '@delfrance/core';
import { mlSizeChartsForContaSchema, type MlSizeChart } from '@delfrance/schemas';
import { tabelaDeMedidasCollection } from '../data/tabelaDeMedidasCollection';
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

export interface ChartDraftRemoval {
  integracaoId: string;
  chartIndex: number;
  original: MlSizeChart;
}

export interface RemoveChartDraftsInput {
  db: Firestore;
  tabMediId: string;
  removals: readonly ChartDraftRemoval[];
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

/** All staged removals share one commit; every retry repeats the baseline guard. */
export async function removeChartDraftsTransaction(
  input: RemoveChartDraftsInput,
): Promise<Record<string, MlSizeChart[]>> {
  const { db, tabMediId, removals } = input;
  if (removals.length === 0) return {};
  const ref = tabelaDeMedidasCollection.docRef(db, {}, tabMediId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new SizeChartConflictError('Esta tabela foi excluída enquanto você editava.');
    }
    const map = snap.data().tabelasDeMedidasMercadoLivre;
    const accounts = new Map<string, { stored: MlSizeChart[]; indexes: Set<number> }>();
    for (const removal of removals) {
      let account = accounts.get(removal.integracaoId);
      const entry = map?.[removal.integracaoId];
      const parsed = mlSizeChartsForContaSchema.safeParse(entry);
      if (!parsed.success || !Array.isArray(parsed.data.tabelas)) {
        throw new SizeChartConflictError(
          'Não foi possível ler as guias desta conta. Recarregue a tabela antes de salvar.',
        );
      }
      assertChartUnchanged(parsed.data.tabelas, removal.chartIndex, removal.original);
      if (removal.original.id != null && removal.original.id !== '') {
        throw new SizeChartConflictError(
          'Somente rascunhos não enviados podem ser excluídos aqui.',
        );
      }
      if (!account) {
        // Validate with the read schema, but retain the actual wire values of
        // survivors (including tolerant dates and unknown legacy chart fields).
        const raw = entry as { tabelas: MlSizeChart[] };
        account = { stored: raw.tabelas, indexes: new Set() };
        accounts.set(removal.integracaoId, account);
      }
      account.indexes.add(removal.chartIndex);
    }

    const lists: Record<string, MlSizeChart[]> = {};
    for (const [integracaoId, account] of accounts) {
      const tabelas = account.stored.filter((_, index) => !account.indexes.has(index));
      lists[integracaoId] = tabelas;
      tx.update(
        ref,
        new FieldPath('tabelasDeMedidasMercadoLivre', integracaoId, 'tabelas'),
        tabelas,
      );
    }
    tx.update(ref, 'ultimaModificacao', Date.now());
    return lists;
  });
}
