/**
 * Setup for the Amazon emulator suites (`*.tasks.test.ts`,
 * `*.firestore.test.ts`), run only by `ci-amazon.yml` (step-3 plan PR 3-e).
 *
 * ⚠️ ONE file, ONE config (`vitest.tasks.config.ts`). The Firestore-only suite
 * shares the round-trip job's emulators, so there is no second setup to split
 * these gates into — and no gate message naming a config file that does not
 * exist.
 *
 * Five jobs, each guarding a way this lane could report GREEN while proving
 * nothing, or reach the platform it must never reach (D11). The two D11
 * refusals in (4) are pure functions in `lib/amazon/testing/guardaDaLaneDeTarefas.ts`,
 * proved offline by its unit test — this file only throws on their answer.
 */
import {
  CHAVE_DE_CHAMADAS_DA_LANE,
  chamadasLigadasNoAmbiente,
  envsDoArtefatoQueNomeiamAChave,
} from './lib/amazon/testing/guardaDaLaneDeTarefas';

/**
 * (1) The Firestore fail-loud gate.
 *
 * The emulator suites are wrapped in a `skipIf` on the emulator variables, so
 * without them they skip — and vitest still exits 0, because its success check
 * counts COLLECTED files, not executed tests. `Amazon Cloud Tasks round trip`
 * is a REQUIRED row in the gate manifest and certifies on
 * `conclusion == success`, so a misconfigured job would be green having
 * asserted nothing. Locally a bare `pnpm test:tasks` should still skip quietly;
 * in CI it must throw.
 *
 * `REQUIRE_EMULATOR` is set by the workflow so the gate does not rely on `CI`
 * alone (a test must not assume its own env — and the inverse failure, a local
 * run silently proving nothing, is real too).
 */
export const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (!EMULATED && (process.env.CI || process.env.REQUIRE_EMULATOR)) {
  throw new Error(
    'test:tasks rodou sem FIRESTORE_EMULATOR_HOST — envolva o comando em ' +
      '`firebase emulators:exec --config firebase.amazon.tasks.json ' +
      '--only firestore,functions,tasks` (veja .github/workflows/ci-amazon.yml).',
  );
}

/**
 * (2) The SECOND fail-loud gate, symmetric with the first.
 *
 * The Firestore half of the skip predicate is guarded above; the Cloud Tasks
 * half would be guarded by nothing. With Firestore up and the tasks emulator
 * absent, the round-trip suites skip and the job exits 0.
 *
 * Realistic ways it fires: someone trims the run to `--only firestore,functions`,
 * or a firebase-tools bump (the lane pins a version) renames or stops exporting
 * the variable. Neither would turn the lane red on its own.
 */
if (!process.env.CLOUD_TASKS_EMULATOR_HOST && (process.env.CI || process.env.REQUIRE_EMULATOR)) {
  throw new Error(
    'test:tasks rodou sem CLOUD_TASKS_EMULATOR_HOST — envolva o comando em ' +
      '`firebase emulators:exec --config firebase.amazon.tasks.json ' +
      '--only firestore,functions,tasks` (veja .github/workflows/ci-amazon.yml). ' +
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
 * why every suite also carries a POSITIVE existence assertion before any
 * absence it claims.
 */
if (EMULATED) {
  process.env.FIREBASE_PROJECT_ID = 'demo-erp';
  process.env.FIREBASE_DATABASE_ID ??= 'default';
}

/**
 * (4) The read switch must NOT be on — in this process or in the artifact.
 *
 * D11: no code of this app calls Amazon before the cutover. Every call goes
 * through the read switch, which refuses unless `AMAZON_CHAMADAS` is exactly
 * `on`; the lane's job env sets it to `off`, and the round-trip suites assert
 * the refusal. This is the layer that fails the lane when someone turns the
 * switch on for it. The suites that run PAST the switch (the resolve case of
 * `notificacao.firestore.test.ts`, and the backstop poll's two suites, which
 * serve `searchOrders` from a scripted `deps.fetch`) do it in this process, with
 * the switch `on` in an object literal they pass as `ambiente` — never through
 * the environment.
 *
 * Two places can turn it on, and the kill-switch in (5) reaches neither:
 *
 * - the shell: `emulators:exec` hands its environment to the functions emulator,
 *   which is the process that runs the task handler;
 * - the artifact's own env files, which firebase-tools loads into the functions
 *   emulator — refused when a file merely NAMES the switch, whatever it sets it
 *   to (the guard module's header says why).
 */
if (chamadasLigadasNoAmbiente(process.env)) {
  throw new Error(
    `${CHAVE_DE_CHAMADAS_DA_LANE}=on no ambiente de test:tasks — a lane de emuladores NUNCA ` +
      'liga a chave de leitura (D11: nenhuma chamada à Amazon antes do cutover). ' +
      `Remova a variável do shell, ou exporte ${CHAVE_DE_CHAMADAS_DA_LANE}=off.`,
  );
}

const envsQueNomeiamAChave = envsDoArtefatoQueNomeiamAChave();
if (envsQueNomeiamAChave.length > 0) {
  throw new Error(
    `${envsQueNomeiamAChave.join(', ')} em .deploy/amazon-functions nomeia(m) ` +
      `${CHAVE_DE_CHAMADAS_DA_LANE} — a lane de ` +
      'emuladores recusa um artefato que possa ligar a chave de leitura (D11). ' +
      'Remova a linha do .env.deploy* de apps/amazon/functions e rode ' +
      'prepare-deploy.mjs de novo.',
  );
}

/**
 * (5) The network kill-switch.
 *
 * GitHub runners have egress, so a test that forgets to stub `fetch` would reach
 * the real platform. The read switch in (4) is what keeps the app's own code
 * from ever building a client; this is the second, independent layer for the
 * code a test itself runs.
 *
 * ⚠️ It covers THIS process only. `setupFiles` are loaded into the vitest
 * worker; the functions emulator runs `.deploy/amazon-functions` in a SIBLING
 * process that never imports this file, so a dispatched function's `fetch` is
 * untouched. What protects that side is the job env's `AMAZON_CHAMADAS=off`
 * plus the refusals in (4) — and the suites choose paths that stop at the
 * switch, before any client exists.
 *
 * Scoped to non-local hosts so the Admin SDK's own emulator traffic is
 * untouched, and so a test may still hand a scripted `fetch` to the code it
 * runs. ⚠️ The IPv6 loopback is `[::1]`, brackets included: WHATWG
 * `URL.hostname` keeps them on an IPv6 literal, so a bare `'::1'` never matches.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const { hostname } = new URL(url);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new Error(
      `ci-amazon é uma lane OFFLINE — chamada de rede para ${hostname} bloqueada. ` +
        'Nenhum código desta app chama a Amazon antes do cutover (D11). ' +
        'Faça o stub do fetch dentro do teste.',
    );
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;
