/**
 * The layout rules of `lib/lojaIntegrada`, asserted as raw source text, because
 * breaking any of them fails nothing else:
 *
 *  - Next-free: step 3's functions bundle imports this tree. Only
 *    `core/respond.ts` may import `next/*`, and nothing may reach for the app's
 *    `@/` alias (the admin singleton lives there: `db` is a PARAMETER here);
 *  - no `process.env` read — configuration is a parameter too;
 *  - the test double and its fixtures are imported by tests only;
 *  - the name of the Admin SDK's multi-document atomic-write call appears in NO
 *    file of this app, tests and fakes included. The guard in
 *    `firestore-transaction-inventory.test.js` greps raw text, and a mention —
 *    even in a comment — would demand an inventory class for a site that does
 *    not exist. The word is assembled below so this file does not contain it;
 *  - the logger and the redactor stay light: `core/redacao.ts` and
 *    `core/refCredencial.ts` import only `zod` and `@delfrance/core/*`, and the
 *    transitive import closure of the logger never reaches the Admin SDK, the
 *    admin data layer, Next or the app alias;
 *  - the observer seam: outside `core/log.ts`, every observer handed to the
 *    package is exactly `criarObservadorLi(…)` as imported from the logger —
 *    the whole value, under its own name, never shadowed — and no file names
 *    the raw event type: it carries the raw query and the full response text,
 *    and only the logger redacts them;
 *  - the capture sanitizer (`sanitizacao/**`, `fixtures/**`, `scripts/sanitizar.ts`)
 *    cannot reach a network, a process, a token or Firestore: its transitive
 *    import closure holds no network or process module, no package client, no
 *    Admin SDK or admin data layer, none of the credential modules, and no text
 *    that calls `fetch` or loads code dynamically — and every external module it
 *    does import is on a short allow-list;
 *  - the committed fixture corpus keeps its `.prettierignore` and `.gitattributes`
 *    lines, so a re-run over an unchanged capture writes identical bytes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ_LIB = fileURLToPath(new URL('.', import.meta.url));
const RAIZ_APP = fileURLToPath(new URL('../..', import.meta.url));
const RAIZ_REPO = fileURLToPath(new URL('../../../..', import.meta.url));

function arquivosTs(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const caminho = join(dir, e.name);
    if (e.isDirectory()) saida.push(...arquivosTs(caminho));
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) saida.push(caminho);
  }
  return saida;
}

const rel = (p: string) => relative(RAIZ_LIB, p).split(sep).join('/');
const relApp = (p: string) => relative(RAIZ_APP, p).split(sep).join('/');
const ehTeste = (p: string) => p.endsWith('.test.ts');

/** Every module specifier in a source text: `from '…'`, `import '…'`, `import('…')`. */
function especificadores(texto: string): string[] {
  const saida: string[] = [];
  const re =
    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of texto.matchAll(re)) saida.push(m[1] ?? m[2] ?? m[3] ?? '');
  return saida;
}

/** A source text by its path relative to `lib/lojaIntegrada`, or `null`. */
type LeitorDeFonte = (caminho: string) => string | null;

const lerDoDisco: LeitorDeFonte = (caminho) => {
  const absoluto = join(RAIZ_LIB, ...caminho.split('/'));
  return existsSync(absoluto) ? readFileSync(absoluto, 'utf8') : null;
};

/** The same, by path relative to the APP root (`scripts/…`, `lib/lojaIntegrada/…`). */
const lerDoApp: LeitorDeFonte = (caminho) => {
  const absoluto = join(RAIZ_APP, ...caminho.split('/'));
  return existsSync(absoluto) ? readFileSync(absoluto, 'utf8') : null;
};

/**
 * The transitive closure of RELATIVE imports from `entradas`: every file
 * reached, and every non-relative specifier any of them imports. A relative
 * import that resolves to no file is reported as `?<path>` — fail closed.
 */
function fechoDeImportacoes(
  entradas: readonly string[],
  ler: LeitorDeFonte,
): { arquivos: string[]; externos: string[] } {
  const arquivos: string[] = [];
  const externos = new Set<string>();
  const pendentes = [...entradas];
  while (pendentes.length > 0) {
    const arquivo = pendentes.pop() ?? '';
    if (arquivos.includes(arquivo)) continue;
    const texto = ler(arquivo);
    if (texto === null) {
      externos.add(`?${arquivo}`);
      continue;
    }
    arquivos.push(arquivo);
    for (const espec of especificadores(texto)) {
      if (!espec.startsWith('.')) {
        externos.add(espec);
        continue;
      }
      const base = posix.normalize(posix.join(posix.dirname(arquivo), espec));
      const alvo = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => ler(c) !== null);
      pendentes.push(alvo ?? base);
    }
  }
  return { arquivos: arquivos.sort(), externos: [...externos].sort() };
}

/** What the logger's closure may never reach. */
const proibidoNoFecho = (espec: string) =>
  espec.startsWith('?') ||
  espec.startsWith('firebase-admin') ||
  espec.startsWith('@delfrance/data') ||
  espec.startsWith('next') ||
  espec.startsWith('@/');

/** The logger's entry points (the sanitizer's own, stricter closure is below; 2b-c adds the valves). */
const ENTRADAS_DO_FECHO = ['core/log.ts', 'core/redacao.ts', 'core/refCredencial.ts'];

/* ----------------------------- the sanitizer ------------------------------ */

/** Node modules that open a connection or start a process, with or without `node:`. */
const MODULOS_DE_REDE_OU_PROCESSO = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dns',
  'dgram',
  'child_process',
  'worker_threads',
  'cluster',
]);

/** What the sanitizer's closure may never import (the plan's list, plus the bare spellings). */
function proibidoNoSanitizador(espec: string): boolean {
  const modulo = espec.replace(/^node:/, '').split('/')[0] ?? '';
  return (
    espec.startsWith('?') ||
    espec.startsWith('firebase-admin') ||
    espec.startsWith('@delfrance/data') ||
    espec === '@delfrance/integrations-loja-integrada' ||
    espec.startsWith('@delfrance/integrations-loja-integrada/') ||
    espec.startsWith('next') ||
    espec.startsWith('@/') ||
    espec === 'undici' ||
    MODULOS_DE_REDE_OU_PROCESSO.has(modulo)
  );
}

/**
 * The ONLY external modules the sanitizer's closure imports. Fail closed: a new
 * one fails this test until it is added here, in review.
 */
const EXTERNOS_DO_SANITIZADOR = new Set([
  'zod',
  '@delfrance/core/wire',
  '@delfrance/core/documents',
  'node:fs',
  'node:path',
  'node:url',
]);

/** The modules that hold the credential, the context or Firestore handles. */
const MODULOS_DE_CREDENCIAL = [
  'core/credentialStore',
  'core/contexto',
  'core/estacionamento',
  'core/credencial',
].map((m) => `lib/lojaIntegrada/${m}.ts`);

/** Text that calls the network or loads code the import scan cannot see. */
const CHAMADAS_PROIBIDAS = [
  /\bfetch\s*\(/,
  /\brequire\s*\(/,
  /\bcreateRequire\b/,
  /\bimport\s*\(\s*[^'"\s)]/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
];

/**
 * Why the closure from `entradas` (app-relative paths) breaks the sanitizer's
 * isolation; empty when it does not.
 */
function violacoesDoSanitizador(entradas: readonly string[], ler: LeitorDeFonte): string[] {
  const fecho = fechoDeImportacoes(entradas, ler);
  const violacoes: string[] = [];
  for (const espec of fecho.externos) {
    if (proibidoNoSanitizador(espec)) violacoes.push(`imports ${espec}`);
    else if (!EXTERNOS_DO_SANITIZADOR.has(espec)) {
      violacoes.push(`imports ${espec} (not allow-listed)`);
    }
  }
  for (const arquivo of fecho.arquivos) {
    if (MODULOS_DE_CREDENCIAL.includes(arquivo)) violacoes.push(`reaches ${arquivo}`);
    const texto = ler(arquivo) ?? '';
    for (const re of CHAMADAS_PROIBIDAS) {
      if (re.test(texto)) violacoes.push(`${arquivo} matches ${re.source}`);
    }
  }
  return violacoes;
}

const LINHA_WIRE_PRETTIER = 'apps/loja-integrada/lib/lojaIntegrada/fixtures/__wire__/';
const LINHA_WIRE_ATRIBUTOS =
  'apps/loja-integrada/lib/lojaIntegrada/fixtures/__wire__/** text eol=lf';

/** The one file allowed to see the raw call event and build an observer. */
const ARQUIVO_DO_LOGGER = 'lib/lojaIntegrada/core/log.ts';
/** The logger as a module, relative to the app root (`@/` resolves there). */
const MODULO_DO_LOGGER = 'lib/lojaIntegrada/core/log';
const PROPRIEDADE = 'onChamada: ';
const SEAM_OK = `${PROPRIEDADE}criarObservadorLi(`;

/**
 * The index of the `)` that closes the `(` at `abre`, skipping quoted text, or
 * -1 when it never closes.
 */
function fimDaChamada(texto: string, abre: number): number {
  let nivel = 0;
  let aspas: string | null = null;
  for (let i = abre; i < texto.length; i++) {
    const c = texto[i];
    if (aspas !== null) {
      if (c === '\\') i++;
      else if (c === aspas) aspas = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') aspas = c;
    else if (c === '(') nivel += 1;
    else if (c === ')') {
      nivel -= 1;
      if (nivel === 0) return i;
    }
  }
  return -1;
}

/** A specifier as an app-relative module path (`@/x` → `x`, `./x` against the file). */
function moduloDe(arquivo: string, espec: string): string {
  if (espec.startsWith('@/')) return espec.slice(2);
  if (espec.startsWith('.')) return posix.normalize(posix.join(posix.dirname(arquivo), espec));
  return espec;
}

/**
 * Why a source text (`arquivo` relative to the app root) breaks the observer
 * seam; empty when it does not.
 *
 * 1. Every `onChamada` is `onChamada: criarObservadorLi(…)`, and that call is
 *    the WHOLE value: the next token after its closing `)` is `,` or `}` — so
 *    `criarObservadorLi(…) && ((e) => …)` cannot slip an inline observer in.
 * 2. A file that has the seam imports `criarObservadorLi` under its own name
 *    from the logger module, and every other mention of the name is one of its
 *    seam calls — so a local function, a parameter or a renamed import of the
 *    same name cannot stand in for it.
 * 3. No file names the raw event type.
 */
function violacoesDoSeam(arquivo: string, texto: string): string[] {
  if (arquivo === ARQUIVO_DO_LOGGER) return [];
  const violacoes: string[] = [];
  const chamadas = new Set<number>();
  let i = texto.indexOf('onChamada');
  while (i !== -1) {
    if (!texto.startsWith(SEAM_OK, i)) {
      violacoes.push(`${arquivo}: onChamada at ${String(i)} is not ${SEAM_OK}…)`);
    } else {
      const nome = i + PROPRIEDADE.length;
      chamadas.add(nome);
      const fim = fimDaChamada(texto, i + SEAM_OK.length - 1);
      const depois =
        fim === -1
          ? ''
          : texto
              .slice(fim + 1)
              .trimStart()
              .charAt(0);
      if (depois !== ',' && depois !== '}') {
        violacoes.push(`${arquivo}: the observer at ${String(nome)} is not the whole value`);
      }
    }
    i = texto.indexOf('onChamada', i + 1);
  }
  if (chamadas.size > 0) {
    const importacoes: (readonly [number, number])[] = [];
    for (const m of texto.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const nomes = (m[1] ?? '').split(',').map((n) => n.trim());
      if (
        nomes.includes('criarObservadorLi') &&
        moduloDe(arquivo, m[2] ?? '') === MODULO_DO_LOGGER
      ) {
        importacoes.push([m.index, m.index + m[0].length]);
      }
    }
    const fora = [...texto.matchAll(/\bcriarObservadorLi\b/g)]
      .map((m) => m.index)
      .filter((j) => !chamadas.has(j) && !importacoes.some(([a, b]) => j >= a && j < b));
    if (importacoes.length === 0 || fora.length > 0) {
      violacoes.push(
        `${arquivo}: criarObservadorLi is not the logger's (imported from it: ${String(importacoes.length > 0)}; other mentions at ${fora.join(', ') || 'none'})`,
      );
    }
  }
  if (/\bChamadaLi\b/.test(texto)) violacoes.push(`${arquivo}: names ChamadaLi`);
  return violacoes;
}

describe('lib/lojaIntegrada layout', () => {
  const todos = arquivosTs(RAIZ_LIB);
  const fontes = todos.filter((p) => !ehTeste(p));

  it('the scan found the tree', () => {
    expect(fontes.map(rel)).toEqual(
      expect.arrayContaining([
        'avisos/avisos.ts',
        'conta/expiracaoSweep.ts',
        'conta/status.ts',
        'conta/validade.ts',
        'core/credentialStore.ts',
        'core/estacionamento.ts',
        'core/contexto.ts',
        'core/respond.ts',
        'core/log.ts',
        'core/redacao.ts',
        'core/refCredencial.ts',
        'sanitizacao/requisicao.ts',
        'sanitizacao/local.ts',
        'sanitizacao/lote.ts',
        'sanitizacao/capturaParaFixture.ts',
        'sanitizacao/folhas.ts',
        'sanitizacao/executar.ts',
        'fixtures/piiScan.ts',
        'fixtures/wireCorpus.ts',
      ]),
    );
  });

  it('only core/respond.ts imports next/*, and nothing imports the @/ alias', () => {
    for (const arquivo of fontes) {
      const texto = readFileSync(arquivo, 'utf8');
      const importaNext = /from 'next(\/[^']*)?'/.test(texto);
      expect(importaNext, rel(arquivo)).toBe(rel(arquivo) === 'core/respond.ts');
      expect(/from '@\//.test(texto), rel(arquivo)).toBe(false);
    }
  });

  it('reads no process.env', () => {
    for (const arquivo of fontes) {
      expect(readFileSync(arquivo, 'utf8'), rel(arquivo)).not.toContain('process.env');
    }
  });

  it('testing/ is imported by tests only', () => {
    for (const arquivo of fontes) {
      if (rel(arquivo).startsWith('testing/')) continue;
      expect(readFileSync(arquivo, 'utf8'), rel(arquivo)).not.toMatch(/from '[^']*testing\//);
    }
  });

  it('core/redacao.ts and core/refCredencial.ts import only zod and @delfrance/core/*', () => {
    const permitido = (espec: string) => espec === 'zod' || espec.startsWith('@delfrance/core/');
    for (const arquivo of ['core/redacao.ts', 'core/refCredencial.ts']) {
      const texto = lerDoDisco(arquivo);
      expect(texto, arquivo).not.toBeNull();
      expect(
        especificadores(texto ?? '').filter((e) => !permitido(e)),
        arquivo,
      ).toEqual([]);
    }
    // Anti-vacuity: the reader sees the redactor's real imports.
    expect(especificadores(lerDoDisco('core/redacao.ts') ?? '')).toEqual(
      expect.arrayContaining(['zod', '@delfrance/core/wire', '@delfrance/core/documents']),
    );
  });

  it("the logger's import closure reaches no Admin SDK, admin data layer, Next or @/ alias", () => {
    const fecho = fechoDeImportacoes(ENTRADAS_DO_FECHO, lerDoDisco);
    expect(fecho.arquivos).toEqual(ENTRADAS_DO_FECHO.slice().sort());
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
  });

  it('the observer seam: only criarObservadorLi(…) is handed to the package, and only log.ts names the raw event', () => {
    const fontes = arquivosTs(RAIZ_APP).filter((p) => !ehTeste(p));
    const violacoes = fontes.flatMap((p) => violacoesDoSeam(relApp(p), readFileSync(p, 'utf8')));
    expect(violacoes).toEqual([]);
    // Anti-vacuity: the three wired sites exist, and the logger itself is exempt.
    const sites = fontes.filter((p) => readFileSync(p, 'utf8').includes(SEAM_OK)).map(relApp);
    expect(sites.sort()).toEqual([
      'app/api/marketplace/loja-integrada/conta/[id]/credencial/route.ts',
      'app/api/marketplace/loja-integrada/conta/[id]/credencial/validade/route.ts',
      'lib/lojaIntegrada/core/contexto.ts',
    ]);
    expect(fontes.map(relApp)).toContain(ARQUIVO_DO_LOGGER);
  });

  it('the sanitizer cannot reach a network, a process, a token or Firestore', () => {
    const entradas = [
      ...fontes
        .map(relApp)
        .filter(
          (p) =>
            p.startsWith('lib/lojaIntegrada/sanitizacao/') ||
            p.startsWith('lib/lojaIntegrada/fixtures/'),
        ),
      'scripts/sanitizar.ts',
    ];
    expect(violacoesDoSanitizador(entradas, lerDoApp)).toEqual([]);
    // Anti-vacuity: the walk reached the script, the run and the redactor, and saw real imports.
    const fecho = fechoDeImportacoes(entradas, lerDoApp);
    expect(fecho.arquivos).toEqual(
      expect.arrayContaining([
        'scripts/sanitizar.ts',
        'lib/lojaIntegrada/sanitizacao/executar.ts',
        'lib/lojaIntegrada/fixtures/piiScan.ts',
        'lib/lojaIntegrada/core/redacao.ts',
      ]),
    );
    expect(fecho.externos).toEqual(expect.arrayContaining(['node:fs', 'zod']));
  });

  it('scripts/ is typechecked and linted: the tsconfig includes **/*.ts, the ESLint config ignores nothing of it', () => {
    const tsconfig = readFileSync(join(RAIZ_APP, 'tsconfig.json'), 'utf8');
    expect(tsconfig).toContain('"**/*.ts"');
    expect(readFileSync(join(RAIZ_APP, 'eslint.config.mjs'), 'utf8')).not.toMatch(/\bignores\b/);
    expect(existsSync(join(RAIZ_APP, 'scripts', 'sanitizar.ts'))).toBe(true);
  });

  it('the committed corpus keeps its .prettierignore and .gitattributes lines', () => {
    const linhas = (arquivo: string) =>
      readFileSync(join(RAIZ_REPO, arquivo), 'utf8').split(/\r?\n/);
    expect(linhas('.prettierignore')).toContain(LINHA_WIRE_PRETTIER);
    expect(linhas('.gitattributes')).toContain(LINHA_WIRE_ATRIBUTOS);
  });

  it('no file of this app names the multi-document atomic-write call', () => {
    const palavra = ['run', 'Transaction'].join('');
    const arquivos = arquivosTs(RAIZ_APP);
    expect(arquivos.length).toBeGreaterThan(20);
    for (const arquivo of arquivos) {
      expect(readFileSync(arquivo, 'utf8').includes(palavra), relative(RAIZ_APP, arquivo)).toBe(
        false,
      );
    }
  });
});

// The two guards above can only fail on a file that does not exist yet, so pin
// them on synthetic source text: each must flag what it exists to flag.
describe('the guards, on synthetic source', () => {
  const leitor =
    (arquivos: Readonly<Record<string, string>>): LeitorDeFonte =>
    (caminho) =>
      Object.hasOwn(arquivos, caminho) ? (arquivos[caminho] ?? null) : null;

  it('import closure: log.ts → refCredencial.ts is accepted', () => {
    const fecho = fechoDeImportacoes(
      ['core/log.ts'],
      leitor({
        'core/log.ts': "import { versaoDaRef } from './refCredencial';\nimport { z } from 'zod';",
        'core/refCredencial.ts': 'export const x = 1;',
      }),
    );
    expect(fecho.arquivos).toEqual(['core/log.ts', 'core/refCredencial.ts']);
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
  });

  it('import closure: log.ts → credencial.ts is flagged, through what credencial.ts imports', () => {
    const fecho = fechoDeImportacoes(
      ['core/log.ts'],
      leitor({
        'core/log.ts': "import { versaoDaRef } from './credencial';",
        'core/credencial.ts': "import { sha256Hex } from '@delfrance/data/admin';",
      }),
    );
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual(['@delfrance/data/admin']);
  });

  it.each([
    ["import type { Firestore } from 'firebase-admin/firestore';", 'firebase-admin/firestore'],
    ["import { NextResponse } from 'next/server';", 'next/server'],
    ["import { x } from '@/lib/firebase/admin';", '@/lib/firebase/admin'],
    ["const m = await import('@delfrance/data/admin/cache');", '@delfrance/data/admin/cache'],
    ["export { y } from './sumiu';", '?core/sumiu'],
  ])('import closure flags %s', (fonte, esperado) => {
    const fecho = fechoDeImportacoes(['core/log.ts'], leitor({ 'core/log.ts': fonte }));
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([esperado]);
  });

  const IMPORTA_DO_LOGGER = "import { criarObservadorLi } from './log';\n";

  it.each([
    ['an inline observer', 'cliente({ onChamada: (e) => console.warn(e) })'],
    ['a forwarded one', 'cliente({ onChamada: deps.x })'],
    ['the shorthand', 'cliente({ onChamada })'],
    ['a destructured one', 'const { onChamada } = deps;'],
    [
      'the raw event type',
      "import type { ChamadaLi } from '@delfrance/integrations-loja-integrada';",
    ],
    [
      'the call combined with an inline observer',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorLi({ conta }) && ((e) => console.warn(e.corpo)) })`,
    ],
    [
      'the call combined with a forwarded one',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorLi({ conta }) || deps.x, x: 1 })`,
    ],
    [
      'an unbalanced call',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorLi({ conta: f(") })`,
    ],
    [
      'a local function of the same name',
      'const criarObservadorLi = (o) => (e) => console.log(e.corpo);\n' +
        'cliente({ onChamada: criarObservadorLi({ conta }) });',
    ],
    [
      'the name imported from elsewhere',
      "import { criarObservadorLi } from './outro/log';\n" +
        'cliente({ onChamada: criarObservadorLi({ conta }) });',
    ],
    [
      'another export renamed to the name',
      "import { escritorPadrao as criarObservadorLi } from './log';\n" +
        'cliente({ onChamada: criarObservadorLi({ conta }) });',
    ],
    [
      'a parameter that shadows the import',
      `${IMPORTA_DO_LOGGER}function f(criarObservadorLi) { return cliente({ onChamada: criarObservadorLi({ conta }) }); }`,
    ],
  ])('seam flags %s', (_caso, fonte) => {
    expect(violacoesDoSeam('lib/lojaIntegrada/core/contexto.ts', fonte)).toHaveLength(1);
  });

  const SANITIZADOR = 'lib/lojaIntegrada/sanitizacao/x.ts';
  const comRedator = (fonte: string) =>
    leitor({
      [SANITIZADOR]: fonte,
      'lib/lojaIntegrada/core/redacao.ts': "import { z } from 'zod';",
      'lib/lojaIntegrada/core/contexto.ts':
        "import { x } from '@delfrance/integrations-loja-integrada';",
    });

  it('sanitizer closure: node:fs, zod and the redactor are accepted', () => {
    expect(
      violacoesDoSanitizador(
        [SANITIZADOR],
        comRedator("import { readFileSync } from 'node:fs';\nimport { x } from '../core/redacao';"),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a call to fetch(', "export const f = () => fetch('https://x.example');"],
    ['an import of ../core/contexto', "import { y } from '../core/contexto';"],
    ['node:child_process', "import { spawn } from 'node:child_process';"],
    ['bare child_process', "import { spawn } from 'child_process';"],
    ['node:https', "import https from 'node:https';"],
    ['dns/promises', "import { lookup } from 'node:dns/promises';"],
    ['undici', "import { request } from 'undici';"],
    ['the package client', "import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';"],
    ['the Admin SDK', "import type { Firestore } from 'firebase-admin/firestore';"],
    ['the admin data layer', "import { x } from '@delfrance/data/admin';"],
    ['a module off the allow-list', "import pad from 'left-pad';"],
    ['a dynamic import of a computed name', 'const m = await import(nome);'],
    ['a require call', "const m = require('x');"],
  ])('sanitizer closure flags %s', (_caso, fonte) => {
    expect(violacoesDoSanitizador([SANITIZADOR], comRedator(fonte)).length).toBeGreaterThan(0);
  });

  it('seam accepts criarObservadorLi(…) imported from the logger, and exempts the logger itself', () => {
    expect(
      violacoesDoSeam(
        'lib/lojaIntegrada/core/contexto.ts',
        "import { type OpcoesObservadorLi, criarObservadorLi } from './log';\n" +
          'cliente({\n  onChamada: criarObservadorLi({ ...deps.registro, conta: id }),\n  x: 1,\n});',
      ),
    ).toEqual([]);
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        "import { criarObservadorLi } from '@/lib/lojaIntegrada/core/log';\n" +
          'validarPersonalToken({ token, onChamada: criarObservadorLi({ conta: f(")") }) })',
      ),
    ).toEqual([]);
    // Near-miss: the same call, but the import path is relative to ANOTHER directory.
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        "import { criarObservadorLi } from './log';\n" +
          'validarPersonalToken({ token, onChamada: criarObservadorLi({ conta: id }) })',
      ),
    ).toHaveLength(1);
    expect(
      violacoesDoSeam(ARQUIVO_DO_LOGGER, 'export function f(e: ChamadaLi) { onChamada(e); }'),
    ).toEqual([]);
    // A longer name that merely contains the type's name is not the type.
    expect(violacoesDoSeam('app/x/route.ts', 'type R = ResultadoChamadaLi;')).toEqual([]);
  });
});
