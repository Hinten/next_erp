import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitLsFilesZ } from './lib/repo-scan.js';

/**
 * No tracked source file may contain a RAW control byte.
 *
 * WHY THIS IS A GUARD AND NOT A STYLE NOTE. A single `\u0000` written as the byte
 * itself — as a `join()` delimiter, as the low end of a regex class — makes GNU
 * grep and ripgrep classify the whole file as BINARY and stop printing matches
 * from that offset on. Not an error, not a warning you would read: `grep -rn`
 * prints `Binary file … matches` with no line, and ripgrep given a DIRECTORY
 * prints nothing at all for that file. `packages/integrations/shopee/src/api.ts`
 * had one at byte 99640 of 137072, and the ~900 lines after it — every request
 * guard, both client factories — were invisible to every content search while
 * lint, typecheck, 440 tests and `prettier --check` were all green.
 *
 * ⚠️ WHY `git grep` CANNOT BE THE SCANNER HERE, unlike every other guard in this
 * folder. Git sniffs for binary content in the FIRST 8000 bytes only, so it read
 * that file as text throughout and answered every query correctly — which is
 * exactly why the repo's own `git grep --untracked` backstops never noticed, and
 * why this one opens the files itself (`lib/repo-scan.js` says as much in its own
 * header: "a future whole-tree `grep -n` could reach" the buffer ceiling).
 *
 * WHAT IS BANNED. Every byte below 0x20 except tab (0x09), LF (0x0a) and CR
 * (0x0d), plus DEL (0x7f). The escape is always available and always identical at
 * runtime: `'\u0000'` is the same one-character string as the raw byte, and
 * `/[\u0000-\u001f]/` is the same regex class. Nothing is lost by spelling it.
 *
 * ⚠️ THE POPULATION IS ZERO, so this is an `error`-grade guard rather than a
 * ratchet: the three bytes that existed when it was written (one in the Shopee
 * client, one `join()` delimiter in `itemsStatusSync.ts`, a regex class in the
 * Mercado Livre package's `api.test.ts`) were all rewritten as escapes in the
 * same change. There is no allowlist on purpose — an allowlist here would be a
 * list of files nobody can grep.
 */

/**
 * Source surfaces. Deliberately the languages whose toolchain reads them as text
 * and whose reviewers grep them; binary assets, PDFs, fonts and snapshots are not
 * in scope and a snapshot legitimately carries whatever a test serialised.
 */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.sh'];

/** Tab, LF and CR are the three that belong in a text file. */
function isForbidden(byte) {
  return byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
}

let scanCache = null;

/**
 * Every tracked source path, with the offsets of any forbidden byte.
 *
 * TRACKED-ONLY, for the same reason `shebang-files-lf.test.js` is: this walks the
 * whole tree, so unioning `--others` would turn any untracked scratch file in
 * someone's working directory into a red build. The moment a file is staged it
 * appears in `ls-files`, and CI always checks out a commit.
 *
 * Memoized: this opens ~3200 files, and both assertions below need the result.
 */
function scanSources() {
  if (scanCache) return scanCache;
  const arquivos = [];
  const ofensores = [];
  for (const file of gitLsFilesZ()) {
    if (!EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
    let conteudo;
    try {
      conteudo = readFileSync(resolve(REPO_ROOT, file));
    } catch (err) {
      // A tracked path missing from the working tree (a symbolic link to a
      // directory, a broken checkout) is not this guard's business — those
      // surface as the three errno codes below. Anything else (a permission
      // error, an I/O failure) must not read as "no control bytes here".
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ELOOP') continue;
      throw err;
    }
    arquivos.push(file);
    for (let i = 0; i < conteudo.length; i += 1) {
      if (!isForbidden(conteudo[i])) continue;
      const linha = conteudo.subarray(0, i).toString('utf8').split('\n').length;
      ofensores.push(`${file}:${String(linha)} (byte 0x${conteudo[i].toString(16)})`);
      break; // one report per file is enough to act on
    }
  }
  scanCache = { arquivos, ofensores };
  return scanCache;
}

describe('no raw control byte in a tracked source file', () => {
  // ------------------------------------------------------------------
  // ANCHOR. The assertion below asserts an EMPTY list, which passes just as
  // happily when the walk read NOTHING — a wrong extension list, a `ls-files`
  // that returned nothing, a `readFileSync` that threw on every path. So prove
  // the walk reached the tree AND actually read bytes off disk.
  // ------------------------------------------------------------------
  it('ÂNCORA — o varredor leu mesmo a árvore, e leu o CONTEÚDO', () => {
    const { arquivos } = scanSources();
    expect(arquivos.length).toBeGreaterThan(1000);
    // Two tracked files that must be in ANY correct walk of this repo — one of
    // them the very file that carried the byte this guard exists for.
    expect(arquivos).toContain('packages/config-eslint/rules/lib/repo-scan.js');
    expect(arquivos).toContain('packages/integrations/shopee/src/api.ts');

    // And the bytes really came off disk, not just the path list.
    const fonte = readFileSync(
      resolve(REPO_ROOT, 'packages/config-eslint/rules/lib/repo-scan.js'),
      'utf8',
    );
    expect(fonte).toContain('export function gitLsFilesZ');

    // The classifier itself, on the bytes that matter — a walk that read
    // everything is still useless if `isForbidden` answers `false` for 0x00.
    expect(isForbidden(0x00)).toBe(true);
    expect(isForbidden(0x1f)).toBe(true);
    expect(isForbidden(0x7f)).toBe(true);
    expect([0x09, 0x0a, 0x0d, 0x20, 0x41].map(isForbidden)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('nenhum arquivo de código carrega um byte de controle cru', () => {
    const { ofensores } = scanSources();
    expect(
      ofensores,
      [
        'Um byte de controle CRU num arquivo de código faz o `grep` e o `ripgrep`',
        'tratarem o arquivo inteiro como BINÁRIO e pararem de imprimir resultados a',
        'partir daquele offset — sem erro, sem aviso legível, com lint, typecheck,',
        'testes e prettier todos verdes. Escreva o escape (`\\u0000`,',
        '`/[\\u0000-\\u001f]/`): o valor em tempo de execução é o MESMO.',
        'Arquivos ofensores:',
        ...ofensores.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
