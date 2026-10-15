import { z } from 'zod';
import { valuesEqual } from '@delfrance/core';
import { wireInt } from '@delfrance/core/wire';
import { mlSizeChartSchema, type MlSizeChart } from '@delfrance/schemas';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreValidationError,
  type MlSizeChartApi,
} from '@delfrance/integrations-mercado-livre';
import {
  acquireRecovery,
  finishRecovery,
  checkpointOperation,
  operationContext,
  chartConflict,
  chartUnconfirmed,
  SizeChartOperationError,
} from './sizeChartOperation';
import {
  chartSiteId,
  matchingResponseRows,
  reconcileChartResponse,
  remoteRowMatches,
  sameRowId,
  type SizeChartSyncDeps,
} from './sizeChartSync';

export const chartRecoveryRequestSchema = z.object({
  operationId: z.uuid(),
  expectedChart: mlSizeChartSchema.nullable().default(null),
  recoveryChartId: z.string().min(1).nullable().default(null),
  confirmNoCreation: z.boolean().default(false),
});

/** Preserve newer names/measurements; bind only unchanged immutable row identities. */
function mergeRecoveredIds(
  current: MlSizeChart,
  original: MlSizeChart,
  recovered: MlSizeChart,
): MlSizeChart {
  if (current.id && current.id !== recovered.id) throw chartConflict();
  for (const key of [
    'domain_id',
    'tipo',
    'grupoDeVariacoesUid',
    'attributes',
    'main_attribute',
  ] as const) {
    if (!valuesEqual(current[key] ?? null, original[key] ?? null)) throw chartConflict();
  }
  const mainId = recovered.main_attribute_id;
  if (current.main_attribute_id && current.main_attribute_id !== mainId) throw chartConflict();
  if ((current.rows ?? []).length !== (original.rows ?? []).length) throw chartConflict();
  const matchedIndices = new Set<number>();
  const rows = (current.rows ?? []).map((row) => {
    const matches = (original.rows ?? [])
      .map((old, index) => ({ old, index }))
      .filter(({ old }) => {
        if (row.id) return sameRowId(row.id, old.id);
        return (
          valuesEqual(row.varianteUid ?? null, old.varianteUid ?? null) &&
          valuesEqual(
            row.attributes?.find((a) => a.id === mainId) ?? null,
            old.attributes?.find((a) => a.id === mainId) ?? null,
          )
        );
      });
    if (matches.length !== 1) throw chartConflict();
    if (matchedIndices.has(matches[0]!.index)) throw chartConflict();
    matchedIndices.add(matches[0]!.index);
    const matched = recovered.rows![matches[0]!.index]!;
    return {
      ...row,
      id: matched.id ?? null,
      ...(matched.sizeCalculado ? { sizeCalculado: matched.sizeCalculado } : {}),
    };
  });
  return { ...current, id: recovered.id ?? null, main_attribute_id: mainId ?? null, rows };
}

/** Explicit recovery never replays the old desired payload or performs an ML write. */
export async function recoverSizeChart(deps: SizeChartSyncDeps, tabMediId: string, input: unknown) {
  const request = chartRecoveryRequestSchema.parse(input);
  const ctx = operationContext(deps.db, tabMediId, deps.integracaoId);
  const op = await acquireRecovery(ctx, request.operationId);
  let finished = false;
  try {
    let remote: MlSizeChartApi | null = null;
    let project: ((current: MlSizeChart) => MlSizeChart) | undefined;
    const knownId = op.projected.id || (op.pending?.kind === 'create' ? op.baseline?.id : null);
    const remoteId =
      request.recoveryChartId ??
      (typeof knownId === 'string' || typeof knownId === 'number' ? String(knownId) : null);
    if (op.projected.id && remoteId !== op.projected.id) throw chartUnconfirmed();
    if (op.pending?.kind === 'create' && remoteId == null) {
      // No negative GET can identify an unacknowledged chart POST. Only the
      // operator's explicit verification can abandon this uncertain attempt.
      if (!request.confirmNoCreation) throw chartUnconfirmed();
    } else {
      if (remoteId == null) throw chartUnconfirmed();
      try {
        remote = await deps.api.getSizeChart(remoteId);
      } catch (err) {
        if (
          !(err instanceof MercadoLivreHttpError) ||
          err.status !== 404 ||
          op.pending?.kind === 'create'
        )
          throw err;
      }
      if (remote && String(remote.id) !== remoteId) throw chartUnconfirmed();
      if (op.pending?.kind === 'create') {
        if (request.confirmNoCreation || remote == null) throw chartUnconfirmed();
        const me = await deps.api.getMe();
        if (
          wireInt().safeParse(remote.seller_id).data !== me.id ||
          remote.site_id !== chartSiteId(op.projected) ||
          remote.domain_id !== op.projected.domain_id?.split('-').slice(1).join('-') ||
          remote.names?.[chartSiteId(op.projected)] !== op.projected.nome ||
          (op.projected.tipo != null && remote.measure_type !== op.projected.tipo) ||
          !remoteRowMatches(
            op.projected,
            { id: null, attributes: op.projected.attributes },
            { attributes: remote.attributes },
          ) ||
          (remote.rows ?? []).length !== (op.projected.rows ?? []).length
        )
          throw chartUnconfirmed();
        const recovered = reconcileChartResponse(
          { ...op.projected, main_attribute_id: remote.main_attribute_id },
          remote,
        );
        if (
          !(recovered.rows ?? []).every((row) =>
            remoteRowMatches(recovered, row, remote!.rows!.find((r) => sameRowId(r.id, row.id))!),
          )
        )
          throw chartUnconfirmed();
        project = (current) => mergeRecoveredIds(current, op.projected, recovered);
      } else if (
        op.pending?.kind === 'row' &&
        !op.projected.rows?.[op.pending.rowIndex!]?.id &&
        remote != null
      ) {
        const pendingRow = op.projected.rows![op.pending.rowIndex!]!;
        const matches = matchingResponseRows(op.projected, pendingRow, remote);
        if (matches.length === 0) {
          if (!request.confirmNoCreation) throw chartUnconfirmed();
        } else {
          if (matches.length !== 1 || request.confirmNoCreation) throw chartUnconfirmed();
          const selected = op.projected.rows!.filter(
            (row, index) => !!row.id || index === op.pending!.rowIndex,
          );
          const mapped = reconcileChartResponse({ ...op.projected, rows: selected }, remote);
          let cursor = 0;
          const recovered = {
            ...mapped,
            rows: op.projected.rows!.map((row, index) =>
              row.id || index === op.pending!.rowIndex ? mapped.rows![cursor++]! : row,
            ),
          };
          project = (current) => mergeRecoveredIds(current, op.projected, recovered);
        }
      }
    }
    const chart = await finishRecovery(
      ctx,
      op,
      remote as Record<string, unknown> | null,
      request.expectedChart,
      project,
    );
    finished = true;
    return { released: true as const, chartIndex: op.chartIndex, chart: project ? chart : null };
  } catch (err) {
    if (
      !(
        err instanceof SizeChartOperationError ||
        err instanceof MercadoLivreHttpError ||
        err instanceof MercadoLivreNetworkError ||
        err instanceof MercadoLivreValidationError ||
        err instanceof z.ZodError
      )
    )
      throw err;
    if (!finished) await checkpointOperation(ctx, op, {}, false, true);
    throw err;
  }
}
