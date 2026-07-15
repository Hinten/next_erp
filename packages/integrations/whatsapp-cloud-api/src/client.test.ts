import { describe, expect, it, vi } from 'vitest';
import { WhatsAppClient, WhatsAppHttpError, WhatsAppNetworkError } from './client';

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async (_input: string | URL, _init?: Record<string, unknown>) => {
    const r = responses[i++];
    if (!r) throw new Error('no more fake responses');
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
}

/** Like {@link fakeFetch} but each response can be raw bytes (for downloadMedia). */
function fakeFetchBinary(
  responses: Array<{ status: number; body: Uint8Array; contentType?: string }>,
) {
  let i = 0;
  return vi.fn(async (_input: string | URL, _init?: Record<string, unknown>) => {
    const r = responses[i++];
    if (!r) throw new Error('no more fake responses');
    // Uint8Array → ArrayBuffer slice so Blob owns plain bytes, sidestepping
    // a `BodyInit` type mismatch between @types/node's `Uint8Array` and
    // lib.dom's (same pattern as mercado-livre/src/api.ts uploadPicture).
    const bytes = r.body.buffer.slice(
      r.body.byteOffset,
      r.body.byteOffset + r.body.byteLength,
    ) as ArrayBuffer;
    return new Response(new Blob([bytes]), {
      status: r.status,
      headers: r.contentType ? { 'content-type': r.contentType } : undefined,
    });
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

describe('WhatsAppClient.sendMedia', () => {
  it('POSTs a media message nesting {link, caption} under the type key', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.img' }] } }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const out = await client.sendMedia({
      to: '5511999990000',
      type: 'image',
      link: 'https://cdn.example/wa_media.jpg',
      caption: 'legenda',
    });
    expect(out.messageId).toBe('wamid.img');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v\d+\.\d+\/111\/messages$/);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '5511999990000',
      type: 'image',
      image: { link: 'https://cdn.example/wa_media.jpg', caption: 'legenda' },
    });
  });

  it('omits caption when not provided (e.g. audio)', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.aud' }] } }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await client.sendMedia({ to: '55', type: 'audio', link: 'https://cdn.example/a.ogg' });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.audio).toEqual({ link: 'https://cdn.example/a.ogg' });
    expect(body.audio.caption).toBeUndefined();
  });

  it('attaches context when replyTo is set', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.doc' }] } }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await client.sendMedia({
      to: '55',
      type: 'document',
      link: 'https://cdn.example/d.pdf',
      replyTo: 'wamid.original',
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.context).toEqual({ message_id: 'wamid.original' });
  });

  it('throws on non-2xx response with body content', async () => {
    const fetcher = fakeFetch([{ status: 400, body: { error: 'bad media' } }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(
      client.sendMedia({ to: '55', type: 'image', link: 'https://x/y.jpg' }),
    ).rejects.toThrow(/400/);
  });

  it('throws when response is missing messages[0].id', async () => {
    const fetcher = fakeFetch([{ status: 200, body: {} }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(
      client.sendMedia({ to: '55', type: 'video', link: 'https://x/y.mp4' }),
    ).rejects.toThrow(/messages\[0\]\.id/);
  });
});

describe('WhatsAppClient.getMediaData', () => {
  it('GETs /{mediaId} with the Bearer header and parses the metadata', async () => {
    const fetcher = fakeFetch([
      {
        status: 200,
        body: {
          messaging_product: 'whatsapp',
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc',
          mime_type: 'image/jpeg',
          sha256: 'deadbeef',
          file_size: 12345,
          id: 'media-1',
        },
      },
    ]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const out = await client.getMediaData('media-1');
    expect(out).toMatchObject({
      id: 'media-1',
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc',
      mime_type: 'image/jpeg',
      sha256: 'deadbeef',
      file_size: 12345,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v\d+\.\d+\/media-1$/);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer tk');
  });

  it('tolerates a response missing the optional sha256/file_size fields', async () => {
    const fetcher = fakeFetch([
      {
        status: 200,
        body: {
          url: 'https://lookaside.fbsbx.com/x',
          mime_type: 'audio/ogg',
          id: 'media-2',
        },
      },
    ]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const out = await client.getMediaData('media-2');
    expect(out.sha256).toBeUndefined();
    expect(out.file_size).toBeUndefined();
  });

  it('throws a typed error on a non-2xx response', async () => {
    const fetcher = fakeFetch([{ status: 404, body: { error: 'not found' } }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(client.getMediaData('missing')).rejects.toThrow(/404/);
  });
});

describe('WhatsAppClient.downloadMedia', () => {
  it('GETs the lookaside URL with the Bearer header and returns bytes + content-type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetcher = fakeFetchBinary([{ status: 200, body: bytes, contentType: 'image/jpeg' }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc';
    const out = await client.downloadMedia(mediaUrl);
    expect(new Uint8Array(out.data)).toEqual(bytes);
    expect(out.contentType).toBe('image/jpeg');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(mediaUrl);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer tk');
  });

  it('throws a typed error on a non-2xx response', async () => {
    const fetcher = fakeFetchBinary([{ status: 403, body: new TextEncoder().encode('forbidden') }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(client.downloadMedia('https://lookaside.fbsbx.com/x')).rejects.toThrow(/403/);
  });
});

describe('WhatsAppClient — typed errors', () => {
  it('throws WhatsAppHttpError carrying the status + Graph body snippet on a non-2xx', async () => {
    const fetcher = fakeFetch([{ status: 400, body: { error: { message: 'bad recipient' } } }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const err = await client.sendText({ to: '55', text: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppHttpError);
    expect(err.status).toBe(400);
    expect(err.body).toContain('bad recipient');
  });

  it('throws WhatsAppHttpError (not WhatsAppNetworkError) when a 2xx body lacks the id', async () => {
    const fetcher = fakeFetch([{ status: 200, body: {} }]);
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const err = await client
      .sendMedia({ to: '55', type: 'image', link: 'https://x/y.jpg' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppHttpError);
  });

  it('wraps a transport-level rejection as WhatsAppNetworkError with the cause', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const err = await client.sendText({ to: '55', text: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppNetworkError);
    expect(String(err.cause)).toContain('network down');
  });

  it('surfaces markRead / getMediaData / downloadMedia transport failures as WhatsAppNetworkError', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('conn reset');
    });
    const client = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(client.markRead('wamid.x')).rejects.toBeInstanceOf(WhatsAppNetworkError);
    await expect(client.getMediaData('m')).rejects.toBeInstanceOf(WhatsAppNetworkError);
    await expect(client.downloadMedia('https://x')).rejects.toBeInstanceOf(WhatsAppNetworkError);
  });
});
