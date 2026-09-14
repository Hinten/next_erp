/**
 * Melhor Envio webhook processing bound to the shared failures-only
 * notification pipeline (#681).
 */
import { createHash } from 'node:crypto';
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { ESTADO_FRETE, notificationResilienceFields } from '@delfrance/schemas';
import type { EstadoFrete } from '@delfrance/schemas';
import {
  notificacaoMelhorEnvioCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  defineNotificationPipeline,
  MAX_TENTATIVAS,
  type NotificationDisposition,
  type ReprocessOptions,
  type ReprocessResult,
  TASK_MAX_ATTEMPTS,
} from '@delfrance/data/admin/notifications';

/** Deployed task function name and auto-provisioned queue name. */
export const MELHOR_ENVIO_NOTIFICATION_QUEUE = 'processMelhorEnvioNotification';

export { MAX_TENTATIVAS, TASK_MAX_ATTEMPTS };
export type { ReprocessOptions, ReprocessResult };

const meNotificationWireSchema = z
  .object({
    labelId: z.string().nullable().default(null),
    event: z.string().nullable().default(null),
    providerStatus: z.string().nullable().default(null),
    tracking: z.string().nullable().default(null),
  })
  .passthrough();

export type MelhorEnvioNotificationPayload = z.infer<typeof meNotificationWireSchema>;

const KNOWN_WIRE_KEYS = new Set(['labelId', 'event', 'providerStatus', 'tracking']);
const RESILIENCE_KEYS = new Set(Object.keys(notificationResilienceFields()));
const RESERVED_FIELD_NAME = /^__.*__$/;
const REMAINDER_MAX_FIELDS = 32;
const REMAINDER_MAX_FIELD_NAME_CHARS = 128;
const REMAINDER_MAX_VALUE_CHARS = 512;
const REMAINDER_MAX_BYTES = 8 * 1024;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(value: string): string {
  return value.length <= REMAINDER_MAX_VALUE_CHARS
    ? value
    : `${value.slice(0, REMAINDER_MAX_VALUE_CHARS)}…`;
}

function scalarize(value: unknown): string | number | boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return truncate(value);
  try {
    return truncate(JSON.stringify(value) ?? 'null');
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return null;
  }
}

function sanitizeRemainder(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  let budget = REMAINDER_MAX_BYTES;
  let dropped = 0;

  for (const key of Object.keys(input).sort()) {
    if (
      key === '' ||
      key.length > REMAINDER_MAX_FIELD_NAME_CHARS ||
      RESERVED_FIELD_NAME.test(key) ||
      Object.keys(output).length >= REMAINDER_MAX_FIELDS
    ) {
      dropped += 1;
      continue;
    }
    const value = scalarize(input[key]);
    if (value === undefined) continue;
    const cost = key.length + (typeof value === 'string' ? value.length : 8);
    if (cost > budget) {
      dropped += 1;
      continue;
    }
    budget -= cost;
    output[key] = value;
  }

  if (dropped > 0) {
    console.warn('[melhor-envio] notification remainder truncated', {
      dropped,
      kept: Object.keys(output).length,
    });
  }
  return output;
}

/** Normalize both a raw ME body and a stored/replayed flat payload. */
export function normalizeMelhorEnvioNotification(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const data = objectValue(input.data);
  const remainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_WIRE_KEYS.has(key) && !RESILIENCE_KEYS.has(key)) remainder[key] = value;
  }

  return {
    ...sanitizeRemainder(remainder),
    labelId: asString(input.labelId) ?? asString(data?.id),
    event: asString(input.event),
    providerStatus: asString(input.providerStatus) ?? asString(data?.status),
    tracking: asString(input.tracking) ?? asString(data?.tracking),
  };
}

/** Re-normalizes on the task boundary so every producer is held to one gate. */
export const melhorEnvioNotificationTaskSchema = z.preprocess((value) => {
  const input = objectValue(value);
  return input ? normalizeMelhorEnvioNotification(input) : value;
}, meNotificationWireSchema);

/** Null means a JSON value that is not a webhook object. */
export function parseNotificationBody(raw: unknown): MelhorEnvioNotificationPayload | null {
  const input = objectValue(raw);
  if (!input) return null;
  const parsed = melhorEnvioNotificationTaskSchema.safeParse(input);
  if (!parsed.success) return null;
  const { labelId, event, providerStatus, tracking } = parsed.data;
  return labelId || event || providerStatus || tracking ? parsed.data : null;
}

function notificationKey(payload: MelhorEnvioNotificationPayload): string {
  return JSON.stringify([payload.labelId, payload.event, payload.providerStatus, payload.tracking]);
}

/** Safe, deterministic failure-row id; provider values never become a path. */
export function notificationDocId(payload: MelhorEnvioNotificationPayload): string {
  return `me-${createHash('sha256').update(notificationKey(payload)).digest('hex')}`;
}

/** ME order status → the legacy `EstadoFrete` mapping. */
export function meStatusToEstadoFrete(status: string | null | undefined): EstadoFrete | null {
  switch (status) {
    case 'delivered':
      return ESTADO_FRETE.entregue;
    case 'released':
      return null;
    case 'posted':
    case 'received':
      return ESTADO_FRETE.postado;
    case 'canceled':
    case 'cancelled':
      return ESTADO_FRETE.cancelado;
    case 'suspended':
    case 'paused':
      return ESTADO_FRETE.suspenso;
    case 'undelivered':
      return ESTADO_FRETE.falhaNaEntrega;
    case null:
    case undefined:
    default:
      return null;
  }
}

const TERMINAL_ESTADOS: ReadonlySet<EstadoFrete> = new Set([
  ESTADO_FRETE.entregue,
  ESTADO_FRETE.cancelado,
]);

export interface PedidoMatch {
  id: string;
  data: unknown;
  updateTime: Timestamp;
}

export interface MelhorEnvioProcessDeps {
  findPedidoByLabel(db: Firestore, labelId: string): Promise<PedidoMatch | null>;
  updatePedido(db: Firestore, pedido: PedidoMatch, patch: Record<string, unknown>): Promise<void>;
}

const defaultProcessDeps: MelhorEnvioProcessDeps = {
  async findPedidoByLabel(db, labelId) {
    const snap = await pedidoCollection
      .ref(db, {})
      .where('freteInicial.printLabelId', '==', labelId)
      .limit(1)
      .get();
    const doc = snap.docs[0];
    return doc ? { id: doc.id, data: doc.data(), updateTime: doc.updateTime } : null;
  },
  async updatePedido(db, pedido, patch) {
    await pedidoCollection.docRef(db, {}, pedido.id).update(patch, {
      lastUpdateTime: pedido.updateTime,
    });
  },
};

export type MelhorEnvioProcessDetail =
  | 'estado-e-rastreio-atualizados'
  | 'estado-atualizado'
  | 'rastreio-atualizado'
  | 'sem-alteracao'
  | 'estado-terminal'
  | 'released'
  | 'label-ausente'
  | 'label-desconhecida'
  | 'status-nao-mapeado';

export type MelhorEnvioProcessOutcome =
  | {
      kind: 'applied';
      detail: Extract<
        MelhorEnvioProcessDetail,
        'estado-e-rastreio-atualizados' | 'estado-atualizado' | 'rastreio-atualizado'
      >;
      pedidoId: string;
      estado: string | null;
    }
  | {
      kind: 'noop';
      detail: Extract<MelhorEnvioProcessDetail, 'sem-alteracao' | 'estado-terminal' | 'released'>;
      pedidoId?: string;
      estado?: string | null;
    }
  | {
      kind: 'dropped';
      detail: Extract<
        MelhorEnvioProcessDetail,
        'label-ausente' | 'label-desconhecida' | 'status-nao-mapeado'
      >;
      reason: string;
    };

function readFrete(data: unknown): { estado: string | null; codRastreio: string | null } {
  const root = objectValue(data);
  const frete = objectValue(root?.freteInicial);
  return {
    estado: asString(frete?.estado),
    codRastreio: asString(frete?.codRastreio),
  };
}

function effectiveProviderStatus(payload: MelhorEnvioNotificationPayload): string | null {
  return payload.providerStatus ?? payload.event?.replace(/^order\./, '') ?? null;
}

/** Deterministic channel processing. Infrastructure failures throw. */
export async function processMelhorEnvioNotification(
  db: Firestore,
  payload: MelhorEnvioNotificationPayload,
  deps: MelhorEnvioProcessDeps = defaultProcessDeps,
): Promise<MelhorEnvioProcessOutcome> {
  if (!payload.labelId) {
    return { kind: 'dropped', detail: 'label-ausente', reason: 'labelId ausente' };
  }

  const providerStatus = effectiveProviderStatus(payload);
  if (providerStatus === 'released') {
    return { kind: 'noop', detail: 'released' };
  }
  const target = meStatusToEstadoFrete(providerStatus);
  if (!target) {
    return {
      kind: 'dropped',
      detail: 'status-nao-mapeado',
      reason: `status do Melhor Envio não mapeado: ${providerStatus ?? '(ausente)'}`,
    };
  }

  const pedido = await deps.findPedidoByLabel(db, payload.labelId);
  if (!pedido) {
    return {
      kind: 'dropped',
      detail: 'label-desconhecida',
      reason: `nenhum pedido encontrado para a etiqueta ${payload.labelId}`,
    };
  }

  const frete = readFrete(pedido.data);
  const isTerminal = frete.estado != null && TERMINAL_ESTADOS.has(frete.estado as EstadoFrete);
  const patch: Record<string, unknown> = {};
  if (!isTerminal && frete.estado !== target) patch['freteInicial.estado'] = target;
  if (payload.tracking != null && frete.codRastreio !== payload.tracking) {
    patch['freteInicial.codRastreio'] = payload.tracking;
  }

  if (Object.keys(patch).length === 0) {
    return {
      kind: 'noop',
      detail: isTerminal ? 'estado-terminal' : 'sem-alteracao',
      pedidoId: pedido.id,
      estado: frete.estado,
    };
  }

  await deps.updatePedido(db, pedido, patch);
  const changedEstado = 'freteInicial.estado' in patch;
  const changedTracking = 'freteInicial.codRastreio' in patch;
  const detail = changedEstado
    ? changedTracking
      ? 'estado-e-rastreio-atualizados'
      : 'estado-atualizado'
    : 'rastreio-atualizado';
  return {
    kind: 'applied',
    detail,
    pedidoId: pedido.id,
    estado: changedEstado ? target : frete.estado,
  };
}

export interface MelhorEnvioTaskResult {
  outcome: 'done' | 'failed' | 'dropped';
  labelId?: string;
  pedidoId?: string;
  estado?: string | null;
  kind?: MelhorEnvioProcessOutcome['kind'];
  detail?: MelhorEnvioProcessDetail;
}

function pipelineFor(deps: MelhorEnvioProcessDeps) {
  return defineNotificationPipeline<MelhorEnvioNotificationPayload, MelhorEnvioProcessOutcome>({
    channel: 'melhor-envio',
    collection: notificacaoMelhorEnvioCollection,
    taskSchema: melhorEnvioNotificationTaskSchema,
    docIdOf: notificationDocId,
    dedupKeyOf: notificationKey,
    toDocFields: (payload) => normalizeMelhorEnvioNotification(payload),
    fromDoc: (parsed, raw) => {
      const source = objectValue(parsed) ?? raw;
      const result = melhorEnvioNotificationTaskSchema.safeParse(source);
      if (!result.success) {
        throw new Error('Notificação Melhor Envio corrompida: campos inválidos');
      }
      return result.data;
    },
    process: (db, payload) => processMelhorEnvioNotification(db, payload, deps),
    toDisposition: (outcome): NotificationDisposition => {
      if (outcome.kind === 'dropped') {
        return { kind: 'drop', reason: outcome.reason, label: outcome.detail };
      }
      return { kind: 'resolve', label: outcome.detail };
    },
  });
}

const basePipeline = pipelineFor(defaultProcessDeps);

export function persistNotificationFailure(
  db: Firestore,
  payload: MelhorEnvioNotificationPayload,
  erro: string,
): Promise<void> {
  return basePipeline.persistFailure(db, payload, erro);
}

export async function handleNotificationTask(
  db: Firestore,
  data: unknown,
  retryCount: number,
  deps: MelhorEnvioProcessDeps = defaultProcessDeps,
): Promise<MelhorEnvioTaskResult> {
  const result = await pipelineFor(deps).handleTask(db, data, retryCount);
  const pedidoId = result.result && 'pedidoId' in result.result ? result.result.pedidoId : null;
  const estado = result.result && 'estado' in result.result ? result.result.estado : null;
  return {
    outcome:
      result.outcome === 'parked' || result.outcome === 'deferred' ? 'failed' : result.outcome,
    ...(result.payload?.labelId ? { labelId: result.payload.labelId } : {}),
    ...(pedidoId != null ? { pedidoId } : {}),
    ...(estado != null ? { estado } : {}),
    ...(result.result ? { kind: result.result.kind, detail: result.result.detail } : {}),
  };
}

export function reprocessNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  deps: MelhorEnvioProcessDeps = defaultProcessDeps,
): Promise<ReprocessResult> {
  return pipelineFor(deps).reprocess(db, opts);
}
