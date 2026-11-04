import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { MAX_REF_CREDENCIAL } from '@delfrance/integrations-amazon-sp-api';
import { MAX_REF_CREDENCIAL_AMAZON } from '@delfrance/schemas';

import { AGORA_MS, REFRESH_TOKEN_A, REFRESH_TOKEN_B } from '../testing/fixtures';
import {
  REF_CONSENTIMENTO,
  fingerprintDoRefreshToken,
  montarRef,
  refDaCredencial,
} from './refCredencial';

describe('fingerprintDoRefreshToken', () => {
  it('pins the domain prefix with a literal test vector (changing it re-derives every ref)', () => {
    // sha256('amazon:lwa-refresh-token:tok|vetor') → first 16 hex characters.
    expect(fingerprintDoRefreshToken('tok|vetor')).toBe('06bf48585ec92440');
    const recalculado = createHash('sha256')
      .update('amazon:lwa-refresh-token:tok|vetor', 'utf8')
      .digest('hex')
      .slice(0, 16);
    expect(recalculado).toBe('06bf48585ec92440');
  });

  it('is NOT a plain sha256 of the token (near-miss: the prefix is load-bearing)', () => {
    const semPrefixo = createHash('sha256').update('tok|vetor', 'utf8').digest('hex').slice(0, 16);
    expect(fingerprintDoRefreshToken('tok|vetor')).not.toBe(semPrefixo);
  });
});

describe('refDaCredencial', () => {
  const base = { refresh_token: REFRESH_TOKEN_A, autorizadoEmMs: AGORA_MS };

  it('is `<16 hex>.<autorizadoEmMs>`', () => {
    expect(refDaCredencial(base)).toBe(
      montarRef(fingerprintDoRefreshToken(REFRESH_TOKEN_A), AGORA_MS),
    );
    expect(refDaCredencial(base)).toMatch(/^[0-9a-f]{16}\.\d+$/);
  });

  it('the same token with a different autorizadoEmMs gives a different ref', () => {
    expect(refDaCredencial({ ...base, autorizadoEmMs: AGORA_MS + 1 })).not.toBe(
      refDaCredencial(base),
    );
  });

  it('the same ms with a different token gives a different ref', () => {
    expect(refDaCredencial({ ...base, refresh_token: REFRESH_TOKEN_B })).not.toBe(
      refDaCredencial(base),
    );
  });

  it('fits the package limit and never contains the token', () => {
    const ref = refDaCredencial(base);
    expect(ref.length).toBeLessThanOrEqual(MAX_REF_CREDENCIAL);
    expect(ref).not.toContain(REFRESH_TOKEN_A);
  });

  it('reads ONLY the grant: any other field (a hand-edited one) cannot move it', () => {
    const comLixo = { ...base, tokenFingerprint: 'ffffffffffffffff', acessoRef: 'x' };
    expect(refDaCredencial(comLixo)).toBe(refDaCredencial(base));
  });
});

describe('the constants', () => {
  it('MAX_REF_CREDENCIAL_AMAZON (schemas) === MAX_REF_CREDENCIAL (package): the cross-check', () => {
    expect(MAX_REF_CREDENCIAL_AMAZON).toBe(MAX_REF_CREDENCIAL);
  });

  it('REF_CONSENTIMENTO can never equal a versioned ref', () => {
    expect(REF_CONSENTIMENTO).toBe('consentimento');
    expect(REF_CONSENTIMENTO).not.toMatch(/^[0-9a-f]{16}\.\d+$/);
  });
});
