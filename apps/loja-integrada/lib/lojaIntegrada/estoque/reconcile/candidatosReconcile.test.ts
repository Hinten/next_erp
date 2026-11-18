/**
 * `candidatosReconcile.ts` (master plan step 12, PR 12-g): the run's candidate list — one per
 * (conta, store id), held to a byte budget counted by Firestore's own storage formula, and never
 * dropping an over-advertising row for an under-advertising one. Pure.
 */
import { describe, expect, it } from 'vitest';
import type { CandidatoReconcileEstoqueLi } from '@delfrance/schemas';

import { DELTA_SEM_LIMITE_LI } from '../planoEstoqueLi';
import {
  ListaCandidatosReconcileLi,
  MAX_BYTES_CANDIDATOS_RECONCILE_LI,
  bytesDoCandidatoLi,
} from './candidatosReconcile';

const cand = (i: string, d: number, c = 0, p = `p${i}`): CandidatoReconcileEstoqueLi => ({
  c,
  i,
  p,
  d,
});

describe('the size of one candidate', () => {
  it('Firestore’s formula: four one-letter names, two integers, two strings (+1 each)', () => {
    // 4 × (1 + 1) + 8 + 8 + (3 + 1) + (4 + 1) = 33
    expect(bytesDoCandidatoLi(cand('123', 5, 0, 'abcd'))).toBe(33);
    // UTF-8 bytes, not code units: 'ç' is two.
    expect(bytesDoCandidatoLi(cand('1', 0, 0, 'ç'))).toBe(26 + 1 + 2);
  });

  it('the budget keeps the run document far from 1 MiB', () => {
    expect(MAX_BYTES_CANDIDATOS_RECONCILE_LI).toBe(600_000);
    expect(MAX_BYTES_CANDIDATOS_RECONCILE_LI).toBeLessThan(1_048_576 / 1.5);
  });
});

describe('one candidate per (conta, store id)', () => {
  it('a second sighting REPLACES the first (the newer reading), never a second send', () => {
    const lista = new ListaCandidatosReconcileLi([]);
    expect(lista.adicionar(cand('7', 3))).toBe('adicionado');
    expect(lista.adicionar(cand('7', -1))).toBe('substituido');
    expect(lista.lista()).toEqual([cand('7', -1)]);
    expect(lista.tamanhoBytes).toBe(bytesDoCandidatoLi(cand('7', -1)));
    expect(lista.sujo).toBe(true);
  });

  it('⚠️ NEAR-MISS: the same store id of ANOTHER conta is another candidate', () => {
    const lista = new ListaCandidatosReconcileLi([]);
    lista.adicionar(cand('7', 3, 0));
    expect(lista.adicionar(cand('7', 3, 1))).toBe('adicionado');
    expect(lista.lista()).toHaveLength(2);
  });

  it('the stored list is read as is, and is not dirty until something changes', () => {
    const lista = new ListaCandidatosReconcileLi([cand('1', 1), cand('2', 2)]);
    expect(lista.sujo).toBe(false);
    expect(lista.lista()).toEqual([cand('1', 1), cand('2', 2)]);
    expect(lista.tamanhoBytes).toBe(bytesDoCandidatoLi(cand('1', 1)) * 2);
  });
});

describe('the byte budget drops the most UNDER-advertising row first', () => {
  const um = bytesDoCandidatoLi(cand('1', 0));

  it('a full list drops its LAST member in the queue’s order — the lowest d', () => {
    const lista = new ListaCandidatosReconcileLi([], um * 2);
    lista.adicionar(cand('1', -5));
    lista.adicionar(cand('2', 4));
    expect(lista.adicionar(cand('3', 1))).toBe('adicionado');
    expect(
      lista
        .lista()
        .map((c) => c.i)
        .sort(),
    ).toEqual(['2', '3']);
    expect(lista.descartados).toBe(1);
    expect(lista.tamanhoBytes).toBeLessThanOrEqual(um * 2);
  });

  it('⚠️ an over-advertising row is never displaced by an under-advertising one: the newcomer is dropped', () => {
    const lista = new ListaCandidatosReconcileLi(
      [cand('1', DELTA_SEM_LIMITE_LI), cand('2', 3)],
      um * 2,
    );
    expect(lista.adicionar(cand('3', -2))).toBe('descartado');
    expect(lista.lista()).toEqual([cand('1', DELTA_SEM_LIMITE_LI), cand('2', 3)]);
    expect(lista.descartados).toBe(1);
    // Nothing changed: the stored list need not be written again.
    expect(lista.sujo).toBe(false);
  });

  it('⚠️ NEAR-MISS: a tie in d is broken by the queue’s own order (conta, then store id)', () => {
    const lista = new ListaCandidatosReconcileLi([cand('5', 0)], um);
    // '4' sorts before '5' at the same d: '5' is the last member and goes.
    expect(lista.adicionar(cand('4', 0))).toBe('adicionado');
    expect(lista.lista()).toEqual([cand('4', 0)]);
    // '6' sorts after '4': the newcomer is the last member.
    expect(lista.adicionar(cand('6', 0))).toBe('descartado');
  });

  it('a replacement that no longer fits leaves the list changed (the old reading is gone)', () => {
    const lista = new ListaCandidatosReconcileLi([cand('1', 9), cand('2', 8)], um * 2);
    expect(lista.adicionar(cand('2', -9, 0, 'p2-mais-longo'))).toBe('descartado');
    expect(lista.lista()).toEqual([cand('1', 9)]);
    expect(lista.sujo).toBe(true);
  });
});
