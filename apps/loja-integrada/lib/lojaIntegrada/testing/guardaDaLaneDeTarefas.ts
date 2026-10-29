/**
 * The D17 refusals of the emulator lane (`ci-loja-integrada.yml`), as pure
 * functions — for `vitest.tasks.setup.ts` and its own unit test ONLY (the
 * `fakeDb.ts` rule: nothing in production imports `testing/`,
 * `estrutura.test.ts`).
 *
 * Why a module and not inline code in the setup: the setup is a side-effect
 * file that THROWS on import under `CI` without an emulator host, so no offline
 * test could import it to prove its refusals. These functions are what it runs,
 * and `guardaDaLaneDeTarefas.test.ts` proves them in `CI test`.
 *
 * The lane's dispatched functions run in the FUNCTIONS EMULATOR, a sibling of
 * the vitest process that the setup's fetch kill-switch never reaches. Two
 * layers keep them from ever calling Loja Integrada there:
 *
 *  - the read switch `LOJA_INTEGRADA_CHAMADAS`, off (the job env): a context —
 *    read or write — refuses before any client exists;
 *  - since master plan step 7, the write side: the job env sets the write valve
 *    `LOJA_INTEGRADA_MODO_RASTREIO` to `dry-run` (so the trigger and the queue
 *    really run), and NO write valve may be exactly `on` and NO canary list may
 *    name a target — a run that passed the switch could then still never write.
 *
 * Two places could break either layer:
 *
 *  - the shell, which `emulators:exec` hands to the functions emulator: refused
 *    by the loader's own rule — the switch or a valve EXACTLY `on` (`ON` and
 *    ` on` are off to the loader too), and a canary list that is not blank;
 *  - an env file in the generated artifact: `prepare-deploy.mjs` copies an
 *    operator's `.env.deploy*` there, and firebase-tools loads `.env` and
 *    `.env.<project>` from the functions source into the functions emulator.
 *    WHETHER such a value overrides the job env inside the emulator is
 *    unverified, so a file that merely NAMES the read switch is refused,
 *    whatever value it sets and even commented out; a file is refused for the
 *    write side when it assigns a valve `on` or a canary list anything, read
 *    with firebase-tools' own rules (quotes, `export`, a trailing comment, CRLF),
 *    and when a line naming either cannot be read at all.
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
 * depend on the module it polices. The unit test pins the two spellings equal.
 */
export const CHAVE_DE_CHAMADAS_DA_LANE = 'LOJA_INTEGRADA_CHAMADAS';

/** Every write valve's name starts with this (pinned against `VALVULA_ENV_LI`). */
export const PREFIXO_DAS_VALVULAS_DA_LANE = 'LOJA_INTEGRADA_MODO_';

/** Every canary list's name starts with this (pinned against `CANARIO_ENV_LI`). */
export const PREFIXO_DOS_CANARIOS_DA_LANE = 'LOJA_INTEGRADA_CANARIO_';

/** The one value the loaders accept as on — exactly this, nothing trimmed. */
const LIGADO = 'on';

/**
 * The generated functions artifact the emulator loads — the `source` of
 * `firebase.loja-integrada.tasks.json` (pinned by the unit test), at the repo root.
 */
export const DIRETORIO_DO_ARTEFATO_LI = fileURLToPath(
  new URL('../../../../../.deploy/loja-integrada-functions', import.meta.url),
);

/** `.env` or `.env.<one lowercase segment>`: `.env.deploy`, `.env.demo-erp`, `.env.local`. */
export const NOME_DE_ENV_DO_ARTEFATO = /^\.env(?:\.[a-z0-9-]+)?$/;

type AmbienteDaLane = Readonly<Record<string, string | undefined>>;

/** Is the read switch ON in this environment, by the loader's own rule (exactly `on`)? */
export function chamadasLigadasNoAmbiente(ambiente: AmbienteDaLane): boolean {
  return ambiente[CHAVE_DE_CHAMADAS_DA_LANE] === LIGADO;
}

/** Whether a valve or canary value, as the loader would receive it, turns a write on. */
function ligaEscrita(nome: string, valor: string): boolean {
  if (nome.startsWith(PREFIXO_DAS_VALVULAS_DA_LANE)) return valor === LIGADO;
  if (nome.startsWith(PREFIXO_DOS_CANARIOS_DA_LANE)) return valor.trim() !== '';
  return false;
}

/**
 * The write valves exactly `on` and the canary lists that are not blank, in
 * this environment, by name, sorted. `dry-run` — the lane's own value — is
 * accepted.
 */
export function escritasLigadasNoAmbiente(ambiente: AmbienteDaLane): string[] {
  return Object.entries(ambiente)
    .filter(([nome, valor]) => valor !== undefined && ligaEscrita(nome, valor))
    .map(([nome]) => nome)
    .sort();
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

/** The artifact's env files, by their anchored name; none when there is no artifact yet. */
function envsDoArtefato(diretorio: string, leitor: LeitorDoArtefato): string[] {
  if (!leitor.existe(diretorio)) return [];
  return leitor
    .listar(diretorio)
    .filter((nome) => NOME_DE_ENV_DO_ARTEFATO.test(nome))
    .sort();
}

/**
 * The artifact env files that NAME the read switch, sorted. An absent artifact
 * (`prepare-deploy.mjs` has not run) has nothing to police, and the functions
 * emulator has nothing to load either.
 */
export function envsDoArtefatoQueNomeiamAChave(
  diretorio: string = DIRETORIO_DO_ARTEFATO_LI,
  leitor: LeitorDoArtefato = LEITOR_DO_DISCO,
): string[] {
  return envsDoArtefato(diretorio, leitor).filter((nome) =>
    leitor.ler(join(diretorio, nome)).includes(CHAVE_DE_CHAMADAS_DA_LANE),
  );
}

/**
 * One line, read as firebase-tools reads it (`lib/functions/env.js`): an
 * optional `export`, the key, `=`, then a single- or double-quoted value or an
 * unquoted one up to a `#`; the value trimmed and one pair of quotes removed.
 * `null` when the line is not an assignment that way.
 */
const LINHA_DE_ENV =
  /^\s*(?:export)?\s*([\w./]+)\s*=[\f\t\v]*(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|[^#\r\n]*)?\s*(?:#.*)?$/;

function atribuicao(linha: string): { readonly nome: string; readonly valor: string } | null {
  const m = LINHA_DE_ENV.exec(linha);
  if (m === null) return null;
  const bruto = (m[2] ?? '').trim();
  const aspas = /^(["'])([\s\S]*)\1$/.exec(bruto);
  return { nome: m[1] ?? '', valor: aspas === null ? bruto : (aspas[2] ?? '') };
}

/** Whether a file's text turns a write on (module header). Comments are skipped. */
function textoLigaEscrita(texto: string): boolean {
  for (const linha of texto.split(/\r?\n/)) {
    if (linha.trim().startsWith('#')) continue;
    const nomeia =
      linha.includes(PREFIXO_DAS_VALVULAS_DA_LANE) || linha.includes(PREFIXO_DOS_CANARIOS_DA_LANE);
    if (!nomeia) continue;
    const a = atribuicao(linha);
    // A line that names a valve or a list and cannot be read is refused: the
    // guard would otherwise be guessing what the emulator makes of it.
    if (a === null) return true;
    if (ligaEscrita(a.nome, a.valor)) return true;
  }
  return false;
}

/**
 * The artifact env files that assign a write valve `on` or a canary list a
 * value, sorted (module header).
 */
export function envsDoArtefatoQueLigamEscritas(
  diretorio: string = DIRETORIO_DO_ARTEFATO_LI,
  leitor: LeitorDoArtefato = LEITOR_DO_DISCO,
): string[] {
  return envsDoArtefato(diretorio, leitor).filter((nome) =>
    textoLigaEscrita(leitor.ler(join(diretorio, nome))),
  );
}
