/**
 * The app's error classes and the package's `LiError` are DISJOINT families —
 * the property `erros.ts`'s header promises. A step-3 `catch` narrowed on
 * `LiError` (a Loja Integrada answer) must never swallow "this conta is
 * parked" or "the stored credential is corrupt".
 *
 * Exhaustive over the module's exports, so a new subclass is covered the day
 * it is added; the count below fails until this file is told about it.
 */
import { describe, expect, it } from 'vitest';
import { LiError } from '@delfrance/integrations-loja-integrada';

import * as erros from './erros';
import {
  LiAppError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from './erros';

const ID = 'conta-li-1';

/** One instance of every concrete class the module exports. */
const INSTANCIAS: readonly LiAppError[] = [
  new LiContaNaoEncontradaError(ID),
  new LiContaInativaError(ID),
  new LiCredencialAusenteError(ID),
  new LiCredencialInvalidaError(ID, ['x']),
  new LiCredencialAlteradaError(ID),
  new LiContaParadaError(ID, 401, 1),
  new LiEstacionamentoEmConflitoError(ID, 3),
];

describe('the app errors are NOT LiError', () => {
  it('every exported subclass of LiAppError is instantiated here (7 of them)', () => {
    const subclasses = Object.values(erros).filter(
      (v) => typeof v === 'function' && v.prototype instanceof LiAppError,
    );
    expect(subclasses).toHaveLength(7);
    for (const classe of subclasses) {
      expect(
        INSTANCIAS.some((e) => e.constructor === classe),
        classe.name,
      ).toBe(true);
    }
  });

  it.each(INSTANCIAS.map((e) => [e.name, e] as const))(
    '%s roots at LiAppError and is not a LiError',
    (_nome, err) => {
      expect(err).toBeInstanceOf(LiAppError);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(LiError);
      expect(err.integracaoId).toBe(ID);
    },
  );

  it('near-miss: the package class is not an app error either', () => {
    expect(LiError.prototype instanceof LiAppError).toBe(false);
    expect(LiAppError.prototype instanceof LiError).toBe(false);
  });
});
