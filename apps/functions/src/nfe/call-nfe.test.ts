import { afterEach, describe, expect, it, vi } from 'vitest';

import { postNfe } from './call-nfe';

/** Minimal fetch `Response` stand-in carrying only what `postNfe` reads. */
function fakeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

interface RecordedCall {
  readonly url: string;
  readonly method?: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

describe('postNfe', () => {
  const original = process.env.NFE_BASE_URL;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.NFE_BASE_URL;
    else process.env.NFE_BASE_URL = original;
  });

  it('throws when NFE_BASE_URL is unset', async () => {
    delete process.env.NFE_BASE_URL;
    await expect(postNfe('/api/nfe/reconciliar', {})).rejects.toThrow(/NFE_BASE_URL/);
  });

  it('mints an OIDC token for the exact target URL, then POSTs the JSON body', async () => {
    process.env.NFE_BASE_URL = 'https://nfe.example.app';
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (
          input: string | URL,
          init?: { method?: string; headers?: Record<string, string>; body?: string },
        ): Promise<Response> => {
          const url = String(input);
          calls.push({ url, method: init?.method, headers: init?.headers ?? {}, body: init?.body });
          if (url.includes('metadata.google.internal')) return fakeResponse(200, 'tok-123');
          return fakeResponse(200, '{"ok":true}');
        },
      ),
    );

    const res = await postNfe('/api/nfe/reconciliar', { kind: 'consulta-lote', nRec: 'R1' });
    expect(res).toEqual({ status: 200, ok: true });

    // The identity token's audience must be the EXACT target URL apps/nfe validates.
    const meta = calls.find((c) => c.url.includes('metadata.google.internal'));
    expect(meta?.url).toContain(
      `audience=${encodeURIComponent('https://nfe.example.app/api/nfe/reconciliar')}`,
    );
    expect(meta?.headers['Metadata-Flavor']).toBe('Google');

    const api = calls.find((c) => c.url === 'https://nfe.example.app/api/nfe/reconciliar');
    expect(api?.method).toBe('POST');
    expect(api?.headers['Authorization']).toBe('Bearer tok-123');
    expect(api?.headers['Content-Type']).toBe('application/json');
    expect(api?.body).toBe(JSON.stringify({ kind: 'consulta-lote', nRec: 'R1' }));
  });

  it('returns ok:false on a non-2xx apps/nfe response (so the caller can retry)', async () => {
    process.env.NFE_BASE_URL = 'https://nfe.example.app';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes('metadata.google.internal')) return fakeResponse(200, 'tok');
        return fakeResponse(503, 'unavailable');
      }),
    );
    const res = await postNfe('/api/nfe/processar-pendentes', {});
    expect(res).toEqual({ status: 503, ok: false });
  });

  it('throws when the metadata token request fails (never reaches apps/nfe)', async () => {
    process.env.NFE_BASE_URL = 'https://nfe.example.app';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => fakeResponse(500, 'boom')),
    );
    await expect(postNfe('/api/nfe/reconciliar', {})).rejects.toThrow(/metadata identity token/);
  });
});
