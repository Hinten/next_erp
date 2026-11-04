import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHAVE_DE_TESTE_HEX, chaveDeTeste } from '../testing/chaveDeFixtures';
import { escreverFixturesLi, novoProgressoDaEscritaLi } from './escrita';
import { executarSanitizacao } from './executar';
import { ARQUIVO_CHAVE_FIXTURES } from './lote';
import { discoDasFixturesNodeLi, sistemaDeArquivosNodeLi } from './sistemaNode';

/*
 * The script's real file-system binding, over TEMPORARY folders: a synthetic
 * capture folder and a stand-in for `__wire__/`, both under the OS temp dir and
 * removed after each test. Never the real capture folder, never the corpus.
 */
let pasta: string;
let wire: string;

beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'li-capturas-teste-'));
  wire = mkdtempSync(join(tmpdir(), 'li-wire-teste-'));
  writeFileSync(join(pasta, 'nomes-proibidos.txt'), 'Loja Exemplo\n', 'utf8');
  writeFileSync(
    join(pasta, 'grade.txt'),
    'GET /v1/grades/6062/ 200\ncredencial: personal-token\ndata: 2026-10-07\n',
  );
  writeFileSync(
    join(pasta, 'grade.json'),
    JSON.stringify({
      id: 6062,
      resource_uri: '/api/v1/grades/6062',
      variacoes: [
        { grade: '/api/v1/grades/6062', id: 31, resource_uri: '/api/v1/grade/6062/variacao/31' },
      ],
    }),
  );
});

afterEach(() => {
  rmSync(pasta, { recursive: true, force: true });
  rmSync(wire, { recursive: true, force: true });
});

const rodar = (...flags: string[]) =>
  executarSanitizacao(['--entrada', pasta, ...flags], sistemaDeArquivosNodeLi(wire));

/** A clean run, written the way the script writes it. */
function rodarEEscrever(...flags: string[]) {
  const r = rodar(...flags);
  escreverFixturesLi(r.escritas, discoDasFixturesNodeLi(wire), novoProgressoDaEscritaLi());
  return r;
}

/** Every file now in the stand-in `__wire__/`, with its text. */
const escritos = () =>
  readdirSync(wire).map((nome) => [nome, readFileSync(join(wire, nome), 'utf8')] as const);

describe('the node binding, on temporary folders', () => {
  it('--gerar-chave writes 64 lowercase hex digits and a newline, and refuses a second time', () => {
    const r = rodar('--gerar-chave');
    expect(r.codigo).toBe(0);
    const texto = readFileSync(join(pasta, ARQUIVO_CHAVE_FIXTURES), 'utf8');
    expect(texto).toMatch(/^[0-9a-f]{64}\n$/);
    expect(r.saida).not.toContain(texto.trim());
    const deNovo = rodar('--gerar-chave');
    expect(deNovo.codigo).toBe(1);
    expect(readFileSync(join(pasta, ARQUIVO_CHAVE_FIXTURES), 'utf8')).toBe(texto);
  });

  it('no key: the catalogue pair is refused and nothing is written', () => {
    const r = rodarEEscrever();
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('sem-chave-de-fixtures');
    expect(escritos()).toEqual([]);
  });

  it('with a TEST key: the fixture holds pseudonyms only, never the key, and a re-run is unchanged', () => {
    writeFileSync(join(pasta, ARQUIVO_CHAVE_FIXTURES), `${CHAVE_DE_TESTE_HEX}\n`, 'utf8');
    expect(rodarEEscrever().codigo).toBe(0);
    const g = String(chaveDeTeste().pseudonimo('6062'));
    const arquivos = escritos();
    expect(arquivos.map(([nome]) => nome)).toEqual(['grade.json']);
    const [, texto] = arquivos[0] ?? ['', ''];
    expect(texto).toContain(`"caminho": "/v1/grades/${g}/"`);
    expect(texto).toContain(`"resource_uri": "/api/v1/grade/${g}/variacao/`);
    expect(texto).not.toMatch(/\b(?:6062|31)\b/);
    expect(texto).not.toContain(CHAVE_DE_TESTE_HEX);
    // Byte-reproducible: the same key over the same capture is a no-op.
    const deNovo = rodarEEscrever();
    expect(deNovo.saida).toContain('grade -> unchanged');
    expect(escritos()).toEqual(arquivos);
  });

  it('a freshly generated key converts the pair, and its text appears in no output or fixture', () => {
    expect(rodar('--gerar-chave').codigo).toBe(0);
    const chave = readFileSync(join(pasta, ARQUIVO_CHAVE_FIXTURES), 'utf8').trim();
    const seco = rodar('--dry-run');
    const r = rodarEEscrever();
    expect(r.codigo).toBe(0);
    for (const texto of [seco.saida, r.saida, ...escritos().map(([, t]) => t)]) {
      expect(texto).not.toContain(chave);
      expect(texto).not.toContain(chave.slice(0, 16));
    }
  });

  it('the binding itself never overwrites a key: a second create throws and leaves the file as it was', () => {
    const sistema = sistemaDeArquivosNodeLi(wire);
    sistema.criarChave(pasta, ARQUIVO_CHAVE_FIXTURES);
    const texto = readFileSync(join(pasta, ARQUIVO_CHAVE_FIXTURES), 'utf8');
    expect(() => {
      sistema.criarChave(pasta, ARQUIVO_CHAVE_FIXTURES);
    }).toThrow();
    expect(readFileSync(join(pasta, ARQUIVO_CHAVE_FIXTURES), 'utf8')).toBe(texto);
  });

  it('NEAR-MISS: two generated keys differ (random bytes, never a constant)', () => {
    const outra = mkdtempSync(join(tmpdir(), 'li-capturas-teste-'));
    try {
      const sistema = sistemaDeArquivosNodeLi(wire);
      sistema.criarChave(pasta, ARQUIVO_CHAVE_FIXTURES);
      sistema.criarChave(outra, ARQUIVO_CHAVE_FIXTURES);
      expect(readFileSync(join(pasta, ARQUIVO_CHAVE_FIXTURES), 'utf8')).not.toBe(
        readFileSync(join(outra, ARQUIVO_CHAVE_FIXTURES), 'utf8'),
      );
    } finally {
      rmSync(outra, { recursive: true, force: true });
    }
  });

  // POSIX only: Windows applies no file mode, so there is nothing to observe there.
  it.skipIf(process.platform === 'win32')('the key file is readable by its owner only', () => {
    sistemaDeArquivosNodeLi(wire).criarChave(pasta, ARQUIVO_CHAVE_FIXTURES);
    expect(statSync(join(pasta, ARQUIVO_CHAVE_FIXTURES)).mode & 0o077).toBe(0);
  });
});
