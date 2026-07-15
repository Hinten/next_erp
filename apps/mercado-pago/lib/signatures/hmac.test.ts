import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import { verifyHmac, verifyMpSignature } from './hmac';

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

/* ---------------------------- verifyMpSignature -------------------------- */

const WEBHOOK_SECRET = 'mp-webhook-secret';
const REQUEST_ID = 'req-abc-123';
const TS = '1700000000';
const DATA_ID = 'PAY-987';

/** Compute the manifest HMAC MP expects for a given data.id / request-id / ts. */
function mpManifestHmac(dataId: string, requestId: string, ts: string, secret: string): string {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

function mpRequest(opts: {
  dataId?: string;
  signature?: string | null;
  requestId?: string | null;
  useQueryId?: boolean;
}): Request {
  const key = opts.useQueryId ? 'id' : 'data.id';
  const url = new URL('https://mp.example.com/api/webhooks/mercado-pago');
  if (opts.dataId !== undefined) url.searchParams.set(key, opts.dataId);
  const headers: Record<string, string> = {};
  if (opts.signature !== null && opts.signature !== undefined)
    headers['x-signature'] = opts.signature;
  if (opts.requestId !== null) headers['x-request-id'] = opts.requestId ?? REQUEST_ID;
  return new Request(url.toString(), { method: 'POST', headers });
}

describe('verifyMpSignature', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips validation (returns true) when the webhook secret is unset', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', '');
    // No signature header at all — still accepted because the check is skipped.
    expect(verifyMpSignature(mpRequest({ dataId: DATA_ID, signature: null }))).toBe(true);
  });

  it('accepts a valid x-signature when the secret is set (data.id in query)', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    const v1 = mpManifestHmac(DATA_ID, REQUEST_ID, TS, WEBHOOK_SECRET);
    const req = mpRequest({ dataId: DATA_ID, signature: `ts=${TS},v1=${v1}` });
    expect(verifyMpSignature(req)).toBe(true);
  });

  it('lowercases an alphanumeric data.id before hashing', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    // The header is computed over the lowercased id; the query carries mixed case.
    const v1 = mpManifestHmac('pay-987', REQUEST_ID, TS, WEBHOOK_SECRET);
    const req = mpRequest({ dataId: 'PAY-987', signature: `ts=${TS},v1=${v1}` });
    expect(verifyMpSignature(req)).toBe(true);
  });

  it('rejects an invalid v1 hash when the secret is set', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    const req = mpRequest({ dataId: DATA_ID, signature: `ts=${TS},v1=deadbeefdeadbeef` });
    expect(verifyMpSignature(req)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    const v1 = mpManifestHmac(DATA_ID, REQUEST_ID, TS, 'not-the-secret');
    const req = mpRequest({ dataId: DATA_ID, signature: `ts=${TS},v1=${v1}` });
    expect(verifyMpSignature(req)).toBe(false);
  });

  it('rejects when the x-signature header is absent but a secret is set', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    expect(verifyMpSignature(mpRequest({ dataId: DATA_ID, signature: null }))).toBe(false);
  });

  it('rejects a malformed x-signature header (missing ts or v1)', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    expect(verifyMpSignature(mpRequest({ dataId: DATA_ID, signature: 'v1=abc' }))).toBe(false);
    expect(verifyMpSignature(mpRequest({ dataId: DATA_ID, signature: `ts=${TS}` }))).toBe(false);
    expect(verifyMpSignature(mpRequest({ dataId: DATA_ID, signature: 'garbage' }))).toBe(false);
  });

  it('tolerates spaces and reordered parts in the header', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    const v1 = mpManifestHmac(DATA_ID, REQUEST_ID, TS, WEBHOOK_SECRET);
    const req = mpRequest({ dataId: DATA_ID, signature: `v1=${v1}, ts=${TS}` });
    expect(verifyMpSignature(req)).toBe(true);
  });

  it('falls back to the ?id= query param when data.id is absent', () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    const v1 = mpManifestHmac(DATA_ID, REQUEST_ID, TS, WEBHOOK_SECRET);
    const req = mpRequest({ dataId: DATA_ID, signature: `ts=${TS},v1=${v1}`, useQueryId: true });
    expect(verifyMpSignature(req)).toBe(true);
  });
});
