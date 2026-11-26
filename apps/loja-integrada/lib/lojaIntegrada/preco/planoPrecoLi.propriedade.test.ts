/**
 * PROPERTY sweep of `planoPrecoLi.ts` (master plan step 13, PR 13-d): seeded draws over the
 * store's leaves (JSON numbers, two- and four-decimal text, `null`, 0, unreadable values), targets
 * (a full price, a promotion or the clear), `baixar` and the clear's forma — each checked against
 * an INDEPENDENT oracle written here in integer centavos. The oracle never calls the shared helpers:
 * the generator keeps what each drawn spelling MEANS, so the plan is judged by meaning, not by a
 * second copy of the fold.
 *
 *  (a) `enviar` never lowers the full price, a positive promotion or the effective price when
 *      `baixar` is false;
 *  (b) `nao-baixado` only when `baixar` is false, with exactly the oracle's leaves;
 *  (c) `refletido` ⇔ the oracle's "same centavos, or the clear under the forma";
 *  (d) `atual-ilegivel` ⇔ an unreadable store leaf;
 *  (e) every `enviar` echoes the detail's custo and `sob_consulta` by identity.
 *
 * Deterministic: a 32-bit seeded generator (mulberry32), no new dependency. Invented values only.
 */
import { describe, expect, it } from 'vitest';
import type { ProdutoComPrecoDetalheLi } from '@delfrance/integrations-loja-integrada';
import {
  type EnvioPrecoLi,
  FORMA_PROMO_LIMPA_LI,
  type FormaPromoLimpaLi,
} from '@delfrance/schemas';

import { detalhePrecoLi } from '../testing/precoLi';
import { type FolhaBaixaPrecoLi, planoPrecoLi } from './planoPrecoLi';

/** mulberry32: a deterministic generator in [0, 1). */
function mulberry32(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escolher<T>(r: () => number, de: readonly T[]): T {
  return de[Math.floor(r() * de.length)] as T;
}

/** What a drawn store leaf MEANS: integer centavos (0 included), nothing, or unreadable. */
type SentidoLi = { readonly centavos: number } | 'vazio' | 'ilegivel';

/** Amounts near one another, so lowerings, equalities and raises all occur. */
const CENTAVOS = [1111, 2222, 4443, 4444, 4445, 5554, 5555, 5556, 5560] as const;
const ILEGIVEIS: readonly unknown[] = ['abc', '1,50', -1, '-1.00', true, { v: 1 }];

/** A store leaf in one of its spellings, and what it means. */
function folhaSorteada(r: () => number): { readonly valor: unknown; readonly sentido: SentidoLi } {
  const x = r();
  if (x < 0.12) return { valor: null, sentido: 'vazio' };
  if (x < 0.2) return { valor: escolher(r, [0, '0.00', '0.0000', '0']), sentido: { centavos: 0 } };
  if (x < 0.27) return { valor: escolher(r, ILEGIVEIS), sentido: 'ilegivel' };
  const c = escolher(r, CENTAVOS);
  return { valor: escolher(r, grafias(c)), sentido: { centavos: c } };
}

/**
 * `c` centavos as the store spells an amount: a JSON number, two-decimal text and four-decimal
 * text — built from the integer digits, never by rounding a float.
 */
function grafias(c: number): readonly unknown[] {
  const inteiros = String((c - (c % 100)) / 100);
  const fracao = String(c % 100).padStart(2, '0');
  return [c / 100, `${inteiros}.${fracao}`, `${inteiros}.${fracao}00`];
}

/** The leaf spelling `c` centavos (0 for a clear), in one of the store's spellings. */
function folhaDe(
  r: () => number,
  c: number | null,
): { readonly valor: unknown; readonly sentido: SentidoLi } {
  if (c === null) return { valor: escolher(r, [null, 0, '0.0000']), sentido: 'vazio' };
  return { valor: escolher(r, grafias(c)), sentido: { centavos: c } };
}

/** The positive centavos of a readable meaning, or `null`. */
const positivo = (s: SentidoLi): number | null =>
  typeof s !== 'string' && s.centavos > 0 ? s.centavos : null;

interface Oraculo {
  readonly ilegivel: boolean;
  readonly refletido: boolean;
  readonly folhas: readonly FolhaBaixaPrecoLi[];
}

/** The oracle, in integer centavos, from the MEANINGS alone. */
function oraculo(
  alvo: { readonly cheio: number; readonly promo: number | null },
  cheio: SentidoLi,
  promo: SentidoLi,
  forma: FormaPromoLimpaLi,
): Oraculo {
  if (cheio === 'ilegivel' || promo === 'ilegivel') {
    return { ilegivel: true, refletido: false, folhas: [] };
  }
  const cheioLoja = positivo(cheio);
  const promoLoja = positivo(promo);
  const efetivoLoja =
    cheioLoja === null && promoLoja === null
      ? null
      : Math.min(cheioLoja ?? Number.POSITIVE_INFINITY, promoLoja ?? Number.POSITIVE_INFINITY);

  const cheioIgual = cheioLoja !== null && cheioLoja === alvo.cheio;
  const promoLimpa =
    promoLoja === null || (forma === FORMA_PROMO_LIMPA_LI.igualCheio && promoLoja === cheioLoja);
  const refletido = cheioIgual && (alvo.promo === null ? promoLimpa : promoLoja === alvo.promo);

  const efetivoNovo = alvo.promo === null ? alvo.cheio : Math.min(alvo.cheio, alvo.promo);
  const folhas: FolhaBaixaPrecoLi[] = [];
  if (cheioLoja !== null && alvo.cheio < cheioLoja) folhas.push('cheio');
  if (alvo.promo !== null && promoLoja !== null && alvo.promo < promoLoja) {
    folhas.push('promocional');
  }
  if (efetivoLoja !== null && efetivoNovo < efetivoLoja) folhas.push('efetivo');
  return { ilegivel: false, refletido, folhas };
}

const SORTEIOS = 3_000;
const FORMAS = [
  FORMA_PROMO_LIMPA_LI.nulo,
  FORMA_PROMO_LIMPA_LI.zero,
  FORMA_PROMO_LIMPA_LI.igualCheio,
] as const;

describe('PROPERTY: the plan against an independent integer-centavos oracle', () => {
  // CI runners are ~5× slower under load: 3 000 seeded draws get their own budget.
  it(`${String(SORTEIOS)} seeded draws: (a)–(e)`, { timeout: 60_000 }, () => {
    const r = mulberry32(13_013);
    const vistos = { enviar: 0, refletido: 0, naoBaixado: 0, ilegivel: 0 };
    for (let i = 0; i < SORTEIOS; i++) {
      const alvoCheio = escolher(r, CENTAVOS);
      const alvoPromo = r() < 0.4 ? null : escolher(r, CENTAVOS);
      // A fifth of the draws spell the target itself (in any spelling), so reflected is common.
      const refletir = r() < 0.2;
      const cheio = refletir ? folhaDe(r, alvoCheio) : folhaSorteada(r);
      const promo = refletir ? folhaDe(r, alvoPromo) : folhaSorteada(r);
      const custo = escolher(r, [null, 0, 12.34, -1.5, '12.34', 'abc']);
      const sobConsulta = r() < 0.5;
      const baixar = r() < 0.5;
      const forma = escolher(r, FORMAS);
      const alvo: EnvioPrecoLi = {
        cheioCentavos: alvoCheio,
        promo: alvoPromo === null ? 'limpar' : { centavos: alvoPromo },
      };
      const detalhe: ProdutoComPrecoDetalheLi = {
        ...detalhePrecoLi(1001, { preco_cheio: null, preco_promocional: null, preco_custo: null }),
        preco_cheio: cheio.valor,
        preco_promocional: promo.valor,
        preco_custo: custo,
        preco_sob_consulta: sobConsulta,
      };
      const p = planoPrecoLi({ alvo, detalhe, idLi: 1001, baixar, forma });
      const o = oraculo(
        { cheio: alvoCheio, promo: alvoPromo },
        cheio.sentido,
        promo.sentido,
        forma,
      );
      const rotulo = `sorteio ${String(i)}: ${JSON.stringify({ cheio: cheio.valor, promo: promo.valor, alvoCheio, alvoPromo, baixar, forma })}`;

      // (d)
      expect(p.tipo === 'atual-ilegivel', rotulo).toBe(o.ilegivel);
      if (o.ilegivel) {
        vistos.ilegivel += 1;
        continue;
      }
      // (c)
      expect(p.tipo === 'refletido', rotulo).toBe(o.refletido);
      if (o.refletido) {
        vistos.refletido += 1;
        continue;
      }
      if (p.tipo === 'nao-baixado') {
        // (b)
        vistos.naoBaixado += 1;
        expect(baixar, rotulo).toBe(false);
        expect(p.folhas, rotulo).toEqual(o.folhas);
        continue;
      }
      expect(p.tipo, rotulo).toBe('enviar');
      if (p.tipo !== 'enviar') continue;
      vistos.enviar += 1;
      // (a)
      if (!baixar) expect(o.folhas, rotulo).toEqual([]);
      // (e)
      expect(Object.is(p.entrada.custo, custo), rotulo).toBe(true);
      expect(p.entrada.sobConsulta, rotulo).toBe(sobConsulta);
      expect(p.entrada.formaPromoLimpa, rotulo).toBe(forma);
      expect(p.entrada.alvo, rotulo).toEqual(alvo);
    }
    // Anti-vacuity: every branch was met many times.
    for (const [ramo, n] of Object.entries(vistos)) {
      expect(n, ramo).toBeGreaterThan(SORTEIOS / 30);
    }
  });
});
