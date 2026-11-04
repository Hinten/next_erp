/**
 * The D11 refusals of the emulator lane (`ci-amazon.yml`), as pure functions —
 * for `vitest.tasks.setup.ts` and its own unit test ONLY (the `fakeDb.ts` rule:
 * nothing in production imports `testing/`, `estrutura.test.ts`).
 *
 * Why a module and not inline code in the setup: the setup is a side-effect
 * file that THROWS on import under `CI` without an emulator host, so no offline
 * test could import it to prove its refusals. These functions are what it runs,
 * and `guardaDaLaneDeTarefas.test.ts` proves them in `CI test`, where every
 * Amazon unit test runs unfiltered.
 *
 * The lane's dispatched function runs in the FUNCTIONS EMULATOR, a sibling of
 * the vitest process that the setup's fetch kill-switch never reaches. What
 * keeps it from calling Amazon is the read switch being off there (D11's
 * second layer, step-3 plan §3 decision 37), and two things could turn it on:
 *
 *  - the shell, which `emulators:exec` hands to the functions emulator: refused
 *    when the switch is EXACTLY `on`, the one value the loader accepts
 *    (`core/valvulas.ts`); `ON` or ` on` are off to the loader too;
 *  - an env file in the generated artifact: `prepare-deploy.mjs` copies an
 *    operator's `.env.deploy*` there, and firebase-tools loads `.env`,
 *    `.env.<project>` and `.env.local` from the functions source into the
 *    functions emulator. WHETHER such a value overrides the job env inside the
 *    emulator is unverified, so a file that merely NAMES the switch is refused,
 *    whatever value it sets and even commented out: a value check would need an
 *    env parser (quoting, `export`, CRLF) that a substring check does not
 *    (Loja Integrada's rule, step-3 plan review row 10).
 *
 * ⚠️ The artifact's files are selected by an ANCHORED name — the shapes
 * `copyDeployEnv` can produce and firebase-tools loads — never by a prefix: a
 * prefix selection is a denylist, and `env-secrets-no-copy.test.js` fails on it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The read switch's name. Spelled out here, NOT imported from
 * `core/valvulas.ts`: this is a guard on the environment, and a guard must not
 * depend on the module it polices. `guardaDaLaneDeTarefas.test.ts` pins the
 * two spellings equal.
 */
export const CHAVE_DE_CHAMADAS_DA_LANE = 'AMAZON_CHAMADAS';

/**
 * The generated functions artifact the emulator loads — the `source` of
 * `firebase.amazon.tasks.json` (pinned by the unit test), at the repo root.
 */
export const DIRETORIO_DO_ARTEFATO_AMAZON = fileURLToPath(
  new URL('../../../../../.deploy/amazon-functions', import.meta.url),
);

/** `.env` or `.env.<one lowercase segment>`: `.env.deploy`, `.env.demo-erp`, `.env.local`. */
export const NOME_DE_ENV_DO_ARTEFATO = /^\.env(?:\.[a-z0-9-]+)?$/;

/** Is the switch ON in this environment, by the loader's own rule (exactly `on`)? */
export function chamadasLigadasNoAmbiente(
  ambiente: Readonly<Record<string, string | undefined>>,
): boolean {
  return ambiente[CHAVE_DE_CHAMADAS_DA_LANE] === 'on';
}

/** The three filesystem reads the artifact scan makes — injectable for the unit test. */
export interface LeitorDoArtefato {
  readonly existe: (caminho: string) => boolean;
  readonly listar: (diretorio: string) => readonly string[];
  readonly ler: (caminho: string) => string;
}

const LEITOR_DO_DISCO: LeitorDoArtefato = {
  existe: (caminho) => existsSync(caminho),
  listar: (diretorio) => readdirSync(diretorio),
  ler: (caminho) => readFileSync(caminho, 'utf8'),
};

/**
 * The artifact env files that NAME the switch, sorted. An absent artifact
 * (`prepare-deploy.mjs` has not run) has nothing to police, and the functions
 * emulator has nothing to load either.
 */
export function envsDoArtefatoQueNomeiamAChave(
  diretorio: string = DIRETORIO_DO_ARTEFATO_AMAZON,
  leitor: LeitorDoArtefato = LEITOR_DO_DISCO,
): string[] {
  if (!leitor.existe(diretorio)) return [];
  return leitor
    .listar(diretorio)
    .filter((nome) => NOME_DE_ENV_DO_ARTEFATO.test(nome))
    .filter((nome) => leitor.ler(join(diretorio, nome)).includes(CHAVE_DE_CHAMADAS_DA_LANE))
    .sort();
}
