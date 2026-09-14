/**
 * The daily Shopee **push-health** monitor (master plan step 4, #1512).
 *
 * `get_app_push_config.live_push_status` is the only API surface on Shopee's
 * warning/auto-disable ladder — >600 pushes in 6 h with <70 % success ⇒
 * `Warning`; the same volume with <30 % ⇒ the subscription is **disabled**.
 * There is no API for the success rate itself (Console only), and a suspension
 * loses everything not already in the 3-day queue: `guide 18` says the
 * notifications missed while the subscription was disabled are never re-sent,
 * so the lost-push sweep does NOT cover it. That is why the suspended row is
 * `critico` and why this runs every day.
 *
 * ## ⚠️ It never writes to Shopee
 *
 * `set_app_push_config` is not implemented in `@delfrance/integrations-shopee`
 * at all, and that absence IS the enforcement: the operation takes one app-wide
 * `callback_url`, fires a live test push, has undocumented partial-body
 * semantics and its own code enum stops at 13 while live codes reach 47 — a
 * read-modify-write would silently unsubscribe everything above 13. Registering
 * the URL and recovering from a suspension are human Console steps (`faq 446`).
 *
 * ## ⚠️ The status fold is trim + lowercase, and the match is EXACT after it
 *
 * The page contradicts itself on casing (description `Normal/Warning/Suspended`,
 * its own sample `"suspended"`), so the comparison folds the case — and stops
 * there. Never `startsWith`, never `includes`: `'normalizado'` starts with
 * `'normal'` and reading it as healthy would RESOLVE a standing critical aviso
 * on a value nobody verified.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ShopeePartnerClient } from '@delfrance/integrations-shopee';

import {
  avisarPushDegradado,
  avisarPushSuspenso,
  resolverAvisosDePush,
  resolverPushSuspenso,
} from '../avisos/pushSaude';
import { shopeePushCallbackUrl } from '../env';

/**
 * The push codes this channel depends on: 1 / 2 (the conta arms), 3 (order
 * status — the ERP's whole order intake) and 12 (the authorization-expiry
 * warning).
 *
 * ⚠️ Checked against `push_config_off_list` ONLY — explicit presence there is
 * evidence, an absence from it is not. The documented config enum stops at 13
 * while live push codes reach 47, so a code in NEITHER list is undetermined and
 * an empty `off_list` proves nothing about what is ON.
 */
export const CODIGOS_ESPERADOS = [1, 2, 3, 12] as const;

/** The folded reading of `live_push_status`. */
export type SaudePush = 'normal' | 'warning' | 'suspended' | 'desconhecido';

export interface PushConfigMonitorLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface PushConfigMonitorDeps {
  /** Public-signed client. The ONE provider call is `get_app_push_config`. */
  readonly partnerClient: ShopeePartnerClient;
  /** `(by) => FieldValue.increment(by)` — see `avisos/autorizacao.ts`. */
  readonly increment: (by: number) => unknown;
  /** Now, in MILLISECONDS. */
  readonly nowMs: number;
  readonly logger?: PushConfigMonitorLogger;
}

export interface PushConfigMonitorResult {
  readonly status: SaudePush;
  /** Shopee's string VERBATIM — the only record of a value we do not know. */
  readonly statusBruto: string | null;
  readonly avisados: number;
  /** Rows actually CLOSED — a transition, never "we asked about two rows". */
  readonly resolvidos: number;
  readonly resultados: Record<'criado' | 'repetido' | 'reaberto' | 'ignorado', number>;
  readonly callbackDivergente: boolean;
  /** The intersection of `push_config_off_list` with {@link CODIGOS_ESPERADOS}. */
  readonly codigosDesligados: readonly number[];
  readonly lojasBloqueadas: number;
}

/** See the module header: trim + lowercase, then an EXACT switch. */
function normalizarStatus(raw: string | null): SaudePush {
  // An absent status folds to `''`, which no case claims — the same
  // `desconhecido` an unknown string gets, and it keeps the switched value a
  // plain `string` for the exhaustiveness rule.
  switch (raw == null ? '' : raw.trim().toLowerCase()) {
    case 'normal':
      return 'normal';
    case 'warning':
      return 'warning';
    case 'suspended':
      return 'suspended';
    default:
      return 'desconhecido';
  }
}

function loggerDe(deps: PushConfigMonitorDeps): PushConfigMonitorLogger {
  return (
    deps.logger ?? {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

/**
 * Read the app-wide push configuration and keep the two push avisos in step with
 * it.
 *
 * The transition table, and every branch is a decision:
 *
 * | `live_push_status` | degradado | suspenso |
 * |---|---|---|
 * | `normal` | resolved | resolved |
 * | `warning` | RAISED | resolved |
 * | `suspended` | **untouched** | RAISED |
 * | anything else | untouched | untouched |
 *
 * - **`warning` resolves suspenso** because being reported as `Warning` is
 *   positive proof the subscription is live — the field is one scalar and
 *   `Suspended` is strictly worse. Same structural argument as the expiry sweep
 *   closing `shopeeDesautorizado` on both of its branches.
 * - **`suspended` does not touch degradado.** Resolving it would stamp
 *   `resolvidoEm` on "entrega degradada" at the moment things are at their
 *   worst, drop it from the bell and start its 90-day retention clock — a lie in
 *   the dangerous direction. Raising it too would put two rows carrying two
 *   different runbooks in the inbox for one event. Not touching it asserts
 *   nothing false: a degradado row raised on an earlier tick stands beside the
 *   critical one (both true), and `normal` closes both together.
 * - **An unknown or absent status raises nothing and resolves nothing**, and
 *   logs the raw value. Both wrong-way defaults are worse: `normal` would
 *   resolve a real critical alert on garbage input, and `warning` would write a
 *   row whose text asserts degradation we did not observe. There is deliberately
 *   no durable sink for it either — `aviso.ts` is explicit that avisos carry no
 *   plumbing telemetry.
 */
export async function runShopeePushConfigMonitor(
  db: Firestore,
  deps: PushConfigMonitorDeps,
): Promise<PushConfigMonitorResult> {
  const logger = loggerDe(deps);
  const config = await deps.partnerClient.getAppPushConfig();

  const statusBruto = config.live_push_status;
  const status = normalizarStatus(statusBruto);

  const resultados = { criado: 0, repetido: 0, reaberto: 0, ignorado: 0 };
  let avisados = 0;
  let resolvidos = 0;

  if (status === 'normal') {
    const fechados = await resolverAvisosDePush(db, { nowMs: deps.nowMs });
    if (fechados.degradado) resolvidos += 1;
    if (fechados.suspenso) resolvidos += 1;
  } else if (status === 'warning') {
    const { resultado } = await avisarPushDegradado(
      db,
      // The message QUOTES the provider, so the raw string rides through
      // unfolded. `statusBruto` cannot be null in this branch — a null folds to
      // `desconhecido` — and the fallback is only what keeps that provable to
      // the compiler without an assertion.
      { status: statusBruto ?? 'Warning' },
      { increment: deps.increment, nowMs: deps.nowMs, logger },
    );
    resultados[resultado] += 1;
    if (resultado !== 'ignorado') avisados += 1;
    if (await resolverPushSuspenso(db, { nowMs: deps.nowMs })) resolvidos += 1;
  } else if (status === 'suspended') {
    const { resultado } = await avisarPushSuspenso(
      db,
      {
        // ⚠️ SECONDS on the wire, MILLIS on this side — converted here, at the
        // provider boundary, exactly like every other Shopee clock. And
        // spread-or-nothing: an absent `suspended_time` must leave the stored
        // watermark alone, never reset it.
        ...(config.suspended_time == null ? {} : { suspendedTimeMs: config.suspended_time * 1000 }),
      },
      { increment: deps.increment, nowMs: deps.nowMs, logger },
    );
    resultados[resultado] += 1;
    if (resultado !== 'ignorado') avisados += 1;
  } else {
    logger.warn('[shopee/push-config] live_push_status desconhecido — nada levantado nem fechado', {
      statusBruto,
    });
  }

  // ---- log-only checks: no aviso tipo exists for any of these ---------------

  // ⚠️ BYTE FOR BYTE. The configured url goes inside the push HMAC base string
  // (`callback_url + '|' + rawBody`), and `pushSignature.test.ts` already pins
  // that a trailing slash changes the digest — so a "cosmetic" difference IS the
  // defect. No trim, no slash stripping, no scheme folding. Both values are
  // URLs, not secrets, so both are safe to log.
  const configurada = shopeePushCallbackUrl();
  let callbackDivergente = false;
  if (configurada == null) {
    logger.warn('[shopee/push-config] callback_url não configurado localmente — sem comparação', {
      naShopee: config.callback_url,
    });
  } else if (config.callback_url !== configurada) {
    callbackDivergente = true;
    logger.warn('[shopee/push-config] callback_url da Shopee diverge do configurado', {
      naShopee: config.callback_url,
      configurada,
    });
  }

  const desligados = config.push_config_off_list ?? [];
  const codigosDesligados = CODIGOS_ESPERADOS.filter((code) => desligados.includes(code));
  if (codigosDesligados.length > 0) {
    logger.warn('[shopee/push-config] códigos que este canal depende estão DESLIGADOS', {
      codigosDesligados,
    });
  }

  const lojasBloqueadas = config.blocked_shop_id?.length ?? 0;
  if (lojasBloqueadas > 0) {
    // A blocked shop silently receives no pushes and nothing else would say so.
    logger.warn('[shopee/push-config] lojas bloqueadas para push', { lojasBloqueadas });
  }

  return {
    status,
    statusBruto,
    avisados,
    resolvidos,
    resultados,
    callbackDivergente,
    codigosDesligados,
    lojasBloqueadas,
  };
}
