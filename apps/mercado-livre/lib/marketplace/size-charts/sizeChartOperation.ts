import { randomUUID } from 'node:crypto';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { valuesEqual } from '@delfrance/core';
import { mlSizeChartsForContaSchema, type MlSizeChart } from '@delfrance/schemas';
import {
  tabelaDeMedidasCollection,
  mlChartSyncCollection,
  mlChartOperationCollection,
  type MlChartOperation,
} from '@delfrance/data/admin/collections';

export class TabelaDeMedidasNotFoundError extends Error {
  constructor(id: string) {
    super(`Tabela de medidas ${id} não encontrada.`);
  }
}

export class SizeChartOperationError extends Error {
  constructor(
    public readonly code: 'CHART_CONFLICT' | 'CHART_BUSY' | 'CHART_UNCONFIRMED',
    message: string,
  ) {
    super(message);
    this.name = 'SizeChartOperationError';
  }
}

export function chartConflict(): SizeChartOperationError {
  return new SizeChartOperationError(
    'CHART_CONFLICT',
    'A guia mudou durante o envio. Suas alterações foram mantidas. Feche e abra a guia para revisar.',
  );
}
export function chartUnconfirmed(): SizeChartOperationError {
  return new SizeChartOperationError(
    'CHART_UNCONFIRMED',
    'O envio anterior não foi confirmado. Tente recuperar o resultado antes de enviar novamente. Para uma guia nova, informe o ID da guia criada no Mercado Livre.',
  );
}

// The worker stops starting I/O at 120s, and the route bounds each ML call to
// 20s with NO transport retries. A takeover cannot overlap its mutation window.
export const CHART_WORKER_MS = 120_000;
export const CHART_LEASE_MS = 240_000;

export interface OperationContext {
  db: Firestore;
  tabMediId: string;
  integracaoId: string;
  owner: string;
  deadlineMs: number;
}

function refs(ctx: OperationContext, id: string) {
  return {
    parent: tabelaDeMedidasCollection.docRef(ctx.db, {}, ctx.tabMediId),
    control: mlChartSyncCollection.docRef(ctx.db, { tabMediId: ctx.tabMediId }, ctx.integracaoId),
    operation: mlChartOperationCollection.docRef(
      ctx.db,
      { tabMediId: ctx.tabMediId, integracaoId: ctx.integracaoId },
      id,
    ),
  };
}

function charts(raw: Record<string, unknown> | undefined, integracaoId: string): MlSizeChart[] {
  const map = raw?.tabelasDeMedidasMercadoLivre as Record<string, unknown> | undefined;
  const parsed = mlSizeChartsForContaSchema.safeParse(map?.[integracaoId] ?? {});
  if (!parsed.success) throw chartConflict();
  return parsed.data.tabelas ?? [];
}

export function operationContext(
  db: Firestore,
  tabMediId: string,
  integracaoId: string,
): OperationContext {
  return {
    db,
    tabMediId,
    integracaoId,
    owner: randomUUID(),
    deadlineMs: Date.now() + CHART_WORKER_MS,
  };
}

export async function acquireOperation(
  ctx: OperationContext,
  id: string,
  chartIndex: number,
  desired: MlSizeChart,
  kind: MlChartOperation['kind'] = 'sync',
): Promise<MlChartOperation> {
  const ref = refs(ctx, id);
  return ctx.db.runTransaction(async (tx) => {
    const parent = await tx.get(ref.parent);
    const controlSnap = await tx.get(ref.control);
    const opSnap = await tx.get(ref.operation);
    if (!parent.exists) throw new TabelaDeMedidasNotFoundError(ctx.tabMediId);
    const control = controlSnap.exists ? mlChartSyncCollection.parse(controlSnap.data()) : null;
    if (control?.activeId && control.activeId !== id) {
      throw new SizeChartOperationError(
        'CHART_BUSY',
        'Há um envio ou uma recuperação pendente nesta conta. Retome a guia anterior antes de enviar outra.',
      );
    }
    let op: MlChartOperation;
    if (opSnap.exists) {
      op = mlChartOperationCollection.parse(opSnap.data());
      if (op.status === 'abandoned') throw chartConflict();
      if (op.kind !== kind || op.chartIndex !== chartIndex || !valuesEqual(op.desired, desired))
        throw chartConflict();
      if (op.owner && op.leaseUntilMs > Date.now()) {
        throw new SizeChartOperationError(
          'CHART_BUSY',
          'Esta guia ainda está sendo enviada. Aguarde antes de tentar novamente.',
        );
      }
    } else {
      op = {
        id,
        kind,
        chartIndex,
        desired,
        projected: desired,
        baseline: null,
        pending: null,
        status: 'pending',
        validationErrors: [],
        updated: false,
        owner: null,
        leaseUntilMs: 0,
      };
    }
    const stored = charts(parent.data(), ctx.integracaoId);
    if (!valuesEqual(stored[chartIndex], op.projected)) throw chartConflict();
    if (op.status === 'completed' || op.status === 'validation' || op.status === 'conflict')
      return op;
    op = { ...op, owner: ctx.owner, leaseUntilMs: Date.now() + CHART_LEASE_MS, status: 'pending' };
    tx.set(ref.operation, mlChartOperationCollection.parse(op));
    tx.set(ref.control, { activeId: id, lastId: id });
    return op;
  });
}

/**
 * Class B/C: owner + entire projected chart are checked against tx.get on every
 * retry. A receipt is durable even when a newer local edit defeats write-back.
 */
export async function checkpointOperation(
  ctx: OperationContext,
  op: MlChartOperation,
  patch: Partial<MlChartOperation>,
  receipt = false,
  release = false,
  remove = false,
): Promise<MlChartOperation> {
  const ref = refs(ctx, op.id);
  return ctx.db.runTransaction(async (tx) => {
    const parent = await tx.get(ref.parent);
    const controlSnap = await tx.get(ref.control);
    const opSnap = await tx.get(ref.operation);
    const fresh = mlChartOperationCollection.parse(opSnap.data());
    const control = mlChartSyncCollection.parse(controlSnap.data());
    if (fresh.owner !== ctx.owner || control.activeId !== op.id) throw chartConflict();
    // A late receipt can be recorded by the owner; it cannot authorize more I/O.
    if (
      !receipt &&
      !release &&
      (Date.now() >= ctx.deadlineMs || fresh.leaseUntilMs <= Date.now())
    ) {
      throw new SizeChartOperationError(
        'CHART_BUSY',
        'O envio atingiu o limite de tempo. Tente novamente para retomar o progresso.',
      );
    }
    const stored = parent.exists ? charts(parent.data(), ctx.integracaoId) : [];
    const unchanged = parent.exists && valuesEqual(stored[fresh.chartIndex], fresh.projected);
    if (!unchanged && !receipt && !release) throw chartConflict();
    const next = { ...fresh, ...patch };
    if (!unchanged && (receipt || next.pending == null)) next.status = 'conflict';
    const terminal =
      release ||
      next.status === 'completed' ||
      next.status === 'validation' ||
      next.status === 'conflict';
    if (terminal) {
      next.owner = null;
      next.leaseUntilMs = 0;
    }
    tx.set(ref.operation, mlChartOperationCollection.parse(next));
    // An unknown POST must keep the reservation across releases/restarts.
    tx.set(ref.control, {
      activeId: terminal && next.pending == null ? null : op.id,
      lastId: op.id,
    });
    if (receipt && unchanged && (remove || !valuesEqual(fresh.projected, next.projected))) {
      const list = remove
        ? stored.filter((_, index) => index !== fresh.chartIndex)
        : stored.map((chart, index) => (index === fresh.chartIndex ? next.projected : chart));
      tx.update(
        ref.parent,
        new FieldPath('tabelasDeMedidasMercadoLivre', ctx.integracaoId, 'tabelas'),
        list,
        'ultimaModificacao',
        Date.now(),
      );
    }
    return next;
  });
}

export async function operationCharts(ctx: OperationContext): Promise<MlSizeChart[]> {
  const snap = await tabelaDeMedidasCollection.docRef(ctx.db, {}, ctx.tabMediId).get();
  if (!snap.exists) throw new TabelaDeMedidasNotFoundError(ctx.tabMediId);
  return charts(snap.data(), ctx.integracaoId);
}

/** Reopening the editor discovers the durable operation ID without client access to receipts. */
export async function currentOperation(
  db: Firestore,
  tabMediId: string,
  integracaoId: string,
): Promise<MlChartOperation | null> {
  const ctx = operationContext(db, tabMediId, integracaoId);
  const control = await mlChartSyncCollection.docRef(db, { tabMediId }, integracaoId).get();
  if (!control.exists) return null;
  const state = mlChartSyncCollection.parse(control.data());
  const snap = await refs(ctx, state.activeId ?? state.lastId).operation.get();
  return snap.exists ? mlChartOperationCollection.parse(snap.data()) : null;
}

/** Recovery owns the reservation but never requires reverting newer draft content. */
export async function acquireRecovery(
  ctx: OperationContext,
  id: string,
): Promise<MlChartOperation> {
  const ref = refs(ctx, id);
  return ctx.db.runTransaction(async (tx) => {
    const control = await tx.get(ref.control);
    const snapshot = await tx.get(ref.operation);
    if (!control.exists || !snapshot.exists) throw chartConflict();
    const state = mlChartSyncCollection.parse(control.data());
    const op = mlChartOperationCollection.parse(snapshot.data());
    if (state.activeId !== id) throw chartConflict();
    if (op.owner && op.leaseUntilMs > Date.now()) {
      throw new SizeChartOperationError(
        'CHART_BUSY',
        'O envio anterior ainda está em andamento. Aguarde antes de recuperar.',
      );
    }
    const owned = { ...op, owner: ctx.owner, leaseUntilMs: Date.now() + CHART_LEASE_MS };
    tx.set(ref.operation, mlChartOperationCollection.parse(owned));
    return owned;
  });
}

/**
 * Recovery's CAS checks the owner, active operation and reviewed current draft
 * inside every retry. The projection callback is pure and can add ONLY provider
 * identity/cache fields; desired name/measurements remain the tx-fresh draft's.
 */
export async function finishRecovery(
  ctx: OperationContext,
  op: MlChartOperation,
  baseline: MlChartOperation['baseline'],
  expected: MlSizeChart | null,
  project?: (current: MlSizeChart) => MlSizeChart,
): Promise<MlSizeChart | null> {
  const ref = refs(ctx, op.id);
  return ctx.db.runTransaction(async (tx) => {
    const control = await tx.get(ref.control);
    const snapshot = await tx.get(ref.operation);
    const parent = await tx.get(ref.parent);
    const state = mlChartSyncCollection.parse(control.data());
    const fresh = mlChartOperationCollection.parse(snapshot.data());
    if (state.activeId !== op.id || fresh.owner !== ctx.owner || fresh.leaseUntilMs <= Date.now())
      throw chartConflict();
    const list = parent.exists ? charts(parent.data(), ctx.integracaoId) : [];
    let current = list[fresh.chartIndex] ?? null;
    if (project != null) {
      if (current == null || expected == null || !valuesEqual(current, expected))
        throw chartConflict();
      current = project(current);
      tx.update(
        ref.parent,
        new FieldPath('tabelasDeMedidasMercadoLivre', ctx.integracaoId, 'tabelas'),
        list.map((chart, index) => (index === fresh.chartIndex ? current : chart)),
        'ultimaModificacao',
        Date.now(),
      );
    }
    tx.set(
      ref.operation,
      mlChartOperationCollection.parse({
        ...fresh,
        baseline,
        pending: null,
        status: 'abandoned',
        owner: null,
        leaseUntilMs: 0,
      }),
    );
    tx.set(ref.control, { activeId: null, lastId: op.id });
    return current;
  });
}
