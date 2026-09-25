/**
 * Every ERP-side bound, the three probe-settled wire decisions and the manual
 * push's two tunables of the Shopee PRICE sync (#1521, step 13) — the
 * `precos/` folder's ONE environment reader family.
 *
 * ⚠️ **The only module under `precos/` that reads the environment**, and it
 * does so exclusively through `envInt` from `@delfrance/data/admin/estoque` —
 * the family step 12's `estoque/constantesEstoque.ts` uses, which treats a
 * blank value as unset and a non-integer or negative one as the default. The
 * folder's raw-text discipline grep exempts THIS file from its environment
 * check and no other, so a second reader anywhere under `precos/` reds that
 * gate. It is the app's THIRD reader family (after `lib/shopee/env.ts` and the
 * stock constants), and every read is LAZY: a test may stub the environment
 * after import, and a rehearsal retunes with a redeploy instead of a patch.
 *
 * ⚠️ **Not path-bound to the deploy preflight**, unlike the stock constants.
 * The two manual knobs are read by the App Hosting route at request time, the
 * two job knobs by the functions codebase at dispatch time, and no queue rate
 * is env-driven for price — the price queue declares its rates as literals —
 * so nothing outside the app regexes this file's text.
 *
 * ⚠️ **The three wire decisions are CONSTANTS, never env knobs.** Each was
 * settled by the SG sandbox probe of 2026-09-24 (`probe-step13-results.md`,
 * the P-lines each docblock cites), and flipping one changes what is WRITTEN to
 * a live marketplace — a one-literal code change reviewed as such, never a
 * runtime switch an operator could turn without a review.
 *
 * The rule the module holds is step 12's: a bound the WIRE states lives in
 * `@delfrance/integrations-shopee` and is imported; a bound WE chose lives
 * here; a value an operator may change without a code deploy is a lazy
 * `envInt` reader here. The account-wide job (the second PR) keeps its queue
 * name, its bounds and its two knobs in this same file.
 */
import { envInt } from '@delfrance/data/admin/estoque';

import { concurrentDispatches } from '../estoque/constantesEstoque';

/* ------------------------- the three wire decisions ------------------------ */

/**
 * The `model_id` a NO-MODEL item carries in `update_price`'s `price_list`.
 *
 * Probe **P4/P6**: on an item without variations Shopee accepts BOTH
 * `model_id: 0` and an omitted key, and the read-back equals the request either
 * way — so `0` stays, the spelling the package's validator admits (and admits
 * only when it rides ALONE in the list).
 *
 * ⚠️ The ECHO is not the request. P4c measured the success entry of a no-model
 * item carrying NO `model_id` key at all, so whoever matches the echo maps an
 * ABSENT (`null`) `model_id` back to this value — never `=== 0` on the echo
 * side, which would find nothing and report a landed write as unanswered.
 *
 * ⚠️ Never a truthiness test on a model id anywhere downstream: `0` is a
 * legitimate id at every hop, and a `{...(id ? { model_id: id } : {})}` spread
 * silently turns the simplest listing there is into a malformed body. Should
 * Shopee ever require the omission, the flip is this literal plus the ONE
 * branch that builds the no-model entry.
 */
export const SHOPEE_PRECO_MODEL_ID_SEM_MODELO = 0;

/**
 * Whether `price_list` carries ONLY the models whose price changed (`true`) or
 * every live linked model that has a price (`false`).
 *
 * Probe **P8**: a partial `price_list` on a two-model item left the UNSENT
 * sibling's price intact (`m2Preservado: true`) and the echo equalled the
 * request — so the diff is safe and it STANDS. This was the first PR's
 * pre-merge blocker: had Shopee reset an unsent sibling, the diff would have
 * wiped every unchanged model's price on the first send.
 *
 * ⚠️ The diff narrows what is WRITTEN, never what is JUDGED. Shopee evaluates
 * its max/min ratio between variations against the unsent siblings' CURRENT
 * prices as well (probe P11b), so the pre-wire ratio check still reads every
 * model of the item, sent or not.
 *
 * Annotated `boolean` rather than left as the literal `true`, so the flipped
 * branch stays a live, type-checked path instead of one the compiler narrows
 * away.
 */
export const PRICE_LIST_SO_A_DIFERENCA: boolean = true;

/**
 * Where the post-send verification reads the price it compares with the
 * target: the `update_price` ECHO (`'eco'`) or a fresh read-back
 * (`'releitura'`).
 *
 * Probes **P4/P8**: on every accepted write the echo, the request and a
 * read-back all agreed, so the echo is sufficient and a read-back's extra call
 * per item — on the per-APPLICATION quota every conta shares — buys nothing
 * that was measured.
 *
 * ⚠️ What the echo can NOT prove, stated so nobody reads more into it: that the
 * stored value equals the echoed one on a shop where the two would differ.
 * Should a later measurement find them diverging, the flip is this literal;
 * the re-read seam already exists in the verifier. Also measured (P5): a price
 * write does NOT move `update_time`, so that clock can stand in for neither
 * source.
 */
export const FONTE_DE_VERIFICACAO_PRECO: 'eco' | 'releitura' = 'eco';

/* ------------------------------- the bounds -------------------------------- */

/**
 * How many produtos ONE manual price request may ask for — counted AFTER the
 * dedupe, and REFUSED over the cap (400 with `limite` and `solicitados`),
 * never silently truncated: a truncating cap answers 200 for work it never did.
 *
 * ⚠️ Its own constant, never the stock push's. This channel already holds
 * several bounds that read 50 — models per write call (the wire's, in the
 * package), models per item (the package's create-side bound), produtos per
 * manual STOCK request — and they agree today by coincidence alone. A request
 * cap is part of the route's contract (it appears in a 400 body), not
 * configuration, so it is not an env knob either.
 */
export const SHOPEE_ENVIO_PRECO_MAX_PRODUTOS = 50;

/**
 * The manual push's own retry ladder: how many attempts ONE item gets inside a
 * single request.
 *
 * Only a THROWN error retries — a transient or unclassified failure. A
 * classified refusal is an ANSWER, and asking again spends the shared quota to
 * hear it twice.
 *
 * ⚠️ It stays `<=` {@link ENVIO_PRECO_MAX_TENTATIVAS}, the price queue's
 * attempt cap (step 12's pin, copied): a manual ladder longer than the queue's
 * would reach a terminal state the queue never can.
 */
export const ENVIO_PRECO_MANUAL_MAX_TENTATIVAS = 2;

/**
 * The pause between those attempts, in milliseconds — spent through the
 * injected `esperar`, never through a timer of this folder's own.
 */
export const ENVIO_PRECO_MANUAL_RETRY_DELAY_MS = 1_500;

/* ------------------------ the manual push's tunables ----------------------- */

/**
 * The floor under {@link manualDeadlineMsPreco}, in milliseconds.
 *
 * `envInt` accepts `0` as a valid integer, and a zero (or few-millisecond)
 * budget would answer EVERY item `tempo-esgotado` without a single call — a
 * misconfiguration that reads to the operator as "Shopee was slow". Nothing
 * useful completes in under a second, so the reader clamps up to this.
 */
const PRAZO_MANUAL_MINIMO_MS = 1_000;

/**
 * The manual price push's budget, in milliseconds —
 * `SHOPEE_PRICE_MANUAL_DEADLINE_MS`, default 120 000, floored at
 * {@link PRAZO_MANUAL_MINIMO_MS}. An ELAPSED-clock bound, measured on the
 * injected `agora`, never on the logical `nowMs`.
 *
 * It sits below the App Hosting request ceiling (`runConfig.timeoutSeconds`,
 * 180 s) so what normally ends a long manual push is this deadline — which
 * answers a rendered envelope with `tempo-esgotado` rows — and not the
 * platform, which answers nothing at all.
 *
 * ⚠️ That guarantee is per ITEM, not per request, for step 12's reason: the
 * budget is checked BETWEEN items and the transport sets no fetch timeout, so
 * a call hanging inside an item already started is bounded only by the
 * platform. The gap up to 180 s is headroom for the last item's ladder, not a
 * bound.
 *
 * Its OWN knob rather than the stock push's, so the two routes retune apart.
 */
export function manualDeadlineMsPreco(): number {
  return Math.max(PRAZO_MANUAL_MINIMO_MS, envInt('SHOPEE_PRICE_MANUAL_DEADLINE_MS', 120000));
}

/**
 * The manual price push's concurrency — `SHOPEE_PRICE_MANUAL_CONCURRENCY`
 * (default 2), CLAMPED into `[1, concurrentDispatches()]`.
 *
 * ⚠️ The ceiling is the STOCK queue's width, imported and never re-read under
 * another name. Shopee's rate limit is per APPLICATION, so every conta's stock
 * queue and every operator's manual push spend one quota, and that width is the
 * only one this channel has rehearsed: an operator-triggered push must not
 * out-spend the queue it runs beside, so a raw 99 is served at the queue's
 * width. The floor is 1 because a width of 0 would run nothing and answer an
 * envelope as if every item had been considered.
 *
 * ⚠️ Clamped HERE, where step 12 exposes the raw reader and clamps in its
 * manual module. The seam names this one function, so no caller can read the
 * unclamped value by mistake — there is nothing else to read.
 */
export function concorrenciaEnvioPrecoManual(): number {
  return Math.max(
    1,
    Math.min(envInt('SHOPEE_PRICE_MANUAL_CONCURRENCY', 2), concurrentDispatches()),
  );
}

/* ------------------------ the account-wide job (PR 2) ---------------------- */

/**
 * The deployed `onTaskDispatched` name of the price job — which is ALSO its
 * auto-provisioned Cloud Tasks queue name, the app's FOURTH queue. Declared
 * here, in a module with no Functions SDK import, so the scheduler, the job and
 * the functions entry all read one spelling; the entry asserts the pair at
 * module load (its rename-safety check).
 */
export const SHOPEE_PRICE_SYNC_QUEUE = 'processShopeePriceSync';

/**
 * The job's in-task attempt cap — kept equal to the queue's
 * `retryConfig.maxAttempts`, and `>=` {@link ENVIO_PRECO_MANUAL_MAX_TENTATIVAS}
 * (the manual ladder must never outlast the queue's). On the LAST attempt an
 * otherwise-retryable failure stamps the job `failed` instead of rethrowing,
 * because nothing re-drives a task the queue has dropped.
 */
export const ENVIO_PRECO_MAX_TENTATIVAS = 3;

/**
 * How many BURST rate-limit pauses one run may take before it fails — each is a
 * delayed self re-enqueue that consumes no attempt, so without a ceiling a conta
 * that keeps throttling would chain delayed tasks for ever.
 */
export const ENVIO_PRECO_MAX_PAUSAS = 50;

/**
 * How many DAILY-quota parks one run may take before it fails. A park holds the
 * conta's one-active slot until the next 00:00 (UTC+8), so three rollovers is
 * already three days of a job that has not finished; cancel is the operator's
 * exit before that.
 */
export const ENVIO_PRECO_MAX_PARQUES = 3;

/** Milliseconds per second, minute and hour — the units the bounds below are written in. */
const MS_POR_SEGUNDO = 1_000;
const SEGUNDOS_POR_MINUTO = 60;
const MINUTOS_POR_HORA = 60;
const MS_POR_HORA = MINUTOS_POR_HORA * SEGUNDOS_POR_MINUTO * MS_POR_SEGUNDO;

/**
 * A `running` job whose `updatedAt` is older than this is an ORPHAN — a crash
 * bypassed every terminal stamp — and the next start reclaims it instead of
 * refusing with 409 for ever. Six hours is far beyond one dispatch (300 s) times
 * the queue's whole ladder. ⚠️ A PARKED job is exempt while its `retomarEm`
 * lies ahead (the job module's orphan predicate): its `updatedAt` legitimately
 * stops moving for up to a day.
 */
export const ENVIO_PRECO_ORFAO_MS = 6 * MS_POR_HORA;

/** The `skips` sample's cap on the job document — the counters stay exact. */
export const AMOSTRA_PULOS_CAP = 200;

/** The `failures` sample's cap on the job document — the counters stay exact. */
export const AMOSTRA_FALHAS_CAP = 100;

/**
 * The upper bound, in SECONDS, of the jitter added to a park's re-enqueue delay,
 * so a fleet of contas parked on the same rollover does not resume in the same
 * second. The randomness itself is the functions entry's (`jitterSec`): a module
 * that drew its own could not be tested for the delay it computed.
 */
export const PARQUE_JITTER_MAX_S = 30;

/** The clamp of {@link pageLimitPreco}: a page never exceeds the wire's own batch of fifty. */
const PAGINA_DE_PRECO_MAXIMA = 50;

/**
 * Anchors the job PLANS per dispatch — `SHOPEE_PRICE_PAGE_LIMIT`, default 25,
 * clamped into `[1, 50]`.
 *
 * The page bounds what one plan write carries: every listing of every anchor on
 * the page lands in `fila` in ONE checkpoint, and the job document is rewritten
 * after every drained item, so a wide page is a large document written many
 * times. A zero would plan nothing and walk no further, so the floor is 1.
 */
export function pageLimitPreco(): number {
  return Math.min(PAGINA_DE_PRECO_MAXIMA, Math.max(1, envInt('SHOPEE_PRICE_PAGE_LIMIT', 25)));
}

/** The clamp of {@link itensPorDespachoPreco}. */
const ITENS_POR_DESPACHO_MAXIMO = 10;

/**
 * Listings the job SENDS per dispatch — `SHOPEE_PRICE_ITEMS_PER_DISPATCH`,
 * default 10, clamped into `[1, 10]`.
 *
 * Budget arithmetic, stated rather than discovered: per item one masked
 * `precos` read, at most one `get_model_list`, one `update_price`, the link
 * write-backs and the per-item checkpoint — a worst case of ≈ 20 s, so the
 * CEILING spends ≈ 200 s of the queue's 300 s timeout, inside the 70 % budget
 * a test pins — so NO value the knob accepts can outrun the timeout. The
 * default IS the ceiling; the knob only goes DOWN. Raising the ceiling is a
 * decision on a MEASURED per-item time (the step's open register item), never
 * an env change: a dispatch that runs out of time is killed mid-item and
 * retried from its last per-item checkpoint.
 */
export function itensPorDespachoPreco(): number {
  return Math.min(
    ITENS_POR_DESPACHO_MAXIMO,
    Math.max(1, envInt('SHOPEE_PRICE_ITEMS_PER_DISPATCH', 10)),
  );
}
