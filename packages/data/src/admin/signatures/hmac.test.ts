import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { type HmacVerifyInput, verifyHmac } from './index';

const SECRET = '\x0b'.repeat(20);
const PAYLOAD = 'Hi There';
const SHA256_HEX = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';

// Fixed HMAC vectors from RFC 2202 (SHA-1) and RFC 4231 (SHA-256/SHA-512).
const VECTORS: { algorithm: NonNullable<HmacVerifyInput['algorithm']>; hex: string }[] = [
  { algorithm: 'sha1', hex: 'b617318655057264e28bc0b6fb378c8ef146be00' },
  { algorithm: 'sha256', hex: SHA256_HEX },
  {
    algorithm: 'sha512',
    hex: '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854',
  },
];

describe('verifyHmac', () => {
  it('defaults to SHA-256 and hex', () => {
    expect(verifyHmac({ payload: PAYLOAD, signature: SHA256_HEX, secret: SECRET })).toBe(true);
  });

  describe.each(VECTORS)('$algorithm', ({ algorithm, hex }) => {
    it.each(['hex', 'base64'] as const)('accepts the matching %s digest', (encoding) => {
      const signature = encoding === 'hex' ? hex : Buffer.from(hex, 'hex').toString('base64');
      expect(verifyHmac({ payload: PAYLOAD, signature, secret: SECRET, algorithm, encoding })).toBe(
        true,
      );
    });
  });

  it('rejects a changed payload, a wrong secret and a different digest of the same length', () => {
    expect(verifyHmac({ payload: PAYLOAD + '!', signature: SHA256_HEX, secret: SECRET })).toBe(
      false,
    );
    expect(verifyHmac({ payload: PAYLOAD, signature: SHA256_HEX, secret: 'wrong' })).toBe(false);
    expect(verifyHmac({ payload: PAYLOAD, signature: '00'.repeat(32), secret: SECRET })).toBe(
      false,
    );
  });

  it.each(['', 'gg', SHA256_HEX.slice(0, -2), SHA256_HEX + '00'])(
    'rejects a digest with a different decoded length without throwing: %s',
    (signature) => {
      const verify = () => verifyHmac({ payload: PAYLOAD, signature, secret: SECRET });
      expect(verify).not.toThrow();
      expect(verify()).toBe(false);
    },
  );

  it('hashes the raw UTF-8 body without normalizing whitespace', () => {
    const payload = '{ "message": "ação" }\n';
    const signature = createHmac('sha256', SECRET)
      .update(Buffer.from(payload, 'utf8'))
      .digest('hex');

    expect(verifyHmac({ payload, signature, secret: SECRET })).toBe(true);
    expect(verifyHmac({ payload: payload.trim(), signature, secret: SECRET })).toBe(false);
    expect(verifyHmac({ payload: '{"message":"ação"}', signature, secret: SECRET })).toBe(false);
    expect(verifyHmac({ payload: '{ "message": "acao" }\n', signature, secret: SECRET })).toBe(
      false,
    );
  });

  it('preserves the existing Node decoder behavior for hex signatures', () => {
    for (const signature of [SHA256_HEX.toUpperCase(), SHA256_HEX + 'zz', SHA256_HEX + '0']) {
      expect(verifyHmac({ payload: PAYLOAD, signature, secret: SECRET })).toBe(true);
    }
  });

  it('preserves the existing Node decoder behavior for base64 signatures', () => {
    const signature = Buffer.from(SHA256_HEX, 'hex').toString('base64') + '!!';
    expect(verifyHmac({ payload: PAYLOAD, signature, secret: SECRET, encoding: 'base64' })).toBe(
      true,
    );
  });
});
