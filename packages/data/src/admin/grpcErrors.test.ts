/**
 * `isGrpcStatusError` / `isTransientGrpcError` — the discriminators a rule-6
 * catch uses to isolate an Admin-SDK Firestore failure (#1654). Each is tested
 * for WHERE it stops, not only that it fires: a near-miss shape must stay out,
 * or a catch built on it swallows a bug that merely carries a `code`.
 */
import { describe, expect, it } from 'vitest';

import { isGrpcStatusError, isTransientGrpcError } from './grpcErrors';

/** The shape the Admin SDK throws: an `Error` carrying a numeric gRPC `code`. */
function comCodigo(code: unknown): Error {
  return Object.assign(new Error(`gRPC code ${String(code)}`), { code });
}

/** Every non-OK gRPC status code (1 CANCELLED … 16 UNAUTHENTICATED). */
const TODOS = Array.from({ length: 16 }, (_, i) => i + 1);
/** DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE. */
const TRANSIENTES = [4, 8, 10, 13, 14];

describe('isGrpcStatusError', () => {
  it.each(TODOS)('an Error with the integer code %i → true', (code) => {
    expect(isGrpcStatusError(comCodigo(code))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['code 0 (OK is not a failure)', comCodigo(0)],
    ['code 17 (outside the gRPC status space)', comCodigo(17)],
    ['code -1', comCodigo(-1)],
    ['code 14.5 (not an integer)', comCodigo(14.5)],
    ['code NaN', comCodigo(Number.NaN)],
    ["code '14' (a string)", comCodigo('14')],
    [
      "a FirebaseError-style string code 'functions/unavailable'",
      comCodigo('functions/unavailable'),
    ],
    ['an Error with no code', new Error('sem código')],
    ['a TypeError with no code', new TypeError('bug')],
    ['a plain object {code: 14, message}', { code: 14, message: 'não é um Error' }],
    ['the number 14', 14],
    ['null', null],
    ['undefined', undefined],
  ])('%s → false', (_caso, err) => {
    expect(isGrpcStatusError(err)).toBe(false);
  });
});

describe('isTransientGrpcError', () => {
  it.each(TRANSIENTES)('code %i → true', (code) => {
    expect(isTransientGrpcError(comCodigo(code))).toBe(true);
  });

  // Every other gRPC code stays out — INVALID_ARGUMENT, NOT_FOUND,
  // FAILED_PRECONDITION and PERMISSION_DENIED among them: retrying those
  // repeats a deterministic failure.
  it.each(TODOS.filter((c) => !TRANSIENTES.includes(c)))('code %i → false', (code) => {
    expect(isTransientGrpcError(comCodigo(code))).toBe(false);
  });

  it.each<[string, unknown]>([
    ['a plain object {code: 14}', { code: 14, message: 'x' }],
    ["an Error whose code is the string '14'", comCodigo('14')],
    ['an Error with no code', new Error('UNAVAILABLE')],
    ['code 0', comCodigo(0)],
  ])('near-miss: %s → false', (_caso, err) => {
    expect(isTransientGrpcError(err)).toBe(false);
  });
});
