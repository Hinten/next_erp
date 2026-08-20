/**
 * Size-chart deletion — the half of the CRUD the legacy Flutter screen never
 * had (its trash icon only dropped the chart from the Firestore payload,
 * orphaning it on ML forever) because `DELETE /catalog/charts/{id}` did not
 * exist yet.
 *
 * It is a **request, not a delete**. ML acks 200 immediately and only then
 * checks — asynchronously, over as much as 24h — that no listing still links
 * the chart; one that is still in use is silently kept. So the flow is two
 * steps, and the entry stays on the tabMedi doc in between:
 *
 *  - `requestSizeChartDeletion` → ML DELETE, then stamp `exclusaoSolicitadaEm`
 *    so the editor can show "Exclusão solicitada" across reloads;
 *  - `verifySizeChartDeletion` → re-read the chart; a 404, or `chart_status`
 *    `INACTIVE`, means it is really gone and the entry is dropped locally.
 *    `ACTIVE` means it is still linked and the operator has to unlink first.
 *
 * ⚠️ Both rebuild the chart array from a FRESH read of the doc, keyed by ML
 * chart id — never from anything the caller passed. The still-running Flutter
 * app writes the same map, and a full-array merge built from stale client state
 * would silently drop whatever it added (root CLAUDE.md rule 7).
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreHttpError,
  type MlSizeChartApi,
} from '@delfrance/integrations-mercado-livre';
import type { MlSizeChart } from '@delfrance/schemas';
import { mlSizeChartsForConta } from '@delfrance/schemas';
import { tabelaDeMedidasCollection } from '@delfrance/data/admin/collections';

import { TabelaDeMedidasNotFoundError } from './sizeChartSync';

/** The chart id referenced by a delete/verify call is not on this tabMedi. */
export class SizeChartNotFoundError extends Error {
  constructor(chartId: string) {
    super(`Guia de tamanho ${chartId} não encontrada nesta tabela de medidas.`);
    this.name = 'SizeChartNotFoundError';
  }
}

export interface SizeChartDeleteDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
}

export interface RequestDeletionResult {
  /** ML accepted the removal request (it has NOT necessarily removed anything). */
  requested: true;
  /** ML's explanatory message, when it sent one. */
  message: string | null;
  /** The charts as stored after the stamp. */
  tabelas: MlSizeChart[];
}

export interface VerifyDeletionResult {
  /** True ⇒ ML confirmed the removal and the entry is off the doc. */
  removed: boolean;
  /** Raw `chart_status` as of this read (`ACTIVE` = still linked), or null. */
  chartStatus: string | null;
  /** The charts as stored after the check. */
  tabelas: MlSizeChart[];
}

/** Read the tabMedi doc and this conta's stored chart list. */
async function readStored(
  db: Firestore,
  integracaoId: string,
  tabMediId: string,
): Promise<MlSizeChart[]> {
  const snap = await tabelaDeMedidasCollection.docRef(db, {}, tabMediId).get();
  if (!snap.exists) throw new TabelaDeMedidasNotFoundError(tabMediId);
  const doc = tabelaDeMedidasCollection.parseRead(
    snap.data(),
    tabelaDeMedidasCollection.docPath({}, tabMediId),
  );
  return mlSizeChartsForConta(doc.tabelasDeMedidasMercadoLivre ?? null, integracaoId);
}

/**
 * Deep-merge this integração's key only, so other contas' charts and the
 * Flutter-authored `tabelasMedidasShopee` survive untouched — the same write
 * shape `syncSizeCharts` uses.
 */
async function persist(
  db: Firestore,
  integracaoId: string,
  tabMediId: string,
  tabelas: MlSizeChart[],
): Promise<void> {
  await tabelaDeMedidasCollection.merge(db, {}, tabMediId, {
    tabelasDeMedidasMercadoLivre: { [integracaoId]: { tabelas } },
    ultimaModificacao: Date.now(),
  });
}

/**
 * Ask ML to remove the chart, then record that we asked.
 *
 * The stamp lands only AFTER ML accepted: stamping first would leave a guia
 * permanently flagged "Exclusão solicitada" when the call turned out to be
 * rejected, and the operator would have no way to tell that apart from a chart
 * ML is genuinely still chewing on.
 */
export async function requestSizeChartDeletion(
  deps: SizeChartDeleteDeps,
  tabMediId: string,
  chartId: string,
  now: number = Date.now(),
): Promise<RequestDeletionResult> {
  const { db, api, integracaoId } = deps;

  const before = await readStored(db, integracaoId, tabMediId);
  if (!before.some((c) => c.id === chartId)) throw new SizeChartNotFoundError(chartId);

  const response = await api.deleteSizeChart(chartId);

  // Re-read: the ML round trip is a window in which another writer may have
  // landed (a concurrent operator, a redelivered task, the sync sweep).
  const after = await readStored(db, integracaoId, tabMediId);
  const tabelas = after.map((c) => (c.id === chartId ? { ...c, exclusaoSolicitadaEm: now } : c));
  await persist(db, integracaoId, tabMediId, tabelas);

  return { requested: true, message: response.message ?? null, tabelas };
}

/**
 * Read the chart back from ML and drop it locally once ML confirms it is gone.
 *
 * A 404 counts as gone: ML stops serving a chart it has removed, and treating
 * that as an error would strand the entry on the doc forever.
 */
export async function verifySizeChartDeletion(
  deps: SizeChartDeleteDeps,
  tabMediId: string,
  chartId: string,
): Promise<VerifyDeletionResult> {
  const { db, api, integracaoId } = deps;

  const before = await readStored(db, integracaoId, tabMediId);
  if (!before.some((c) => c.id === chartId)) throw new SizeChartNotFoundError(chartId);

  let chart: MlSizeChartApi | null = null;
  try {
    chart = await api.getSizeChart(chartId);
  } catch (err) {
    if (!(err instanceof MercadoLivreHttpError) || err.status !== 404) throw err;
  }

  const chartStatus = chart?.chart_status ?? null;
  const removed = chart === null || chartStatus === 'INACTIVE';
  if (!removed) return { removed: false, chartStatus, tabelas: before };

  const after = await readStored(db, integracaoId, tabMediId);
  const tabelas = after.filter((c) => c.id !== chartId);
  await persist(db, integracaoId, tabMediId, tabelas);

  return { removed: true, chartStatus, tabelas };
}
