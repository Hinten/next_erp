import { z } from 'zod';

/**
 * Firestore TTL policies — the ONE place in this repo where a document stores a
 * real Firestore `Timestamp` instead of a numeric epoch.
 *
 * A TTL policy deletes a document once a designated field holds a timestamp in
 * the past. Three properties of the mechanism shape everything here:
 *
 *  1. **The field must be a `Timestamp`** (a JS `Date` on write — the SDK
 *     stores it as one). A number is IGNORED, silently: the document simply
 *     never expires. That is why the field cannot be `millisSinceEpoch()` /
 *     `microsSinceEpoch()` — both COERCE a `Date` into an int on write, which
 *     would turn every stamp into a no-op nobody notices.
 *  2. **Only documents that carry the field expire**, and a collection GROUP
 *     has at most one TTL field. So the writer decides per document — a row it
 *     must keep simply gets no stamp — and a group shared by several parents
 *     (`relatorios`, `mensagens`, `historicoDeModificacoes`) is safe as long as
 *     the other parents' writers never stamp.
 *  3. **The policy lives in `firestore.indexes.json`** (`fieldOverrides`,
 *     `"ttl": true`) and deploys with `firebase deploy --only firestore:indexes`
 *     — verified on the Enterprise database in PR #1639. `TTL_POLICIES` below
 *     is the registry that file must match; `ttl.policies.test.ts` enforces it.
 *
 * ⚠️ Never key a policy on an EXISTING date field: `chat/*\/mensagem.createdAt`
 * is a legacy `Timestamp`, and a policy on it would wipe the imported chat
 * history on arrival. Always a new `expiraEm`, stamped deliberately.
 */

/** The field every TTL policy in this repo keys on. */
export const TTL_FIELD = 'expiraEm';

const DIA_MS = 86_400_000;

/** Produto `historicoDeModificacoes` rows (#651). Price/cost and delete rows are kept. */
export const RETENCAO_HISTORICO_PRODUTO_DIAS = 365;

/**
 * Pedido `historicoDeModificacoes` rows, in CALENDAR years (`expiraEmAposAnos`),
 * never days. Six, not five: the tax clock (CTN art. 173, I) starts on January 1
 * of the year AFTER the event, so the five-year period closes at the start of
 * year+6 — up to six years after the row was written. Delete rows are kept: they
 * are the only record that a deleted pedido existed.
 *
 * ⚠️ Why not 2190 days: every six-year window holds one or two leap days, so
 * 6 × 365 lands up to two days SHORT — a row written on the first day of a year
 * would expire before the period it exists to cover had closed. Six calendar
 * years covers every case: an event inside Brazilian year Y happens no earlier
 * than Jan 1 of Y 00:00 BRT, so six UTC calendar years later is no earlier than
 * Jan 1 of Y+6 00:00 BRT — the instant the period closes (Brazil has had no DST
 * since 2019, so BRT is a fixed UTC-3). `historyRetention.test.ts` checks it
 * against that oracle at the boundary.
 */
export const RETENCAO_HISTORICO_PEDIDO_ANOS = 6;

/** Mercado Livre price-send runs (`enviosPrecoMercadoLivre`). Their report shards get a week more. */
export const RETENCAO_ENVIO_PRECO_ML_DIAS = 180;

/** Processed `whatsappVinculos/*\/mensagens` — redundant copies already replayed into the chat. */
export const RETENCAO_VINCULO_WHATSAPP_DIAS = 30;

/** A Firestore `Timestamp` of either SDK (admin or web), recognised by shape. */
export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis: () => number;
}

function isTimestampLike(value: unknown): value is TimestampLike {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<TimestampLike>;
  return (
    typeof v.toMillis === 'function' &&
    typeof v.seconds === 'number' &&
    typeof v.nanoseconds === 'number'
  );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * The TTL field's schema: a `Date` (what a writer stamps) or a `Timestamp`
 * (what a read returns — duck-typed, because the admin and web SDKs ship
 * different classes and `packages/schemas` depends on neither). Returned
 * UNCHANGED — no coercion in either direction, which is the whole point (see
 * the module note). Chain `.nullable().optional()`: server-stamped, and absent
 * on every row that must never expire.
 */
export function ttlExpiry() {
  return z.custom<Date | TimestampLike>((value) => isValidDate(value) || isTimestampLike(value), {
    message: 'expected a Date or a Firestore Timestamp (a TTL ignores a numeric epoch)',
  });
}

/**
 * The expiry `dias` days after `agoraMs` (milliseconds since epoch). Pure — the
 * caller passes the clock, so a replayed event stamps the same instant.
 */
export function expiraEmApos(agoraMs: number, dias: number): Date {
  if (!Number.isFinite(agoraMs) || !Number.isInteger(dias) || dias <= 0) {
    throw new RangeError(`expiraEmApos: invalid input (agoraMs=${agoraMs}, dias=${dias})`);
  }
  return new Date(agoraMs + dias * DIA_MS);
}

/**
 * The expiry `anos` CALENDAR years after `agoraMs`, on the UTC calendar — the
 * same month, day and time of day. For a retention defined by a legal period in
 * years, where `expiraEmApos(ms, 365 * n)` drifts short by the leap days. A
 * Feb 29 start lands on Mar 1 of a non-leap target year: later, never earlier.
 */
export function expiraEmAposAnos(agoraMs: number, anos: number): Date {
  if (!Number.isFinite(agoraMs) || !Number.isInteger(anos) || anos <= 0) {
    throw new RangeError(`expiraEmAposAnos: invalid input (agoraMs=${agoraMs}, anos=${anos})`);
  }
  const d = new Date(agoraMs);
  return new Date(
    Date.UTC(
      d.getUTCFullYear() + anos,
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
}

/**
 * Has a stored TTL expiry passed? `false` when there is none (a row that never
 * expires). For a reader that must not offer a document the TTL has already
 * condemned: deletion trails the expiry by an UNBOUNDED lag (Firestore:
 * "typically within 24 hours"), so "still readable" never means "still valid".
 */
export function ttlExpirado(
  valor: Date | TimestampLike | null | undefined,
  agoraMs: number,
): boolean {
  if (valor == null) return false;
  const ms = valor instanceof Date ? valor.getTime() : valor.toMillis();
  return ms <= agoraMs;
}

export interface TtlPolicy {
  /** The collection GROUP id, as `firestore.indexes.json` names it. */
  collectionGroup: string;
  /** Who stamps the field, and which documents are deliberately never stamped. */
  motivo: string;
}

/**
 * Every TTL policy the repo declares. `firestore.indexes.json` must hold exactly
 * one `{ collectionGroup, fieldPath: TTL_FIELD, ttl: true, indexes: [] }`
 * override per row — `ttl.policies.test.ts`.
 */
export const TTL_POLICIES: readonly TtlPolicy[] = [
  {
    collectionGroup: 'historicoDeModificacoes',
    motivo:
      'apps/functions modification-history trigger: produto rows 365 days, pedido rows 6 calendar years; ' +
      'delete rows and produto rows touching precos/custo are never stamped (#651, #648).',
  },
  {
    collectionGroup: 'enviosPrecoMercadoLivre',
    motivo: 'apps/mercado-livre precoSync: each price-send run, 180 days after it starts.',
  },
  {
    collectionGroup: 'relatorios',
    motivo:
      'apps/mercado-livre precoSync: the run report shards, 187 days (a week past their run). ' +
      'balanco/*/relatorios shares the group and is never stamped.',
  },
  {
    collectionGroup: 'mensagens',
    motivo:
      'apps/whatsapp vinculo replay: a message 30 days after it is processed. Unprocessed ' +
      'messages and whatsappConversaAliases/*/mensagens are never stamped.',
  },
];
