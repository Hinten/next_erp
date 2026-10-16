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
 *    exist. The word is assembled below so this file does not contain it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RAIZ_LIB = fileURLToPath(new URL('.', import.meta.url));
const RAIZ_APP = fileURLToPath(new URL('../..', import.meta.url));

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
        'core/refCredencial.ts',
        'core/respond.ts',
        'core/valvulas.ts',
        'testing/fakeDb.ts',
        'testing/fakeOauthState.ts',
        'testing/fixtures.ts',
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
