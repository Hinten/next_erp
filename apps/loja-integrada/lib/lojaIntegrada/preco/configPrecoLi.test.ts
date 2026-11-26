/**
 * `configPrecoLi.ts` (master plan step 13, PR 13-d): the clear's forma, read from the environment
 * an entry point passes in. Every refusal has a near-miss beside the value it is refused next to:
 * nothing is trimmed, case-folded or read as a JS literal.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { FORMA_PROMO_LIMPA_LI, FORMA_PROMO_LIMPA_PADRAO_LI } from '@delfrance/schemas';

import { FORMA_PROMO_LIMPA_ENV_LI, lerFormaPromoLimpaLi } from './configPrecoLi';

const comForma = (v: string | undefined) => ({ [FORMA_PROMO_LIMPA_ENV_LI]: v });

describe('the clear forma (LOJA_INTEGRADA_PRECO_PROMO_LIMPO)', () => {
  it('the variable name, and the default is `nulo` — never `igual-cheio`', () => {
    expect(FORMA_PROMO_LIMPA_ENV_LI).toBe('LOJA_INTEGRADA_PRECO_PROMO_LIMPO');
    expect(FORMA_PROMO_LIMPA_PADRAO_LI).toBe(FORMA_PROMO_LIMPA_LI.nulo);
    expect(lerFormaPromoLimpaLi({})).toBe(FORMA_PROMO_LIMPA_PADRAO_LI);
    expect(lerFormaPromoLimpaLi({})).not.toBe(FORMA_PROMO_LIMPA_LI.igualCheio);
  });

  it('unset and EXACTLY blank ⇒ `nulo`', () => {
    expect(lerFormaPromoLimpaLi({})).toBe('nulo');
    expect(lerFormaPromoLimpaLi(comForma(undefined))).toBe('nulo');
    expect(lerFormaPromoLimpaLi(comForma(''))).toBe('nulo');
  });

  it.each(['nulo', 'zero', 'igual-cheio'] as const)('EQUAL: %j exactly ⇒ itself', (forma) => {
    expect(lerFormaPromoLimpaLi(comForma(forma))).toBe(forma);
  });

  it.each([
    ' nulo',
    'nulo ',
    'NULO',
    'Nulo',
    'null',
    '0',
    'false',
    'igual_cheio',
    'igualCheio',
    'zero\n',
    ' ',
    'cheio',
  ])('⚠️ NEAR-MISS: %j ⇒ null (the run refuses; never trimmed, folded or guessed)', (valor) => {
    expect(lerFormaPromoLimpaLi(comForma(valor))).toBeNull();
  });

  it('never throws, whatever the environment holds', () => {
    for (const v of ['', 'x', '∞', '\u0000', 'nulo\u0000']) {
      expect(() => lerFormaPromoLimpaLi(comForma(v))).not.toThrow();
    }
  });
});

describe('the variable, documented where the operator looks (PR 13-d)', () => {
  const linhasDe = (relativo: string) =>
    readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8').split(/\r?\n/);
  const ENV_EXAMPLE = linhasDe('../../../../../.env.example');
  const APPHOSTING = linhasDe('../../../apphosting.yaml');

  it('a BLANK line in .env.example — exactly one, with no value', () => {
    expect(ENV_EXAMPLE.filter((l) => l.startsWith(`${FORMA_PROMO_LIMPA_ENV_LI}=`))).toEqual([
      `${FORMA_PROMO_LIMPA_ENV_LI}=`,
    ]);
  });

  it('named in apphosting.yaml’s comment rows, and never as an `env:` row (the functions codebase reads it)', () => {
    expect(APPHOSTING.some((l) => new RegExp(`^#\\s+${FORMA_PROMO_LIMPA_ENV_LI}\\b`).test(l))).toBe(
      true,
    );
    expect(
      APPHOSTING.some(
        (l) => !l.trimStart().startsWith('#') && l.includes(FORMA_PROMO_LIMPA_ENV_LI),
      ),
    ).toBe(false);
  });

  it('is not secret-shaped — `env-example-split.test.js`’s credential suffixes: it is config', () => {
    expect(FORMA_PROMO_LIMPA_ENV_LI).not.toMatch(
      /(SECRET|PASSWORD|_TOKEN|PRIVATE_KEY|CERT_BASE64|ENC_KEY)$/,
    );
  });
});
