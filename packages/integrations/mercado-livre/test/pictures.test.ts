import { describe, expect, it } from 'vitest';

import { highResPictureUrl } from '../src/mapping/pictures';

const CDN = 'https://http2.mlstatic.com';

describe('highResPictureUrl', () => {
  it('rewrites the single-letter size-code suffix to the -F max variant', () => {
    expect(highResPictureUrl({ secure_url: `${CDN}/D_NQ_NP_123-MLA456_112021-O.jpg` })).toBe(
      `${CDN}/D_NQ_NP_123-MLA456_112021-F.jpg`,
    );
    // retina prefix (_2X_) + webp
    expect(highResPictureUrl({ secure_url: `${CDN}/D_NQ_NP_2X_654-MLB789_042024-V.webp` })).toBe(
      `${CDN}/D_NQ_NP_2X_654-MLB789_042024-F.webp`,
    );
  });

  it('leaves an already -F url unchanged', () => {
    const u = `${CDN}/D_NQ_NP_1-MLA2_1-F.jpg`;
    expect(highResPictureUrl({ secure_url: u })).toBe(u);
  });

  it('prefers secure_url over url', () => {
    expect(
      highResPictureUrl({
        url: `http://http2.mlstatic.com/x-O.jpg`,
        secure_url: `${CDN}/y-O.jpg`,
      }),
    ).toBe(`${CDN}/y-F.jpg`);
  });

  it('falls back to url when secure_url is absent', () => {
    expect(highResPictureUrl({ url: `${CDN}/z-C.png` })).toBe(`${CDN}/z-F.png`);
  });

  it('does NOT rewrite a url without a single-letter size-code suffix (id preserved)', () => {
    // no `-<letter>` before the extension
    expect(highResPictureUrl({ secure_url: `${CDN}/foo.jpg` })).toBe(`${CDN}/foo.jpg`);
    // a multi-char tail (e.g. an id) is not a size code → untouched
    expect(highResPictureUrl({ secure_url: `${CDN}/123-MLA456.jpg` })).toBe(
      `${CDN}/123-MLA456.jpg`,
    );
  });

  it('returns null when the picture has no usable url', () => {
    expect(highResPictureUrl({})).toBeNull();
    expect(highResPictureUrl({ secure_url: null, url: null })).toBeNull();
    expect(highResPictureUrl({ secure_url: '' })).toBeNull();
  });
});
