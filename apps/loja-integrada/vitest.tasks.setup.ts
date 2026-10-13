/**
 * Setup for the Loja Integrada emulator suites (`*.tasks.test.ts`,
 * `*.firestore.test.ts`).
 *
 * ⚠️ ONE file, ONE config (`vitest.tasks.config.ts`). The Firestore-only suites
 * share the round-trip job's emulators, so there is no second setup to split
 * these gates into — and no gate message naming a config file that does not
 * exist, the least useful thing an error can do to someone whose lane just went
 * red.
 *
 * Five jobs, each guarding a way this lane could report GREEN while proving
 * nothing, or reach the platform it must never reach.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The read switch (`core/valvulas.ts`, `CHAMADAS_ENV_LI`). Spelled out here, not
 * imported: this file is a guard on the environment, and a guard must not
 * depend on the module it polices.
 */
const CHAMADAS = 'LOJA_INTEGRADA_CHAMADAS';

/** The generated functions artifact the emulator loads (`prepare-deploy.mjs`). */
const ARTEFATO = fileURLToPath(new URL('../../.deploy/loja-integrada-functions', import.meta.url));

/**
 * (1) The Firestore fail-loud gate.
 *
 * The emulator suites are wrapped in a `skipIf` on the emulator variables, so
 * without them they skip — and vitest still exits 0, because its success check
 * counts COLLECTED files, not executed tests. `Loja Integrada Cloud Tasks round
 * trip` is a REQUIRED row in the gate manifest and certifies on
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
      '`firebase emulators:exec --config firebase.loja-integrada.tasks.json ' +
      '--only firestore,functions,tasks` (veja .github/workflows/ci-loja-integrada.yml).',
  );
}

/**
 * (2) The SECOND fail-loud gate, symmetric with the first.
 *
 * The Firestore half of the skip predicate is guarded above; the Cloud Tasks
 * half would be guarded by nothing. With Firestore up and the tasks emulator
 * absent, the round-trip suite skips and the job exits 0.
 *
 * Realistic ways it fires: someone trims the run to `--only firestore,functions`,
 * or a firebase-tools bump (the lane pins a version) renames or stops exporting
 * the variable. Neither would turn the lane red on its own.
 */
if (!process.env.CLOUD_TASKS_EMULATOR_HOST && (process.env.CI || process.env.REQUIRE_EMULATOR)) {
  throw new Error(
    'test:tasks rodou sem CLOUD_TASKS_EMULATOR_HOST — envolva o comando em ' +
      '`firebase emulators:exec --config firebase.loja-integrada.tasks.json ' +
      '--only firestore,functions,tasks` (veja .github/workflows/ci-loja-integrada.yml). ' +
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
 * why a suite must also carry a POSITIVE existence assertion.
 */
if (EMULATED) {
  process.env.FIREBASE_PROJECT_ID = 'demo-erp';
  process.env.FIREBASE_DATABASE_ID ??= 'default';
}

/**
 * (4) The read switch must NOT be on — in this process or in the artifact.
 *
 * D17: no code of this app calls Loja Integrada before the cutover. Every call
 * goes through the context loader, which refuses unless `LOJA_INTEGRADA_CHAMADAS`
 * is exactly `on`; the lane's job env sets it to `off`, and the round-trip suite
 * asserts the refusal. This is the layer that fails the lane when someone turns
 * the switch on for it.
 *
 * Two places can turn it on, and the kill-switch in (5) reaches neither of the
 * second:
 *
 * - the shell: `emulators:exec` hands its environment to the functions emulator,
 *   which is the process that runs the task handler. Checked here as the exact
 *   value the loader accepts — a stray `ON` or `true` is not `on` to the loader,
 *   so it is not this guard's business.
 * - the artifact's own env files: `prepare-deploy.mjs` copies an operator's
 *   `.env.deploy*` into the artifact, and firebase-tools loads `.env` and
 *   `.env.<project>` from the functions source directory into the functions
 *   emulator. WHETHER such a value overrides the job env inside the emulator is
 *   unverified, so a file that merely NAMES the switch is refused, whatever it
 *   sets it to.
 *
 * ⚠️ The artifact's files are selected by an ANCHORED name — exactly the names
 * `copyDeployEnv` can produce — never by a prefix match: a prefix selection is
 * a denylist, and `env-secrets-no-copy.test.js` fails on it.
 */
if (process.env[CHAMADAS] === 'on') {
  throw new Error(
    `${CHAMADAS}=on no ambiente de test:tasks — a lane de emuladores NUNCA liga a chave ` +
      'de leitura (D17: nenhuma chamada à Loja Integrada antes do cutover). ' +
      `Remova a variável do shell, ou exporte ${CHAMADAS}=off.`,
  );
}

const NOME_DE_ENV_DO_ARTEFATO = /^\.env(?:\.[a-z0-9-]+)?$/;

function arquivosDeEnvDoArtefato(): string[] {
  // No artifact yet: `prepare-deploy.mjs` has not run, so there is no file to
  // police — and the functions emulator has nothing to load either.
  if (!existsSync(ARTEFATO)) return [];
  return readdirSync(ARTEFATO).filter((n) => NOME_DE_ENV_DO_ARTEFATO.test(n));
}

for (const nome of arquivosDeEnvDoArtefato()) {
  if (readFileSync(join(ARTEFATO, nome), 'utf8').includes(CHAMADAS)) {
    throw new Error(
      `${nome} em .deploy/loja-integrada-functions nomeia ${CHAMADAS} — a lane de ` +
        'emuladores recusa um artefato que possa ligar a chave de leitura (D17). ' +
        'Remova a linha do .env.deploy* de apps/loja-integrada/functions e rode ' +
        'prepare-deploy.mjs de novo.',
    );
  }
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
 * worker; the functions emulator runs `.deploy/loja-integrada-functions` in a
 * SIBLING process that never imports this file, so a dispatched function's
 * `fetch` is untouched. What protects that side is the job env's
 * `LOJA_INTEGRADA_CHAMADAS=off` plus the refusals in (4) — and the suites choose
 * paths that stop at the switch, before any client exists.
 *
 * Scoped to non-local hosts so the Admin SDK's own emulator traffic is
 * untouched, and so a test may still stub `fetch` itself (vi.stubGlobal) for a
 * canned answer.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const { hostname } = new URL(url);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    throw new Error(
      `ci-loja-integrada é uma lane OFFLINE — chamada de rede para ${hostname} bloqueada. ` +
        'Nenhum código desta app chama a Loja Integrada antes do cutover (D17). ' +
        'Faça o stub do fetch dentro do teste.',
    );
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;
