import { describe, expect, it } from 'vitest';
import { MAX_REF_CREDENCIAL } from '@delfrance/integrations-amazon-sp-api';
import { MAX_REF_CREDENCIAL_AMAZON } from '@delfrance/schemas';

import { AGORA_MS, REFRESH_TOKEN_A } from '../testing/fixtures';
import {
  FORMATO_REF,
  MAX_TAMANHO_REF,
  REF_CONSENTIMENTO,
  montarRef,
  versaoDaRef,
} from './formatoDaRef';
import * as refCredencial from './refCredencial';

const FP = '0123456789abcdef';

describe('versaoDaRef', () => {
  it('a valid ref gives its ms', () => {
    expect(versaoDaRef(montarRef(FP, AGORA_MS))).toBe(AGORA_MS);
    expect(versaoDaRef(`${FP}.1`)).toBe(1);
    expect(versaoDaRef(`${FP}.${String(Number.MAX_SAFE_INTEGER)}`)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('a ref derived from a real grant reads back its consent time', () => {
    const ref = refCredencial.refDaCredencial({
      refresh_token: REFRESH_TOKEN_A,
      autorizadoEmMs: AGORA_MS,
    });
    expect(versaoDaRef(ref)).toBe(AGORA_MS);
  });

  it.each([
    ['consentimento', REF_CONSENTIMENTO],
    ['a 15-hex fingerprint', `${FP.slice(1)}.${String(AGORA_MS)}`],
    ['a 17-hex fingerprint', `${FP}0.${String(AGORA_MS)}`],
    ['an uppercase-hex fingerprint', `${FP.toUpperCase()}.${String(AGORA_MS)}`],
    ['0 ms', `${FP}.0`],
    ['a leading zero', `${FP}.0${String(AGORA_MS)}`],
    ['an unsafe-integer ms', `${FP}.9007199254740993`],
    ['17 digits of ms', `${FP}.12345678901234567`],
    ['65 characters', `${FP}.${'1'.repeat(48)}`],
    ['no dot', `${FP}${String(AGORA_MS)}`],
    ['a trailing newline', `${FP}.${String(AGORA_MS)}\n`],
    ['empty', ''],
    ['a number', 123],
    ['null', null],
    ['undefined', undefined],
  ])('%s → null', (_c, ref) => {
    expect(versaoDaRef(ref)).toBeNull();
  });

  it('the 65-character probe really is longer than the limit (anti-vacuity)', () => {
    expect(`${FP}.${'1'.repeat(48)}`).toHaveLength(MAX_TAMANHO_REF + 1);
  });
});

describe('the format constants', () => {
  it('MAX_TAMANHO_REF equals the package limit and the schemas copy', () => {
    expect(MAX_TAMANHO_REF).toBe(MAX_REF_CREDENCIAL);
    expect(MAX_TAMANHO_REF).toBe(MAX_REF_CREDENCIAL_AMAZON);
  });

  it('REF_CONSENTIMENTO is outside the versioned format', () => {
    expect(REF_CONSENTIMENTO).toBe('consentimento');
    expect(FORMATO_REF.test(REF_CONSENTIMENTO)).toBe(false);
  });

  it('refCredencial.ts re-exports the SAME bindings (one owner of the format)', () => {
    expect(refCredencial.montarRef).toBe(montarRef);
    expect(refCredencial.REF_CONSENTIMENTO).toBe(REF_CONSENTIMENTO);
  });
});
