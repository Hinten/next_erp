/**
 * The price trigger's relevance against the price function itself (master plan step 13, PR 13-e):
 * "not relevant" drops a write at zero reads, so it must NEVER be the answer for a write that moves
 * the target `precoAlvoLi` computes for some conta. Two shapes, each over seeded draws (mulberry32,
 * no dependency):
 *
 *  (i)  the written produto's OWN target, with its parent held fixed;
 *  (ii) a CHILD's target, when the written produto is that child's parent.
 *
 * In both, a differing target must come with `relevante` AND one of the reasons the trigger acts
 * on: the parent moved, the folded flag flipped, or a tabela THIS conta prices at moved. Every value
 * is invented.
 */
import { describe, expect, it } from 'vitest';
import { precoAlvoLi } from '@delfrance/schemas';

import {
  type DadosProdutoPrecoLi,
  relevanciaEventoPrecoLi,
  tabelaDaContaMoveuLi,
} from './relevanciaPrecoLi';

const ID = 'prod-li-1';
const N = 'tab-n';
const P = 'tab-p';
const X = 'tab-x';
/** The written produto in shape (ii): the parent the drawn child names. */
const PAI = 'pai-li-1';

const AUSENTE = Symbol('ausente');

function gerador(semente: number) {
  let s = semente;
  const aleatorio = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const escolher = <T>(xs: readonly T[]): T => xs[Math.floor(aleatorio() * xs.length)] as T;
  return { aleatorio, escolher };
}

type Gerador = ReturnType<typeof gerador>;

const VALORES = [10, 10.004, 10.01, 49.99, 49.991, 50, 0, 0.004, -1, '10', 1e17] as const;
const PAIS = [AUSENTE, null, '', ID, 'P1', 'P2', 'a/b'] as const;
const FLAGS = [AUSENTE, true, false, 'false', 0] as const;
const CONTAS = [
  { tabelaNormalId: N, tabelaPromocionalId: P },
  { tabelaNormalId: N, tabelaPromocionalId: N },
  { tabelaNormalId: N, tabelaPromocionalId: null },
  { tabelaNormalId: X, tabelaPromocionalId: P },
] as const;

/** One tabela entry: absent, `{valor}`, a legacy bare number, or `null`. */
function entrada(g: Gerador): unknown {
  const r = g.aleatorio();
  if (r < 0.25) return AUSENTE;
  if (r < 0.8) return { valor: g.escolher(VALORES) };
  if (r < 0.9) return g.escolher([10, 50]);
  return null;
}

function precos(g: Gerador): unknown {
  const r = g.aleatorio();
  if (r < 0.06) return AUSENTE;
  if (r < 0.1) return g.escolher([null, [], 5]);
  const mapa: Record<string, unknown> = {};
  for (const chave of [N, P, X, 'a/b']) {
    const e = entrada(g);
    if (e !== AUSENTE) mapa[chave] = e;
  }
  return mapa;
}

function payload(g: Gerador, paiId: unknown = g.escolher(PAIS)): Record<string, unknown> {
  const dados: Record<string, unknown> = {};
  const p = precos(g);
  if (p !== AUSENTE) dados.precos = p;
  if (paiId !== AUSENTE) dados.paiId = paiId;
  const flag = g.escolher(FLAGS);
  if (flag !== AUSENTE) dados.propagatePriceToChildren = flag;
  return dados;
}

/** The after side: the before side with each price-deciding field re-drawn with some chance. */
function depoisDe(g: Gerador, antes: Record<string, unknown>): Record<string, unknown> {
  const depois = structuredClone(antes);
  const outro = payload(g);
  for (const campo of ['precos', 'paiId', 'propagatePriceToChildren'] as const) {
    if (g.aleatorio() < 0.3) {
      if (Object.hasOwn(outro, campo)) depois[campo] = outro[campo];
      else delete depois[campo];
    }
  }
  // Noise outside the three fields: never a reason either way.
  if (g.aleatorio() < 0.3) depois.custo = g.escolher([11.11, 22.22]);
  if (g.aleatorio() < 0.3) depois.integracoesComProduto = ['conta-li-a'];
  return depois;
}

function alvo(
  produto: DadosProdutoPrecoLi,
  pai: DadosProdutoPrecoLi | null,
  conta: (typeof CONTAS)[number],
) {
  return precoAlvoLi({ produto: { id: ID, dados: produto }, pai, ...conta });
}

describe('relevance is never false when the price function’s target moves', () => {
  // CI runners are about 5× slower under load.
  it('5 000 seeded draws over both shapes, every conta pairing', { timeout: 30_000 }, () => {
    const g = gerador(0x13e_2026);
    const DRAWS = 5_000;
    let diferem = 0;
    let irrelevantes = 0;
    let soPelaTabela = 0;

    for (let i = 0; i < DRAWS; i += 1) {
      const conta = g.escolher(CONTAS);
      const forma = g.aleatorio() < 0.5 ? 'proprio' : 'filho';
      let antes: Record<string, unknown>;
      let depois: Record<string, unknown>;
      let difere: boolean;
      if (forma === 'proprio') {
        // (i) The written produto's own target; its parent is held fixed (or missing).
        antes = payload(g);
        depois = depoisDe(g, antes);
        const pai = g.aleatorio() < 0.15 ? null : payload(g);
        difere =
          JSON.stringify(alvo(antes, pai, conta)) !== JSON.stringify(alvo(depois, pai, conta));
      } else {
        // (ii) A child of the written produto: the parent before vs after.
        const filho = payload(g, PAI);
        antes = payload(g);
        depois = depoisDe(g, antes);
        difere =
          JSON.stringify(alvo(filho, antes, conta)) !== JSON.stringify(alvo(filho, depois, conta));
      }

      const r = relevanciaEventoPrecoLi({
        produtoId: forma === 'proprio' ? ID : PAI,
        antes,
        depois,
      });
      if (!r.relevante) irrelevantes += 1;
      if (!difere) continue;
      diferem += 1;

      expect(r.relevante, JSON.stringify({ forma, conta, antes, depois })).toBe(true);
      if (!r.relevante) continue;
      const tabela = tabelaDaContaMoveuLi(r.tabelasMovidas, conta);
      expect(
        r.paiMudou || r.flagMudou || tabela,
        JSON.stringify({ forma, conta, antes, depois }),
      ).toBe(true);
      if (tabela && !r.paiMudou && !r.flagMudou) soPelaTabela += 1;
    }

    // Anti-vacuity: both kinds of draw occur, and the tabela clause alone carries some.
    expect(diferem).toBeGreaterThan(DRAWS / 10);
    expect(irrelevantes).toBeGreaterThan(DRAWS / 10);
    expect(soPelaTabela).toBeGreaterThan(DRAWS / 50);
  });
});
