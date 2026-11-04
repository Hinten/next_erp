/**
 * The offline capture sanitizer: turns the owner's Amazon captures into
 * committed fixtures (`lib/amazon/fixtures/__wire__/`).
 *
 *   pnpm --filter @delfrance/amazon-app sanitizar --entrada <pasta> --dry-run
 *   pnpm --filter @delfrance/amazon-app sanitizar --entrada <pasta>
 *   pnpm --filter @delfrance/amazon-app sanitizar --entrada <pasta> --verificar <arquivo>…
 *
 * A THIN shell: every rule lives in `lib/amazon/sanitizacao/` (tested there).
 * This file only binds `node:fs` and `node:crypto` to it, writes the fixtures it
 * returns, and prints its text. It reads no environment, holds no token, opens
 * no connection and spawns nothing — `estrutura.test.ts` walks its import
 * closure to prove it. Read `scripts/README.md` before capturing anything.
 *
 * Exit codes: 0 done (or a clean dry run or check) · 1 refused, nothing written ·
 * 2 usage error · 70 unexpected error.
 *
 * ⚠️ The unexpected-error handler prints only the error's class name and `code`.
 * Node's default printer would print an `ERR_INVALID_URL`'s input, or an fs
 * error's path — the captures are real production data. It never resumes, so it
 * swallows nothing. When the error stops the fixture writing part-way, it also
 * says which fixtures were written and which were not.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { DIRETORIO_WIRE_AMAZON } from '../lib/amazon/fixtures/wireCorpus';
import {
  type DiscoDasFixturesAmazon,
  escreverFixturesAmazon,
  mensagemDoErroInesperadoAmazon,
  novoProgressoDaEscritaAmazon,
} from '../lib/amazon/sanitizacao/escrita';
import {
  ErroDeUsoSanitizacao,
  type SistemaDeArquivosDaSanitizacao,
  executarSanitizacao,
} from '../lib/amazon/sanitizacao/executar';

const progresso = novoProgressoDaEscritaAmazon();

process.setUncaughtExceptionCaptureCallback((err) => {
  process.stderr.write(mensagemDoErroInesperadoAmazon(err, progresso));
  process.exit(70);
});

const arquivo = (caminho: string) => existsSync(caminho) && statSync(caminho).isFile();
const fixture = (nome: string) => join(DIRETORIO_WIRE_AMAZON, `${nome}.json`);
/** Beside its fixture. A leftover one fails `wireCorpus.test.ts`: it is not `<nome>.json`. */
const temporario = (nome: string) => join(DIRETORIO_WIRE_AMAZON, `.${nome}.json.tmp`);

/** At most `n` bytes from the start of a file: a label is refused without being read. */
function lerInicio(caminho: string, n: number): Uint8Array {
  const buffer = Buffer.alloc(n);
  const fd = openSync(caminho, 'r');
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

const sistema: SistemaDeArquivosDaSanitizacao = {
  pastaReal: (caminho) => {
    const absoluto = resolve(caminho);
    if (!existsSync(absoluto)) return null;
    const real = realpathSync(absoluto);
    return statSync(real).isDirectory() ? real : null;
  },
  existe: (caminho) => existsSync(caminho),
  // Every entry: a HAR behind a link still refuses the run, and only a regular file is read.
  listar: (pasta) =>
    readdirSync(pasta, { withFileTypes: true }).map((e) => ({ nome: e.name, arquivo: e.isFile() })),
  lerInicio: (pasta, nome, n) => lerInicio(join(pasta, nome), n),
  ler: (pasta, nome) => readFileSync(join(pasta, nome)),
  modificadoEmMs: (pasta, nome) => statSync(join(pasta, nome)).mtimeMs,
  // `wx`: exclusive create — the salt is never overwritten.
  criarExclusivo: (pasta, nome, bytes) => {
    writeFileSync(join(pasta, nome), bytes, { flag: 'wx' });
  },
  aleatorio: (n) => randomBytes(n),
  fixtureExistente: (nome) => (arquivo(fixture(nome)) ? readFileSync(fixture(nome), 'utf8') : null),
  lerArquivo: (caminho) => {
    const absoluto = resolve(caminho);
    return arquivo(absoluto) ? readFileSync(absoluto) : null;
  },
};

const disco: DiscoDasFixturesAmazon = {
  escreverTemporario: (nome, texto) => {
    writeFileSync(temporario(nome), texto, 'utf8');
  },
  promover: (nome) => {
    renameSync(temporario(nome), fixture(nome));
  },
  descartarTemporario: (nome) => {
    rmSync(temporario(nome), { force: true });
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
    mkdirSync(DIRETORIO_WIRE_AMAZON, { recursive: true });
    escreverFixturesAmazon(resultado.escritas, disco, progresso);
  }
  (resultado.codigo === 0 ? process.stdout : process.stderr).write(resultado.saida);
  return resultado.codigo;
}

process.exitCode = principal();
