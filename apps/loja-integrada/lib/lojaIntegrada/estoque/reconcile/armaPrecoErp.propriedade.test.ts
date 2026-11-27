/**
 * A property sweep of the price snapshot route (master plan step 13, PR 13-f1): what the key walk
 * stores for a child (`avaliarPrecoDaPaginaLi`) and what the parents unit then computes from it
 * with the parent's raw masked data (`alvoDaEntradaPrecoLi`) must be EXACTLY what `precoAlvoLi`
 * answers over the RAW child and parent documents and the conta's RAW tabelas — the oracle — for
 * random families: parent flags `true`, `false`, absent or junk; `precos` maps with junk shapes and
 * values past every rounding edge; a parent that is missing, a `''` root, a self-parent, a parent
 * id no document can have; a promotional tabela absent, distinct or equal to the normal one.
 *
 * Deterministic: a 32-bit seeded generator (mulberry32), no new dependency. Invented values only.
 */
import { describe, expect, it } from 'vitest';
import { alvoSnapshotDoAlvoLi, precoAlvoLi } from '@delfrance/schemas';

import { avaliarPrecoDaPaginaLi } from './armaPrecoErp';
import { tabelasDobradasLi } from './contasPrecoReconcile';
import { alvoDaEntradaPrecoLi } from './paisPrecoReconcile';

/** mulberry32: a deterministic generator in [0, 1). */
function gerador(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function escolher<T>(r: () => number, opcoes: readonly T[]): T {
  return opcoes[Math.floor(r() * opcoes.length)] as T;
}

/** A price value past every edge the readers judge: cents, half-cents, zero, negatives, huge. */
function valorSorteado(r: () => number): unknown {
  // Most draws a plain price, so the sweep reaches real targets; the rest every edge.
  if (r() < 0.6) return (1 + Math.floor(r() * 99_999)) / 100;
  return escolher(r, [
    () => Math.floor(r() * 100_000) / 100,
    () => Math.floor(r() * 100_000) / 1000,
    () => 10.005,
    () => 10.004,
    () => 0,
    () => 0.004,
    () => -0.004,
    () => -1,
    () => Math.floor(r() * 1e14),
    () => Number.MAX_SAFE_INTEGER,
    () => '10',
    () => Number.NaN,
    () => undefined,
  ])();
}

/** One tabela entry, of any stored shape. */
function entradaSorteada(r: () => number): unknown {
  if (r() < 0.8) return { valor: valorSorteado(r) };
  return escolher(r, [() => 12, () => null, () => ({}), () => 'x'])();
}

/** A `precos` map (or junk in its place) over a few tabela ids. */
function precosSorteados(r: () => number): unknown {
  const forma = r();
  if (forma < 0.08) return undefined;
  if (forma < 0.12) return escolher(r, [null, 'x', [], 7]);
  const precos: Record<string, unknown> = {};
  for (const tabela of ['tab-n', 'tab-p', 'tab-x']) {
    if (r() < 0.8) precos[tabela] = entradaSorteada(r);
  }
  return precos;
}

/** A document with only the masked price fields, each present or not. */
function documentoSorteado(r: () => number, paiId: unknown): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  if (paiId !== undefined) doc.paiId = paiId;
  const precos = precosSorteados(r);
  if (precos !== undefined) doc.precos = precos;
  if (r() < 0.6) {
    doc.propagatePriceToChildren = escolher(r, [true, false, 'false', 0, null, 'sim']);
  }
  return doc;
}

const LINK = {
  contaLojaIntegrada: 'documents/integracao/C1',
  id: 1001,
  paiProdutoIntegradaId: 900,
  removido: false,
};

describe('the snapshot route ≡ precoAlvoLi over the raw documents', () => {
  it(
    '3,000 random families: the walk’s entry, then the parents unit’s target, equal the oracle’s target',
    // A 3,000-draw sweep; CI runners are slower under load.
    { timeout: 60_000 },
    () => {
      const r = gerador(0x13f1a);
      // Anti-vacuity: the sweep must reach every kind of answer, both ways a parent can go.
      const vistos = new Map<string, number>();
      const ver = (k: string): void => {
        vistos.set(k, (vistos.get(k) ?? 0) + 1);
      };
      for (let n = 0; n < 3_000; n += 1) {
        const promoBruta = escolher(r, [null, 'tab-p', 'tab-n']);
        const tabelas = tabelasDobradasLi({ normal: 'tab-n', promocional: promoBruta });
        if (tabelas === null) throw new Error('inalcançável');
        const paiId = escolher(r, [undefined, '', 'f1', 'pai-1', 'pai-1', 'pai-1', 'a/b', '__x__']);
        const filho = documentoSorteado(r, paiId);
        const paiExiste = r() < 0.8;
        const pai = documentoSorteado(r, undefined);

        const walk = avaliarPrecoDaPaginaLi({
          grupos: [{ produtoId: 'f1', links: [LINK] }],
          produtos: new Map([['f1', { id: 'f1', dados: filho }]]),
          conta: { idx: 0, contaId: 'C1', tabelas },
        });
        const entrada = walk.entradas[0]?.[1];
        if (entrada === undefined) throw new Error('o caminho não escreveu a entrada');
        const alvo =
          entrada.a ??
          alvoDaEntradaPrecoLi({
            entrada,
            pai: entrada.pai != null && paiExiste ? pai : null,
            tabelas,
          });

        const oraculo = alvoSnapshotDoAlvoLi(
          precoAlvoLi({
            produto: { id: 'f1', dados: filho },
            pai: paiExiste ? pai : null,
            tabelaNormalId: 'tab-n',
            tabelaPromocionalId: promoBruta,
          }),
        );
        expect(alvo, JSON.stringify({ n, promoBruta, filho, pai, paiExiste })).toEqual(oraculo);
        ver('r' in oraculo ? oraculo.r : oraculo.q === null ? 'limpa' : 'promo');
        if (entrada.pai != null && paiExiste) {
          ver(pai.propagatePriceToChildren === false ? 'pai-nao-propaga' : 'pai-propaga');
        }
      }
      for (const k of [
        'promo',
        'limpa',
        'sem-preco',
        'ilegivel',
        'pai-ausente',
        'pai-propaga',
        'pai-nao-propaga',
      ]) {
        expect(vistos.get(k) ?? 0, k).toBeGreaterThan(50);
      }
    },
  );
});
