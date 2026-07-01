import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyHmac } from './hmac';

// The HMAC helper is the verification path for channels that sign their webhooks
// (e.g. Shopee's `authorization` header). ML itself does not sign — see the
// mercado-livre webhook route — but this stays as shared per-channel infra.
describe('verifyHmac', () => {
  const secret = 'partner-key';
  const payload = '{"code":3,"shop_id":42}';

  it('accepts a matching hex signature', () => {
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyHmac({ payload, signature: sig, secret })).toBe(true);
  });

  it('accepts a matching base64 signature', () => {
    const sig = createHmac('sha256', secret).update(payload).digest('base64');
    expect(verifyHmac({ payload, signature: sig, secret, encoding: 'base64' })).toBe(true);
  });

  it('rejects a wrong signature and a wrong secret', () => {
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyHmac({ payload, signature: 'deadbeef', secret })).toBe(false);
    expect(verifyHmac({ payload, signature: sig, secret: 'wrong' })).toBe(false);
  });
});
