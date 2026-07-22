import { describe, expect, it, vi } from 'vitest';

import { createMemoryArquivoCache } from './localArquivoCache';
import { downloadArquivo } from './downloadArquivo';

const meta = {
  id: 'arq-1',
  url: 'https://example.test/file.pdf',
  contentType: 'application/pdf',
  fileName: 'manual.pdf',
};

describe('downloadArquivo', () => {
  it('fetches, caches, and saves on a cache miss', async () => {
    const cache = createMemoryArquivoCache();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));
    const save = vi.fn();

    const result = await downloadArquivo(meta, { cache, fetchImpl, save, now: () => 42 });

    expect(result).toEqual({ ok: true, fromCache: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    const cached = await cache.get('arq-1');
    expect(cached?.cachedAt).toBe(42);
    expect(cached?.fileName).toBe('manual.pdf');
  });

  it('uses the cache and skips fetch on a hit', async () => {
    const cache = createMemoryArquivoCache();
    await cache.put('arq-1', {
      contentType: 'application/pdf',
      fileName: 'manual.pdf',
      bytes: new Uint8Array([9]).buffer,
      cachedAt: 1,
    });
    const fetchImpl = vi.fn();
    const save = vi.fn();

    const result = await downloadArquivo(meta, { cache, fetchImpl, save });

    expect(result).toEqual({ ok: true, fromCache: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
  });

  it('returns ok:false on HTTP error without throwing', async () => {
    const cache = createMemoryArquivoCache();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const save = vi.fn();

    const result = await downloadArquivo(meta, { cache, fetchImpl, save });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/404/);
    expect(save).not.toHaveBeenCalled();
  });
});
