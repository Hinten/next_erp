import { describe, expect, it } from 'vitest';

import { code128Png } from '../../src/danfe/barcode';
import { CHAVE } from './fixtures';

describe('danfe/barcode code128Png', () => {
  it('renders a non-empty PNG of the chave', async () => {
    const png = await code128Png(CHAVE);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(0);
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A.
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});
