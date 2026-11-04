/**
 * The offline capture sanitizer: turns the store owner's read-only Loja
 * Integrada captures into committed fixtures (`lib/lojaIntegrada/fixtures/__wire__/`).
 *
 *   pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada <pasta> --gerar-chave
 *   pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada <pasta> --dry-run
 *   pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada <pasta>
 *   pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada <pasta> --verificar <arquivo>…
 *
 * A THIN shell: every rule lives in `lib/lojaIntegrada/sanitizacao/` (tested
 * there), and so does the `node:fs` binding (`sistemaNode.ts`). This file only
 * hands the binding to the run, writes the fixtures it returns, and prints its
 * text. It reads no environment, holds no token, opens no connection and spawns
 * nothing — `estrutura.test.ts` walks its import closure to prove it. Read
 * `scripts/README.md` before capturing anything.
 *
 * Exit codes: 0 done (or a clean dry run or check, or a key created) · 1 refused,
 * nothing written · 2 usage error · 70 unexpected error.
 *
 * ⚠️ The unexpected-error handler prints only the error's class name and `code`.
 * Node's default printer would print an `ERR_INVALID_URL`'s input, or an fs
 * error's path — the captures are real production data. It never resumes, so it
 * swallows nothing. When the error stops the fixture writing part-way, it also
 * says which fixtures were written and which were not (`sanitizacao/escrita.ts`
 * writes every temporary before renaming any, so a failed WRITE replaces none).
 */
import { mkdirSync } from 'node:fs';

import { DIRETORIO_WIRE_LI } from '../lib/lojaIntegrada/fixtures/wireCorpus';
import {
  escreverFixturesLi,
  novoProgressoDaEscritaLi,
  resumoDoProgressoLi,
} from '../lib/lojaIntegrada/sanitizacao/escrita';
import {
  ErroDeUsoSanitizacao,
  executarSanitizacao,
} from '../lib/lojaIntegrada/sanitizacao/executar';
import {
  discoDasFixturesNodeLi,
  sistemaDeArquivosNodeLi,
} from '../lib/lojaIntegrada/sanitizacao/sistemaNode';

const NOME_DE_CLASSE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODIGO = /^[A-Z][A-Z0-9_]{0,63}$/;

function descrever(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err;
  const nome = err.constructor.name;
  const codigo = 'code' in err && typeof err.code === 'string' ? err.code : '';
  return [NOME_DE_CLASSE.test(nome) ? nome : 'Error', CODIGO.test(codigo) ? codigo : '']
    .filter((p) => p !== '')
    .join(' ');
}

const progresso = novoProgressoDaEscritaLi();

process.setUncaughtExceptionCaptureCallback((err) => {
  const escrita = resumoDoProgressoLi(progresso);
  process.stderr.write(
    `sanitizar: unexpected error (${descrever(err)}); no other detail of it is shown.\n`,
  );
  if (escrita !== null) process.stderr.write(`sanitizar: ${escrita}\n`);
  process.exit(70);
});

function principal(): number {
  let resultado: ReturnType<typeof executarSanitizacao>;
  try {
    resultado = executarSanitizacao(
      process.argv.slice(2),
      sistemaDeArquivosNodeLi(DIRETORIO_WIRE_LI),
    );
  } catch (err) {
    if (err instanceof ErroDeUsoSanitizacao) {
      process.stderr.write(`sanitizar: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (resultado.escritas.length > 0) {
    mkdirSync(DIRETORIO_WIRE_LI, { recursive: true });
    escreverFixturesLi(resultado.escritas, discoDasFixturesNodeLi(DIRETORIO_WIRE_LI), progresso);
  }
  (resultado.codigo === 0 ? process.stdout : process.stderr).write(resultado.saida);
  return resultado.codigo;
}

process.exitCode = principal();
