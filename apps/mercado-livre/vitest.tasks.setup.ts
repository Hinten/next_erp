/**
 * Setup for the Cloud Tasks round-trip suite.
 *
 * Everything `vitest.firestore.setup.ts` does applies here too — the fail-loud
 * Firestore gate, the pinned project/database, the outbound-fetch kill-switch —
 * so import it for its side effects rather than duplicating it.
 */
import './vitest.firestore.setup';

/**
 * The SECOND fail-loud gate, and the reason this file exists.
 *
 * `route.tasks.test.ts` skips on `!EMULATED || !TASKS`. The Firestore half of
 * that predicate is guarded by the imported setup; the Cloud Tasks half was
 * guarded by nothing. So with Firestore up and the tasks emulator absent, the
 * whole suite skipped and the job exited 0 — and `ML Cloud Tasks round trip` is
 * a **required** row in the gate manifest, which certifies on
 * `conclusion == success`. A required check that can go green having asserted
 * nothing is exactly what this lane, its header, and `ci-lane-gates.test.js`
 * exist to prevent; it shipped here anyway (caught in review on #1041).
 *
 * Realistic ways it would have fired silently: someone trims the run to
 * `--only firestore,functions`, or a firebase-tools bump (the lane pins 15.15.0)
 * renames or stops exporting the variable. Neither would turn the lane red.
 *
 * ⚠️ The message names THIS suite's config and emulator set. The Firestore
 * gate's message points at `firebase.mercado-livre.json --only firestore`,
 * which for a failing `test:tasks` run is both the wrong config and the wrong
 * emulators.
 */
if (!process.env.CLOUD_TASKS_EMULATOR_HOST && (process.env.CI || process.env.REQUIRE_EMULATOR)) {
  throw new Error(
    'test:tasks ran without CLOUD_TASKS_EMULATOR_HOST — wrap it in ' +
      '`firebase emulators:exec --config firebase.mercado-livre.tasks.json ' +
      '--only firestore,functions,tasks` (see .github/workflows/ci-mercado-livre.yml). ' +
      'The functions emulator is not optional either: it is what registers the ' +
      'queues from the trigger definitions, so without it the enqueue 404s.',
  );
}
