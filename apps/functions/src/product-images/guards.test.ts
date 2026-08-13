import { describe, expect, it } from 'vitest';
import {
  ownedDerivativePath,
  productDerivativePath,
  productOriginalPath,
  tabMediOriginalPath,
} from '@delfrance/schemas';
import { shouldResize } from './guards';

const HASH = 'a'.repeat(16);
const original = productOriginalPath('p1', HASH, 'png');
const tabMediOriginal = tabMediOriginalPath('tm1', HASH, 'jpg');

describe('shouldResize', () => {
  it('returns true for a fresh product-image original', () => {
    expect(shouldResize({ name: original, contentType: 'image/png' })).toBe(true);
  });

  it('returns true for a fresh tabela-de-medidas original', () => {
    // The gate that brings size-chart photos into the resize pipeline at all.
    // False here means the AI agent never gets a `jpeg` variant to read
    // measurements from, and the gallery keeps loading full originals.
    expect(shouldResize({ name: tabMediOriginal, contentType: 'image/jpeg' })).toBe(true);
  });

  it('still refuses a tabMedi DERIVATIVE — the loop guard covers both owners', () => {
    expect(
      shouldResize({
        name: ownedDerivativePath('tabMedi', 'tm1', HASH, '200'),
        contentType: 'image/jpeg',
        metadata: { resized: 'true' },
      }),
    ).toBe(false);
    // …and with the marker absent, on the name alone (defense in depth).
    expect(
      shouldResize({
        name: ownedDerivativePath('tabMedi', 'tm1', HASH, '200'),
        contentType: 'image/jpeg',
      }),
    ).toBe(false);
  });

  it('returns false outside <owner>/<id>/originals (derivative, video, media, flat)', () => {
    expect(
      shouldResize({
        name: productDerivativePath('p1', HASH, '200'),
        contentType: 'image/jpeg',
        metadata: { resized: 'true' },
      }),
    ).toBe(false);
    expect(shouldResize({ name: `produtos/p1/videos/${HASH}.mp4`, contentType: 'video/mp4' })).toBe(
      false,
    );
    expect(shouldResize({ name: `media/${HASH}.png`, contentType: 'image/png' })).toBe(false);
    expect(shouldResize({ name: `produtos/${HASH}`, contentType: 'image/png' })).toBe(false);
  });

  it('returns false for a non-image content type', () => {
    expect(shouldResize({ name: original, contentType: 'application/pdf' })).toBe(false);
    expect(shouldResize({ name: original, contentType: null })).toBe(false);
  });

  it('returns false when the resized marker is present', () => {
    expect(
      shouldResize({ name: original, contentType: 'image/png', metadata: { resized: 'true' } }),
    ).toBe(false);
  });

  it('returns false for an empty name', () => {
    expect(shouldResize({ name: '', contentType: 'image/png' })).toBe(false);
  });
});
