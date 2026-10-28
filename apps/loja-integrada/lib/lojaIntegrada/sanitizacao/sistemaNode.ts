/**
 * The sanitizer's `node:fs` binding: what `scripts/sanitizar.ts` injects into the
 * run (`executar.ts`) and into the fixture writer (`escrita.ts`). It lives here,
 * not in the script, so a test can run the real binding over temporary folders
 * (`sistemaNode.test.ts`); `diretorioWire` is `__wire__/` in the script and a
 * temporary folder in that test.
 *
 * It reads and writes only what the run asks for: the capture folder's entries,
 * the fixtures, the `--verificar` files, and — with `--gerar-chave` — one new
 * pseudonym key, created EXCLUSIVELY (`wx`: an existing file is never
 * overwritten, the run's own check notwithstanding) and readable by its owner
 * only. Nothing here prints.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import type { DiscoDasFixturesLi } from './escrita';
import type { SistemaDeArquivosDaSanitizacao } from './executar';
import { BYTES_DA_CHAVE_LI, textoDeChaveNovaLi } from './pseudonimo';

const arquivo = (caminho: string) => existsSync(caminho) && statSync(caminho).isFile();

/** Everything the run reads, plus the key writer, over `node:fs`. */
export function sistemaDeArquivosNodeLi(diretorioWire: string): SistemaDeArquivosDaSanitizacao {
  const fixture = (nome: string) => join(diretorioWire, `${nome}.json`);
  return {
    pastaReal: (caminho) => {
      const absoluto = resolve(caminho);
      if (!existsSync(absoluto)) return null;
      const real = realpathSync(absoluto);
      return statSync(real).isDirectory() ? real : null;
    },
    existe: (caminho) => existsSync(caminho),
    // Every entry: a HAR behind a link still refuses the run, and only a regular file is read.
    listar: (pasta) =>
      readdirSync(pasta, { withFileTypes: true }).map((e) => ({
        nome: e.name,
        arquivo: e.isFile(),
      })),
    ler: (pasta, nome) => readFileSync(join(pasta, nome)),
    modificadoEmMs: (pasta, nome) => statSync(join(pasta, nome)).mtimeMs,
    fixtureExistente: (nome) =>
      arquivo(fixture(nome)) ? readFileSync(fixture(nome), 'utf8') : null,
    lerArquivo: (caminho) => {
      const absoluto = resolve(caminho);
      return arquivo(absoluto) ? readFileSync(absoluto) : null;
    },
    criarChave: (pasta, nome) => {
      writeFileSync(join(pasta, nome), textoDeChaveNovaLi(randomBytes(BYTES_DA_CHAVE_LI)), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    },
  };
}

/** The fixture writer's disk, over `node:fs`. */
export function discoDasFixturesNodeLi(diretorioWire: string): DiscoDasFixturesLi {
  const fixture = (nome: string) => join(diretorioWire, `${nome}.json`);
  /** Beside its fixture. A leftover one fails `wireCorpus.test.ts`: it is not `<nome>.json`. */
  const temporario = (nome: string) => join(diretorioWire, `.${nome}.json.tmp`);
  return {
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
}
