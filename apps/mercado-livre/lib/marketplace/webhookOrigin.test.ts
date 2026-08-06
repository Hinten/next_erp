import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAllowedSourceIp,
  isBodyTooLarge,
  isExpectedApplication,
  MAX_WEBHOOK_BODY_BYTES,
} from './webhookOrigin';

/** ML's published sender IPs (see .env.example) — a representative subset. */
const ML_IPS = '54.88.218.97, 18.215.140.160, 35.236.253.169';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3006/api/webhooks/mercado-livre', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('isExpectedApplication', () => {
  beforeEach(() => {
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', '5503910054141466');
  });

  it('accepts our application_id as a number and as a string', () => {
    expect(isExpectedApplication({ application_id: 5503910054141466 })).toBe(true);
    expect(isExpectedApplication({ application_id: '5503910054141466' })).toBe(true);
    // ML pads/trims inconsistently across surfaces
    expect(isExpectedApplication({ application_id: ' 5503910054141466 ' })).toBe(true);
  });

  it('rejects a foreign application_id', () => {
    expect(isExpectedApplication({ application_id: 2069392825111111 })).toBe(false);
    expect(isExpectedApplication({ application_id: '2069392825111111' })).toBe(false);
  });

  it('rejects a payload with no application_id at all (allowlist, not blocklist)', () => {
    expect(isExpectedApplication({ resource: '/orders/1', topic: 'orders_v2' })).toBe(false);
    expect(isExpectedApplication({ application_id: null })).toBe(false);
    expect(isExpectedApplication({ application_id: '' })).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(isExpectedApplication(null)).toBe(false);
    expect(isExpectedApplication('5503910054141466')).toBe(false);
    expect(isExpectedApplication([{ application_id: 5503910054141466 }])).toBe(false);
  });

  it('matches an id above MAX_SAFE_INTEGER, where JSON.parse already rounded the wire value', () => {
    const huge = '12345678901234567890';
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', huge);
    // what `JSON.parse` actually yields for that literal
    const rounded = JSON.parse(`{"application_id":${huge}}`) as { application_id: number };
    expect(String(rounded.application_id)).not.toBe(huge); // precision really is lost
    expect(isExpectedApplication(rounded)).toBe(true);
  });

  it('fails OPEN (with a warning) when MERCADO_LIVRE_CLIENT_ID is unset', () => {
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', '');
    expect(isExpectedApplication({ application_id: 999 })).toBe(true);
    expect(isExpectedApplication({})).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('isAllowedSourceIp', () => {
  it('allows everything when the allow-list is unset (opt-in check)', () => {
    vi.stubEnv('MERCADO_LIVRE_WEBHOOK_ALLOWED_IPS', '');
    expect(isAllowedSourceIp(req({ 'x-forwarded-for': '203.0.113.9' }))).toBe(true);
    expect(isAllowedSourceIp(req())).toBe(true);
  });

  it('accepts a listed IP and rejects an unlisted one', () => {
    vi.stubEnv('MERCADO_LIVRE_WEBHOOK_ALLOWED_IPS', ML_IPS);
    expect(isAllowedSourceIp(req({ 'x-forwarded-for': '54.88.218.97' }))).toBe(true);
    expect(isAllowedSourceIp(req({ 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
  });

  it('reads the second-from-the-right XFF entry — the left-most is caller-supplied', () => {
    vi.stubEnv('MERCADO_LIVRE_WEBHOOK_ALLOWED_IPS', ML_IPS);
    // Google's LB appends: <spoofed>, <real client>, <lb>
    expect(
      isAllowedSourceIp(req({ 'x-forwarded-for': '54.88.218.97, 203.0.113.9, 35.191.0.1' })),
    ).toBe(false);
    expect(
      isAllowedSourceIp(req({ 'x-forwarded-for': '203.0.113.9, 54.88.218.97, 35.191.0.1' })),
    ).toBe(true);
  });

  it('normalizes IPv4-mapped IPv6 and falls back to x-real-ip', () => {
    vi.stubEnv('MERCADO_LIVRE_WEBHOOK_ALLOWED_IPS', ML_IPS);
    expect(isAllowedSourceIp(req({ 'x-forwarded-for': '::ffff:54.88.218.97' }))).toBe(true);
    expect(isAllowedSourceIp(req({ 'x-real-ip': '18.215.140.160' }))).toBe(true);
    expect(isAllowedSourceIp(req({ 'x-real-ip': '203.0.113.9' }))).toBe(false);
  });

  it('rejects when the allow-list is set but no client IP can be determined', () => {
    vi.stubEnv('MERCADO_LIVRE_WEBHOOK_ALLOWED_IPS', ML_IPS);
    expect(isAllowedSourceIp(req())).toBe(false);
  });
});

describe('isBodyTooLarge', () => {
  it('rejects only above the cap, and passes a body with no content-length', () => {
    expect(isBodyTooLarge(req({ 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) }))).toBe(
      true,
    );
    expect(isBodyTooLarge(req({ 'content-length': String(MAX_WEBHOOK_BODY_BYTES) }))).toBe(false);
    expect(isBodyTooLarge(req({ 'content-length': '512' }))).toBe(false);
    expect(isBodyTooLarge(req())).toBe(false);
    expect(isBodyTooLarge(req({ 'content-length': 'not-a-number' }))).toBe(false);
  });
});
