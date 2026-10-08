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
 *    not exist. The word is assembled below so this file does not contain it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
const ehTeste = (p: string) => p.endsWith('.test.ts');

describe('lib/lojaIntegrada layout', () => {
  const todos = arquivosTs(RAIZ_LIB);
  const fontes = todos.filter((p) => !ehTeste(p));

  it('the scan found the tree', () => {
    expect(fontes.map(rel)).toEqual(
      expect.arrayContaining([
        'avisos/avisos.ts',
        'conta/expiracaoSweep.ts',
        'core/credentialStore.ts',
        'core/estacionamento.ts',
        'core/contexto.ts',
        'core/respond.ts',
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
