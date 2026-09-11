import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBlob } from './saveBlob';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('saveBlob', () => {
  it('downloads the supplied blob and filename, then removes the anchor and releases the URL', () => {
    const blob = new Blob(['report']);
    const createObjectURL = vi.fn().mockReturnValue('blob:report');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let anchor: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      anchor = this;
      expect(this.isConnected).toBe(true);
      expect(this.href).toBe('blob:report');
      expect(this.download).toBe('checkouts.csv');
    });
    saveBlob(blob, 'checkouts.csv');
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor?.isConnected).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:report');
  });

  it('cleans up and propagates a failed download', () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:report', revokeObjectURL });
    const failure = new TypeError('download failed');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw failure;
    });
    expect(() => saveBlob(new Blob(['report']), 'report.csv')).toThrow(failure);
    expect(document.querySelector('a[download="report.csv"]')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
  });
});
