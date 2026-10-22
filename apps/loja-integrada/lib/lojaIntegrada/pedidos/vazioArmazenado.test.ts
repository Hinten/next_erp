import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { vazioArmazenadoLi } from './vazioArmazenado';

/** The three mappers that fill a stored document's fields once. */
const MAPEADORES = ['pedidoMapeamento.ts', 'freteMapeamento.ts', 'pagamentoMapeamento.ts'];

describe('vazioArmazenadoLi: the one fill-once predicate', () => {
  it('EQUAL: null, absent and the empty text are all "nothing stored yet"', () => {
    for (const vazio of [null, undefined, '']) {
      expect(vazioArmazenadoLi(vazio), String(vazio)).toBe(true);
    }
  });

  it('⚠️ NEAR-MISS: 0, false, a blank text, an empty list or map are VALUES somebody wrote', () => {
    for (const valor of [0, false, ' ', [], {}, 'x', Number.NaN]) {
      expect(vazioArmazenadoLi(valor), JSON.stringify(valor)).toBe(false);
    }
  });

  it('every fill-once mapper imports it, and none keeps a copy of its own', () => {
    for (const nome of MAPEADORES) {
      const texto = readFileSync(fileURLToPath(new URL(`./${nome}`, import.meta.url)), 'utf8');
      expect(texto.includes("from './vazioArmazenado'"), `${nome} imports it`).toBe(true);
      expect(/function\s+vazio\w*\s*\(/.test(texto), `${nome} keeps no copy`).toBe(false);
    }
  });
});
