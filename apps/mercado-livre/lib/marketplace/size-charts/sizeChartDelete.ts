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
 * Both reserve the account through the sync journal, guard the entire target
 * chart, and rebuild siblings inside the receipt transaction. A fresh read
 * followed by an unguarded array merge would still lose a concurrent edit.
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
import { randomUUID } from 'node:crypto';
import {
  acquireOperation,
  checkpointOperation,
  currentOperation,
  operationCharts,
  operationContext,
  SizeChartOperationError,
  chartConflict,
} from './sizeChartOperation';

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
 * Admit a deletion/verification under the same reservation as sends.
 */
async function beginDeletion(
  deps: SizeChartDeleteDeps,
  tabMediId: string,
  chartId: string,
  kind: 'delete' | 'verify',
) {
  const list = await readStored(deps.db, deps.integracaoId, tabMediId);
  const index = list.findIndex((chart) => chart.id === chartId);
  if (index < 0) throw new SizeChartNotFoundError(chartId);
  const ctx = operationContext(deps.db, tabMediId, deps.integracaoId);
  const previous = await currentOperation(deps.db, tabMediId, deps.integracaoId);
  const resume =
    previous?.kind === kind &&
    previous.desired.id === chartId &&
    (previous.status === 'pending' || previous.status === 'unconfirmed');
  const op = await acquireOperation(
    ctx,
    resume ? previous.id : randomUUID(),
    index,
    resume ? previous.desired : list[index]!,
    kind,
  );
  return { ctx, op };
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
  const { api } = deps;

  const { ctx, op: acquired } = await beginDeletion(deps, tabMediId, chartId, 'delete');
  let op = await checkpointOperation(ctx, acquired, {
    pending: { kind: 'delete', rowIndex: null },
  });
  try {
    const response = await api.deleteSizeChart(chartId);
    op = await checkpointOperation(
      ctx,
      op,
      {
        pending: null,
        projected: { ...op.projected, exclusaoSolicitadaEm: now },
        status: 'completed',
      },
      true,
      true,
    );
    if (op.status === 'conflict') throw chartConflict();
    return {
      requested: true,
      message: response.message ?? null,
      tabelas: await operationCharts(ctx),
    };
  } catch (err) {
    if (!(err instanceof MercadoLivreHttpError || err instanceof SizeChartOperationError))
      throw err;
    if (op.status !== 'conflict')
      await checkpointOperation(ctx, op, { pending: null }, false, true);
    throw err;
  }
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
  const { api } = deps;
  const { ctx, op } = await beginDeletion(deps, tabMediId, chartId, 'verify');
  await checkpointOperation(ctx, op, {});

  let chart: MlSizeChartApi | null = null;
  try {
    chart = await api.getSizeChart(chartId);
  } catch (err) {
    if (!(err instanceof MercadoLivreHttpError) || err.status !== 404) {
      if (err instanceof MercadoLivreHttpError) await checkpointOperation(ctx, op, {}, false, true);
      throw err;
    }
  }

  const chartStatus = chart?.chart_status ?? null;
  const removed = chart === null || chartStatus === 'INACTIVE';
  const finished = await checkpointOperation(ctx, op, { status: 'completed' }, true, true, removed);
  if (finished.status === 'conflict') throw chartConflict();
  return { removed, chartStatus, tabelas: await operationCharts(ctx) };
}
