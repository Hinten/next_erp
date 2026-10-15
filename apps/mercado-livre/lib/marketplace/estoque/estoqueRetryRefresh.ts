/**
 * Fresh stock resolution for delayed Mercado Livre stock tasks (#693).
 *
 * The dominant first-attempt path never calls this module. A real Cloud Tasks
 * retry or a pause re-enqueue pays at most two BatchGet RPCs: one for the
 * distinct target produtos, then one for the distinct own/component estoque
 * documents at the conta's depósito. Modern tasks carry the exact estoque ids
 * observed by the sweep, including legacy auto-ids; there is no query, pipeline,
 * scan or cache here.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
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
export type StockLocatorSource = 'none' | 'snapshot' | 'canonical-compat';

export interface StockRefreshTelemetry {
  refreshed: boolean;
  source: StockRefreshSource;
  locatorSource: StockLocatorSource;
  retryCount: number;
  reenqueues: number;
  produtoReadCount: number;
  estoqueReadCount: number;
  componentRefCount: number;
  legacyEstoqueRefCount: number;
  missingLocatorCount: number;
  depositoId: string | null;
  produtoIdsSample: string[];
  componentIdsSample: string[];
  estoquePathsSample: string[];
  readSetTruncated: boolean;
}

export type StockRetryRefreshSkipReason =
  | 'refresh-sem-produto-id'
  | 'refresh-produto-ausente'
  | 'refresh-deposito-alterado'
  | 'kit-virtual';

export type StockRetryRefreshFallbackReason =
  | 'refresh-sem-snapshot-legado'
  | 'refresh-localizador-incompleto';

export type StockRetryRefreshResult =
  | { outcome: 'refreshed'; payload: MlStockSendTask; telemetry: StockRefreshTelemetry }
  | {
      outcome: 'payload-fallback';
      payload: MlStockSendTask;
      reason: StockRetryRefreshFallbackReason;
      telemetry: StockRefreshTelemetry;
    }
  | {
      outcome: 'skipped';
      reason: StockRetryRefreshSkipReason;
      telemetry: StockRefreshTelemetry;
    };

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
    locatorSource: 'none',
    retryCount,
    payload,
    depositoId,
    produtoIds: [],
    componentIds: [],
    estoquePaths: [],
    legacyEstoqueRefCount: 0,
    missingLocatorCount: 0,
  });
}

/**
 * Recompute the task's stock quantities from point reads at one depósito.
 *
 * A modern snapshot distinguishes an exact legacy/canonical row from a row the
 * sweep observed as absent. A task from the previous release cannot make that
 * distinction: if any canonical estoque is absent, the whole original payload
 * is used rather than inventing zero for a possible legacy auto-id row.
 */
export async function refreshStockTaskPayload(
  args: RefreshStockTaskArgs,
): Promise<StockRetryRefreshResult> {
  const { db, payload, depositoId, retryCount, source } = args;
  const produtoIds = targetProdutoIds(payload);
  if (produtoIds == null) {
    return {
      outcome: 'skipped',
      reason: 'refresh-sem-produto-id',
      telemetry: telemetry({
        refreshed: false,
        source,
        locatorSource: payload.estoqueSnapshot == null ? 'canonical-compat' : 'snapshot',
        retryCount,
        payload,
        depositoId,
        produtoIds: [],
        componentIds: [],
        estoquePaths: [],
        legacyEstoqueRefCount: 0,
        missingLocatorCount: 0,
      }),
    };
  }

  if (
    payload.estoqueSnapshot != null &&
    validDocumentId(payload.estoqueSnapshot.depositoId) &&
    payload.estoqueSnapshot.depositoId !== depositoId
  ) {
    return {
      outcome: 'skipped',
      reason: 'refresh-deposito-alterado',
      telemetry: telemetry({
        refreshed: false,
        source,
        locatorSource: 'snapshot',
        retryCount,
        payload,
        depositoId,
        produtoIds: [],
        componentIds: [],
        estoquePaths: [],
        legacyEstoqueRefCount: 0,
        missingLocatorCount: 0,
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
        outcome: 'skipped',
        reason: 'refresh-produto-ausente',
        telemetry: telemetry({
          refreshed: false,
          source,
          locatorSource: payload.estoqueSnapshot == null ? 'canonical-compat' : 'snapshot',
          retryCount,
          payload,
          depositoId,
          produtoIds,
          componentIds: [],
          estoquePaths: [],
          legacyEstoqueRefCount: 0,
          missingLocatorCount: 0,
        }),
      };
    }
    produtoRawById.set(produtoIds[i]!, snap.data() as Record<string, unknown>);
  }

  const componentIds = distinct(
    produtoIds.flatMap((produtoId) => constrainingComponentIds(produtoRawById.get(produtoId)!)),
  );
  const estoqueProdutoIds = distinct([...produtoIds, ...componentIds]);
  const snapshotLocators = payload.estoqueSnapshot?.refs ?? null;
  const locatorResult = snapshotLocators == null ? null : locatorMap(snapshotLocators);

  const malformedSnapshot =
    payload.estoqueSnapshot != null &&
    (!validDocumentId(payload.estoqueSnapshot.depositoId) || locatorResult?.malformed === true);
  if (malformedSnapshot || locatorResult?.conflicting === true) {
    return payloadFallback({
      source,
      retryCount,
      payload,
      depositoId,
      produtoIds,
      componentIds,
      missingLocatorCount: 1,
    });
  }

  const missingLocatorIds =
    locatorResult == null
      ? []
      : estoqueProdutoIds.filter((produtoId) => !locatorResult.locators.has(produtoId));
  if (missingLocatorIds.length > 0) {
    return payloadFallback({
      source,
      retryCount,
      payload,
      depositoId,
      produtoIds,
      componentIds,
      missingLocatorCount: missingLocatorIds.length,
    });
  }

  const locatorSource: StockLocatorSource = locatorResult == null ? 'canonical-compat' : 'snapshot';
  let legacyEstoqueRefCount = 0;
  const estoqueRefs: DocumentReference[] = estoqueProdutoIds.map((produtoId) => {
    const canonicalId = makeEstoqueUid(produtoId, depositoId);
    const capturedId = locatorResult?.locators.get(produtoId) ?? null;
    if (capturedId != null && capturedId !== canonicalId) legacyEstoqueRefCount += 1;
    return estoqueCollection.docRef(db, { produtoId }, capturedId ?? canonicalId);
  });
  const estoqueSnaps = await db.getAll(...estoqueRefs, {
    fieldMask: ['quantidade', 'quantidadeReservada'],
  });

  const missingEstoqueCount = estoqueSnaps.filter((snap) => !snap.exists).length;
  if (locatorResult == null && missingEstoqueCount > 0) {
    return {
      outcome: 'payload-fallback',
      payload,
      reason: 'refresh-sem-snapshot-legado',
      telemetry: telemetry({
        refreshed: false,
        source,
        locatorSource,
        retryCount,
        payload,
        depositoId,
        produtoIds,
        componentIds,
        estoquePaths: estoqueRefs.map((ref) => ref.path),
        legacyEstoqueRefCount,
        missingLocatorCount: missingEstoqueCount,
      }),
    };
  }

  const disponivelByProdutoId = new Map<string, number>();
  for (let i = 0; i < estoqueProdutoIds.length; i += 1) {
    const snap = estoqueSnaps[i];
    const raw = snap?.exists ? (snap.data() as Record<string, unknown>) : undefined;
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
    locatorSource,
    retryCount,
    payload,
    depositoId,
    produtoIds,
    componentIds,
    estoquePaths: estoqueRefs.map((ref) => ref.path),
    legacyEstoqueRefCount,
    missingLocatorCount: 0,
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
      return { outcome: 'skipped', reason: 'kit-virtual', telemetry: refreshTelemetry };
    }
    return {
      outcome: 'refreshed',
      payload: { ...payload, variations },
      telemetry: refreshTelemetry,
    };
  }

  const targetId = scalarTargetProdutoId(payload);
  if (targetId == null) {
    return {
      outcome: 'skipped',
      reason: 'refresh-sem-produto-id',
      telemetry: refreshTelemetry,
    };
  }
  const quantidade = quantityByProdutoId.get(targetId) ?? null;
  if (quantidade == null) {
    return { outcome: 'skipped', reason: 'kit-virtual', telemetry: refreshTelemetry };
  }
  return {
    outcome: 'refreshed',
    payload: { ...payload, quantidade },
    telemetry: refreshTelemetry,
  };
}

function payloadFallback(args: {
  source: Exclude<StockRefreshSource, 'payload'>;
  retryCount: number;
  payload: MlStockSendTask;
  depositoId: string;
  produtoIds: string[];
  componentIds: string[];
  missingLocatorCount: number;
}): StockRetryRefreshResult {
  return {
    outcome: 'payload-fallback',
    payload: args.payload,
    reason: 'refresh-localizador-incompleto',
    telemetry: telemetry({
      refreshed: false,
      source: args.source,
      locatorSource: 'snapshot',
      retryCount: args.retryCount,
      payload: args.payload,
      depositoId: args.depositoId,
      produtoIds: args.produtoIds,
      componentIds: args.componentIds,
      estoquePaths: [],
      legacyEstoqueRefCount: 0,
      missingLocatorCount: args.missingLocatorCount,
    }),
  };
}

function locatorMap(refs: Array<{ produtoId: string; estoqueDocId: string | null }>): {
  locators: Map<string, string | null>;
  conflicting: boolean;
  malformed: boolean;
} {
  const locators = new Map<string, string | null>();
  let conflicting = false;
  let malformed = false;
  for (const locator of refs) {
    if (
      !validDocumentId(locator.produtoId) ||
      (locator.estoqueDocId != null && !validDocumentId(locator.estoqueDocId))
    ) {
      malformed = true;
      continue;
    }
    if (
      locators.has(locator.produtoId) &&
      locators.get(locator.produtoId) !== locator.estoqueDocId
    ) {
      conflicting = true;
      continue;
    }
    locators.set(locator.produtoId, locator.estoqueDocId);
  }
  return { locators, conflicting, malformed };
}

function validDocumentId(value: string): boolean {
  return value !== '' && !value.includes('/');
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
  locatorSource: StockLocatorSource;
  retryCount: number;
  payload: MlStockSendTask;
  depositoId: string;
  produtoIds: string[];
  componentIds: string[];
  estoquePaths: string[];
  legacyEstoqueRefCount: number;
  missingLocatorCount: number;
}): StockRefreshTelemetry {
  const { produtoIds, componentIds, estoquePaths } = args;
  return {
    refreshed: args.refreshed,
    source: args.source,
    locatorSource: args.locatorSource,
    retryCount: args.retryCount,
    reenqueues: args.payload.reenqueues,
    produtoReadCount: produtoIds.length,
    estoqueReadCount: estoquePaths.length,
    componentRefCount: componentIds.length,
    legacyEstoqueRefCount: args.legacyEstoqueRefCount,
    missingLocatorCount: args.missingLocatorCount,
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
