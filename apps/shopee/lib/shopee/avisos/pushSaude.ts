/**
 * The producer of the two Shopee **push-health** avisos, and their resolver.
 *
 * One trigger, one producer: the daily `monitorShopeePushConfig` reads
 * `get_app_push_config.live_push_status` and turns it into at most one open row
 * per tipo. There is no second source — Shopee publishes no API for the push
 * success rate itself (Console only), and `set_app_push_config` is never called
 * from this repo.
 *
 * ## ⚠️ This module holds NO unit conversion
 *
 * `avisos/autorizacao.ts` is the ONE module in `apps/shopee` that speaks
 * microseconds, and it stays that way: the µs seam (`agoraUsDe`,
 * `depsDeEscrita`) is imported from there rather than re-derived here, so its
 * "exactly two call sites" promise survives a second producer. Everything below
 * is milliseconds, exactly like the rest of the app.
 *
 * ## ⚠️ Partner-level: no `conta`, no `entidade`, no `janela`
 *
 * `get_app_push_config` is keyed on `partner_id` alone — one app, one
 * `callback_url`, one health reading, with no per-shop addressing anywhere on
 * the page. So each tipo is ONE global row forever (`chaveDeAviso({ tipo })`
 * alone, which is legal and yields a single-segment id). A `janela` would be
 * worse than useless: keyed on `suspended_time` it would make the resolver
 * compute a key that was never created, and the row would stand past the 90-day
 * retention sweep on a `serverOwned` collection nobody can dismiss by hand.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type ResultadoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import { CANAL_AVISO, SEVERIDADE_AVISO, TIPO_AVISO, chaveDeAviso } from '@delfrance/schemas';

import { type AvisoDeps, agoraUsDe, depsDeEscrita } from './autorizacao';

/** The motivo every machine resolution of these two tipos is stamped with. */
export const MOTIVO_PUSH_NORMALIZADO = 'normalizado';

/** The dedup identity — and the document id — of "delivery is degraded". */
export function chavePushDegradado(): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.shopeePushDegradado });
}

/** The dedup identity of "the subscription is suspended". */
export function chavePushSuspenso(): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.shopeePushSuspenso });
}

export interface EventoPushDegradado {
  /**
   * Shopee's `live_push_status` VERBATIM — the rendered message quotes the
   * provider ("A Shopee reporta entrega degradada (…)"), so a value Shopee
   * changes the casing of still reads correctly to the operator.
   */
  readonly status: string;
}

export interface EventoPushSuspenso {
  /**
   * `suspended_time` in MILLISECONDS (Shopee sends SECONDS; the monitor
   * converts at the provider boundary, as every other Shopee reader does).
   *
   * ⚠️ **OMIT it when Shopee sent none.** An absent optional means "I do not
   * know" and leaves the stored watermark alone; a `null` would RESET it, and a
   * reset watermark is a guard that never rejects anything again — the next
   * repeated reading of the SAME suspension would reopen the row instead of
   * being ignored (`camposInformados`, root CLAUDE.md rule 7).
   */
  readonly suspendedTimeMs?: number;
}

/**
 * Raise (or refresh) "Shopee reports degraded push delivery" — `Warning` on the
 * provider's own warning/auto-disable ladder (>600 pushes / 6 h AND <70 %
 * success).
 *
 * `severidade: atencao` — pushes are still being delivered, and `critico` is the
 * only tier that escalates out of the app.
 *
 * ⚠️ **No `relogioEvento`, ever.** `get_app_push_config` supplies no clock for a
 * Warning: there is no `warning_time` field on the page, and the only stamp it
 * ever sends is `suspended_time`, which belongs to the other tipo. So every
 * daily tick is a `repetido` — `ocorrencias` counts DAYS in warning, `criadoEm`
 * does not move, and the operator is not re-alerted. Passing the wall clock
 * instead would make each day look like a fresher event and defeat the very
 * watermark it pretends to be.
 *
 * ⚠️ **`urlInterna: null`, stated rather than omitted.** The remedy is outside
 * this app entirely (the Shopee Console, plus a `minInstances` change the
 * message's runbook names), and `ROTAS_AVISO.inicio.build()` would render a
 * button that navigates to the dashboard the inbox already lives on — a link
 * that does nothing trains the operator to stop clicking links.
 */
export function avisarPushDegradado(
  db: Firestore,
  evento: EventoPushDegradado,
  deps: AvisoDeps,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.shopeePushDegradado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      // Structured params, never a rendered sentence: the pt-BR wording lives in
      // `apps/web/lib/avisos/mensagens.ts` and reads exactly `status`.
      params: { status: evento.status },
      urlInterna: null,
    },
    depsDeEscrita(deps),
  );
}

/**
 * Raise "Shopee suspended the push subscription" — the bottom of the same
 * ladder (<30 % success), and the only Shopee event that loses data
 * IRRECOVERABLY: `guide 18` states that notifications missed while the
 * subscription was disabled are never re-sent, and the 3-day lost-push queue
 * does not cover a suspension either.
 *
 * `severidade: critico` is pre-decided rather than a judgement call —
 * `packages/schemas/src/aviso.ts` names this exact call site ("one Shopee
 * `get_app_push_config` read yields `Warning` (atenção) or `Suspended` (crítico)
 * from the same call site"). One global row, at most a handful ever, so the
 * "keep `critico` rare" seam holds.
 *
 * ⚠️ **No `params`** — the rendered message reads none, and a param nothing
 * renders is a field that drifts silently.
 *
 * ⚠️ **No `prazo`, ever.** `suspended_time` is when the suspension STARTED;
 * `prazo` is a provider-supplied DEADLINE and renders as one, so putting a start
 * there shows the operator "Prazo: <a date in the past>".
 *
 * ⚠️ `relogioEvento` is `suspended_time`, spread-or-nothing. Two ticks inside
 * ONE suspension carry the same value, so the watermark answers `'ignorado'` —
 * which is exactly right: `ocorrencias` counts SUSPENSIONS, not days. A new
 * suspension carries a later stamp and reopens the row with a fresh `criadoEm`.
 */
export function avisarPushSuspenso(
  db: Firestore,
  evento: EventoPushSuspenso,
  deps: AvisoDeps,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.shopeePushSuspenso,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.shopee,
      urlInterna: null,
      // ⚠️ Spread-or-nothing, never `?? null` — see the field's docblock.
      ...(evento.suspendedTimeMs === undefined ? {} : { relogioEvento: evento.suspendedTimeMs }),
    },
    depsDeEscrita(deps),
  );
}

/** Which of the two rows a resolution actually closed. */
export interface ResolucaoPush {
  readonly degradado: boolean;
  readonly suspenso: boolean;
}

/**
 * The machine resolver both tipos name: Shopee reports `Normal` again.
 *
 * Both rows are closed together because one healthy reading ends both problems
 * at once — `live_push_status` is a single value, and `Normal` is strictly
 * better than either. `resolverAviso` reports a TRANSITION, so an
 * already-resolved (or never-raised) row answers `false` and a caller's counter
 * reads "closed" rather than "the document was there".
 *
 * ⚠️ The keys it computes MUST be the keys the producers above created. They are
 * the same two functions, which is the point of exporting them: a resolver that
 * derives its own key is how a row ends up standing forever.
 */
export async function resolverAvisosDePush(
  db: Firestore,
  deps: { nowMs: number },
): Promise<ResolucaoPush> {
  const agoraUs = agoraUsDe(deps);
  const degradado = await resolverAviso(db, chavePushDegradado(), MOTIVO_PUSH_NORMALIZADO, {
    agoraUs,
  });
  const suspenso = await resolverAviso(db, chavePushSuspenso(), MOTIVO_PUSH_NORMALIZADO, {
    agoraUs,
  });
  return { degradado, suspenso };
}

/**
 * Close the SUSPENSO row alone.
 *
 * ⚠️ Exported separately because the monitor closes it on the `warning` branch
 * too: being reported as `Warning` is positive proof the subscription is LIVE
 * (the value is one scalar, and `Suspended` is strictly worse), exactly as
 * `expiracaoSweep` resolves `shopeeDesautorizado` on both of its branches. The
 * mirror image is NOT true and there is deliberately no `resolverPushDegradado`:
 * see the monitor's `suspended` branch, which must not stamp "delivery is
 * degraded" as resolved at the moment things are at their worst.
 */
export function resolverPushSuspenso(db: Firestore, deps: { nowMs: number }): Promise<boolean> {
  return resolverAviso(db, chavePushSuspenso(), MOTIVO_PUSH_NORMALIZADO, {
    agoraUs: agoraUsDe(deps),
  });
}
