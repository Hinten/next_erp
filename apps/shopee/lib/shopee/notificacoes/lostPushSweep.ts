/**
 * The Shopee **lost-push** sweep (master plan step 4, #1512) — the backstop
 * decision P3 spends the receiver's cold-start cost on.
 *
 * A push that exhausts Shopee's own retry ladder (+5 min / +30 min / +3 h) lands
 * in a partner-level queue holding "the earliest 100 lost within 3 days and not
 * confirmed". This walks that queue, re-parses each entry's `data` STRING back
 * into the receiver's payload, enqueues it onto the same
 * `processShopeeNotification` queue a live delivery uses — and only then
 * acknowledges the page.
 *
 * ## ⚠️ The ordering rule, and what "durable" means
 *
 * Paging is cursor-by-ACKNOWLEDGEMENT: there is no `page_no`, no `cursor` and no
 * offset input, so the ONLY way to advance is
 * `confirm_consumed_lost_push_message`. One entry we never make durable
 * therefore blocks every later one — for three days, in a queue that is filtered
 * on "not confirmed" and ordered "earliest first". Hence:
 *
 * > An entry is **durable** when it has been ENQUEUED, or persisted `failed`, or
 * > persisted `parked`. A page is confirmed only when EVERY one of its entries
 * > is durable, once, with THAT page's `last_message_id`. An empty page is never
 * > confirmed.
 *
 * ⚠️ **This diverges from `apps/mercado-livre`'s `missedFeedsSweep` on purpose.**
 * ML deliberately does not persist an enqueue failure, and its stated reason is
 * "the sweep has no such pressure and the entry survives in the feed for 2
 * days" — an offset-paged feed with no ack, where an entry left behind is simply
 * re-read tomorrow. Neither half transfers: this queue only forgets an entry
 * when WE ack it or when it expires, and a stuck entry hides entries 101+
 * entirely. Persisting is also strictly better here, because this channel
 * already runs the drain lane: `reprocessShopeeNotifications` re-drives `failed`
 * rows every 30 minutes with the full `MAX_TENTATIVAS` ladder.
 *
 * ⚠️ **Truncation is harmless here, unlike the order backfill's.** Every page
 * confirmed already advanced the provider's own cursor, so the next tick resumes
 * exactly where this one stopped. There is no cursor to store and no
 * partial-advance trap — do not copy `orderBackfill`'s truncation heuristic into
 * this file.
 *
 * ## ⚠️ What is NOT covered
 *
 * A SUSPENSION. `guide 18` states that notifications missed while the
 * subscription was disabled are never re-sent, and `faq 455` repeats it 13
 * months after these APIs shipped. The order backfill (step 4's other half) is
 * the only documented recovery from that; the daily `monitorShopeePushConfig` is
 * what makes it visible.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import { asMillis } from '@delfrance/data/admin/notifications';
import {
  ShopeeApiError,
  ShopeeHttpError,
  type ShopeeLostPushEntry,
  ShopeeNetworkError,
  type ShopeePartnerClient,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import type { ShopeeTaskScheduler } from '../shopeeTasks';
import {
  CODIGO_AUSENTE,
  type ShopeeNotificationPayload,
  docIdOf,
  mensagemDoErro,
  parseNotificationBody,
  persistNotificationFailure,
  persistNotificationParked,
  sanitizarData,
} from './notificacao';

/**
 * Pages read per tick. 5 × 100 = 500 entries, far past any plausible backlog for
 * this seller — and a bound, because the queue's page size is fixed at 100 and
 * the only exit from the loop is an ack we might be refusing to send.
 */
export const MAX_PAGES_PER_TICK = 5;

/**
 * Shopee's own retention for the queue: "lost within 3 days". Not read by the
 * code — it is the other half of the scheduling invariant (the tick period must
 * fit at least twice inside it), which `functions/src/index.test.ts` asserts
 * against the cron literal.
 */
export const LOST_PUSH_RETENTION_HOURS = 72;

/**
 * An entry older than this is close to expiring UNRECOVERABLY — two thirds of
 * the way through the retention window, which is late enough to mean something
 * and early enough to still act on.
 */
export const IDADE_ALERTA_MS = 48 * 60 * 60 * 1000;

/** How much of an unreadable `data` string reaches a parked row. */
export const BRUTO_MAX_CHARS = 4000;

/**
 * The ONE narrow valve: `'1'` skips the confirm, and nothing else.
 *
 * ⚠️ There is deliberately **no** `SHOPEE_LOST_PUSH_SWEEP_ENABLED`. A backstop
 * that ships OFF is a backstop nobody notices is off (#778), and this sweep
 * publishes nothing to Shopee, cannot corrupt seller data, and degrades to
 * persist-and-drain under `SHOPEE_TASKS_DISABLED`. The incident lever that
 * matters — pausing the Cloud Scheduler job — needs no code.
 *
 * This valve exists for ONE rehearsal: the sandbox cannot exercise the lost-push
 * APIs at all, so the first call is production. With it on, a tick proves the
 * read / parse / enqueue path and reports the GETTER envelope's `error`
 * verbatim without sending an irreversible ack — which is why
 * `getLostPushMessages()` hands back the whole operation rather than
 * `res.response`. It is opt-in-to-DISABLE, so an
 * unset or blank value can never leave the sweep inert. While it is on the tick
 * stops after the first page, because the queue did not advance and the next
 * read would return the same entries.
 */
export const SHOPEE_LOST_PUSH_CONFIRM_DISABLED_ENV = 'SHOPEE_LOST_PUSH_CONFIRM_DISABLED';

export interface LostPushSweepLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface LostPushSweepDeps {
  /** Public-signed client: both calls work when every conta's token is dead. */
  readonly partnerClient: ShopeePartnerClient;
  /** The SAME queue a live delivery goes through — see the acceptance test. */
  readonly scheduler: ShopeeTaskScheduler;
  /** ONE clock read for the whole tick, MILLISECONDS. */
  readonly nowMs: number;
  readonly logger?: LostPushSweepLogger;
}

export interface LostPushSweepErro {
  readonly pagina: number;
  readonly erro: string;
}

export interface LostPushSweepResult {
  readonly paginas: number;
  readonly encontradas: number;
  readonly enfileiradas: number;
  readonly persistidas: number;
  /** Unreadable entries turned into a terminal, operator-visible row. */
  readonly paradas: number;
  readonly duplicadas: number;
  /** PAGES confirmed, never entries — the ack is per page. */
  readonly confirmadas: number;
  readonly truncado: boolean;
  /** Age of the OLDEST entry seen, ms. `null` when the queue was empty. */
  readonly maisAntigaMs: number | null;
  /**
   * The FIRST getter page's envelope `error`, VERBATIM — the field that settles
   * whether Shopee really answers `"-"` where every other page answers `""`.
   *
   * ⚠️ It is the **GETTER's** envelope and not the confirm's, and that is the
   * whole point: the rehearsal tick
   * (`SHOPEE_LOST_PUSH_CONFIRM_DISABLED`) exists precisely to read the queue
   * without acking it, so a field sourced from the confirm would be `null` on
   * every tick the rehearsal runs — the one tick it was added for. Hence
   * `getLostPushMessages()` hands back the whole parsed operation rather than
   * `res.response`.
   *
   * `null` means no page was read at all (a contained read failure on page 1).
   * An empty queue still answers, so `''` and `'-'` are both real readings.
   * Delete the field once live traffic has read the same value for a week.
   */
  readonly envelopeError: string | null;
  readonly erros: readonly LostPushSweepErro[];
}

/**
 * Admin-SDK and Cloud Tasks transport failures surface as `Error`s carrying a
 * numeric gRPC status `code`. Narrowed to the real status range (integers 1–16;
 * 0 = OK never rides an error) so a coding-bug `Error` that happens to expose
 * some other numeric `code` is NOT contained. Mirrors `expiracaoSweep`.
 */
function isGrpcCodedError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/**
 * Contained per TICK: recorded in `erros`, logged, and the tick STOPS **without
 * confirming the page it was on**. Everything else RETHROWS and fails the
 * execution.
 *
 * ⚠️ `ShopeeConfigError` is deliberately ABSENT, and it is NOT covered by
 * `ShopeeApiError` — it extends `ShopeeError` directly. A missing partner
 * credential is OUR misconfiguration, and #778 is the worked example of a sweep
 * that logged per-item errors forever instead of failing the execution that
 * would have named the missing binding. Catching `ShopeeError` — which
 * `expiracaoSweep.contidoPorLoja` does safely, because its only provider call
 * runs OUTSIDE the try — would swallow it here, where the provider calls are in
 * the loop.
 *
 * ⚠️ Burst and daily rate limits are handled IDENTICALLY (the tick stops); the
 * distinction survives only in the log line. The 2-hour cadence is already past
 * any burst window, and the daily quota resets on Shopee's clock, which the next
 * ticks walk into. Nothing here sleeps.
 */
function contidoNoTick(err: unknown): err is Error {
  return (
    err instanceof ShopeeApiError || // incl. ShopeeRateLimitError / ShopeeReauthRequiredError
    err instanceof ShopeeNetworkError ||
    err instanceof ShopeeHttpError || // the IP-whitelist edge rejection (P2)
    err instanceof ShopeeSchemaError ||
    isGrpcCodedError(err)
  );
}

function loggerDe(deps: LostPushSweepDeps): LostPushSweepLogger {
  return (
    deps.logger ?? {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

/** Either the receiver-shaped payload, or WHY the entry is unreadable. */
type LeituraDaEntrada = { payload: ShopeeNotificationPayload } | { razao: string };

/**
 * Re-parse one queue entry's `data` STRING back into the payload a live
 * delivery would have produced.
 *
 * ⚠️ **Never synthesize an envelope from the LIST-level fields.** The list's
 * `code` / `shop_id` / `timestamp` are metadata about the LOSS — the page says
 * the timestamp is "when the message was lost" — so feeding it into the
 * payload's `timestamp` slot would put a knowingly wrong clock on a real
 * payload, and that clock becomes the `carimbo` in `docIdOf` and is compared as
 * a watermark downstream.
 */
function lerEntrada(bruto: string): LeituraDaEntrada {
  let envelope: unknown;
  try {
    // `JSON.parse(s) as unknown` — the form `no-unvalidated-response` allows,
    // and the only cast in this module.
    envelope = JSON.parse(bruto) as unknown;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { razao: 'data não é JSON' };
  }
  if (envelope == null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { razao: 'data é JSON mas não é um objeto' };
  }
  const payload = parseNotificationBody(envelope);
  if (payload == null) return { razao: 'envelope sem push_code inteiro' };
  return { payload };
}

/**
 * The payload of a PARKED row for an entry we could not read.
 *
 * ⚠️ `_lostPush.ref` is `<last_message_id>_<index in the page>` and it is
 * load-bearing: `identidadeDoPush`'s `CODIGO_AUSENTE` row keys the document id
 * on it, so two unreadable partner-level entries lost in the same second get
 * DISTINCT ids. Without it both key `-1:-:-:<carimbo>`, `store.create` narrows
 * ALREADY_EXISTS and returns silently, and the sweep confirms past an entry
 * whose payload was never stored.
 */
function payloadDeEntradaPerdida(
  entrada: ShopeeLostPushEntry,
  ref: string,
): ShopeeNotificationPayload {
  return {
    code: CODIGO_AUSENTE,
    shopId: entrada.shop_id,
    // The LOSS clock, and it is here only so the doc id is stable across a
    // re-read of an unconfirmed page. `_lostPush.timestamp` keeps the raw value
    // beside its real meaning.
    timestamp: asMillis(entrada.timestamp * 1000),
    data: sanitizarData({
      _lostPush: {
        ref,
        // The LIST-level code — the inner envelope's is what we could not read.
        code: entrada.code,
        shopId: entrada.shop_id,
        // SECONDS, verbatim, exactly as Shopee sent it.
        timestamp: entrada.timestamp,
        bruto: entrada.data.slice(0, BRUTO_MAX_CHARS),
        truncado: entrada.data.length > BRUTO_MAX_CHARS,
      },
    }),
  };
}

/**
 * Walk the lost-push queue and re-drive everything in it through this channel's
 * normal pipeline.
 *
 * @returns counters an operator reads; `confirmadas < paginas` means a page was
 * left for the next tick, which is the safe direction and the whole design.
 */
export async function runShopeeLostPushSweep(
  db: Firestore,
  deps: LostPushSweepDeps,
): Promise<LostPushSweepResult> {
  const logger = loggerDe(deps);
  // Read at the use site, like `SHOPEE_SANDBOX` and `SHOPEE_TASKS_DISABLED`.
  const confirmDesabilitado = process.env[SHOPEE_LOST_PUSH_CONFIRM_DISABLED_ENV] === '1';

  const erros: LostPushSweepErro[] = [];
  const vistos = new Set<string>();
  let paginas = 0;
  let encontradas = 0;
  let enfileiradas = 0;
  let persistidas = 0;
  let paradas = 0;
  let duplicadas = 0;
  let confirmadas = 0;
  let truncado = false;
  let maisAntigaMs: number | null = null;
  let envelopeError: string | null = null;

  for (let pagina = 1; pagina <= MAX_PAGES_PER_TICK; pagina += 1) {
    let op;
    try {
      op = await deps.partnerClient.getLostPushMessages();
    } catch (err) {
      if (!contidoNoTick(err)) throw err;
      erros.push({ pagina, erro: err.message });
      logger.warn('[shopee/lost-push] leitura da fila contida — nada confirmado', {
        pagina,
        erro: err.message,
      });
      break;
    }
    paginas += 1;
    // ⚠️ The FIRST page's envelope, and the getter's — see `envelopeError`. It
    // is captured before any entry is touched, so a page that goes on to fail
    // still reports what Shopee answered.
    envelopeError ??= op.error;
    const page = op.response;

    const entradas = page.push_message_list ?? [];
    encontradas += entradas.length;

    if (entradas.length === 0) {
      // ⚠️ NEVER confirm an empty page. `last_message_id` is documented as "the
      // end entry of data returned in the current call"; with no entries there
      // is no end entry, and acking an unrelated id is undefined behaviour
      // against a watermark whose semantics Shopee never wrote down.
      if (page.has_next_page) {
        logger.warn('[shopee/lost-push] contradição do provedor: página vazia com has_next_page', {
          pagina,
          lastMessageId: page.last_message_id,
        });
      }
      break;
    }

    let paginaDuravel = true;

    for (const [indice, entrada] of entradas.entries()) {
      const idade = deps.nowMs - entrada.timestamp * 1000;
      if (Number.isFinite(idade) && (maisAntigaMs == null || idade > maisAntigaMs)) {
        maisAntigaMs = idade;
      }
      const ref = `${String(page.last_message_id)}_${String(indice)}`;

      const leitura = lerEntrada(entrada.data);

      // Rung 3 taken directly: an entry whose `data` cannot be read at all can
      // never be processed, so it becomes a TERMINAL row and the page is still
      // confirmed. Refusing to confirm would jam a 100-entry page for three days
      // to satisfy one entry nothing can ever handle.
      if (!('payload' in leitura)) {
        try {
          await persistNotificationParked(
            db,
            payloadDeEntradaPerdida(entrada, ref),
            `entrada da fila de mensagens perdidas ilegível: ${leitura.razao} (ref ${ref})`,
          );
          paradas += 1;
        } catch (err) {
          if (!contidoNoTick(err)) throw err;
          erros.push({ pagina, erro: err.message });
          logger.warn('[shopee/lost-push] entrada ilegível não pôde ser parada — sem confirmar', {
            pagina,
            ref,
            erro: err.message,
          });
          paginaDuravel = false;
          break;
        }
        continue;
      }

      const payload = leitura.payload;

      // ⚠️ `docIdOf`, NOT `dedupKeyOf`. The key keeps the carimbo, so two events
      // about ONE order with different `update_time` stay two jobs. `dedupKeyOf`
      // drops the carimbo — right for the reprocess sweep, which leaves the
      // skipped document for a later run, and wrong here, where the skipped
      // entry is about to be CONFIRMED AWAY.
      const id = docIdOf(payload);
      if (id != null) {
        if (vistos.has(id)) {
          duplicadas += 1;
          continue;
        }
        vistos.add(id);
      }
      // A null id means "do not dedup this entry": losing dedup for an id
      // `asDocId` refused costs one duplicate task, which is the trade `asDocId`
      // already makes.

      try {
        await deps.scheduler.enqueue(payload);
        enfileiradas += 1;
        continue;
      } catch (err) {
        // ⚠️ Deliberately TOTAL, and it is the receiver's own decision (rule 6
        // is about SWALLOWING, and nothing is swallowed): whatever the enqueue
        // threw — the `SHOPEE_TASKS_DISABLED` valve, a missing IAM grant, a
        // transport failure — the entry must become durable before we ack, and
        // `persistNotificationFailure` puts it on the 30-minute drain lane.
        const motivo = mensagemDoErro(err);
        try {
          await persistNotificationFailure(
            db,
            payload,
            `enqueue falhou (mensagem perdida): ${motivo}`,
          );
          persistidas += 1;
          logger.warn('[shopee/lost-push] enqueue falhou — persistido para o sweep', {
            pagina,
            code: payload.code,
            erro: motivo,
          });
          continue;
        } catch (persistErr) {
          // A `ZodError` means the payload failed the collection's write
          // validator, so re-persisting it in any shape is hopeless — but the
          // PARKED shape is minimal and known-good, which is what this rung has
          // that the failed one did not.
          if (persistErr instanceof ZodError) {
            try {
              await persistNotificationParked(
                db,
                payloadDeEntradaPerdida(entrada, ref),
                `payload da mensagem perdida rejeitado pelo validador (ref ${ref}): ${persistErr.message}`,
              );
              paradas += 1;
              continue;
            } catch (parkErr) {
              // The last rung failed too: the entry is not durable in ANY shape,
              // so the page must not be confirmed.
              if (!contidoNoTick(parkErr)) throw parkErr;
              erros.push({ pagina, erro: parkErr.message });
              logger.warn('[shopee/lost-push] parada falhou — página não confirmada', {
                pagina,
                ref,
                erro: parkErr.message,
              });
              paginaDuravel = false;
              break;
            }
          }
          if (!contidoNoTick(persistErr)) throw persistErr;
          erros.push({ pagina, erro: persistErr.message });
          logger.warn('[shopee/lost-push] persistência falhou — página não confirmada', {
            pagina,
            code: payload.code,
            erro: persistErr.message,
          });
          paginaDuravel = false;
          break;
        }
      }
    }

    // ⚠️ A partially durable page is NEVER confirmed. The entries already
    // enqueued are not undone — the page comes back next tick and duplicates,
    // which is the safe side: every handler re-fetches and the derived doc ids
    // collapse onto one row.
    if (!paginaDuravel) break;

    if (confirmDesabilitado) {
      logger.warn('[shopee/lost-push] confirmação desabilitada pela válvula — ensaio', {
        variavel: SHOPEE_LOST_PUSH_CONFIRM_DISABLED_ENV,
        pagina,
        lastMessageId: page.last_message_id,
      });
      break;
    }

    try {
      // The confirm's own envelope is NOT what `envelopeError` reports — it
      // would be `null` on exactly the rehearsal tick the field exists for.
      await deps.partnerClient.confirmConsumedLostPushMessages({
        lastMessageId: page.last_message_id,
      });
    } catch (err) {
      if (!contidoNoTick(err)) throw err;
      erros.push({ pagina, erro: err.message });
      logger.warn('[shopee/lost-push] confirmação contida — a página volta na próxima tick', {
        pagina,
        lastMessageId: page.last_message_id,
        erro: err.message,
      });
      break;
    }
    confirmadas += 1;

    if (!page.has_next_page) break;
    if (pagina === MAX_PAGES_PER_TICK) {
      truncado = true;
      logger.warn('[shopee/lost-push] fila truncada no teto de páginas — sobrou trabalho', {
        paginas,
        maxPaginas: MAX_PAGES_PER_TICK,
      });
    }
  }

  if (maisAntigaMs != null && maisAntigaMs > IDADE_ALERTA_MS) {
    logger.warn('[shopee/lost-push] entrada perto de expirar sem recuperação', {
      maisAntigaMs,
      idadeAlertaMs: IDADE_ALERTA_MS,
      retencaoHoras: LOST_PUSH_RETENTION_HOURS,
    });
  }

  return {
    paginas,
    encontradas,
    enfileiradas,
    persistidas,
    paradas,
    duplicadas,
    confirmadas,
    truncado,
    maisAntigaMs,
    envelopeError,
    erros,
  };
}
