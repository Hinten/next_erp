/**
 * The offline capture sanitizer: turns the store owner's read-only Loja
 * Integrada captures into committed fixtures (`lib/lojaIntegrada/fixtures/__wire__/`).
 *
 *   pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada <pasta> --dry-run
 *   pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada <pasta>
 *   pnpm --filter @delfrance/loja-integrada-app sanitizar --entrada <pasta> --verificar <arquivo>…
 *
 * A THIN shell: every rule lives in `lib/lojaIntegrada/sanitizacao/` (tested
 * there). This file only binds `node:fs` to it, writes the fixtures it returns,
 * and prints its text. It reads no environment, holds no token, opens no
 * connection and spawns nothing — `estrutura.test.ts` walks its import closure
 * to prove it. Read `scripts/README.md` before capturing anything.
 *
 * Exit codes: 0 done (or a clean dry run or check) · 1 refused, nothing written ·
 * 2 usage error · 70 unexpected error.
 *
 * ⚠️ The unexpected-error handler prints only the error's class name and `code`.
 * Node's default printer would print an `ERR_INVALID_URL`'s input, or an fs
 * error's path — the captures are real production data. It never resumes, so it
 * swallows nothing.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { DIRETORIO_WIRE_LI } from '../lib/lojaIntegrada/fixtures/wireCorpus';
import {
  ErroDeUsoSanitizacao,
  type SistemaDeArquivosDaSanitizacao,
  executarSanitizacao,
} from '../lib/lojaIntegrada/sanitizacao/executar';

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

process.setUncaughtExceptionCaptureCallback((err) => {
  process.stderr.write(`sanitizar: unexpected error (${descrever(err)}); nothing else is shown.\n`);
  process.exit(70);
});

const arquivo = (caminho: string) => existsSync(caminho) && statSync(caminho).isFile();

const sistema: SistemaDeArquivosDaSanitizacao = {
  pastaReal: (caminho) => {
    const absoluto = resolve(caminho);
    if (!existsSync(absoluto)) return null;
    const real = realpathSync(absoluto);
    return statSync(real).isDirectory() ? real : null;
  },
  existe: (caminho) => existsSync(caminho),
  listar: (pasta) =>
    readdirSync(pasta, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
  ler: (pasta, nome) => readFileSync(join(pasta, nome)),
  modificadoEmMs: (pasta, nome) => statSync(join(pasta, nome)).mtimeMs,
  fixtureExistente: (nome) => {
    const caminho = join(DIRETORIO_WIRE_LI, `${nome}.json`);
    return arquivo(caminho) ? readFileSync(caminho, 'utf8') : null;
  },
  lerArquivo: (caminho) => {
    const absoluto = resolve(caminho);
    return arquivo(absoluto) ? readFileSync(absoluto) : null;
  },
};

function principal(): number {
  let resultado: ReturnType<typeof executarSanitizacao>;
  try {
    resultado = executarSanitizacao(process.argv.slice(2), sistema);
  } catch (err) {
    if (err instanceof ErroDeUsoSanitizacao) {
      process.stderr.write(`sanitizar: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (resultado.escritas.length > 0) {
    mkdirSync(DIRETORIO_WIRE_LI, { recursive: true });
    for (const e of resultado.escritas) {
      writeFileSync(join(DIRETORIO_WIRE_LI, `${e.nome}.json`), e.texto, 'utf8');
    }
  }
  (resultado.codigo === 0 ? process.stdout : process.stderr).write(resultado.saida);
  return resultado.codigo;
}

process.exitCode = principal();
