import sharp from 'sharp';
import { PRODUCT_IMAGE_VARIANTS, type VariantSpec } from '@delfrance/schemas';

export { PRODUCT_IMAGE_VARIANTS };

export interface RenderedVariant {
  spec: VariantSpec;
  buffer: Buffer;
  contentType: 'image/jpeg';
}

/**
 * Render one product-image variant: downscale to `spec.width` (or keep full
 * size when `width` is null) and JPEG-encode. `withoutEnlargement` guarantees
 * a smaller-than-target source is never upscaled. EXIF orientation is baked in
 * via `.rotate()`.
 */
export async function renderVariant(input: Buffer, spec: VariantSpec): Promise<Buffer> {
  let pipeline = sharp(input).rotate();
  if (spec.width !== null) {
    pipeline = pipeline.resize({ width: spec.width, withoutEnlargement: true });
  }
  return pipeline.jpeg({ quality: 82 }).toBuffer();
}

/** Render every {@link PRODUCT_IMAGE_VARIANTS} entry for the input image. */
export async function renderAllVariants(input: Buffer): Promise<RenderedVariant[]> {
  const out: RenderedVariant[] = [];
  for (const spec of PRODUCT_IMAGE_VARIANTS) {
    out.push({
      spec,
      buffer: await renderVariant(input, spec),
      contentType: 'image/jpeg',
    });
  }
  return out;
}
