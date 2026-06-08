import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderAllVariants, renderVariant } from './variants';

async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 12, g: 34, b: 56 },
    },
  })
    .png()
    .toBuffer();
}

describe('renderVariant', () => {
  let big: Buffer;
  beforeAll(async () => {
    big = await makeImage(800, 600);
  });

  it('downscales to the target width and encodes JPEG', async () => {
    const out = await renderVariant(big, { key: '200', width: 200 });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(200);
  });

  it('keeps full size when width is null', async () => {
    const out = await renderVariant(big, { key: 'jpeg', width: null });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(800);
  });

  it('never upscales a smaller-than-target source', async () => {
    const small = await makeImage(100, 80);
    const out = await renderVariant(small, { key: '200', width: 200 });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
  });
});

describe('renderAllVariants', () => {
  it('renders the 200 / 400 / full-jpeg set', async () => {
    const big = await makeImage(1000, 1000);
    const rendered = await renderAllVariants(big);
    expect(rendered.map((r) => r.spec.key)).toEqual(['200', '400', 'jpeg']);
    const widths = await Promise.all(
      rendered.map(async (r) => (await sharp(r.buffer).metadata()).width),
    );
    expect(widths).toEqual([200, 400, 1000]);
    expect(rendered.every((r) => r.contentType === 'image/jpeg')).toBe(true);
  });
});
