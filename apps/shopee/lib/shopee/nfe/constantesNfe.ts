/**
 * The NF-e upload's ERP-side bounds (#1522, step 14): the queue's name, the
 * attempt ceiling, the SERPRO waits, the recheck ladder, the pause ceiling, the
 * `get_order_detail` field list and the excerpt cap — plus the ONE pure
 * function that turns an authorization instant into the remaining SERPRO wait.
 *
 * The rule is step 12's (`estoque/constantesEstoque.ts`) and step 13's
 * (`precos/constantesPreco.ts`): a bound the WIRE states lives in
 * `@delfrance/integrations-shopee` and is imported by whoever needs it; a bound
 * WE chose lives here. ⚠️ So the upload's BYTE ceiling is deliberately absent:
 * it is the package's own constant, measured against the same bytes the
 * package sends, and a copy here would be a second number that can drift from
 * the one the transport enforces.
 *
 * ⚠️ **No environment reader and no clock.** Every value is a literal — the
 * queue's retry configuration pins the attempt ceiling by equality, and a
 * knob an operator could turn would let the two disagree — and the one
 * function takes the clock as a PARAMETER (`nowMs`). The folder is reached by
 * the functions bundle, so it stays free of Next's server module too.
 */

/* --------------------------------- the queue -------------------------------- */

/**
 * The Cloud Tasks queue — and, by the functions codebase's convention, the
 * EXPORT name of the `onTaskDispatched` handler that owns it. The functions
 * index asserts the two are equal; a rename on one side alone would enqueue
 * onto a queue nothing drains.
 */
export const SHOPEE_NFE_UPLOAD_QUEUE = 'processShopeeNfeUpload';

/**
 * The queue's `retryConfig.maxAttempts`, pinned by EQUALITY in the handler's
 * declaration. The handler reads it to know when it is on its FINAL attempt
 * (`retryCount === NFE_SHOPEE_MAX_TENTATIVAS - 1`) — the only moment a
 * transport failure may finalize instead of rethrowing — so the two numbers
 * must be one number.
 */
export const NFE_SHOPEE_MAX_TENTATIVAS = 4;

/* ------------------------------- the SERPRO waits ---------------------------- */

/**
 * Seconds between the NF-e's approval and its FIRST upload attempt.
 *
 * Shopee's integration guide asks for a wait of about five minutes after the
 * NF-e is created, because it checks the note against the federal record
 * (SERPRO), which lags the SEFAZ authorization. 300 s plus a 60 s margin: the
 * trigger fires only AFTER the authorization is persisted, so both candidate
 * anchors (the emission instant and the authorization instant) are already in
 * the past when the delay starts, and what is left is SERPRO's propagation —
 * which the self re-enqueue ladder below heals if it runs long.
 *
 * ⚠️ Never below 300: the tasks emulator IGNORES `scheduleDelaySeconds`, so no
 * round trip can catch an early dispatch — a constant pin is the only guard.
 * And every minute above the need is a minute the expedição waits at step 15.
 */
export const ATRASO_SERPRO_S = 360;

/**
 * The delays, in SECONDS, of the self re-enqueues after Shopee answers that the
 * NF-e is not valid YET (the guide's "invalid NF-e": not in the federal record,
 * or younger than five minutes). The LENGTH is the ceiling — the fourth such
 * answer is final — and the escalation reaches roughly an hour and forty
 * minutes after the first attempt, because multi-hour SEFAZ outages have been
 * observed.
 *
 * ⚠️ A re-enqueue with a delay consumes NO queue attempt, which is the point:
 * waiting for SERPRO is not a failure of the transport.
 */
export const ATRASOS_SERPRO_REENVIO_S = [600, 1800, 3600] as const;

/**
 * The delays, in SECONDS, of the rechecks that follow an accepted upload: the
 * first ~15 minutes after the 200, and ONE more ~30 minutes later only while
 * the note reads pending WITHOUT a reason. The length is the ceiling. A
 * recheck is one read and never uploads; it is the only chance to see an
 * asynchronous SEFAZ flag before step 15 tries to ship.
 */
export const ATRASOS_REVERIFICACAO_S = [900, 1800] as const;

/**
 * How many rate-limit re-enqueues (burst and daily quota together) one task may
 * spend before it gives up. Each pause is a delayed self re-enqueue that
 * consumes no queue attempt, so without a ceiling a conta stuck at its quota
 * would re-enqueue the same NF-e forever.
 */
export const NFE_SHOPEE_MAX_PAUSAS = 6;

/* ------------------------------ the order read -------------------------------- */

/**
 * `get_order_detail`'s `response_optional_fields` for every read this folder
 * makes — the pre-read, the read-back after a 200, and each recheck. ONE list,
 * so the three reads can never judge the same order from different shapes.
 *
 * ⚠️ The list REPLACES the package's default, it does not extend it — and that
 * is the point: no buyer, address, item or payment block is requested, so this
 * wire carries no buyer datum at all. The base fields (`order_sn`, `region`,
 * `order_status`, `update_time`) arrive without being asked.
 *
 * - `invoice_data` — the note Shopee holds for the order (its key, status and
 *   pending reason);
 * - `fulfillment_flag` — Shopee's fulfillment and cross-border orders get no
 *   NF-e from the seller;
 * - `international_label` — an export order, which Shopee invoices itself.
 */
export const SHOPEE_NFE_DETALHE_CAMPOS = [
  'invoice_data',
  'fulfillment_flag',
  'international_label',
] as const;

/* ------------------------------- the excerpt ---------------------------------- */

/**
 * The cap, in characters, of the sanitized Shopee excerpt that two aviso
 * reasons carry (`redacaoNfe.ts`). Applied AFTER masking, so a cut can never
 * expose half of a number the mask would have hidden whole.
 */
export const EXCERTO_SHOPEE_MAX = 160;

/* --------------------------- the remaining wait ------------------------------- */

const MS_POR_SEGUNDO = 1_000;

/**
 * How many SECONDS a task enqueued NOW should still wait for SERPRO, given the
 * NF-e's authorization instant.
 *
 * - **Units: milliseconds in, seconds out.** `dataAutorizacaoMs` is the
 *   `nfev4` field `data_autorizacao` (ms since the epoch) and `nowMs` is the
 *   caller's clock; the answer feeds `scheduleDelaySeconds`.
 * - `null` ⇒ the FULL wait ({@link ATRASO_SERPRO_S}): an NF-e whose
 *   authorization instant is unknown is treated as authorized just now. A
 *   non-finite value on either side is read the same way — the safe direction
 *   is to wait, never to dispatch early.
 * - Clamped to `[0, ATRASO_SERPRO_S]`: an authorization in the FUTURE (a clock
 *   skew between writers) waits the full window and never longer; an old NF-e
 *   waits 0 — a re-drive of a note approved yesterday must not wait six minutes.
 * - **`Math.ceil`** of the remaining seconds: a fraction left over rounds UP,
 *   so a dispatch never lands before the window has closed.
 *
 * Callers: the route and the CLI (a re-drive), which omit the delay option
 * entirely when the answer is 0. The trigger never calls this — it runs at the
 * approval moment itself and passes the constant.
 */
export function atrasoSerproS(dataAutorizacaoMs: number | null, nowMs: number): number {
  if (dataAutorizacaoMs === null || !Number.isFinite(dataAutorizacaoMs)) return ATRASO_SERPRO_S;
  if (!Number.isFinite(nowMs)) return ATRASO_SERPRO_S;
  const decorridoS = (nowMs - dataAutorizacaoMs) / MS_POR_SEGUNDO;
  const restanteS = Math.ceil(ATRASO_SERPRO_S - decorridoS);
  return Math.min(ATRASO_SERPRO_S, Math.max(0, restanteS));
}
