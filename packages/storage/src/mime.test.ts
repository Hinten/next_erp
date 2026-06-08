import { describe, expect, it } from 'vitest';
import { extensionForContentType } from './mime';

describe('extensionForContentType', () => {
  it('maps known content types to an extension', () => {
    expect(extensionForContentType('image/png')).toBe('png');
    expect(extensionForContentType('image/jpeg')).toBe('jpeg');
    expect(extensionForContentType('application/pdf')).toBe('pdf');
    expect(extensionForContentType('video/mp4')).toBe('mp4');
  });

  it('returns null for unknown content types', () => {
    expect(extensionForContentType('font/woff2')).toBeNull();
  });
});
