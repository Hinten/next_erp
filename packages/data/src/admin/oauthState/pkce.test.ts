import { afterEach, describe, expect, it, vi } from 'vitest';

import { codeChallengeS256, createCodeVerifier, pkceEnabledFor } from './pkce';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createCodeVerifier', () => {
  it('fits RFC 7636 §4.1 — 43..128 chars from the unreserved set', () => {
    const v = createCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it('never repeats', () => {
    // A verifier reused across attempts would let a captured code from one
    // attempt be redeemed against another.
    const seen = new Set(Array.from({ length: 50 }, () => createCodeVerifier()));
    expect(seen.size).toBe(50);
  });
});

describe('codeChallengeS256', () => {
  it('matches the RFC 7636 Appendix B golden vector', () => {
    // Pinned against the spec rather than our own implementation: if the digest
    // or the encoding ever drifts, the provider rejects the exchange with
    // `invalid_grant` at the very end of the consent flow, where it is hardest
    // to diagnose.
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('emits base64url — never padded or +/ base64', () => {
    for (let i = 0; i < 20; i++) {
      expect(codeChallengeS256(createCodeVerifier())).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    }
  });
});

describe('pkceEnabledFor', () => {
  it('is OFF unless the flag is exactly "1"', () => {
    // ⚠️ Fail-closed: PKCE must not switch on by accident, because a provider
    // rejects the parameters unless the registered application has PKCE enabled
    // too — and the flag has to be flipped WITH that dashboard toggle.
    for (const raw of ['', '0', 'true', 'TRUE', 'yes', 'on', ' 1']) {
      vi.stubEnv('SOME_CHANNEL_PKCE_ENABLED', raw);
      expect(pkceEnabledFor('SOME_CHANNEL_PKCE_ENABLED')).toBe(false);
    }
  });

  it('is ON for "1"', () => {
    vi.stubEnv('SOME_CHANNEL_PKCE_ENABLED', '1');
    expect(pkceEnabledFor('SOME_CHANNEL_PKCE_ENABLED')).toBe(true);
  });

  it('reads the NAMED variable, so channels do not share a flag', () => {
    // Each provider toggles PKCE per registered application, so one channel
    // being on must never imply another is.
    vi.stubEnv('CHANNEL_A_PKCE_ENABLED', '1');
    vi.stubEnv('CHANNEL_B_PKCE_ENABLED', '');
    expect(pkceEnabledFor('CHANNEL_A_PKCE_ENABLED')).toBe(true);
    expect(pkceEnabledFor('CHANNEL_B_PKCE_ENABLED')).toBe(false);
  });
});
