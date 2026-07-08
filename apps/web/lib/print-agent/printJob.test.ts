import { describe, expect, it, vi } from 'vitest';
import { printJob, type PrintAgentRequest } from './printJob';

const blobOf = (text: string): Blob => new Blob([text], { type: 'application/pdf' });
const opts = { fileName: 'danfe.pdf', contentType: 'application/pdf', tamanho: 'a4' } as const;

const bodyOf = (init: RequestInit): PrintAgentRequest =>
  JSON.parse(init.body as string) as PrintAgentRequest;

// Impls declare (url, init) so `.mock.calls[0]` types as [string, RequestInit].
const respond =
  (status: number) =>
  (_url: string, _init: RequestInit): Promise<Response> =>
    Promise.resolve(new Response(null, { status }));
const reject =
  (err: unknown) =>
  (_url: string, _init: RequestInit): Promise<Response> =>
    Promise.reject(err);

describe('printJob', () => {
  it('POSTs the exact agent contract and returns "printed" on 200', async () => {
    const fetchMock = vi.fn(respond(200));
    const saveBlob = vi.fn();
    const result = await printJob(blobOf('hello'), opts, {
      fetch: fetchMock as unknown as typeof fetch,
      saveBlob,
    });
    expect(result).toBe('printed');
    expect(saveBlob).not.toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8888');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain;charset=utf-8' });

    const body = bodyOf(init);
    expect(body.docName).toBe('danfe.pdf');
    expect(body.contentType).toBe('application/pdf');
    expect(body.tamanhoFolhaImpressao).toBe('a4');
    expect(body.jobTime).toBeNull();
    expect(atob(body.docDataBase64)).toBe('hello');
  });

  it('falls back to a browser download when the agent is unreachable (TypeError)', async () => {
    const fetchMock = vi.fn(reject(new TypeError('Failed to fetch')));
    const saveBlob = vi.fn();
    const blob = blobOf('x');
    const result = await printJob(
      blob,
      { ...opts, tamanho: 'etq' },
      { fetch: fetchMock as unknown as typeof fetch, saveBlob },
    );
    expect(result).toBe('downloaded');
    expect(saveBlob).toHaveBeenCalledWith(blob, 'danfe.pdf');
  });

  it('falls back on a non-OK response', async () => {
    const fetchMock = vi.fn(respond(500));
    const saveBlob = vi.fn();
    const result = await printJob(blobOf('x'), opts, {
      fetch: fetchMock as unknown as typeof fetch,
      saveBlob,
    });
    expect(result).toBe('downloaded');
    expect(saveBlob).toHaveBeenCalledOnce();
  });

  it('rethrows an unexpected (non-TypeError) error', async () => {
    const boom = new RangeError('boom');
    const fetchMock = vi.fn(reject(boom));
    await expect(
      printJob(blobOf('x'), opts, {
        fetch: fetchMock as unknown as typeof fetch,
        saveBlob: vi.fn(),
      }),
    ).rejects.toBe(boom);
  });

  it('base64-encodes a large blob without a stack overflow', async () => {
    const big = 'a'.repeat(200_000);
    const fetchMock = vi.fn(respond(200));
    await printJob(blobOf(big), opts, {
      fetch: fetchMock as unknown as typeof fetch,
      saveBlob: vi.fn(),
    });
    expect(atob(bodyOf(fetchMock.mock.calls[0]![1]).docDataBase64)).toBe(big);
  });
});
