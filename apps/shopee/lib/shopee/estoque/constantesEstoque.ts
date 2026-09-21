/**
 * Every tunable, every ERP-side bound and the queue name of the Shopee STOCK
 * sync (#1520, step 12) — the folder's ONE `process.env` reader family.
 *
 * ⚠️ **This module is PATH-BOUND.** `tools/deploy-env/preflight.mjs` names it in
 * the shopee codebase's `deployShellSource`, and its drift test regexes
 * `envInt('NAME', N)` against this file's raw TEXT to prove the table it prints
 * on every deploy still matches the code. So the two queue-rate knobs below
 * must keep that literal spelling — an indirection through a constant, a
 * computed name or a default moved to a variable all read as "no envInt for
 * NAME" and red the deploy gate. And renaming or moving this file is a
 * three-file change: here, `preflight.mjs`'s `deployShellSource`, and the
 * `.env.example` block that points readers at it.
 *
 * ⚠️ **The SECOND `process.env` reader family in this app.** `lib/shopee/env.ts`
 * is the first and its docblock enumerates the others; this one is listed there
 * too. The split is deliberate rather than accidental: `env.ts` holds Shopee
 * CONFIGURATION (hosts, partner binding, the public callback) and blank-guards
 * every read because a blank value there builds a broken URL. What lives here
 * is TUNING — windows, caps, pauses — read through `envInt`/`envFlag` from
 * `@delfrance/data/admin/estoque`, which already treat blank as unset. Two
 * families, two rules, and each rule is enforceable inside its own file.
 *
 * ⚠️ **Three different 50s now exist in this channel** and they are three
 * constants on purpose: how many models one `update_stock` call may carry (the
 * WIRE's, {@link MAX_MODELOS_POR_TASK}, imported from the package and never
 * copied), how many models an item may hold at all (the package's create-side
 * bound), and how many produtos ONE manual request may ask for
 * ({@link SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS}, ours). A fourth — the package's
 * batch cap for the DELIST operation — is a fourth thing again, belongs to step
 * 11's surface, and nothing under this folder may read it; a test asserts this
 * file's text never names it.
 *
 * The rule the module exists to hold: a bound the WIRE states lives in
 * `@delfrance/integrations-shopee` and is imported. A bound WE chose lives here.
 * A value an operator may change without a code deploy is an `envInt`/`envFlag`
 * reader here — lazy, so a test may mutate the environment and a rehearsal may
 * retune with a redeploy instead of a patch.
 */
import { SHOPEE_UPDATE_STOCK_MAX_MODELS } from '@delfrance/integrations-shopee';
import { envFlag, envInt } from '@delfrance/data/admin/estoque';

/* ------------------------------- the queue -------------------------------- */

/**
 * Cloud Tasks queue name for the stock send tasks — the channel's THIRD queue.
 *
 * ⚠️ The deployed function's EXPORT NAME must equal this string: the queue a
 * task is enqueued onto is resolved by name, and a rename on one side alone
 * enqueues into a queue nothing serves — tasks accumulate and expire, silently,
 * while every surface reports success. The rename-safety assertion lives in
 * `apps/shopee/functions/src/index.ts` beside the two existing ones.
 */
export const SHOPEE_STOCK_SEND_QUEUE = 'sendShopeeStock';

/**
 * In-task retry cap — the same number the queue is DEPLOYED with
 * (`retryConfig.maxAttempts`).
 *
 * The handler needs it because its terminal states are attempt-sensitive: a
 * refusal is only written as final on the LAST attempt, so a handler that does
 * not know the cap either writes a terminal state too early or never writes one
 * at all. Mirrors Mercado Livre's `STOCK_SEND_MAX_ATTEMPTS` and the mass
 * import's own cap.
 */
export const STOCK_SEND_MAX_ATTEMPTS = 3;

/** Max jitter (seconds) added when a paused conta's task re-enqueues itself. */
export const PAUSE_REENQUEUE_JITTER_MAX_S = 30;

/* -------------------------------- the valve ------------------------------- */

/**
 * The env flag gating the WHOLE stock sync — the three sweeps and the send
 * handler are no-ops while it is off.
 *
 * ⚠️ This is the switch that starts WRITING to a live marketplace, so it ships
 * blank (off) and only the literal `'1'` turns it on. The manual push (route and
 * CLI) ignores it by design: an operator who asked explicitly has already made
 * the decision this flag exists to defer.
 */
export const SHOPEE_STOCK_SYNC_FLAG_ENV = 'SHOPEE_STOCK_SYNC_ENABLED';

/** Master flag — true ONLY on the literal `'1'`; blank and unset are both off. */
export function isShopeeStockSyncEnabled(): boolean {
  return envFlag(SHOPEE_STOCK_SYNC_FLAG_ENV);
}

/* ------------------------------ the tunables ------------------------------ */

/** Incremental sweep fallback window (minutes) when a conta has no cursor yet. */
export function incrementalWindowMin(): number {
  return envInt('SHOPEE_STOCK_INCREMENTAL_WINDOW_MIN', 15);
}

/**
 * Slack (seconds) re-covered behind every window start.
 *
 * The legacy sweep carried exactly this `+20 s`, and its reason survives the
 * port: a write whose stamp lands microseconds before a window boundary is
 * otherwise read by neither the tick that closed nor the tick that opened.
 */
export function windowOverlapSec(): number {
  return envInt('SHOPEE_STOCK_WINDOW_OVERLAP_SEC', 20);
}

/** Cap (hours) on how far back a stale cursor may pull the incremental window. */
export function cursorMaxLookbackHours(): number {
  return envInt('SHOPEE_STOCK_CURSOR_MAX_LOOKBACK_H', 24);
}

/** The daily tier's full window (hours). */
export function dailyWindowHours(): number {
  return envInt('SHOPEE_STOCK_DAILY_WINDOW_H', 24);
}

/**
 * High-stock threshold: on the INCREMENTAL tier only, a movement is not worth a
 * send while the quantity stays comfortably above this on **both** sides of it.
 *
 * ⚠️ The rule compares `min(anterior, atual)`, never `atual` alone — gating on
 * the current value would skip `110 → 95`, which is exactly the movement that
 * walks a listing into the danger zone. The arithmetic itself lives in the
 * shared core (`deveEnviarFamiliaCore`); this reader only supplies its `limiar`.
 * ADR 0014.
 */
export function limiarEstoqueAlto(): number {
  return envInt('SHOPEE_STOCK_LIMIAR_ALTO', 100);
}

/** Anchor-page size of the discovery query — family rows are heavy, pages small. */
export function anchorPageLimit(): number {
  return envInt('SHOPEE_STOCK_ANCHOR_PAGE_LIMIT', 250);
}

/**
 * Truncation guard: max send tasks ONE sweep may enqueue.
 *
 * ⚠️ It is also the blast bound of the monthly reconciliação, which force-sends
 * every live listing and is the one tier that ships on with no flag of its own.
 * Lowering this is the cheapest way to make a first live run small.
 */
export function maxTasksPerSweep(): number {
  return envInt('SHOPEE_STOCK_MAX_TASKS_PER_SWEEP', 2000);
}

/**
 * BURST pause duration (minutes) when Shopee's 429 carries no `Retry-After`.
 *
 * ⚠️ Read on BOTH surfaces — the queue handler and the manual push — because a
 * burst has to stop the whole conta either way, and two numbers would mean one
 * surface resuming while the other still waits.
 */
export function ratePauseMin(): number {
  return envInt('SHOPEE_STOCK_RATE_PAUSE_MIN', 5);
}

/** Cap on how often a paused task re-enqueues itself before it is dropped. */
export function maxPauseReenqueues(): number {
  return envInt('SHOPEE_STOCK_MAX_PAUSE_REENQUEUES', 10);
}

/** How long a listing locked by a promotion stays skipped before a retry (minutes). */
export function promocaoRetryMin(): number {
  return envInt('SHOPEE_STOCK_PROMOCAO_RETRY_MIN', 60);
}

/**
 * The manual push's budget, in milliseconds — an ELAPSED-clock bound.
 *
 * It sits BELOW the App Hosting request ceiling on purpose, so the thing that
 * ends a long manual push is this deadline (which answers a rendered envelope)
 * and not the platform (which answers nothing at all).
 */
export function manualDeadlineMs(): number {
  return envInt('SHOPEE_STOCK_MANUAL_DEADLINE_MS', 120000);
}

/**
 * The manual push's requested concurrency, RAW — before the clamp.
 *
 * ⚠️ The name carries the contract: the value is not usable as it stands. The
 * manual module clamps it into `[1, concurrentDispatches()]`, because the
 * per-APP Shopee quota is shared and an operator-triggered push must not be
 * allowed to out-spend the queue it runs beside.
 *
 * ⚠️ The fallback is the LITERAL 2, not `concurrentDispatches()`. A default that
 * read another variable would make this reader's answer depend on a knob set in
 * a different place (the deploy shell) and would be inexpressible to the
 * preflight drift regex, which matches `envInt('NAME', <digits>)` — so the
 * table printed on every deploy would stop describing the code. Two unset
 * variables agree at 2 today; the clamp is what keeps them honest when one moves.
 */
export function manualConcurrencyRaw(): number {
  return envInt('SHOPEE_STOCK_MANUAL_CONCURRENCY', 2);
}

/**
 * Queue rate limit — read in the DEPLOY SHELL, never at runtime.
 *
 * ⚠️ The literal spelling below is what `tools/deploy-env/preflight.mjs` regexes
 * out of this file. See the module docblock.
 *
 * 2/2 rather than the mass import's 1/1, and the difference is argued rather
 * than inherited: Shopee's limit is per APPLICATION, so a second worker does
 * spend the same quota twice — but on THIS stream a burst is survivable and
 * self-pacing, because a 429 arms a conta pause and a delayed re-enqueue that
 * consumes no attempt, never a hot retry loop. It is also the first knob a
 * rehearsal should move if the first live run looks hot.
 */
export function dispatchesPerSecond(): number {
  return envInt('SHOPEE_STOCK_DISPATCHES_PER_SECOND', 2);
}

/**
 * Queue concurrency — read on TWO surfaces: the deploy shell bakes it into the
 * queue's `rateLimits`, and the manual push reads it as the ceiling it clamps
 * its own concurrency to. See {@link dispatchesPerSecond} for the 2/2 argument
 * and the module docblock for the literal-spelling rule.
 */
export function concurrentDispatches(): number {
  return envInt('SHOPEE_STOCK_CONCURRENT_DISPATCHES', 2);
}

/**
 * Add a kit's OWN stock to the minimum of its components' — default OFF, i.e.
 * the same arithmetic the publish direction has always used.
 *
 * Scoped to Shopee: the shared core takes it as a required parameter precisely
 * so each channel answers it from its own name and its own default.
 */
export function kitIncluiEstoqueProprio(): boolean {
  return envFlag('SHOPEE_STOCK_KIT_INCLUI_PROPRIO');
}

/* ------------------------------- the bounds ------------------------------- */

/**
 * How many produtos ONE manual envio request may ask for.
 *
 * ⚠️ NOT an env var, and that is the decision: a request cap is part of the
 * route's contract — it appears in a 400 body with the number the caller
 * exceeded — not configuration an operator retunes. Over the cap the request is
 * REFUSED with the count, never silently truncated, which is step 11's shape
 * for the same class of guard (a truncating cap answers 200 for work it never
 * did).
 *
 * The count it bounds is the DEDUPED one.
 */
export const SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS = 50;

/**
 * How many models one `update_stock` call may carry — the chunker's cut.
 *
 * ⚠️ Re-exported from the package, never re-typed. It is a bound the WIRE
 * states, and a local copy is how two numbers drift: the copy compiles, passes
 * every test, and only diverges the day the page changes. It is deliberately a
 * DIFFERENT constant from the package's create-side "models per item" cap even
 * though both read 50 today.
 */
export const MAX_MODELOS_POR_TASK = SHOPEE_UPDATE_STOCK_MAX_MODELS;

/** How many discovery pages ONE sweep tick may walk before it hands over. */
export const MAX_PAGES_PER_SWEEP = 10;

/**
 * How long a conta stays paused when Shopee reports the LOJA itself is blocked
 * (banned, frozen, under penalty), in HOURS.
 *
 * Long because the condition is resolved by a human in the Seller Centre and by
 * Shopee's own review — retrying it every fifteen minutes spends the shared
 * per-app quota on an answer that cannot change that fast.
 */
export const PAUSA_LOJA_H = 24;

/**
 * How long a conta stays paused when the shop is in FULL holiday mode, in HOURS.
 *
 * Shorter than {@link PAUSA_LOJA_H} because holiday mode is a switch the seller
 * flips back themselves. It is only the FALLBACK: when the holiday read answers
 * an end time, that time is used instead.
 */
export const PAUSA_FERIAS_H = 6;

/**
 * The two pauses above, in MILLISECONDS.
 *
 * ⚠️ The conversion lives here, once, and the accessors are what call sites use:
 * every stamp under this folder is in milliseconds, so `nowMs + pausaFeriasH()`
 * has to be milliseconds or it is a pause of six thousandths of a second that
 * nothing would ever notice. The `_H` suffix names the CONSTANT's unit; the
 * accessor answers the span.
 */
function horasEmMs(horas: number): number {
  return horas * 60 * 60 * 1000;
}

/** {@link PAUSA_LOJA_H} as a duration in milliseconds. */
export function pausaLojaH(): number {
  return horasEmMs(PAUSA_LOJA_H);
}

/** {@link PAUSA_FERIAS_H} as a duration in milliseconds. */
export function pausaFeriasH(): number {
  return horasEmMs(PAUSA_FERIAS_H);
}

/**
 * The manual push's own retry ladder: how many attempts ONE listing gets inside
 * a single request.
 *
 * ⚠️ It must stay `<=` {@link STOCK_SEND_MAX_ATTEMPTS}, and a test pins that.
 * The handler decides "is this the last attempt?" from the queue's cap, so a
 * manual ladder longer than the queue's would make the manual push reach a
 * terminal state the queue never can.
 */
export const ENVIO_MANUAL_MAX_TENTATIVAS = 2;

/** The pause between those two attempts, in milliseconds — through `deps.esperar`. */
export const ENVIO_MANUAL_RETRY_DELAY_MS = 1_500;

/**
 * Why a conta is paused — the state document's `pausaMotivo` vocabulary.
 *
 * ⚠️ PERSISTED, so adding a member is cheap and renaming one orphans every row
 * already written. It is deliberately NOT the refusal vocabulary: a pause is a
 * conta-wide state with a deadline, while a refusal is a per-listing verdict,
 * and two of these four (`burst`, `loja-bloqueada`) have no per-listing reading
 * at all. The two that overlap keep the same spelling on purpose, so an operator
 * reading a pause and a refusal sees one word for one condition.
 */
export const MOTIVOS_DE_PAUSA = {
  burst: 'burst',
  cotaDiaria: 'cota-diaria',
  lojaEmFerias: 'loja-em-ferias',
  lojaBloqueada: 'loja-bloqueada',
} as const;

/** The closed set of {@link MOTIVOS_DE_PAUSA} values. */
export type MotivoDePausa = (typeof MOTIVOS_DE_PAUSA)[keyof typeof MOTIVOS_DE_PAUSA];

/* --------------------------- the task-size trio --------------------------- */

/**
 * The Cloud Tasks body budget, re-exported so the chunker has ONE import for
 * every size question.
 *
 * Shared rather than copied for the reason the core's own docblock gives: the
 * number is an arithmetic fact about firebase-admin's enqueue and about Cloud
 * Tasks' limit, not a channel preference, and the failure it prevents is a task
 * REJECTED at enqueue time — a whole page of listings never sent.
 */
export {
  STOCK_TASK_ENCODED_BODY_BUDGET_BYTES,
  STOCK_TASK_ENCODED_BODY_WARN_BYTES,
  stockTaskEncodedBodyBytes,
} from '@delfrance/data/admin/estoque';
