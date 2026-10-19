/**
 * The layout rules of `lib/amazon`, asserted as raw source text, because
 * breaking any of them fails nothing else:
 *
 *  - Next-free: step 3's functions bundle will import this tree. Only
 *    `core/respond.ts` may import `next/*`, and nothing may reach for the app's
 *    `@/` alias (the admin singleton lives there: `db` is a PARAMETER here);
 *  - no `process.env` read — the environment is a parameter too (`env.ts`);
 *  - the test doubles and fixtures are imported by tests only;
 *  - the routes never import the park (`core/estacionamento.ts`): a refusal at
 *    connect time is a verdict on a consent, never on a stored credential;
 *  - only the context loader reads through the conta cache: the connect flow
 *    must see a delete at once (its re-read decides the credential undo);
 *  - the name of the Admin SDK's multi-document atomic-write call appears in NO
 *    file of this app, tests and fakes included: this app adds ZERO such sites
 *    (the OAuth seam's redeem is already inventoried in `packages/data`), and
 *    `firestore-transaction-inventory.test.js` greps raw text — a mention, even
 *    in a comment, would demand an inventory class for a site that does not
 *    exist. The word is assembled below so this file does not contain it;
 *  - (step 2b) the logger stays LIGHT: the transitive relative-import closure of
 *    `core/log.ts`, `core/redacao.ts`, `core/formatoDaRef.ts`, `core/idConta.ts`
 *    and `core/valvulas.ts` never reaches the Admin SDK, the admin data layer,
 *    Next or the app alias; the redactor imports only `zod` and
 *    `@delfrance/core/{wire,documents}`, and the two format modules nothing;
 *  - (step 2b) the observer seam: outside `core/log.ts`, every observer handed to
 *    the package is exactly `criarObservadorAmazon(…)` as imported from the
 *    logger — the whole value, under its own name, never shadowed — at exactly
 *    three sites, and no file names the raw event type: it carries the raw
 *    query, the credential ref and the full response text, and only the logger
 *    redacts them;
 *  - (step 2b) no `.message` inside a logger call (any `.info|warn|error(`, or
 *    either non-call line writer), no `console.` anywhere, no `catch` in the
 *    logger or the redactor (they are total by construction), and only the
 *    logger writes a `trechoCorpo` campo;
 *  - (step 2b) the generated leaf inventory keeps its `.prettierignore` and
 *    `.gitattributes` lines, so a regeneration diffs leaf by leaf.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const RAIZ_LIB = fileURLToPath(new URL('.', import.meta.url));
const RAIZ_APP = fileURLToPath(new URL('../..', import.meta.url));
const RAIZ_REPO = fileURLToPath(new URL('../../../..', import.meta.url));

function arquivosTs(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === '.turbo') continue;
    const caminho = join(dir, e.name);
    if (e.isDirectory()) saida.push(...arquivosTs(caminho));
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) saida.push(caminho);
  }
  return saida;
}

const rel = (p: string) => relative(RAIZ_LIB, p).split(sep).join('/');
const relApp = (p: string) => relative(RAIZ_APP, p).split(sep).join('/');
const ehTeste = (p: string) => p.endsWith('.test.ts');

/** The source without its comments (the TypeScript printer), so prose cannot trip a code rule. */
function semComentarios(texto: string): string {
  const fonte = ts.createSourceFile('x.ts', texto, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return ts.createPrinter({ removeComments: true }).printFile(fonte);
}

/* ------------------------------ import closure ----------------------------- */

/** Every module specifier in a source text: `from '…'`, `import '…'`, `import('…')`. */
function especificadores(texto: string): string[] {
  const saida: string[] = [];
  const re =
    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of texto.matchAll(re)) saida.push(m[1] ?? m[2] ?? m[3] ?? '');
  return saida;
}

/** A source text by its path relative to `lib/amazon`, or `null`. */
type LeitorDeFonte = (caminho: string) => string | null;

const lerDoDisco: LeitorDeFonte = (caminho) => {
  const absoluto = join(RAIZ_LIB, ...caminho.split('/'));
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

/**
 * The logger's entry points, and the valves', which step 3's functions bundle
 * imports too. `env.ts` is reached (type-only, from the valves).
 */
const ENTRADAS_DO_FECHO = [
  'core/log.ts',
  'core/redacao.ts',
  'core/formatoDaRef.ts',
  'core/idConta.ts',
  'core/valvulas.ts',
];

/* ------------------------------ observer seam ------------------------------ */

/** The one file allowed to see the raw call event and build an observer. */
const ARQUIVO_DO_LOGGER = 'lib/amazon/core/log.ts';
/** The logger as a module, relative to the app root (`@/` resolves there). */
const MODULO_DO_LOGGER = 'lib/amazon/core/log';
const PROPRIEDADE = 'onChamada: ';
const SEAM_OK = `${PROPRIEDADE}criarObservadorAmazon(`;

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
 * 1. Every `onChamada` is `onChamada: criarObservadorAmazon(…)`, and that call
 *    is the WHOLE value: the next token after its closing `)` is `,` or `}` —
 *    so `criarObservadorAmazon(…) && ((e) => …)` cannot slip an inline
 *    observer in.
 * 2. A file that has the seam imports `criarObservadorAmazon` under its own
 *    name from the logger module, and every other mention of the name is one of
 *    its seam calls — so a local function, a parameter or a renamed import of
 *    the same name cannot stand in for it.
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
        nomes.includes('criarObservadorAmazon') &&
        moduloDe(arquivo, m[2] ?? '') === MODULO_DO_LOGGER
      ) {
        importacoes.push([m.index, m.index + m[0].length]);
      }
    }
    const fora = [...texto.matchAll(/\bcriarObservadorAmazon\b/g)]
      .map((m) => m.index)
      .filter((j) => !chamadas.has(j) && !importacoes.some(([a, b]) => j >= a && j < b));
    if (importacoes.length === 0 || fora.length > 0) {
      violacoes.push(
        `${arquivo}: criarObservadorAmazon is not the logger's (imported from it: ${String(importacoes.length > 0)}; other mentions at ${fora.join(', ') || 'none'})`,
      );
    }
  }
  if (/\bChamadaAmazon\b/.test(texto)) violacoes.push(`${arquivo}: names ChamadaAmazon`);
  return violacoes;
}

/* --------------------------- no `.message` logged -------------------------- */

/**
 * Every way a line is written here: ANY `.info(` / `.warn(` / `.error(` call —
 * on `logger`, `LOGGER_STDOUT_AMAZON`, `deps.logger?`, or the object
 * `warnNaoTipado(…)` returns — plus the two non-call line writers. Fail closed:
 * a receiver of another name is still a logger call to this scan.
 */
const CHAMADA_DE_LOG =
  /(?:\.(?:info|warn|error)|\b(?:registrarEventoAmazon|registrarChamadaBloqueadaAmazon))\(/g;

/**
 * Logger calls whose argument list reads a `.message` (an `AmazonError` message
 * embeds the request path, which can carry a seller id; a Firestore one, a
 * document path). An unbalanced call is read to the end of the text: fail
 * closed.
 */
function mensagensLogadas(arquivo: string, texto: string): string[] {
  const achados: string[] = [];
  for (const m of texto.matchAll(CHAMADA_DE_LOG)) {
    const abre = m.index + m[0].length - 1;
    const fim = fimDaChamada(texto, abre);
    const argumentos = texto.slice(abre, fim === -1 ? texto.length : fim + 1);
    if (/\.message\b/.test(argumentos)) achados.push(`${arquivo}: ${m[0]} at ${String(m.index)}`);
  }
  return achados;
}

/* -------------------------------- the pinned lines -------------------------------- */

const INVENTARIO = 'apps/amazon/lib/amazon/testing/especificacaoFolhas.json';
const LINHA_INVENTARIO_PRETTIER = INVENTARIO;
const LINHA_INVENTARIO_ATRIBUTOS = `${INVENTARIO} text eol=lf`;

describe('lib/amazon layout', () => {
  const todos = arquivosTs(RAIZ_LIB);
  const fontes = todos.filter((p) => !ehTeste(p));

  it('the scan found the tree (anti-vacuity)', () => {
    expect(fontes.map(rel)).toEqual(
      expect.arrayContaining([
        'env.ts',
        'avisos/avisos.ts',
        'conta/conectar.ts',
        'conta/expiracaoSweep.ts',
        'conta/iniciar.ts',
        'conta/oauthState.ts',
        'conta/status.ts',
        'conta/vinculoVendedor.ts',
        'core/agente.ts',
        'core/contaCache.ts',
        'core/contas.ts',
        'core/contexto.ts',
        'core/credentialStore.ts',
        'core/erros.ts',
        'core/estacionamento.ts',
        'core/formatoDaRef.ts',
        'core/idConta.ts',
        'core/log.ts',
        'core/redacao.ts',
        'core/refCredencial.ts',
        'core/respond.ts',
        'core/valvulas.ts',
        'testing/documentos.ts',
        'testing/fakeDb.ts',
        'testing/fakeOauthState.ts',
        'testing/fixtures.ts',
        'testing/sandboxBr.ts',
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
    // …and nothing outside lib/amazon reaches it from production code either.
    for (const arquivo of arquivosTs(join(RAIZ_APP, 'app')).filter((p) => !ehTeste(p))) {
      expect(readFileSync(arquivo, 'utf8'), relApp(arquivo)).not.toMatch(/amazon\/testing\//);
    }
  });

  it('only the context loader reads through the conta cache — the connect flow never does', () => {
    // A cached copy that `isFresh` accepts (active, connected) would hide a conta
    // deleted mid-callback, and the undo would leave its credential orphaned.
    // The callback may only INVALIDATE the cache (`invalidarContaEmCache`).
    const leitores = [...fontes, ...arquivosTs(join(RAIZ_APP, 'app')).filter((p) => !ehTeste(p))]
      .filter((p) => readFileSync(p, 'utf8').includes('lerContaEmCache'))
      .map((p) => (p.startsWith(RAIZ_LIB) ? rel(p) : relApp(p)))
      .sort();
    expect(leitores).toEqual(['core/contaCache.ts', 'core/contexto.ts']);
  });

  it('no route imports the park', () => {
    const rotas = arquivosTs(join(RAIZ_APP, 'app')).filter((p) => /[\\/]route\.ts$/.test(p));
    expect(rotas.length).toBeGreaterThanOrEqual(4);
    for (const rota of rotas) {
      expect(readFileSync(rota, 'utf8'), relApp(rota)).not.toMatch(/estacionamento/);
    }
  });

  it('no file of this app names the multi-document atomic-write call', () => {
    const palavra = ['run', 'Transaction'].join('');
    const arquivos = arquivosTs(RAIZ_APP);
    expect(arquivos.length).toBeGreaterThan(40);
    for (const arquivo of arquivos) {
      expect(readFileSync(arquivo, 'utf8').includes(palavra), relApp(arquivo)).toBe(false);
    }
  });

  it('every test file sits beside a vitest-collected path (the config includes app, lib and the proxy)', () => {
    expect(existsSync(join(RAIZ_APP, 'proxy.test.ts'))).toBe(true);
    const config = readFileSync(join(RAIZ_APP, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("'{app,lib,functions}/**/*.test.ts'");
    expect(config).toContain("'proxy.test.ts'");
  });
});

describe('the step-2b logger guards', () => {
  it('the redactor imports only zod and @delfrance/core/{wire,documents}; the two format modules import nothing', () => {
    const permitido = (espec: string) =>
      espec === 'zod' || espec === '@delfrance/core/wire' || espec === '@delfrance/core/documents';
    const redator = lerDoDisco('core/redacao.ts') ?? '';
    expect(especificadores(redator).filter((e) => !permitido(e))).toEqual([]);
    // Anti-vacuity: the reader sees the redactor's real imports.
    expect(especificadores(redator)).toEqual(
      expect.arrayContaining(['zod', '@delfrance/core/wire', '@delfrance/core/documents']),
    );
    for (const arquivo of ['core/formatoDaRef.ts', 'core/idConta.ts']) {
      expect(lerDoDisco(arquivo), arquivo).not.toBeNull();
      expect(especificadores(lerDoDisco(arquivo) ?? ''), arquivo).toEqual([]);
    }
  });

  it("the logger's and the valves' import closure reaches no Admin SDK, admin data layer, Next or @/ alias", () => {
    const fecho = fechoDeImportacoes(ENTRADAS_DO_FECHO, lerDoDisco);
    expect(fecho.arquivos).toEqual([...ENTRADAS_DO_FECHO, 'env.ts'].sort());
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
    // Anti-vacuity: the closure really walks the package and core imports.
    expect(fecho.externos).toEqual(
      expect.arrayContaining(['@delfrance/integrations-amazon-sp-api', 'zod']),
    );
  });

  it('the observer seam: only criarObservadorAmazon(…) is handed to the package, at exactly 3 sites, and only log.ts names the raw event', () => {
    const fontes = arquivosTs(RAIZ_APP).filter((p) => !ehTeste(p));
    const violacoes = fontes.flatMap((p) => violacoesDoSeam(relApp(p), readFileSync(p, 'utf8')));
    expect(violacoes).toEqual([]);
    // Anti-vacuity: the three wired sites — the LWA refresh, the SP-API client,
    // the code exchange — and the logger itself is exempt.
    const sites = fontes.flatMap((p) =>
      [...readFileSync(p, 'utf8').matchAll(new RegExp(SEAM_OK.replace('(', '\\('), 'g'))].map(() =>
        relApp(p),
      ),
    );
    expect(sites.sort()).toEqual([
      'lib/amazon/conta/conectar.ts',
      'lib/amazon/core/contexto.ts',
      'lib/amazon/core/contexto.ts',
    ]);
    expect(fontes.map(relApp)).toContain(ARQUIVO_DO_LOGGER);
  });

  it('no `.message` inside the arguments of a logger call, under lib/amazon and app/', () => {
    const fontes = [...arquivosTs(RAIZ_LIB), ...arquivosTs(join(RAIZ_APP, 'app'))].filter(
      (p) => !ehTeste(p),
    );
    const achados = fontes.flatMap((p) => mensagensLogadas(relApp(p), readFileSync(p, 'utf8')));
    expect(achados).toEqual([]);
    // Anti-vacuity: the scan sees the real logger calls AND the non-call writers.
    const chamadas = fontes.flatMap((p) =>
      [...readFileSync(p, 'utf8').matchAll(CHAMADA_DE_LOG)].map((m) => m[0]),
    );
    expect(chamadas.length).toBeGreaterThanOrEqual(15);
    expect(chamadas).toEqual(
      expect.arrayContaining(['registrarEventoAmazon(', 'registrarChamadaBloqueadaAmazon(']),
    );
  });

  it('only core/log.ts writes a `trechoCorpo` campo (the sink exempts it on a call line)', () => {
    const fontes = [...arquivosTs(RAIZ_LIB), ...arquivosTs(join(RAIZ_APP, 'app'))].filter(
      (p) => !ehTeste(p),
    );
    const escritores = fontes
      .filter((p) => /\btrechoCorpo\b/.test(semComentarios(readFileSync(p, 'utf8'))))
      .map(relApp);
    expect(escritores).toEqual([ARQUIVO_DO_LOGGER]);
  });

  it('no `console.` under lib/amazon (comments aside): the sink writes stdout itself', () => {
    for (const arquivo of arquivosTs(RAIZ_LIB).filter((p) => !ehTeste(p))) {
      expect(semComentarios(readFileSync(arquivo, 'utf8')), rel(arquivo)).not.toMatch(
        /\bconsole\./,
      );
    }
  });

  it('neither the logger nor the redactor has a `catch` at all (total by construction)', () => {
    for (const arquivo of ['core/log.ts', 'core/redacao.ts']) {
      const codigo = semComentarios(lerDoDisco(arquivo) ?? '');
      expect(codigo.length, arquivo).toBeGreaterThan(1000);
      expect(codigo, arquivo).not.toMatch(/\bcatch\b/);
    }
  });

  it('the generated leaf inventory keeps its .prettierignore and .gitattributes lines', () => {
    const linhas = (arquivo: string) =>
      readFileSync(join(RAIZ_REPO, arquivo), 'utf8').split(/\r?\n/);
    expect(linhas('.prettierignore')).toContain(LINHA_INVENTARIO_PRETTIER);
    expect(linhas('.gitattributes')).toContain(LINHA_INVENTARIO_ATRIBUTOS);
    expect(existsSync(join(RAIZ_REPO, INVENTARIO))).toBe(true);
  });
});

// The guards above can only fail on a file that does not exist yet, so pin
// them on synthetic source text: each must flag what it exists to flag.
describe('the guards, on synthetic source', () => {
  const leitor =
    (arquivos: Readonly<Record<string, string>>): LeitorDeFonte =>
    (caminho) =>
      Object.hasOwn(arquivos, caminho) ? (arquivos[caminho] ?? null) : null;

  it('import closure: log.ts → formatoDaRef.ts and idConta.ts is accepted', () => {
    const fecho = fechoDeImportacoes(
      ['core/log.ts'],
      leitor({
        'core/log.ts':
          "import { versaoDaRef } from './formatoDaRef';\nimport { idDeContaValido } from './idConta';",
        'core/formatoDaRef.ts': 'export const x = 1;',
        'core/idConta.ts': 'export const y = 1;',
      }),
    );
    expect(fecho.arquivos).toEqual(['core/formatoDaRef.ts', 'core/idConta.ts', 'core/log.ts']);
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
  });

  it('import closure: log.ts → refCredencial.ts is flagged, through the hash it imports', () => {
    const fecho = fechoDeImportacoes(
      ['core/log.ts'],
      leitor({
        'core/log.ts': "import { versaoDaRef } from './refCredencial';",
        'core/refCredencial.ts': "import { sha256Hex } from '@delfrance/data/admin';",
      }),
    );
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual(['@delfrance/data/admin']);
  });

  it("import closure: valvulas.ts → contas.ts is flagged, through Firestore's handle", () => {
    const recusado = fechoDeImportacoes(
      ['core/valvulas.ts'],
      leitor({
        'core/valvulas.ts': "import { idDeContaValido } from './contas';",
        'core/contas.ts':
          "import { integracaoCollection } from '@delfrance/data/admin/collections';",
      }),
    );
    expect(recusado.externos.filter(proibidoNoFecho)).toEqual([
      '@delfrance/data/admin/collections',
    ]);
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

  const IMPORTA_DO_LOGGER = "import { criarObservadorAmazon } from './log';\n";

  it.each([
    ['an inline observer', 'cliente({ onChamada: (e) => console.warn(e) })'],
    ['a forwarded one', 'cliente({ onChamada: deps.onChamada })'],
    ['the shorthand', 'cliente({ onChamada })'],
    ['a destructured one', 'const { onChamada } = deps;'],
    [
      'the raw event type',
      "import type { ChamadaAmazon } from '@delfrance/integrations-amazon-sp-api';",
    ],
    [
      'the call combined with an inline observer (&&)',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorAmazon({ conta }) && ((e) => console.warn(e.corpo)) })`,
    ],
    [
      'the call combined with a forwarded one (||)',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorAmazon({ conta }) || deps.x, x: 1 })`,
    ],
    [
      'an unbalanced call',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorAmazon({ conta: f(") })`,
    ],
    [
      'a local function of the same name',
      'const criarObservadorAmazon = (o) => (e) => console.log(e.corpo);\n' +
        'cliente({ onChamada: criarObservadorAmazon({ conta }) });',
    ],
    [
      'the name imported from elsewhere',
      "import { criarObservadorAmazon } from './outro/log';\n" +
        'cliente({ onChamada: criarObservadorAmazon({ conta }) });',
    ],
    [
      'another export renamed to the name',
      "import { linhaDaChamada as criarObservadorAmazon } from './log';\n" +
        'cliente({ onChamada: criarObservadorAmazon({ conta }) });',
    ],
    [
      'a parameter that shadows the import',
      `${IMPORTA_DO_LOGGER}function f(criarObservadorAmazon) { return cliente({ onChamada: criarObservadorAmazon({ conta }) }); }`,
    ],
  ])('seam flags %s', (_caso, fonte) => {
    expect(violacoesDoSeam('lib/amazon/core/contexto.ts', fonte).length).toBeGreaterThan(0);
  });

  it('seam accepts criarObservadorAmazon(…) imported from the logger, and exempts the logger itself', () => {
    expect(
      violacoesDoSeam(
        'lib/amazon/core/contexto.ts',
        "import { type LoggerAmazon, criarObservadorAmazon } from './log';\n" +
          'cliente({\n  onChamada: criarObservadorAmazon({ ...deps.registro, logger, conta: id }),\n  x: 1,\n});',
      ),
    ).toEqual([]);
    expect(
      violacoesDoSeam(
        'lib/amazon/conta/conectar.ts',
        "import { criarObservadorAmazon } from '../core/log';\n" +
          'trocar({ codigo, onChamada: criarObservadorAmazon({ logger, conta: f(")") }) })',
      ),
    ).toEqual([]);
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        "import { criarObservadorAmazon } from '@/lib/amazon/core/log';\n" +
          'trocar({ onChamada: criarObservadorAmazon({ logger, conta: id }) })',
      ),
    ).toEqual([]);
    // Near-miss: the same call, but the import path is relative to ANOTHER directory.
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        "import { criarObservadorAmazon } from './log';\n" +
          'trocar({ onChamada: criarObservadorAmazon({ logger, conta: id }) })',
      ),
    ).toHaveLength(1);
    expect(
      violacoesDoSeam(ARQUIVO_DO_LOGGER, 'export function f(e: ChamadaAmazon) { onChamada(e); }'),
    ).toEqual([]);
    // A longer name that merely contains the type's name is not the type.
    expect(violacoesDoSeam('app/x/route.ts', 'type R = ResultadoChamadaAmazon;')).toEqual([]);
  });

  it('`.message` in a logger call is flagged; outside one, or `.name` inside one, is not', () => {
    expect(mensagensLogadas('x.ts', "logger.warn('falhou', { erro: err.message });")).toHaveLength(
      1,
    );
    expect(
      mensagensLogadas('x.ts', "deps.logger?.warn('m', { e: (err as Error).message })"),
    ).toHaveLength(1);
    expect(
      mensagensLogadas('x.ts', "LOGGER_STDOUT_AMAZON.error('m', { e: x.message })"),
    ).toHaveLength(1);
    // Unbalanced: read to the end, fail closed.
    expect(mensagensLogadas('x.ts', "logger.info('m', { a: f(')' }, err.message")).toHaveLength(1);
    // The non-call writers, the untyped adapter, and a logger under another name.
    for (const fonte of [
      "registrarEventoAmazon(logger, 'chamada-bloqueada', 'INFO', 'm', { e: err.message });",
      'registrarChamadaBloqueadaAmazon(logger, { rota: err.message, valor });',
      "warnNaoTipado(deps.logger).warn('m', { e: err.message });",
      "registro.error('m', { e: err.message });",
    ]) {
      expect(mensagensLogadas('x.ts', fonte), fonte).toHaveLength(1);
    }
    expect(
      mensagensLogadas(
        'x.ts',
        "registrarEventoAmazon(logger, 'chamada-bloqueada', 'INFO', 'm', { e: err.name });",
      ),
    ).toEqual([]);
    // Near-misses.
    expect(mensagensLogadas('x.ts', "logger.warn('falhou', { erro: err.name });")).toEqual([]);
    expect(
      mensagensLogadas(
        'x.ts',
        "const m = err.message;\nlogger.warn('a mensagem (message) não', {});",
      ),
    ).toEqual([]);
  });

  it('`console.` is found in code and ignored in a comment', () => {
    expect(semComentarios('// console.warn\nconst x = 1;')).not.toMatch(/\bconsole\./);
    expect(semComentarios('/* x */ console.warn(1);')).toMatch(/\bconsole\./);
  });
});
