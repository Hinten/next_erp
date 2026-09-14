/**
 * Fresh stock resolution for delayed Mercado Livre stock tasks (#693).
 *
 * The dominant first-attempt path never calls this module. A real Cloud Tasks
 * retry or a pause re-enqueue pays at most two BatchGet RPCs: one for the
 * distinct target produtos, then one for the distinct own/component estoque
 * documents at the conta's depósito. Every estoque reference uses the
 * deterministic `makeEstoqueUid`; there is no query, pipeline, scan or cache.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type ComponentesKit,
  componentesKitEntries,
  estoqueDisponivel,
  makeEstoqueUid,
} from '@delfrance/schemas';
import { estoqueCollection, produtoCollection } from '@delfrance/data/admin/collections';

import { quantidadeParaEnvio } from './bulkEstoquePlan';
import type { MlStockSendTask } from './estoqueSend';

const READ_SET_SAMPLE_LIMIT = 20;

export type StockRefreshSource = 'payload' | 'cloud-task-retry' | 'pause-reenqueue';

export interface StockRefreshTelemetry {
  refreshed: boolean;
  source: StockRefreshSource;
  retryCount: number;
  reenqueues: number;
  produtoReadCount: number;
  estoqueReadCount: number;
  componentRefCount: number;
  depositoId: string | null;
  produtoIdsSample: string[];
  componentIdsSample: string[];
  estoquePathsSample: string[];
  readSetTruncated: boolean;
}

export type StockRetryRefreshReason =
  | 'refresh-sem-produto-id'
  | 'refresh-produto-ausente'
  | 'kit-virtual';

export type StockRetryRefreshResult =
  | { ok: true; payload: MlStockSendTask; telemetry: StockRefreshTelemetry }
  | { ok: false; reason: StockRetryRefreshReason; telemetry: StockRefreshTelemetry };

interface RefreshStockTaskArgs {
  db: Firestore;
  payload: MlStockSendTask;
  depositoId: string;
  retryCount: number;
  source: Exclude<StockRefreshSource, 'payload'>;
}

/** Telemetry for the zero-read, payload-verbatim first-attempt path. */
export function payloadStockTelemetry(
  payload: MlStockSendTask,
  retryCount: number,
  depositoId: string,
): StockRefreshTelemetry {
  return telemetry({
    refreshed: false,
    source: 'payload',
    retryCount,
    payload,
    depositoId,
    produtoIds: [],
    componentIds: [],
    estoquePaths: [],
  });
}

/**
 * Recompute the task's stock quantities from point reads at one depósito.
 *
 * Missing estoque is zero, matching `quantidadeDoMembro`. Missing target
 * produto refuses the whole ML call: mixing fresh and stale members in one
 * legacy `variations[]` write would make the refresh claim false. An old bulk
 * payload without child produto ids is also refused rather than scanned.
 */
export async function refreshStockTaskPayload(
  args: RefreshStockTaskArgs,
): Promise<StockRetryRefreshResult> {
  const { db, payload, depositoId, retryCount, source } = args;
  const produtoIds = targetProdutoIds(payload);
  if (produtoIds == null) {
    return {
      ok: false,
      reason: 'refresh-sem-produto-id',
      telemetry: telemetry({
        refreshed: false,
        source,
        retryCount,
        payload,
        depositoId,
        produtoIds: [],
        componentIds: [],
        estoquePaths: [],
      }),
    };
  }

  const produtoRefs = produtoIds.map((produtoId) => produtoCollection.docRef(db, {}, produtoId));
  const produtoSnaps = await db.getAll(...produtoRefs, {
    fieldMask: ['ehKit', 'ehKitVirtual', 'componentesKit'],
  });
  const produtoRawById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < produtoIds.length; i += 1) {
    const snap = produtoSnaps[i];
    if (!snap?.exists) {
      return {
        ok: false,
        reason: 'refresh-produto-ausente',
        telemetry: telemetry({
          refreshed: true,
          source,
          retryCount,
          payload,
          depositoId,
          produtoIds,
          componentIds: [],
          estoquePaths: [],
        }),
      };
    }
    produtoRawById.set(produtoIds[i]!, snap.data() as Record<string, unknown>);
  }

  const componentIds = distinct(
    produtoIds.flatMap((produtoId) => constrainingComponentIds(produtoRawById.get(produtoId)!)),
  );
  const estoqueProdutoIds = distinct([...produtoIds, ...componentIds]);
  const estoqueRefs = estoqueProdutoIds.map((produtoId) =>
    estoqueCollection.docRef(db, { produtoId }, makeEstoqueUid(produtoId, depositoId)),
  );
  const estoqueSnaps = await db.getAll(...estoqueRefs, {
    fieldMask: ['quantidade', 'quantidadeReservada'],
  });
  const disponivelByProdutoId = new Map<string, number>();
  for (let i = 0; i < estoqueProdutoIds.length; i += 1) {
    const raw = estoqueSnaps[i]?.data() as Record<string, unknown> | undefined;
    disponivelByProdutoId.set(estoqueProdutoIds[i]!, disponibilidade(raw));
  }

  const quantityByProdutoId = new Map<string, number | null>();
  for (const produtoId of produtoIds) {
    const raw = produtoRawById.get(produtoId)!;
    const componentesKit = (raw.componentesKit ?? null) as ComponentesKit | null;
    const componentesDisponiveis = Object.fromEntries(
      constrainingComponentIds(raw).map((componentId) => [
        componentId,
        disponivelByProdutoId.get(componentId) ?? 0,
      ]),
    );
    quantityByProdutoId.set(
      produtoId,
      quantidadeParaEnvio({
        ehKit: raw.ehKit === true,
        ehKitVirtual: raw.ehKitVirtual === true,
        componentesKit,
        ownDisponivel: disponivelByProdutoId.get(produtoId) ?? 0,
        disponivelByProdutoId: componentesDisponiveis,
      }),
    );
  }

  const refreshTelemetry = telemetry({
    refreshed: true,
    source,
    retryCount,
    payload,
    depositoId,
    produtoIds,
    componentIds,
    estoquePaths: estoqueRefs.map((ref) => ref.path),
  });

  if (payload.variations != null) {
    const variations = payload.variations.flatMap((variation) => {
      const produtoId = variation.produtoId;
      if (produtoId == null) return [];
      const quantidade = quantityByProdutoId.get(produtoId) ?? null;
      return quantidade == null
        ? []
        : [{ ...variation, produtoId, available_quantity: quantidade }];
    });
    if (variations.length === 0) {
      return { ok: false, reason: 'kit-virtual', telemetry: refreshTelemetry };
    }
    return { ok: true, payload: { ...payload, variations }, telemetry: refreshTelemetry };
  }

  const targetId = scalarTargetProdutoId(payload);
  if (targetId == null) {
    return { ok: false, reason: 'refresh-sem-produto-id', telemetry: refreshTelemetry };
  }
  const quantidade = quantityByProdutoId.get(targetId) ?? null;
  if (quantidade == null) {
    return { ok: false, reason: 'kit-virtual', telemetry: refreshTelemetry };
  }
  return { ok: true, payload: { ...payload, quantidade }, telemetry: refreshTelemetry };
}

function targetProdutoIds(payload: MlStockSendTask): string[] | null {
  if (payload.variations == null) {
    const produtoId = scalarTargetProdutoId(payload);
    return produtoId == null ? null : [produtoId];
  }
  if (payload.variations.length === 0) return null;
  const ids: string[] = [];
  for (const variation of payload.variations) {
    if (typeof variation.produtoId !== 'string' || variation.produtoId === '') return null;
    ids.push(variation.produtoId);
  }
  return distinct(ids);
}

function scalarTargetProdutoId(payload: MlStockSendTask): string | null {
  if (payload.kind === 'variationItem') return payload.variacaoProdutoId;
  if (payload.kind === 'userProductStock') {
    return payload.variacaoProdutoId ?? payload.produtoId;
  }
  return payload.produtoId;
}

/** Components whose stock actually constrains the kit minimum. */
function constrainingComponentIds(raw: Record<string, unknown>): string[] {
  if (!(raw.ehKit === true || raw.ehKitVirtual === true)) return [];
  return componentesKitEntries((raw.componentesKit ?? null) as ComponentesKit | null)
    .filter(([, component]) => component.limitarEstoque !== false)
    .filter(([, component]) => Number.isFinite(component.quantidade) && component.quantidade > 0)
    .map(([produtoId]) => produtoId);
}

function disponibilidade(raw: Record<string, unknown> | undefined): number {
  return estoqueDisponivel({
    quantidade: finiteNumber(raw?.quantidade) ?? 0,
    quantidadeReservada: finiteNumber(raw?.quantidadeReservada) ?? 0,
  });
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function telemetry(args: {
  refreshed: boolean;
  source: StockRefreshSource;
  retryCount: number;
  payload: MlStockSendTask;
  depositoId: string;
  produtoIds: string[];
  componentIds: string[];
  estoquePaths: string[];
}): StockRefreshTelemetry {
  const { produtoIds, componentIds, estoquePaths } = args;
  return {
    refreshed: args.refreshed,
    source: args.source,
    retryCount: args.retryCount,
    reenqueues: args.payload.reenqueues,
    produtoReadCount: produtoIds.length,
    estoqueReadCount: estoquePaths.length,
    componentRefCount: componentIds.length,
    depositoId: args.depositoId,
    produtoIdsSample: produtoIds.slice(0, READ_SET_SAMPLE_LIMIT),
    componentIdsSample: componentIds.slice(0, READ_SET_SAMPLE_LIMIT),
    estoquePathsSample: estoquePaths.slice(0, READ_SET_SAMPLE_LIMIT),
    readSetTruncated:
      produtoIds.length > READ_SET_SAMPLE_LIMIT ||
      componentIds.length > READ_SET_SAMPLE_LIMIT ||
      estoquePaths.length > READ_SET_SAMPLE_LIMIT,
  };
}
