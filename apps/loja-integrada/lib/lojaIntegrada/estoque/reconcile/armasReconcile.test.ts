/**
 * `armasReconcile.ts` (master plan step 13, PR 13-f1): which arm a slice can run, the both-valve
 * gate, and which arms a run carries. Pure: environments in, verdicts out.
 */
import { describe, expect, it } from 'vitest';

import { CHAMADAS_ENV_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import { FORMA_PROMO_LIMPA_ENV_LI } from '../../preco/configPrecoLi';
import { TETO_ESTOQUE_ENV_LI } from '../configEstoqueLi';
import {
  CONTADORES_DE_PRECO_DO_RUN_LI,
  CONTADOR_ESTOQUE_FORA_DO_RUN_LI,
  CONTADOR_PRECO_ABANDONADO_LI,
  CONTADOR_PRECO_NO_RUN_LI,
  armasDoRunLi,
  lerArmasDoSliceLi,
  reconcileDesligadoLi,
} from './armasReconcile';

const E = VALVULA_ENV_LI.estoque;
const P = VALVULA_ENV_LI.preco;

describe('lerArmasDoSliceLi / reconcileDesligadoLi — the both-valve gate', () => {
  it('both valves off (unset) ⇒ desligado, neither arm active, no setting read', () => {
    const armas = lerArmasDoSliceLi({ [CHAMADAS_ENV_LI]: 'on' });
    expect(reconcileDesligadoLi({})).toBe(true);
    expect(armas.estoque).toMatchObject({ ativa: false, teto: null });
    expect(armas.preco).toMatchObject({ ativa: false, forma: null });
  });

  it('only stock on ⇒ a stock-only slice; NEAR-MISS: a price `OFF`, ` on` or `true` reads as off', () => {
    for (const preco of [undefined, '', 'off', 'OFF', ' on', 'true', 'on ']) {
      const ambiente = { [E]: 'on', ...(preco === undefined ? {} : { [P]: preco }) };
      const armas = lerArmasDoSliceLi(ambiente);
      expect(armas.estoque.ativa, String(preco)).toBe(true);
      expect(armas.preco.ativa, String(preco)).toBe(false);
      expect(reconcileDesligadoLi(ambiente), String(preco)).toBe(false);
      // And with the stock valve unset, the same values leave both off.
      expect(reconcileDesligadoLi({ ...ambiente, [E]: undefined }), String(preco)).toBe(true);
    }
  });

  it('only price on (or dry-run) ⇒ a price-only slice, the forma read (unset = `nulo`)', () => {
    for (const modo of ['on', 'dry-run']) {
      const armas = lerArmasDoSliceLi({ [P]: modo });
      expect(armas.preco).toMatchObject({ ativa: true, forma: 'nulo' });
      expect(armas.preco.valvula.modo).toBe(modo);
      expect(armas.estoque.ativa).toBe(false);
      expect(reconcileDesligadoLi({ [P]: modo })).toBe(false);
    }
    expect(lerArmasDoSliceLi({ [P]: 'on', [FORMA_PROMO_LIMPA_ENV_LI]: 'zero' }).preco.forma).toBe(
      'zero',
    );
  });

  it('a forma that does not read (`NULO`, ` nulo`, `null`) ⇒ the price arm inactive; the valve still counts for the gate', () => {
    for (const forma of ['NULO', ' nulo', 'null', '0']) {
      const ambiente = { [P]: 'on', [FORMA_PROMO_LIMPA_ENV_LI]: forma };
      expect(lerArmasDoSliceLi(ambiente).preco, forma).toMatchObject({ ativa: false, forma: null });
      expect(reconcileDesligadoLi(ambiente), forma).toBe(false);
    }
  });

  it('a cap that does not read (`abc`) ⇒ the stock arm inactive; NEAR-MISS: under `off` the cap is not read at all', () => {
    const armas = lerArmasDoSliceLi({ [E]: 'on', [TETO_ESTOQUE_ENV_LI]: 'abc' });
    expect(armas.estoque).toMatchObject({ ativa: false, teto: null });
    expect(reconcileDesligadoLi({ [E]: 'on', [TETO_ESTOQUE_ENV_LI]: 'abc' })).toBe(false);
    expect(lerArmasDoSliceLi({ [E]: 'dry-run' }).estoque.teto).not.toBeNull();
    // Off: not read, so never "unreadable" either — the same null as a missing one.
    expect(lerArmasDoSliceLi({ [TETO_ESTOQUE_ENV_LI]: '5' }).estoque.teto).toBeNull();
  });
});

describe('armasDoRunLi — an arm is carried from the take, and can only be dropped', () => {
  it.each([
    [{}, { estoque: true, preco: false }],
    [{ [CONTADOR_PRECO_NO_RUN_LI]: 1 }, { estoque: true, preco: true }],
    [
      { [CONTADOR_PRECO_NO_RUN_LI]: 1, [CONTADOR_ESTOQUE_FORA_DO_RUN_LI]: 1 },
      { estoque: false, preco: true },
    ],
    [
      { [CONTADOR_PRECO_NO_RUN_LI]: 1, [CONTADOR_PRECO_ABANDONADO_LI]: 1 },
      { estoque: true, preco: false },
    ],
    // A dropped arm never comes back, whatever else the counters say.
    [{ [CONTADOR_PRECO_ABANDONADO_LI]: 1 }, { estoque: true, preco: false }],
    [
      { c0Validos: 3, erpProdutosLidos: 9 },
      { estoque: true, preco: false },
    ],
  ] as const)('%j ⇒ %j', (contadores, esperado) => {
    expect(armasDoRunLi(contadores)).toEqual(esperado);
  });

  it('the run-level price counters, exhaustive and pinned', () => {
    expect(CONTADORES_DE_PRECO_DO_RUN_LI).toEqual([
      'precoNoRun',
      'precoAbandonado',
      'estoqueForaDoRun',
    ]);
  });
});
