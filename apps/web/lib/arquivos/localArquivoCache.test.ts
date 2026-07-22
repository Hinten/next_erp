import { describe, expect, it } from 'vitest';

import {
  createMemoryArquivoCache,
  MAX_CACHE_ENTRIES,
  type CachedArquivo,
} from './localArquivoCache';

function entry(n: number, cachedAt: number): CachedArquivo {
  return {
    contentType: 'application/pdf',
    fileName: `f${n}.pdf`,
    bytes: new Uint8Array([n]).buffer,
    cachedAt,
  };
}

describe('createMemoryArquivoCache', () => {
  it('round-trips get/put', async () => {
    const cache = createMemoryArquivoCache();
    await cache.put('a1', entry(1, 100));
    const got = await cache.get('a1');
    expect(got?.fileName).toBe('f1.pdf');
    expect(new Uint8Array(got!.bytes)[0]).toBe(1);
  });

  it('returns null for a miss', async () => {
    const cache = createMemoryArquivoCache();
    expect(await cache.get('missing')).toBeNull();
  });

  it('prunes oldest entries when over MAX_CACHE_ENTRIES', async () => {
    const cache = createMemoryArquivoCache();
    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
      await cache.put(`id-${i}`, entry(i, i));
    }
    expect(cache.map.size).toBe(MAX_CACHE_ENTRIES);
    // Oldest five (cachedAt 0..4) should be gone.
    expect(await cache.get('id-0')).toBeNull();
    expect(await cache.get('id-4')).toBeNull();
    expect(await cache.get(`id-${MAX_CACHE_ENTRIES + 4}`)).not.toBeNull();
  });
});
