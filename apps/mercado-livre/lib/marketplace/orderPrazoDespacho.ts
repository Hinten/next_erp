/**
 * Computes the Mercado Livre dispatch deadline ("prazo de despacho") for a
 * shipment during order import (Step 9).
 *
 * Ports `_getPrazoDespacho`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:38-139`).
 * Quoted decision tree:
 *
 * ```dart
 * Future<DateTime?> _getPrazoDespacho(MercadoLivreApi api, MercadoLivreShipping shippment, [DateTime? oldPrazoDespacho]) async {
 *   try {
 *     final sla = await api.get_shipment_sla(shippment.id);
 *     return DateTime.parse(sla['expected_date']);
 *   } catch (e){
 *     print('não foi possível obter o sla');
 *     print(e);
 *   }
 *   if (oldPrazoDespacho != null){
 *     return oldPrazoDespacho;
 *   }
 *   final prazoDespacho = shippment.shipping_option.estimated_handling_limit?.date;
 *   if (prazoDespacho == null){
 *     return null;
 *   }
 *   final horario_despacho = await api.get_horarios_despacho(LOGISTIC_TYPE.fromValue(shippment.logistic_type));
 *   // ... schedule search, see below
 * }
 * ```
 *
 * 1. `GET /shipments/{id}/sla` → `expected_date`. Authoritative; short-
 *    circuits everything below. ANY failure of this step — an HTTP error, a
 *    reauth failure, a network error, OR the field being missing/unparseable
 *    (in Dart, `DateTime.parse` on a null/garbage value THROWS *inside the
 *    same `try`*, so it is swallowed exactly like a network failure) — falls
 *    through to step 2. Legacy's bare `catch (e) { print(...) }` tolerates
 *    every one of these; we narrow to `MercadoLivreError` (the base class
 *    every error this package raises extends — HTTP/reauth/network/
 *    validation), which is the same universe, and rethrow anything else
 *    (repo "no generic catch" rule).
 * 2. The caller-supplied previous value (`oldPrazoDespacho` / `fallbackUs`),
 *    when present, wins over any schedule computation.
 * 3. Otherwise, derive a deadline from
 *    `shipping_option.estimated_handling_limit.date` (`prazoDespacho`) plus
 *    the seller's weekly dispatch window
 *    (`GET /users/{sellerId}/shipping/schedule/{logisticType}`,
 *    `LOGISTIC_TYPE.fromValue(shipment.logistic_type)` validates the
 *    logistic type first and THROWS `Exception('Invalid Value $value')` —
 *    uncaught — on an unrecognized/missing one; api.dart:43-66):
 *      - `estimated_handling_limit.date` missing → null (nothing to compute
 *        from).
 *      - else: if the current UTC weekday's schedule entry has
 *        `work === false`, skip straight to the forward search
 *        (`getNextDay`); otherwise compute `parseDespacho` for the current
 *        day's cutoff and return it only if it is strictly AFTER
 *        `prazoDespacho` — else ALSO fall to the forward search.
 *      - the forward search (`getNextDay`, tasks.dart:103-127) requires
 *        `work === true` exactly (⚠️ NOT `!== false` like the current-day
 *        check above — a day with no `work` field at all counts as
 *        "not working" INSIDE the search but "working" for the CURRENT
 *        day's initial check; this asymmetry is a faithfully-ported legacy
 *        quirk, not a bug fix) and gives up after 14 forward steps
 *        (`Exception('Não foi possível encontrar um dia de despacho válido')`).
 * 4. A schedule-endpoint failure, or the forward search's 14-step exhaustion,
 *    is NOT caught anywhere in `_getPrazoDespacho` (only the SLA fetch is
 *    wrapped in a try) — both propagate to the caller unchanged.
 *
 * `parseDespacho` (tasks.dart:72-101) quirk ported faithfully: it reads the
 * buyer/seller timezone offset off `estimated_delivery_limit.date`'s RAW
 * STRING (last 6 chars, e.g. `"-03:00"`), NOT off `estimated_handling_limit`
 * — there is a commented-out line in the legacy source
 * (`// final handlingString = shippingData['shipping_option']['estimated_handling_limit']['date'];`)
 * showing that was the original intent, but the ACTUAL code reads
 * `estimated_delivery_limit`. This is because in the Dart models
 * `estimated_handling_limit.date` deserializes straight to a `DateTime` (no
 * raw string left to slice) while `estimated_delivery_limit.date` stays a
 * `String` (`models.dart:6253-6272` vs `6275-6291`). Our plugin's Zod types
 * don't carry that asymmetry — both are plain strings — so we replicate the
 * STRING SOURCE legacy actually reads from (`estimated_delivery_limit`), not
 * the intended-but-dead one.
 *
 * The `!prazoDespacho.isUtc` branch (tasks.dart:81-84) is NOT ported: ML's
 * `estimated_handling_limit.date` always carries an explicit numeric UTC
 * offset (e.g. `"2022-08-22T00:00:00.000-03:00"`), so Dart's `DateTime.parse`
 * always yields a UTC-flagged instant for it — that branch is unreachable
 * dead code given the API's actual date format, not an approved behavioral
 * deviation.
 *
 * `getNextDay` (tasks.dart:103-127) quirk ported faithfully: `parseDespacho`
 * is called there WITHOUT an `offset` argument (defaults to 0), so even
 * though the forward search advances to a LATER weekday's schedule entry to
 * borrow its cutoff TIME, the resulting deadline's DATE stays
 * `prazoDespacho`'s original calendar day. Looks like a bug, but this is a
 * faithful port, not a fix.
 *
 * Pure computation aside from the two API calls — no Firestore, no
 * `Date.now()`. Returns microseconds since epoch (µs precision at ms
 * resolution, matching `@delfrance/core/datetime`'s `nowMicros()`
 * convention) or `null` when nothing can be computed.
 */
import {
  MercadoLivreError,
  shipmentLeadTime,
  shipmentLogisticType,
  type MercadoLivreApi,
  type MlSellerShippingSchedule,
  type MlShipment,
} from '@delfrance/integrations-mercado-livre';
import { coerceToMicros } from '@delfrance/core/datetime';

/**
 * `LOGISTIC_TYPE` (legacy `api.dart:43-48`) — the four values ML accepts for
 * the seller shipping-schedule endpoint.
 */
const KNOWN_LOGISTIC_TYPES = new Set(['drop_off', 'xd_drop_off', 'self_service', 'cross_docking']);

/**
 * `LOGISTIC_TYPE.fromValue` throwing `Exception('Invalid Value $value')`
 * (`api.dart:52-66`) — named here per repo convention instead of a raw
 * `Exception`.
 */
export class MlLogisticTypeInvalidoError extends Error {
  constructor(readonly value: string | null) {
    super(`Tipo logístico do Mercado Livre desconhecido: "${value ?? 'null'}"`);
    this.name = 'MlLogisticTypeInvalidoError';
  }
}

/**
 * Legacy's `handlingString!` null-check-operator throw (`tasks.dart:88`), a
 * malformed timezone-offset/cutoff substring, or a schedule day missing its
 * `detail[0].cutoff` — all data-integrity failures the source lets crash
 * uncaught (a raw `TypeError`/`FormatException`); named here instead.
 */
export class MlPrazoDespachoDataIncompleteError extends Error {
  constructor(shipmentId: number, reason: string) {
    super(`Não foi possível calcular o prazo de despacho do shipment ${shipmentId}: ${reason}`);
    this.name = 'MlPrazoDespachoDataIncompleteError';
  }
}

/** `Exception('Não foi possível encontrar um dia de despacho válido')` (`tasks.dart:123`). */
export class MlPrazoDespachoNotFoundError extends Error {
  constructor(shipmentId: number) {
    super(`Não foi possível encontrar um dia de despacho válido para o shipment ${shipmentId}`);
    this.name = 'MlPrazoDespachoNotFoundError';
  }
}

/** `days_of_week` (`tasks.dart:61-69`) ordered by Dart's `DateTime.weekday` (1=Monday..7=Sunday). */
const WEEKDAY_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

/** `prazoDespacho.weekday` read off the UTC calendar date of the instant (see file docstring — always UTC in practice). */
function dartWeekdayIndex(ms: number): number {
  const jsDay = new Date(ms).getUTCDay(); // 0=Sun..6=Sat
  return jsDay === 0 ? 7 : jsDay; // Dart DateTime.weekday: 1=Mon..7=Sun
}

interface ScheduleContext {
  readonly shipmentId: number;
  readonly prazoDespachoMs: number;
  readonly estimatedDeliveryLimitDate: string | null;
}

/**
 * `parseDespacho` (`tasks.dart:72-101`) — only the reachable (`isUtc == true`)
 * branch; see file docstring. `offsetDays` mirrors the Dart `{int offset = 0}`
 * named parameter.
 */
function parseDespacho(ctx: ScheduleContext, cutoff: string, offsetDays = 0): number {
  const anchor = new Date(ctx.prazoDespachoMs);
  const baseMs = Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate() + offsetDays,
  );

  if (ctx.estimatedDeliveryLimitDate == null) {
    throw new MlPrazoDespachoDataIncompleteError(
      ctx.shipmentId,
      'shipping_option.estimated_delivery_limit ausente (necessário para o offset de fuso horário)',
    );
  }
  const tzSuffix = ctx.estimatedDeliveryLimitDate.slice(-6);
  const [tzHoursRaw, tzMinutesRaw] = tzSuffix.split(':');
  const tzHours = parseInt((tzHoursRaw ?? '').trim(), 10);
  const tzMinutes = parseInt((tzMinutesRaw ?? '').trim(), 10);
  if (!Number.isFinite(tzHours) || !Number.isFinite(tzMinutes)) {
    throw new MlPrazoDespachoDataIncompleteError(
      ctx.shipmentId,
      `offset de fuso horário inválido: "${tzSuffix}"`,
    );
  }
  // The sign applies to the WHOLE offset, not just the hour component — for a
  // "-03:30" offset the minutes are also negative (-3.5h, not -3h + 30min).
  // Taken from the string ('-00:30' parses to hours -0, which `< 0` misses).
  const tzSign = tzSuffix.trim().startsWith('-') ? -1 : 1;
  const handlingOffsetMs = tzSign * (Math.abs(tzHours) * 3_600_000 + tzMinutes * 60_000);
  const localMidnightMs = baseMs - handlingOffsetMs;

  const [cutoffHoursRaw, cutoffMinutesRaw] = cutoff.split(':');
  const cutoffHours = parseInt((cutoffHoursRaw ?? '').trim(), 10);
  const cutoffMinutes = parseInt((cutoffMinutesRaw ?? '').trim(), 10);
  if (!Number.isFinite(cutoffHours) || !Number.isFinite(cutoffMinutes)) {
    throw new MlPrazoDespachoDataIncompleteError(ctx.shipmentId, `cutoff inválido: "${cutoff}"`);
  }

  return localMidnightMs + cutoffHours * 3_600_000 + cutoffMinutes * 60_000;
}

/** `getNextDay` (`tasks.dart:103-127`) — see file docstring for the `work === true` / no-offset quirks. */
function getNextWorkingDayDeadline(
  ctx: ScheduleContext,
  currentDayIndex: number,
  schedule: MlSellerShippingSchedule,
): number {
  let nextDayIndex = currentDayIndex + 1;
  if (nextDayIndex > 7) nextDayIndex = 1;
  let iterations = 0;
  for (;;) {
    const dayName = WEEKDAY_ORDER[nextDayIndex - 1]!;
    const day = schedule.schedule?.[dayName];
    if (day?.work === true) {
      const cutoff = day.detail?.[0]?.cutoff;
      if (cutoff == null) {
        throw new MlPrazoDespachoDataIncompleteError(
          ctx.shipmentId,
          `dia de despacho "${dayName}" sem detail[0].cutoff`,
        );
      }
      return parseDespacho(ctx, cutoff); // offset defaults to 0 — legacy quirk, see file docstring
    }
    nextDayIndex += 1;
    if (nextDayIndex > 7) nextDayIndex = 1;
    iterations += 1;
    if (iterations > 14) {
      throw new MlPrazoDespachoNotFoundError(ctx.shipmentId);
    }
  }
}

/** Main body of `_getPrazoDespacho` past the SLA short-circuit (`tasks.dart:60-138`). */
function computeDeadlineFromSchedule(
  ctx: ScheduleContext,
  schedule: MlSellerShippingSchedule,
): number {
  const currentDayIndex = dartWeekdayIndex(ctx.prazoDespachoMs);
  const currentDayName = WEEKDAY_ORDER[currentDayIndex - 1]!;
  const currentDay = schedule.schedule?.[currentDayName];

  // ⚠️ `== false` (not `!== true`): a day with no `work` field at all is
  // treated as WORKING here (falls through to the cutoff read below), unlike
  // `getNextWorkingDayDeadline`'s `=== true` check. Faithful legacy asymmetry.
  if (currentDay?.work === false) {
    return getNextWorkingDayDeadline(ctx, currentDayIndex, schedule);
  }

  const cutoff = currentDay?.detail?.[0]?.cutoff;
  if (cutoff == null) {
    throw new MlPrazoDespachoDataIncompleteError(
      ctx.shipmentId,
      `dia de despacho "${currentDayName}" sem detail[0].cutoff`,
    );
  }
  const horarioDespachoMs = parseDespacho(ctx, cutoff);
  if (horarioDespachoMs > ctx.prazoDespachoMs) {
    return horarioDespachoMs;
  }
  return getNextWorkingDayDeadline(ctx, currentDayIndex, schedule);
}

export interface ResolvePrazoDespachoArgs {
  api: MercadoLivreApi;
  shipment: MlShipment;
  /** The account's OWN seller id — `await seller_id` in legacy (`api.dart:1690`), not the buyer's. */
  sellerId: number;
  /** The previously-stored `freteInicial.prazoDespacho` (µs), if any — `oldPrazoDespacho` in legacy. */
  fallbackUs: number | null;
}

/**
 * Resolves the dispatch deadline for a shipment. See the file docstring for
 * the full ported decision tree. Returns µs since epoch, or `null` when
 * nothing can be computed (no SLA, no fallback, no
 * `estimated_handling_limit.date`).
 */
export async function resolvePrazoDespacho(args: ResolvePrazoDespachoArgs): Promise<number | null> {
  const { api, shipment, sellerId, fallbackUs } = args;

  try {
    const sla = await api.getShipmentSla(shipment.id);
    const expectedUs = coerceToMicros(sla.expected_date ?? null);
    if (expectedUs != null) return expectedUs;
    // expected_date missing/unparseable — legacy's `DateTime.parse(...)`
    // throws inside this same try, so it is swallowed exactly like a network
    // failure and falls through below.
  } catch (err) {
    if (!(err instanceof MercadoLivreError)) throw err;
    // legacy: bare `catch (e) { print(...) }` — every failure this package
    // can raise (HTTP/reauth/network/response-validation) is tolerated here.
  }

  if (fallbackUs != null) return fallbackUs;

  // `estimated_handling_limit` was DEPRECATED by ML on 2025-05-13 — "a informação
  // só poderá ser consumida no recurso de SLA" — and the `x-format-new` body does
  // not document it at all (#957). The SLA read above is now the real source;
  // everything below is the legacy path, kept only for as long as ML still fills
  // the field, and reached only when SLA gave nothing AND there is no stored
  // fallback. Read off the lead-time block via passthrough since the schema no
  // longer types a field ML says it has stopped sending.
  const leadTime = shipmentLeadTime(shipment) as {
    estimated_handling_limit?: { date?: string | null } | null;
  } | null;
  const prazoDespachoStr = leadTime?.estimated_handling_limit?.date ?? null;
  if (prazoDespachoStr == null) return null;

  const prazoDespachoMs = Date.parse(prazoDespachoStr);
  // Defensive beyond legacy fidelity: Dart's field is pre-parsed at JSON
  // deserialization (an unparseable value would have thrown much earlier,
  // outside this function); our Zod type defers parsing to here, so a
  // malformed string is handled as "cannot compute" rather than crashing.
  if (Number.isNaN(prazoDespachoMs)) return null;

  const logisticType = shipmentLogisticType(shipment);
  if (logisticType == null || !KNOWN_LOGISTIC_TYPES.has(logisticType)) {
    throw new MlLogisticTypeInvalidoError(logisticType);
  }

  // Not wrapped in a try/catch — legacy does not catch a `get_horarios_despacho`
  // failure either; it propagates to the caller unchanged.
  const schedule = await api.getSellerShippingSchedule(sellerId, logisticType);

  const ctx: ScheduleContext = {
    shipmentId: shipment.id,
    prazoDespachoMs,
    estimatedDeliveryLimitDate: shipmentLeadTime(shipment)?.estimated_delivery_limit?.date ?? null,
  };
  const deadlineMs = computeDeadlineFromSchedule(ctx, schedule);
  return deadlineMs * 1000; // ms -> µs
}
