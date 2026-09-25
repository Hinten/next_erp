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
 * Both knobs below are read by the App Hosting route at request time, and no
 * queue rate is env-driven for price — the second PR's queue declares its
 * rates as literals — so nothing outside the app regexes this file's text.
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
 * `envInt` reader here. The second PR adds the queue name and the job's knobs
 * to this same file.
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
 * ⚠️ The second PR adds the price queue, and with it the pin that this stays
 * `<=` the queue's attempt cap (step 12's pin, copied): a manual ladder longer
 * than the queue's would reach a terminal state the queue never can.
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
