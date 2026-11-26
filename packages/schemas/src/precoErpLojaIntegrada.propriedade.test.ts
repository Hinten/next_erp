/**
 * A property sweep of `precoRefletidoLi` (master plan step 13): drawn targets in integer
 * centavos against every spelling the store may hand back for the SAME value (a JSON number, a
 * two-decimal text, the price resource's four-decimal text, the text a JSON number prints), and
 * against the near-misses one centavo away. Its scope, not only that it applies: every spelling of
 * the target is reflected, and nothing one centavo off is.
 *
 * Deterministic: a 32-bit seeded generator (mulberry32), no new dependency. The texts are built
 * from the integer centavos with string arithmetic only, never by scaling a float.
 */
import { describe, expect, it } from 'vitest';

import {
  type EnvioPrecoLi,
  FORMA_PROMO_LIMPA_LI,
  type FormaPromoLimpaLi,
  precoRefletidoLi,
} from './precoErpLojaIntegrada';

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

/** A positive integer centavos amount, log-uniform in [1, 1e13]. */
function centavosSorteados(r: () => number): number {
  return Math.max(1, Math.floor(Math.exp(r() * Math.log(1e13))));
}

/** `centavos` as reais text with exactly `casas` decimals (2 or 4), by string arithmetic. */
function textoComCasas(centavos: number, casas: 2 | 4): string {
  const resto = centavos % 100;
  const inteiros = String((centavos - resto) / 100);
  const fracao = String(resto).padStart(2, '0');
  return `${inteiros}.${casas === 2 ? fracao : `${fracao}00`}`;
}

/** `centavos` as a JSON number prints it: no point for whole reais, no trailing zero. */
function textoSemZeros(centavos: number): string {
  const resto = centavos % 100;
  const inteiros = String((centavos - resto) / 100);
  if (resto === 0) return inteiros;
  return `${inteiros}.${String(resto).padStart(2, '0').replace(/0$/, '')}`;
}

/** Every spelling of one store value: the JSON number and three texts. */
function grafias(centavos: number): readonly unknown[] {
  return [
    centavos / 100,
    textoComCasas(centavos, 2),
    textoComCasas(centavos, 4),
    textoSemZeros(centavos),
  ];
}

const FORMAS: readonly FormaPromoLimpaLi[] = [
  FORMA_PROMO_LIMPA_LI.nulo,
  FORMA_PROMO_LIMPA_LI.zero,
  FORMA_PROMO_LIMPA_LI.igualCheio,
];

const LIMPEZAS: readonly unknown[] = [null, 0, '0.00', '0', '0.0000'];

const ALVOS = 3_000;

describe('precoRefletidoLi — a property sweep over drawn targets', () => {
  // CI runners are about 5× slower under load: the sweep gets an explicit bound.
  it(
    `${String(ALVOS)} targets × three formas: every spelling is reflected, one centavo off never is`,
    { timeout: 60_000 },
    () => {
      const r = gerador(0x13c);
      let verificados = 0;
      for (let n = 0; n < ALVOS; n++) {
        const cheio = centavosSorteados(r);
        const limpa = r() < 0.5;
        const promo = limpa ? null : centavosSorteados(r);
        const alvo: EnvioPrecoLi = {
          cheioCentavos: cheio,
          promo: promo === null ? 'limpar' : { centavos: promo },
        };
        const ver = (forma: FormaPromoLimpaLi, c: unknown, p: unknown) =>
          precoRefletidoLi({ alvo, forma, atual: { cheio: c, promocional: p } });
        for (const forma of FORMAS) {
          const promosIguais = promo === null ? LIMPEZAS : grafias(promo);
          // EQUAL: every spelling of the same store value, on both leaves.
          for (const c of grafias(cheio)) {
            for (const p of promosIguais) {
              expect(ver(forma, c, p), `${forma} ${String(c)} ${String(p)}`).toBe(true);
              verificados += 1;
            }
          }
          // ⚠️ NEAR-MISS: one centavo either way on the full price.
          for (const delta of [-1, 1]) {
            for (const c of grafias(cheio + delta)) {
              expect(ver(forma, c, promosIguais[0]), `${forma} cheio ${String(c)}`).toBe(false);
            }
          }
          if (promo !== null) {
            // ⚠️ NEAR-MISS: one centavo either way on a positive promotion.
            for (const delta of [-1, 1]) {
              for (const p of grafias(promo + delta)) {
                expect(ver(forma, cheio / 100, p), `${forma} promo ${String(p)}`).toBe(false);
              }
            }
          } else {
            // ⚠️ NEAR-MISS: a positive store promotion where the target clears.
            const loja = centavosSorteados(r);
            const landed = forma === FORMA_PROMO_LIMPA_LI.igualCheio && loja === cheio;
            for (const p of grafias(loja)) {
              expect(ver(forma, cheio / 100, p), `${forma} limpa ${String(p)}`).toBe(landed);
            }
            // Under igual-cheio the full price AS the promotion is the landed clear; elsewhere not.
            for (const p of grafias(cheio)) {
              expect(ver(forma, cheio / 100, p), `${forma} igual ${String(p)}`).toBe(
                forma === FORMA_PROMO_LIMPA_LI.igualCheio,
              );
            }
          }
        }
      }
      // Anti-vacuity: the sweep compared what it says it compared.
      expect(verificados).toBeGreaterThan(ALVOS * FORMAS.length * 4);
    },
  );
});
