import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GRAPH_API_VERSION,
  WhatsAppClient,
  WhatsAppHttpError,
  WhatsAppNetworkError,
} from './client';

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

describe('WhatsAppClient — Graph API version', () => {
  it('defaults to v23.0', () => {
    expect(DEFAULT_GRAPH_API_VERSION).toBe('v23.0');
  });
});

function client(fetcher: ReturnType<typeof fakeFetch>): WhatsAppClient {
  return new WhatsAppClient({
    phoneNumberId: '111',
    accessToken: 'tk',
    fetch: fetcher as unknown as typeof fetch,
  });
}

describe('WhatsAppClient.requestVerificationCode', () => {
  it('POSTs code_method + language (default pt_BR) to /request_code', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { success: true } }]);
    await client(fetcher).requestVerificationCode({ codeMethod: 'SMS' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://graph.facebook.com/v23.0/111/request_code');
    expect(init?.method).toBe('POST');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer tk');
    expect(JSON.parse(String(init?.body))).toEqual({ code_method: 'SMS', language: 'pt_BR' });
  });

  it('honors an explicit language and VOICE method', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { success: true } }]);
    await client(fetcher).requestVerificationCode({ codeMethod: 'VOICE', language: 'en_US' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      code_method: 'VOICE',
      language: 'en_US',
    });
  });

  it('throws WhatsAppHttpError on a non-2xx', async () => {
    const fetcher = fakeFetch([{ status: 400, body: { error: { message: 'bad number' } } }]);
    await expect(client(fetcher).requestVerificationCode({ codeMethod: 'SMS' })).rejects.toThrow(
      /400/,
    );
  });
});

describe('WhatsAppClient.verifyCode', () => {
  it('POSTs { code } to /verify_code and resolves on success:true', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { success: true } }]);
    await client(fetcher).verifyCode({ code: '123456' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://graph.facebook.com/v23.0/111/verify_code');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ code: '123456' });
  });

  it('throws when a 2xx body lacks success:true', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { success: false } }]);
    const err = await client(fetcher)
      .verifyCode({ code: '000000' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppHttpError);
  });

  it('throws WhatsAppHttpError on a non-2xx', async () => {
    const fetcher = fakeFetch([{ status: 400, body: { error: { message: 'wrong code' } } }]);
    await expect(client(fetcher).verifyCode({ code: '999999' })).rejects.toThrow(/400/);
  });
});

describe('WhatsAppClient.register', () => {
  it('POSTs { messaging_product, pin } to /register and resolves on success:true', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { success: true } }]);
    await client(fetcher).register({ pin: '246810' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://graph.facebook.com/v23.0/111/register');
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: 'whatsapp',
      pin: '246810',
    });
  });

  it('throws when a 2xx body lacks success:true', async () => {
    const fetcher = fakeFetch([{ status: 200, body: {} }]);
    await expect(client(fetcher).register({ pin: '246810' })).rejects.toBeInstanceOf(
      WhatsAppHttpError,
    );
  });

  it('NEVER leaks the pin in the error message/body when Graph rejects it', async () => {
    // The RESPONSE body is safe to carry; the request (which holds the pin) is
    // not. Assert the pin appears in neither the thrown message nor the snippet.
    const fetcher = fakeFetch([
      { status: 400, body: { error: { message: 'pin mismatch', code: 133005 } } },
    ]);
    const err = (await client(fetcher)
      .register({ pin: '135790' })
      .catch((e) => e)) as WhatsAppHttpError;
    expect(err).toBeInstanceOf(WhatsAppHttpError);
    expect(err.message).not.toContain('135790');
    expect(err.body).not.toContain('135790');
  });

  it('never leaks the pin on a transport failure (WhatsAppNetworkError)', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('conn reset');
    });
    const c = new WhatsAppClient({
      phoneNumberId: '111',
      accessToken: 'tk',
      fetch: fetcher as unknown as typeof fetch,
    });
    const err = await c.register({ pin: '112233' }).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppNetworkError);
    expect(String(err)).not.toContain('112233');
    expect(String((err as WhatsAppNetworkError).cause)).not.toContain('112233');
  });
});

describe('WhatsAppClient.deregister', () => {
  it('POSTs to /deregister with no body', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { success: true } }]);
    await client(fetcher).deregister();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://graph.facebook.com/v23.0/111/deregister');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('throws WhatsAppHttpError on a non-2xx', async () => {
    const fetcher = fakeFetch([{ status: 500, body: { error: 'boom' } }]);
    await expect(client(fetcher).deregister()).rejects.toThrow(/500/);
  });

  it('throws WhatsAppHttpError on a 2xx body lacking success:true (sibling parity)', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { success: false } }]);
    await expect(client(fetcher).deregister()).rejects.toBeInstanceOf(WhatsAppHttpError);
  });
});

describe('WhatsAppClient.getPhoneNumberStatus', () => {
  it('GETs the phone node with the full field set and parses tolerantly', async () => {
    const fetcher = fakeFetch([
      {
        status: 200,
        body: {
          id: '111',
          status: 'CONNECTED',
          quality_rating: 'GREEN',
          code_verification_status: 'VERIFIED',
          display_phone_number: '+55 11 90000-0000',
          verified_name: 'Loja WA',
          throughput: { level: 'STANDARD' },
        },
      },
    ]);
    const out = await client(fetcher).getPhoneNumberStatus();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://graph.facebook.com/v23.0/111?fields=status,quality_rating,code_verification_status,display_phone_number,verified_name,throughput',
    );
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer tk');
    expect(out).toMatchObject({
      status: 'CONNECTED',
      quality_rating: 'GREEN',
      code_verification_status: 'VERIFIED',
      throughput: { level: 'STANDARD' },
    });
  });

  it('passes an unknown enum value through as a string and tolerates missing fields', async () => {
    const fetcher = fakeFetch([{ status: 200, body: { status: 'SOME_NEW_STATE' } }]);
    const out = await client(fetcher).getPhoneNumberStatus();
    expect(out.status).toBe('SOME_NEW_STATE');
    expect(out.quality_rating).toBeUndefined();
  });

  it('throws WhatsAppHttpError on a non-2xx', async () => {
    const fetcher = fakeFetch([{ status: 401, body: { error: { code: 190 } } }]);
    await expect(client(fetcher).getPhoneNumberStatus()).rejects.toThrow(/401/);
  });
});

describe('WhatsAppClient.getSubscribedApps', () => {
  it('GETs /{wabaId}/subscribed_apps and returns the data array', async () => {
    const fetcher = fakeFetch([
      {
        status: 200,
        body: { data: [{ whatsapp_business_api_data: { name: 'Meu ERP', id: 'app-1' } }] },
      },
    ]);
    const out = await client(fetcher).getSubscribedApps('WABA-999');
    const [url] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://graph.facebook.com/v23.0/WABA-999/subscribed_apps');
    expect(out).toHaveLength(1);
    expect(out[0]?.whatsapp_business_api_data?.name).toBe('Meu ERP');
  });

  it('degrades a missing data array to []', async () => {
    const fetcher = fakeFetch([{ status: 200, body: {} }]);
    expect(await client(fetcher).getSubscribedApps('WABA-1')).toEqual([]);
  });

  it('throws WhatsAppHttpError on a non-2xx', async () => {
    const fetcher = fakeFetch([{ status: 403, body: { error: 'forbidden' } }]);
    await expect(client(fetcher).getSubscribedApps('WABA-1')).rejects.toThrow(/403/);
  });
});
