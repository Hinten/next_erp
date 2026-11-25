/**
 * The effective price valve: the preview flag fails closed — no batch decision
 * is ever a feed under it — and changes nothing without it.
 */
import { describe, expect, it } from 'vitest';

import {
  CANARIO_ENV_AMAZON,
  FLUXO_AMAZON,
  MODO_AMAZON,
  VALVULA_ENV_AMAZON,
  decidirAlvo,
  decidirLote,
  lerValvula,
} from '../core/valvulas';
import { VEREDITO_VALVULA_PRECO_AMAZON, valvulaPrecoEfetiva } from './modoPreco';

const valvula = (modo: string | undefined, canario: string | undefined) =>
  lerValvula(FLUXO_AMAZON.preco, {
    [VALVULA_ENV_AMAZON.preco]: modo,
    [CANARIO_ENV_AMAZON.preco]: canario,
  });
const LISTA = 'conta-1:SKU-1,conta-1:SKU-2';

describe('★ valvulaPrecoEfetiva — the preview flag fails closed', () => {
  it('★ the flag + on + `*` ⇒ the valve reads `dry-run` (decidirLote: dry-run) plus the ERROR verdict; NEAR-MISS: no flag + `*` ⇒ feed', () => {
    const efetiva = valvulaPrecoEfetiva(valvula('on', '*'), true);
    expect(efetiva.valvula.modo).toBe(MODO_AMAZON.dryRun);
    expect(decidirLote(efetiva.valvula).modo).toBe(MODO_AMAZON.dryRun);
    expect(efetiva.veredito).toBe(VEREDITO_VALVULA_PRECO_AMAZON.validacaoComTodos);
    expect(efetiva.previa).toBe(true);
    // …and every SKU under it is a dry-run: a task writes nothing either.
    expect(decidirAlvo(efetiva.valvula, 'conta-1', 'SKU-1').modo).toBe(MODO_AMAZON.dryRun);

    const sem = valvulaPrecoEfetiva(valvula('on', '*'), false);
    expect(decidirLote(sem.valvula).modo).toBe('feed');
    expect(sem).toEqual({ valvula: valvula('on', '*'), previa: false, veredito: null });
  });

  it('★ the flag + on + a LIST ⇒ the valve unchanged (Decide hands the canary to tasks) and every task previews', () => {
    const lista = valvula('on', LISTA);
    const efetiva = valvulaPrecoEfetiva(lista, true);
    expect(efetiva.valvula).toBe(lista);
    expect(efetiva.previa).toBe(true);
    expect(efetiva.veredito).toBeNull();
    expect(decidirLote(efetiva.valvula).modo).toBe('so-patches-do-canario');
    expect(decidirAlvo(efetiva.valvula, 'conta-1', 'SKU-1')).toEqual({
      modo: MODO_AMAZON.on,
      motivo: 'no-canario',
    });
  });

  it('the flag + off ⇒ off; the flag + dry-run ⇒ dry-run; nothing else is touched', () => {
    for (const modo of ['off', 'dry-run'] as const) {
      const v = valvula(modo, '*');
      const efetiva = valvulaPrecoEfetiva(v, true);
      expect(efetiva.valvula, modo).toBe(v);
      expect(efetiva.veredito, modo).toBeNull();
    }
    expect(decidirLote(valvulaPrecoEfetiva(valvula('off', '*'), true).valvula).modo).toBe('off');
  });

  it('★ under the flag NO batch decision is ever a feed, over every mode and canary form (the closed set, whole)', () => {
    for (const modo of [undefined, '', 'off', 'dry-run', 'on', 'ON', ' on']) {
      for (const canario of [undefined, '', '*', LISTA, ' *', 'lixo']) {
        const efetiva = valvulaPrecoEfetiva(valvula(modo, canario), true);
        expect(decidirLote(efetiva.valvula).modo, `${String(modo)} / ${String(canario)}`).not.toBe(
          'feed',
        );
        expect(efetiva.previa).toBe(true);
      }
    }
  });

  it('without the flag the valve is returned as read, every form', () => {
    for (const modo of ['off', 'dry-run', 'on']) {
      for (const canario of [undefined, '*', LISTA]) {
        const v = valvula(modo, canario);
        expect(valvulaPrecoEfetiva(v, false)).toEqual({
          valvula: v,
          previa: false,
          veredito: null,
        });
      }
    }
  });
});
