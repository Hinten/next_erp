import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// The receiver enqueues via the task scheduler and (only on enqueue failure)
// persists via notificacao. Mock those two seams + admin; the signature check
// (real HMAC) and the envelope parse run real.
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown) => {}),
  persist: vi.fn(async () => {}),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/whatsapp/waTasks', () => ({
  createWhatsappTaskScheduler: () => ({ enqueue: h.enqueue }),
}));

vi.mock('@/lib/whatsapp/notificacao', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/whatsapp/notificacao')>();
  return { ...actual, persistNotificationFailure: h.persist };
});

const { GET, POST } = await import('./route');

const APP_SECRET = 'whatsapp-app-secret';
const VERIFY_TOKEN = 'verify-token-123';

function metaSig(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5511000000000', phone_number_id: 'PNID1' },
              messages: [
                {
                  from: '5511999999999',
                  id: 'wamid.A',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'oi' },
                },
              ],
            },
          },
        ],
      },
    ],
    ...over,
  };
}

function postReq(rawBody: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3008/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

function getReq(params: Record<string, string>): Request {
  const url = new URL('http://localhost:3008/api/webhooks/whatsapp');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* --------------------------------- GET ----------------------------------- */

describe('GET /api/webhooks/whatsapp (verify handshake)', () => {
  it('echoes hub.challenge as text/plain when mode + verify_token match', async () => {
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', VERIFY_TOKEN);
    const res = GET(
      getReq({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'CHAL42',
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('CHAL42');
  });

  it('403 on a wrong verify_token', async () => {
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', VERIFY_TOKEN);
    const res = GET(
      getReq({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'CHAL42' }),
    );
    expect(res.status).toBe(403);
  });

  it('400 when mode is not subscribe, 400 when challenge is missing', async () => {
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', VERIFY_TOKEN);
    expect(GET(getReq({ 'hub.mode': 'x', 'hub.verify_token': VERIFY_TOKEN })).status).toBe(400);
    expect(GET(getReq({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN })).status).toBe(
      400,
    );
  });
});

/* --------------------------------- POST ---------------------------------- */

describe('POST /api/webhooks/whatsapp (signature + enqueue)', () => {
  it('enqueues a signed, well-formed envelope and acks 200 without a Firestore write', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    const raw = JSON.stringify(envelope());
    const res = await POST(postReq(raw, { 'x-hub-signature-256': metaSig(raw, APP_SECRET) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(h.enqueue).toHaveBeenCalledOnce();
    expect(h.enqueue.mock.calls[0]![0]).toMatchObject({
      field: 'messages',
      phoneNumberId: 'PNID1',
      messageId: 'wamid.A',
    });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('503 when the app secret is unset (mandatory policy — never skips)', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', '');
    const raw = JSON.stringify(envelope());
    const res = await POST(postReq(raw, { 'x-hub-signature-256': metaSig(raw, APP_SECRET) }));
    expect(res.status).toBe(503);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('401 on an invalid signature; 401 when the header is absent', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    const raw = JSON.stringify(envelope());
    expect((await POST(postReq(raw, { 'x-hub-signature-256': 'sha256=deadbeef' }))).status).toBe(
      401,
    );
    expect((await POST(postReq(raw))).status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('is byte-exact: a signature over a re-spaced body is rejected (HMAC on the raw string)', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    const raw = JSON.stringify(envelope());
    // Sign the canonical `raw`, but SEND a body with an extra trailing byte. If
    // the route re-serialized before hashing they might collide; verifying the
    // exact received bytes must fail.
    const res = await POST(postReq(`${raw} `, { 'x-hub-signature-256': metaSig(raw, APP_SECRET) }));
    expect(res.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('acks 200 without enqueuing on a non-envelope body and on bad JSON', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    const notEnvelope = JSON.stringify({ hello: 'world' });
    const r1 = await POST(
      postReq(notEnvelope, { 'x-hub-signature-256': metaSig(notEnvelope, APP_SECRET) }),
    );
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ received: true });

    const bad = '{not json';
    const r2 = await POST(postReq(bad, { 'x-hub-signature-256': metaSig(bad, APP_SECRET) }));
    expect(r2.status).toBe(200);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues one payload per change (envelope with two changes)', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    const two = envelope({
      entry: [
        {
          id: 'WABA1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '5511000000000', phone_number_id: 'PNID1' },
                messages: [
                  {
                    from: '5511999999999',
                    id: 'wamid.A',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'a' },
                  },
                ],
              },
            },
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '5511000000000', phone_number_id: 'PNID2' },
                statuses: [
                  {
                    id: 'wamid.OUT',
                    recipient_id: '5511999999999',
                    status: 'delivered',
                    timestamp: '1700000100',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const raw = JSON.stringify(two);
    const res = await POST(postReq(raw, { 'x-hub-signature-256': metaSig(raw, APP_SECRET) }));
    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
  });

  it('falls back to persisting the change when the enqueue fails, still acks 200', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    h.enqueue.mockRejectedValueOnce(new Error('cloudtasks.enqueue denied'));
    const raw = JSON.stringify(envelope());
    const res = await POST(postReq(raw, { 'x-hub-signature-256': metaSig(raw, APP_SECRET) }));
    expect(res.status).toBe(200);
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it('propagates a 5xx only when BOTH the enqueue and a TRANSIENT persist fallback fail', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    h.enqueue.mockRejectedValueOnce(new Error('enqueue down'));
    h.persist.mockRejectedValueOnce(new Error('firestore down'));
    const raw = JSON.stringify(envelope());
    await expect(
      POST(postReq(raw, { 'x-hub-signature-256': metaSig(raw, APP_SECRET) })),
    ).rejects.toThrow('firestore down');
  });
});
