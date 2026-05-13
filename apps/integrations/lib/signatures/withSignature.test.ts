import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withSignature } from './withSignature';

const SECRET = 'test-secret-do-not-use';

function sign(payload: string, secret = SECRET) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function buildReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

describe('withSignature', () => {
  it('returns 500 when secret is undefined', async () => {
    const handler = withSignature(
      { secret: undefined, getSignature: () => 'whatever' },
      async () => Response.json({ ok: true }),
    );
    const res = await handler(buildReq(''));
    expect(res.status).toBe(500);
  });

  it('returns 401 when signature header is missing', async () => {
    const handler = withSignature(
      { secret: SECRET, getSignature: () => null },
      async () => Response.json({ ok: true }),
    );
    const res = await handler(buildReq(''));
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature does not match payload', async () => {
    const handler = withSignature(
      { secret: SECRET, getSignature: (r) => r.headers.get('x-signature') },
      async () => Response.json({ ok: true }),
    );
    const body = '{"event":"x"}';
    const res = await handler(
      buildReq(body, { 'x-signature': sign(body, 'wrong-secret') }),
    );
    expect(res.status).toBe(401);
  });

  it('forwards parsed JSON to the inner handler on valid signature', async () => {
    const body = '{"event":"order.created","id":"abc"}';
    const handler = withSignature<{ event: string; id: string }>(
      { secret: SECRET, getSignature: (r) => r.headers.get('x-signature') },
      async ({ json }) => Response.json({ got: json }),
    );
    const res = await handler(buildReq(body, { 'x-signature': sign(body) }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { got: { event: string; id: string } };
    expect(data.got).toEqual({ event: 'order.created', id: 'abc' });
  });

  it('passes raw payload string when body is not JSON', async () => {
    const body = 'plain=text&v=1'; // form-encoded, not JSON
    const handler = withSignature(
      { secret: SECRET, getSignature: (r) => r.headers.get('x-signature') },
      async ({ payload, json }) =>
        Response.json({ payload, json: json ?? null }),
    );
    const res = await handler(buildReq(body, { 'x-signature': sign(body) }));
    const data = (await res.json()) as { payload: string; json: unknown };
    expect(data.payload).toBe(body);
    expect(data.json).toBeNull();
  });
});
