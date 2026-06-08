import { describe, expect, it, vi } from 'vitest';
import { WhatsAppClient } from './client';

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async (_input: string | URL, _init?: Record<string, unknown>) => {
    const r = responses[i++];
    if (!r) throw new Error('no more fake responses');
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
}

describe('WhatsAppClient.sendText', () => {
  it('POSTs to the messages endpoint and returns the message id', async () => {
    const fetcher = fakeFetch([
      {
        status: 200,
        body: { messages: [{ id: 'wamid.123' }] },
      },
    ]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const out = await client.sendText({ to: '5511999990000', text: 'Olá!' });
    expect(out.messageId).toBe('wamid.123');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v\d+\.\d+\/111\/messages$/);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '5511999990000',
      type: 'text',
      text: { body: 'Olá!', preview_url: false },
    });
  });

  it('attaches context when replyTo is set', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.456' }] } }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await client.sendText({
      to: '5511999990000',
      text: 'reply',
      replyTo: 'wamid.original',
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.context).toEqual({ message_id: 'wamid.original' });
  });

  it('throws on non-2xx response with body content', async () => {
    const fetcher = fakeFetch([{ status: 401, body: { error: 'unauthorized' } }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(client.sendText({ to: '55', text: 'x' })).rejects.toThrow(/401/);
  });

  it('throws when response is missing messages[0].id', async () => {
    const fetcher = fakeFetch([{ status: 200, body: {} }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(client.sendText({ to: '55', text: 'x' })).rejects.toThrow(/messages\[0\]\.id/);
  });
});
