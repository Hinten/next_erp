import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import { verifyHmac, verifyMetaSignature, WhatsappAppSecretMissingError } from './hmac';

describe('verifyHmac', () => {
  const secret = 'app-secret';
  const payload = '{"object":"whatsapp_business_account"}';

  it('accepts a matching hex signature', () => {
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyHmac({ payload, signature: sig, secret })).toBe(true);
  });

  it('rejects a wrong signature and a wrong secret', () => {
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyHmac({ payload, signature: 'deadbeef', secret })).toBe(false);
    expect(verifyHmac({ payload, signature: sig, secret: 'wrong' })).toBe(false);
  });
});

/* --------------------------- verifyMetaSignature ------------------------- */

const APP_SECRET = 'whatsapp-app-secret';
const RAW = '{"object":"whatsapp_business_account","entry":[{"id":"1"}]}';

function metaSig(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

describe('verifyMetaSignature', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws WhatsappAppSecretMissingError when the app secret is unset (mandatory policy)', () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', '');
    expect(() => verifyMetaSignature(RAW, metaSig(RAW, APP_SECRET))).toThrow(
      WhatsappAppSecretMissingError,
    );
  });

  it('accepts a valid sha256= signature over the raw body', () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    expect(verifyMetaSignature(RAW, metaSig(RAW, APP_SECRET))).toBe(true);
  });

  it('tolerates a bare hex value (no sha256= prefix)', () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    const bare = createHmac('sha256', APP_SECRET).update(RAW).digest('hex');
    expect(verifyMetaSignature(RAW, bare)).toBe(true);
  });

  it('rejects an absent header when the secret is set', () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    expect(verifyMetaSignature(RAW, null)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    expect(verifyMetaSignature(RAW, metaSig(RAW, 'not-the-secret'))).toBe(false);
  });

  it('is byte-exact: a re-serialized body (different spacing) fails the HMAC', () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    // The signature is computed over RAW; verifying a re-serialized copy (Meta
    // signs the exact bytes) must fail — proving the HMAC runs on the raw string.
    const reserialized = JSON.stringify(JSON.parse(RAW)); // no spaces added, but key order-safe
    const spaced = `${reserialized} `; // one trailing byte differs
    expect(verifyMetaSignature(spaced, metaSig(RAW, APP_SECRET))).toBe(false);
  });
});
