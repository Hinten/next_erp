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
 *    package is `criarObservadorLi(…)`, and no file names the raw event type —
 *    it carries the raw query and the full response text, and only the logger
 *    redacts them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ_LIB = fileURLToPath(new URL('.', import.meta.url));
const RAIZ_APP = fileURLToPath(new URL('../..', import.meta.url));

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

/** The logger's entry points (later steps add the valves and the sanitizer). */
const ENTRADAS_DO_FECHO = ['core/log.ts', 'core/redacao.ts', 'core/refCredencial.ts'];

/** The one file allowed to see the raw call event and build an observer. */
const ARQUIVO_DO_LOGGER = 'lib/lojaIntegrada/core/log.ts';
const SEAM_OK = 'onChamada: criarObservadorLi(';

/** Why a source text breaks the observer seam; empty when it does not. */
function violacoesDoSeam(arquivo: string, texto: string): string[] {
  if (arquivo === ARQUIVO_DO_LOGGER) return [];
  const violacoes: string[] = [];
  let i = texto.indexOf('onChamada');
  while (i !== -1) {
    if (!texto.startsWith(SEAM_OK, i)) violacoes.push(`${arquivo}: onChamada at ${String(i)}`);
    i = texto.indexOf('onChamada', i + 1);
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

  it.each([
    ['an inline observer', 'cliente({ onChamada: (e) => console.warn(e) })'],
    ['a forwarded one', 'cliente({ onChamada: deps.x })'],
    ['the shorthand', 'cliente({ onChamada })'],
    ['a destructured one', 'const { onChamada } = deps;'],
    [
      'the raw event type',
      "import type { ChamadaLi } from '@delfrance/integrations-loja-integrada';",
    ],
  ])('seam flags %s', (_caso, fonte) => {
    expect(violacoesDoSeam('lib/lojaIntegrada/core/contexto.ts', fonte)).toHaveLength(1);
  });

  it('seam accepts criarObservadorLi(…), and exempts the logger itself', () => {
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        'validarPersonalToken({ token, onChamada: criarObservadorLi({ conta: id }) })',
      ),
    ).toEqual([]);
    expect(
      violacoesDoSeam(ARQUIVO_DO_LOGGER, 'export function f(e: ChamadaLi) { onChamada(e); }'),
    ).toEqual([]);
    // A longer name that merely contains the type's name is not the type.
    expect(violacoesDoSeam('app/x/route.ts', 'type R = ResultadoChamadaLi;')).toEqual([]);
  });
});
