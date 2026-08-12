import { describe, expect, it, vi } from 'vitest';
import { AfterSaveBlockedError } from '@delfrance/ui';

import { flushListings } from './flushListings';

describe('flushListings', () => {
  it('runs every listing flush', async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    await flushListings([a, b]);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('still saves the OTHER listings when one is blocked', async () => {
    // Stopping at the first blocker would discard edits to a listing the
    // operator was never even warned about.
    const blocked = vi.fn().mockRejectedValue(new AfterSaveBlockedError('conflito'));
    const other = vi.fn().mockResolvedValue(undefined);
    await expect(flushListings([blocked, other])).rejects.toBeInstanceOf(AfterSaveBlockedError);
    expect(other).toHaveBeenCalledOnce();
  });

  it('reports the FIRST blocker, so the message matches the first problem shown', async () => {
    const first = vi.fn().mockRejectedValue(new AfterSaveBlockedError('primeiro'));
    const second = vi.fn().mockRejectedValue(new AfterSaveBlockedError('segundo'));
    await expect(flushListings([first, second])).rejects.toThrow('primeiro');
  });

  it('lets an unexpected error through immediately', async () => {
    // A listing form narrows the errors it expects; anything escaping to here
    // is a bug and swallowing it would hide it behind a save that looks fine.
    const boom = vi.fn().mockRejectedValue(new TypeError('bug'));
    const after = vi.fn().mockResolvedValue(undefined);
    await expect(flushListings([boom, after])).rejects.toBeInstanceOf(TypeError);
    expect(after).not.toHaveBeenCalled();
  });

  it('resolves for a tab that was never opened', async () => {
    await expect(flushListings([])).resolves.toBeUndefined();
  });
});
