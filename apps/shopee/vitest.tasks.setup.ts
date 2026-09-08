/**
 * Setup for the Shopee Cloud Tasks round-trip suite.
 *
 * ⚠️ ONE file on purpose. Mercado Livre splits this into
 * `vitest.firestore.setup.ts` + `vitest.tasks.setup.ts` because it HAS two
 * emulator lanes; Shopee's Firestore-only lane is step 22's (#1530). Splitting
 * early would mean the gate messages below naming a config file that does not
 * exist — the least useful thing an error can do to someone whose lane just went
 * red.
 *
 * TODO(step 22, #1530): when the Firestore-only lane and
 * `firebase.shopee.json` land, split (2) and (3) below into
 * `vitest.firestore.setup.ts`, have this file import it, and re-aim the
 * Firestore gate's message at that config.
 *
 * Four jobs, each guarding a way this lane could report GREEN while proving
 * nothing.
 */

/**
 * (1) The Firestore fail-loud gate.
 *
 * The round-trip suite is wrapped in a `skipIf` on the emulator variables, so
 * without them it skips — and vitest still exits 0, because its success check
 * counts COLLECTED files, not executed tests. `Shopee Cloud Tasks round trip` is
 * a REQUIRED row in the gate manifest and certifies on `conclusion == success`,
 * so a misconfigured job would be green having asserted nothing. Locally a bare
 * `pnpm test:tasks` should still skip quietly; in CI it must throw.
 *
 * `REQUIRE_EMULATOR` is set by the workflow so the gate does not rely on `CI`
 * alone (a test must not assume its own env — and the inverse failure, a local
 * run silently proving nothing, is real too).
 */
export const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (!EMULATED && (process.env.CI || process.env.REQUIRE_EMULATOR)) {
  throw new Error(
    'test:tasks rodou sem FIRESTORE_EMULATOR_HOST — envolva o comando em ' +
      '`firebase emulators:exec --config firebase.shopee.tasks.json ' +
      '--only firestore,functions,tasks` (veja .github/workflows/ci-shopee.yml).',
  );
}

/**
 * (2) The SECOND fail-loud gate, symmetric with the first.
 *
 * The Firestore half of the skip predicate is guarded above; the Cloud Tasks
 * half would be guarded by nothing. With Firestore up and the tasks emulator
 * absent, the whole suite skips and the job exits 0 — the exact shape caught in
 * review on Mercado Livre's own lane (#1041).
 *
 * Realistic ways it fires: someone trims the run to `--only firestore,functions`,
 * or a firebase-tools bump (the lane pins a version) renames or stops exporting
 * the variable. Neither would turn the lane red on its own.
 */
if (!process.env.CLOUD_TASKS_EMULATOR_HOST && (process.env.CI || process.env.REQUIRE_EMULATOR)) {
  throw new Error(
    'test:tasks rodou sem CLOUD_TASKS_EMULATOR_HOST — envolva o comando em ' +
      '`firebase emulators:exec --config firebase.shopee.tasks.json ' +
      '--only firestore,functions,tasks` (veja .github/workflows/ci-shopee.yml). ' +
      'O emulador de functions também não é opcional: é ele que registra as ' +
      'filas a partir das definições de trigger, então sem ele o enqueue dá 404.',
  );
}

/**
 * (3) Pin the project + database the Admin SDK resolves to.
 *
 * `emulators:exec` exports GCLOUD_PROJECT and FIREBASE_CONFIG, so the project
 * WOULD be found via the last one. Pinning it explicitly stops the lane
 * depending on that CLI detail, and stops a developer's `.env.local`
 * FIREBASE_PROJECT_ID from splitting the emulator into a second namespace
 * mid-run.
 *
 * FIREBASE_DATABASE_ID matters more than it looks: the database is literally
 * named `default`, not `(default)`. In PRODUCTION the wrong id fails every op
 * with `5 NOT_FOUND`; in the EMULATOR `(default)` silently exists and
 * auto-creates — so a mis-targeted database is invisible here, and every
 * "not found" / "empty" / "no errors" assertion would pass against it. That is
 * why the suite must also carry a POSITIVE existence assertion.
 */
if (EMULATED) {
  process.env.FIREBASE_PROJECT_ID = 'demo-erp';
  process.env.FIREBASE_DATABASE_ID ??= 'default';
}

/**
 * (4) The network kill-switch.
 *
 * GitHub runners have egress, so a test that forgets to stub `fetch` would reach
 * the real Shopee Open Platform. Shopee DOES have a sandbox — so, unlike
 * Mercado Livre, the danger is not "there is nowhere safe to call". It is the
 * half that does transfer: the `refresh_token` is SINGLE-USE and rotating, so
 * one unstubbed refresh burns the stored credential of whichever account the
 * env happens to point at, and the ERP cannot get it back without a human
 * re-consenting in a browser. The partner-level calls (`get_shops_by_partner`,
 * the one this codebase's sweep makes) are rate-limited on top of that.
 *
 * This makes "offline" a property of the LANE rather than of each author's
 * diligence.
 *
 * Scoped to non-local hosts so the Admin SDK's own emulator traffic is
 * untouched, and so a test may still stub `fetch` itself (vi.stubGlobal) for a
 * canned Shopee response.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const { hostname } = new URL(url);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    throw new Error(
      `ci-shopee é uma lane OFFLINE — chamada de rede para ${hostname} bloqueada. ` +
        'O refresh_token da Shopee é de USO ÚNICO e rotativo, então uma chamada real ' +
        'aqui queima a credencial de uma conta de verdade e só um humano reautorizando ' +
        'no navegador a recupera. Faça o stub do fetch dentro do teste.',
    );
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;
