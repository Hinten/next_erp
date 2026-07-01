import { describe, it, expect } from 'vitest';
import { POST } from './route';

function post(body: string): Request {
  return new Request('http://localhost/api/webhooks/mercado-livre', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/webhooks/mercado-livre', () => {
  it('accepts a well-formed ML notification (topic + resource) and acks 200', async () => {
    const res = await POST(
      post(JSON.stringify({ _id: 'n-1', topic: 'orders_v2', resource: '/orders/123', user_id: 7 })),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; accepted: boolean; notificationId: string };
    expect(json).toMatchObject({ ok: true, accepted: true, notificationId: 'n-1' });
  });

  it('acks (accepted: false) a body missing topic/resource', async () => {
    const res = await POST(post(JSON.stringify({ hello: 'world' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: false });
  });

  it('acks 200 (accepted: false) on invalid JSON — never 4xx, so ML stops retrying', async () => {
    const res = await POST(post('{not json'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: false });
  });
});
