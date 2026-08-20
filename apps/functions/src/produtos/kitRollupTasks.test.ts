import { AppErrorCode, FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { describe, expect, it } from 'vitest';

import {
  KIT_ROLLUP_QUEUE,
  KitRollupTasksDisabledError,
  isFalhaDeEnfileiramentoContivel,
} from './kitRollupTasks';

describe('KIT_ROLLUP_QUEUE', () => {
  it('is the deployed function name — rename both together or the enqueue 404s', () => {
    expect(KIT_ROLLUP_QUEUE).toBe('recalcularDimensoesKit');
  });
});

describe('isFalhaDeEnfileiramentoContivel', () => {
  it('contains the kill switch', () => {
    expect(isFalhaDeEnfileiramentoContivel(new KitRollupTasksDisabledError())).toBe(true);
  });

  it('contains the REAL transport failure — a FirebaseFunctionsError', () => {
    // ⚠️ The regression this test exists for. `getFunctions().taskQueue().enqueue()`
    // throws this class, whose `code` is a STRING (`functions/permission-denied`),
    // not a gRPC number — so the numeric `code >= 1 && code <= 16` idiom copied
    // from the ML sweeps matched nothing and the guard never fired.
    const err = new FirebaseFunctionsError({
      code: 'permission-denied',
      message: 'the caller does not have permission',
    });
    expect(err.code).toBe('functions/permission-denied');
    expect(typeof err.code).toBe('string');
    expect(isFalhaDeEnfileiramentoContivel(err)).toBe(true);
  });

  it('contains a credential that could not be resolved', () => {
    const err = new FirebaseAppError({
      code: AppErrorCode.INVALID_CREDENTIAL,
      message: 'no service account',
    });
    expect(err.code).toBe('app/invalid-credential');
    expect(isFalhaDeEnfileiramentoContivel(err)).toBe(true);
  });

  it('does NOT contain a plain Error — a coding bug must still surface', () => {
    expect(isFalhaDeEnfileiramentoContivel(new Error('boom'))).toBe(false);
    expect(isFalhaDeEnfileiramentoContivel(new TypeError('x is not a function'))).toBe(false);
  });

  it('does NOT contain a bare object that merely LOOKS coded', () => {
    // The old shape-based check would have said `true` here and `false` for the
    // real one — exactly backwards.
    expect(isFalhaDeEnfileiramentoContivel({ code: 7 })).toBe(false);
    expect(isFalhaDeEnfileiramentoContivel({ code: 'functions/permission-denied' })).toBe(false);
    expect(isFalhaDeEnfileiramentoContivel(null)).toBe(false);
    expect(isFalhaDeEnfileiramentoContivel(undefined)).toBe(false);
  });
});
