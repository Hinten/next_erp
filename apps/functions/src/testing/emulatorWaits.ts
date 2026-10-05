import { appendFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Shared pollers for the `*.storage.test.ts` suite, which asserts on rows written
 * by the REAL triggers running in the functions emulator. Those land
 * asynchronously, so every such assertion has to wait for an Eventarc delivery.
 *
 * ⚠️ TEST-ONLY. Nothing under `src/` that production imports may reach this file.
 * It is safe here because the deploy artifact is `.deploy/functions`, which
 * `scripts/prepare-deploy.mjs` produces by esbuild-bundling `src/index.ts`
 * (`build.mjs`) — source files are never copied, so a module outside that entry's
 * import graph cannot ship. Living under `src/` is deliberate: it is the only way
 * the file is covered by `tsconfig.json`'s `include` and eslint's `typeAware`
 * glob, and an untypechecked test helper is how the nfe package lost 55 files.
 *
 * ─── Why these numbers, and why ONE of each (#1201) ──────────────────────────
 *
 * This replaces five near-duplicate pollers that had drifted to THREE different
 * deadlines (15s/20s/20s) and TWO step intervals (250ms/500ms). That divergence
 * was the bug: 210 measured delivery samples over 6 full runs put the worst
 * observed delivery at 10712ms, and the file carrying the SHORTEST deadline
 * (15s, `pedidoHistory`) was the one absorbing the LONGEST tail — a 1.40x margin.
 *
 * That pairing was an accident of Vitest's file ordering, not a design: the file
 * that eats the run's first (slowest) deliveries is whichever the sequencer runs
 * first, which would shift on a Vitest upgrade or a rename. One constant for the
 * whole family is what stops the unluckiest file from also being the one with the
 * tightest budget.
 *
 * The measurement also settled what the flake IS: across 210 samples in the
 * suite's normal (deterministic) order, every wait was eventually satisfied — so
 * in everything reproducible it is LATENCY, not dropped delivery. The tail is
 * densest on a run's first deliveries but is not only cold start (dropping the
 * first 6 samples per run still leaves p99 = 7083ms), and it is load-sensitive —
 * the same samples grew from ~4s to ~9.4s on one box as it got busier. Hence a
 * deadline with real headroom rather than a warm-up, which measurement showed
 * cuts p90 9x but the max only 1.3x.
 *
 * ⚠️ ONE observation this does NOT explain, recorded so the next person does not
 * assume it away. Running the suite with `--sequence.shuffle.files=true` (which
 * nothing in this repo does — it was a check that ordering no longer decides who
 * fails) produced, in 1 of 4 runs, a wait that exceeded 45s reporting "nothing had
 * arrived", in a run where the trigger had already fired 231 times and another
 * wait had succeeded at 20459ms. Three follow-up shuffled runs with the deadline
 * temporarily raised to 300s all passed with a max of 25508ms, so it did NOT
 * reproduce and could not be classified as slow-vs-lost. Treat "never dropped" as
 * proven for the ORDER THIS SUITE ACTUALLY RUNS IN, and open for shuffled order.
 *
 * ⚠️ The deadline is bounded from ABOVE, so it cannot simply be maximised. A
 * test aborts at its FIRST failing wait, so a regression that broke delivery
 * entirely costs ONE deadline per polling test — ~20 of them, so ~15 min at 45s
 * plus ~2.5 min for the rest of the suite. `ci-storage.yml` gives the
 * storage-emulator job `timeout-minutes: 35` against an observed green run of
 * 3.9 min, which covers that. Do not raise this constant without redoing that
 * arithmetic: a job killed by `timeout-minutes` reports `cancelled`, which is
 * indistinguishable from the benign push-over-push cancel that
 * `concurrency: cancel-in-progress` produces all day — a real breakage would
 * then look like routine noise.
 *
 * ⚠️ 45s rather than the 30s this PR first tried, and the trace below is why.
 * The first instrumented run of the migrated suite recorded an `estado-trail`
 * wait of 18831ms — nearly 2x the 10712ms worst case measured while the box was
 * idle — because that run shared the machine with a build. 30s would have been a
 * 1.6x margin on a number the same afternoon produced. This is the load
 * sensitivity the issue is about, so the constant is set against the LOADED
 * observation, not the quiet one.
 */
export const TRIGGER_DELIVERY_TIMEOUT_MS = 45_000;

/** Poll interval. The finer of the two the old copies used; detection cost is nil. */
export const TRIGGER_POLL_STEP_MS = 250;

/**
 * Default window for the bounded negatives below.
 *
 * ⚠️ This is NOT a delivery deadline and must never be scaled with one. See
 * `expectNoRowForEvent`.
 */
export const INTRA_HANDLER_WINDOW_MS = 2_000;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The CLOSED set of things a wait may be labelled as in the delivery trace.
 *
 * ⚠️ This is a union, not `string`, on purpose — it is the *mechanical* half of
 * the "a trace line names no identifier" rule below. A call site physically
 * cannot pass `` `rows-${pedidoId}` ``: tsc rejects it, and `turbo run typecheck`
 * is a CI gate. A convention held by comment alone is one hurried debugging
 * session away from a pedido id in a public log.
 */
export const WAIT_LABELS = {
  historicoDeModificacoes: 'historico-de-modificacoes',
  estadoTrail: 'estado-trail',
  freteTrail: 'frete-trail',
  arquivoDoc: 'arquivo-doc',
  derivativeObject: 'derivative-object',
  uploadFinalized: 'upload-finalized',
} as const;

export type WaitLabel = (typeof WAIT_LABELS)[keyof typeof WAIT_LABELS];

/*
 * ─── Delivery-time instrumentation (opt-in) ──────────────────────────────────
 *
 * Set `STORAGE_TRIGGER_DELIVERY_LOG` to a file path and every satisfied wait
 * appends `<label>\t<elapsedMs>`. Unset (the default, and what every CI lane
 * does) it is inert.
 *
 * This exists because answering "latency or dropped delivery?" for #1201 required
 * hand-patching all five pollers, and the next person should not have to.
 *
 * ⚠️ The line carries a STATIC label and an integer, and nothing else. No
 * document id, pedido id, object path or payload ever goes in — call sites pass
 * literals. This repo has already leaked a CNPJ into a public CI log; a debug
 * channel that quietly accumulates identifiers is how that happens twice.
 *
 * Deliberately no try/catch: a bad path is a developer typo in an opt-in flag and
 * should fail loudly rather than silently record nothing (and the repo bans
 * generic catch anyway). The append runs once per SATISFIED wait, never inside
 * the poll loop, so it cannot perturb the timing it measures.
 */
let deliveryLogChecked = false;

function recordDelivery(label: WaitLabel | undefined, elapsedMs: number): void {
  const path = process.env.STORAGE_TRIGGER_DELIVERY_LOG;
  if (!path || label === undefined) return;
  if (!deliveryLogChecked) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      throw new Error(
        `STORAGE_TRIGGER_DELIVERY_LOG points at '${path}', whose directory '${dir}' does not exist.`,
      );
    }
    deliveryLogChecked = true;
  }
  appendFileSync(path, `${label}\t${elapsedMs}\n`);
}

export interface WaitForTriggerOptions {
  timeoutMs?: number;
  stepMs?: number;
  /**
   * Which wait this is, for the delivery trace. Typed as a closed union so an
   * identifier cannot be smuggled in. Omit it and this wait is not recorded.
   */
  label?: WaitLabel;
}

/**
 * Poll `read()` until `isReady`, or throw naming what was awaited AND what was
 * last actually seen.
 *
 * `describe` is not decoration: the pollers this replaces earned their keep in
 * their failure messages (`saw ${snap.size}`), and collapsing them into a bare
 * "timed out" would trade a diagnosis for a shrug.
 */
export async function waitForTrigger<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  what: string,
  describe: (value: T) => string,
  {
    timeoutMs = TRIGGER_DELIVERY_TIMEOUT_MS,
    stepMs = TRIGGER_POLL_STEP_MS,
    label,
  }: WaitForTriggerOptions = {},
): Promise<T> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    const value = await read();
    if (isReady(value)) {
      recordDelivery(label, Date.now() - started);
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what} after ${timeoutMs}ms; ${describe(value)}`);
    }
    await sleep(stepMs);
  }
}

export interface WaitForTriggerThenSettleOptions extends WaitForTriggerOptions {
  quietMs?: number;
}

/**
 * `waitForTrigger`, then hold still for `quietMs` and RE-READ before returning.
 *
 * ⚠️ The quiet window is load-bearing — it is what lets an EXACT-count assertion
 * fail. Returning on the first poll that satisfies the minimum hands back a
 * snapshot that can predate a later row, so "the trail is exactly these rows"
 * would pass by arriving early rather than by being true. Use this wherever the
 * caller asserts a total, and `waitForTrigger` where it asserts a presence.
 */
export async function waitForTriggerThenSettle<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  what: string,
  describe: (value: T) => string,
  { quietMs = INTRA_HANDLER_WINDOW_MS, ...rest }: WaitForTriggerThenSettleOptions = {},
): Promise<T> {
  await waitForTrigger(read, isReady, what, describe, rest);
  await sleep(quietMs);
  return read();
}

/**
 * Bounded negative: assert a trail never gains a row carrying `eventId`,
 * re-reading across `windowMs`.
 *
 * Why not a single read. The pedido trigger launches every trail's write
 * concurrently (one `Promise.all` in `registrarHistoricoPedido.ts`), so seeing
 * ONE trail's row proves the trigger RAN for that CloudEvent — it does NOT prove
 * that a (wrongly emitted) row in another trail for the same event has finished
 * landing. A one-shot read could slip between the two `set()`s and pass in
 * exactly the regressed case this exists to catch. Re-reading across a window
 * closes that while staying event-id-keyed, so it can never be satisfied by an
 * unrelated row, and it fails on the first tick that sees one instead of after
 * the whole window.
 *
 * ⚠️ `windowMs` measures INTRA-HANDLER write concurrency, not delivery latency,
 * and must NOT be scaled with `TRIGGER_DELIVERY_TIMEOUT_MS`. The caller has
 * already proven the handler ran for this event by observing the positive row;
 * what remains is the gap between two `set()`s issued together inside one
 * invocation, which is milliseconds. Scaling it would only make the suite slower
 * while proving nothing more.
 *
 * ⚠️ `keyOf` is EXPLICIT, and deliberately not defaulted, because the two copies
 * this replaces keyed on different things: one on the row's document id
 * (`d.id === eventId`), the other on a field (`r.eventId === eventId`). Both were
 * correct for their own caller — the rows are stored AT `entry.eventId`, so the
 * doc id and the field carry the same value. But a merged signature that guesses
 * (say, always reading `.eventId`) turns the other caller's rows into
 * `undefined === eventId`, which is false for every row forever: the negative
 * assertion would pass unconditionally, and nothing would ever report it. Making
 * each call site name its own key is what keeps that silent pass impossible.
 */
export async function expectNoRowForEvent<T>(
  readRows: () => Promise<T[]>,
  keyOf: (row: T) => unknown,
  eventId: string,
  windowMs = INTRA_HANDLER_WINDOW_MS,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const rows = await readRows();
    if (rows.some((row) => keyOf(row) === eventId)) {
      throw new Error(`a row keyed on event '${eventId}' was written, and must not have been`);
    }
    if (Date.now() >= deadline) return;
    await sleep(Math.min(TRIGGER_POLL_STEP_MS, windowMs));
  }
}
