import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_REF_CREDENCIAL } from '@delfrance/integrations-loja-integrada';
import { credenciaisLojaIntegradaSchema } from '@delfrance/schemas';

import { fingerprintDoToken, refDaCredencial, tokenCabeNaRef } from './credencial';
import { versaoDaRef } from './refCredencial';

const TOKEN = 'token-de-teste-nao-real';
const ATUALIZADO_MS = 1_790_000_000_000;

describe('fingerprintDoToken', () => {
  it('pins the test vector — the domain prefix is load-bearing', () => {
    expect(fingerprintDoToken(TOKEN)).toBe('356650d83857e2ca');
  });

  it('is 16 lowercase hex characters, stable for the same token', () => {
    expect(fingerprintDoToken(TOKEN)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintDoToken(TOKEN)).toBe(fingerprintDoToken(`${TOKEN}`));
  });

  it('near-miss: one character different is a different fingerprint', () => {
    expect(fingerprintDoToken('token-de-teste-nao-reaL')).toBe('86a84c76fac10cec');
    expect(fingerprintDoToken('token-de-teste-nao-reaL')).not.toBe(fingerprintDoToken(TOKEN));
  });

  it('near-miss: never the plain sha256 prefix of the same token (uncorrelatable)', () => {
    const plano = createHash('sha256').update(TOKEN, 'utf8').digest('hex').slice(0, 16);
    expect(plano).toBe('a75c757614170030');
    expect(fingerprintDoToken(TOKEN)).not.toBe(plano);
  });
});

describe('refDaCredencial', () => {
  const credencial = { personalToken: TOKEN, tokenAtualizadoEmMs: ATUALIZADO_MS };

  it('is <fingerprint>.<tokenAtualizadoEmMs>', () => {
    expect(refDaCredencial(credencial)).toBe(`356650d83857e2ca.${String(ATUALIZADO_MS)}`);
  });

  it('round trip: the logger reads back exactly the stamp — one format, one owner', () => {
    expect(versaoDaRef(refDaCredencial(credencial))).toBe(String(credencial.tokenAtualizadoEmMs));
  });

  it('same token and same tokenAtualizadoEmMs → the same ref', () => {
    expect(refDaCredencial({ ...credencial })).toBe(refDaCredencial(credencial));
  });

  it('near-miss: same token, different tokenAtualizadoEmMs → a different ref (a re-save)', () => {
    expect(refDaCredencial({ ...credencial, tokenAtualizadoEmMs: ATUALIZADO_MS + 1 })).not.toBe(
      refDaCredencial(credencial),
    );
  });

  it('is derived from personalToken, never from a stored tokenFingerprint field', () => {
    const comCampoMentiroso = { ...credencial, tokenFingerprint: '0000000000000000' };
    expect(refDaCredencial(comCampoMentiroso)).toBe(refDaCredencial(credencial));
  });

  it('fits the package limit, never contains the token, never equals the validator label', () => {
    const ref = refDaCredencial({ personalToken: TOKEN, tokenAtualizadoEmMs: 9_999_999_999_999 });
    expect(ref.length).toBeLessThanOrEqual(MAX_REF_CREDENCIAL);
    expect(ref).not.toContain(TOKEN);
    expect(ref).not.toBe('candidato');
  });

  it('the stored refCredencial limit equals the package MAX_REF_CREDENCIAL (the copy is checked here)', () => {
    const base = {
      personalToken: TOKEN,
      tokenFingerprint: '356650d83857e2ca',
      tokenExpiraEmMs: 1_800_000_000_000,
      tokenAtualizadoEmMs: ATUALIZADO_MS,
    };
    const comRef = (n: number) => ({
      ...base,
      reconexaoPendente: { desdeMs: 1, status: 401, refCredencial: 'r'.repeat(n) },
    });
    expect(credenciaisLojaIntegradaSchema.safeParse(comRef(MAX_REF_CREDENCIAL)).success).toBe(true);
    expect(credenciaisLojaIntegradaSchema.safeParse(comRef(MAX_REF_CREDENCIAL + 1)).success).toBe(
      false,
    );
  });
});

describe('tokenCabeNaRef', () => {
  it('a real-length token never fits inside its own ref', () => {
    expect(tokenCabeNaRef(TOKEN, ATUALIZADO_MS)).toBe(false);
  });

  it('a token short enough to be a substring of the ref is caught', () => {
    // Any digit run of the stamp is a substring of the ref.
    expect(tokenCabeNaRef('179', ATUALIZADO_MS)).toBe(true);
    expect(tokenCabeNaRef('.', ATUALIZADO_MS)).toBe(true);
  });
});
