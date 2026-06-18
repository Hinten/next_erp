import { describe, expect, it, vi } from 'vitest';

vi.mock('./call-nfe', () => ({ postNfe: vi.fn() }));

import { postNfe } from './call-nfe';
import { handleSweep } from './sweep';

describe('handleSweep', () => {
  it('calls the backstop sweep endpoint and resolves on a 2xx response', async () => {
    vi.mocked(postNfe).mockResolvedValue({ status: 200, ok: true });
    await expect(handleSweep()).resolves.toBeUndefined();
    expect(postNfe).toHaveBeenCalledWith('/api/nfe/processar-pendentes', {});
  });

  it('throws on a non-2xx response', async () => {
    vi.mocked(postNfe).mockResolvedValue({ status: 502, ok: false });
    await expect(handleSweep()).rejects.toThrow(/HTTP 502/);
  });
});
