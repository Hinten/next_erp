import { describe, expect, it } from 'vitest';
import {
  ETIQUETA_CORES,
  ETIQUETA_TEXT_DARK,
  ETIQUETA_TEXT_LIGHT,
  ETIQUETA_TILE_ALPHA,
  argbChannels,
  argbToRgba,
  contrastingTextColor,
  etiquetaTint,
  hasEtiqueta,
  relativeLuminance,
} from './etiquetaCores';

const RED = 0xfff44336;
const YELLOW = 0xffffeb3b;
const DEEP_PURPLE = 0xff673ab7;
const SURFACES = { light: '#ffffff', dark: '#242424' };

function luminance(channels: number[]): number {
  return channels
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrastOnSurface(color: number, surface: string, foreground: string): number {
  const underlay = surface
    .slice(1)
    .match(/../g)!
    .map((channel) => Number.parseInt(channel, 16));
  const channels = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
  const composite = channels.map(
    (channel, index) =>
      channel * ETIQUETA_TILE_ALPHA + underlay[index]! * (1 - ETIQUETA_TILE_ALPHA),
  );
  const backgroundLuminance = luminance(composite);
  const foregroundLuminance = foreground === ETIQUETA_TEXT_DARK ? 0 : 1;
  return (
    (Math.max(backgroundLuminance, foregroundLuminance) + 0.05) /
    (Math.min(backgroundLuminance, foregroundLuminance) + 0.05)
  );
}

describe('etiqueta palette', () => {
  it('has the seven legacy colours', () => {
    expect(ETIQUETA_CORES).toHaveLength(7);
    expect(ETIQUETA_CORES[0]).toBe(0xfff44336); // red
    expect(ETIQUETA_CORES[6]).toBe(0xff9c27b0); // purple
  });
});

describe('argbChannels / argbToRgba', () => {
  it('splits ARGB into 0-255 channels', () => {
    expect(argbChannels(RED)).toEqual({ a: 255, r: 244, g: 67, b: 54 });
  });

  it('handles a value that wrapped to negative on the wire', () => {
    // 0xFFF44336 as a signed 32-bit int is negative; `>>> 0` must recover it.
    expect(argbChannels(RED | 0)).toEqual({ a: 255, r: 244, g: 67, b: 54 });
  });

  it('renders an rgba() string with a 0-1 alpha', () => {
    expect(argbToRgba(RED)).toBe('rgba(244, 67, 54, 1.000)');
  });
});

describe('relativeLuminance', () => {
  it('is high for yellow and low for red (port of Flutter computeLuminance)', () => {
    expect(relativeLuminance(YELLOW)).toBeGreaterThan(0.5);
    expect(relativeLuminance(RED)).toBeLessThan(0.5);
  });
});

describe('contrastingTextColor', () => {
  it('selects black on medium/light colours and white on genuinely dark colours', () => {
    expect(contrastingTextColor(YELLOW)).toBe(ETIQUETA_TEXT_DARK);
    expect(contrastingTextColor(RED)).toBe(ETIQUETA_TEXT_DARK);
    expect(contrastingTextColor(DEEP_PURPLE)).toBe(ETIQUETA_TEXT_LIGHT);
  });

  it('distinguishes the middle-luminance boundary instead of preserving unreadable near-white', () => {
    expect(contrastingTextColor(0x757575)).toBe(ETIQUETA_TEXT_LIGHT);
    expect(contrastingTextColor(0x767676)).toBe(ETIQUETA_TEXT_DARK);
  });

  it('accounts for the translucent label underlay', () => {
    expect(contrastingTextColor(RED, { color: SURFACES.light, opacity: ETIQUETA_TILE_ALPHA })).toBe(
      ETIQUETA_TEXT_DARK,
    );
    expect(contrastingTextColor(RED, { color: SURFACES.dark, opacity: ETIQUETA_TILE_ALPHA })).toBe(
      ETIQUETA_TEXT_LIGHT,
    );
  });

  it('rejects an unsupported surface instead of silently choosing an unverified foreground', () => {
    expect(() =>
      contrastingTextColor(RED, { color: 'transparent', opacity: ETIQUETA_TILE_ALPHA }),
    ).toThrow(TypeError);
  });
});

describe('hasEtiqueta / etiquetaTint', () => {
  it('treats 0 and null/undefined as "no etiqueta"', () => {
    expect(hasEtiqueta(0)).toBe(false);
    expect(hasEtiqueta(null)).toBe(false);
    expect(hasEtiqueta(undefined)).toBe(false);
    expect(etiquetaTint(0, SURFACES)).toBeNull();
    expect(etiquetaTint(null, SURFACES)).toBeNull();
  });

  it('resolves a tint (softened background + contrast text) for a real colour', () => {
    const tint = etiquetaTint(RED, SURFACES);
    expect(tint).not.toBeNull();
    expect(tint!.background).toBe('rgba(244, 67, 54, 0.75)');
    expect(tint!.color).toBe('light-dark(#000000, #ffffff)');
  });

  it.each(ETIQUETA_CORES)('keeps the stored palette colour %i readable in both modes', (color) => {
    const tint = etiquetaTint(color, SURFACES)!;
    const foregrounds = tint.color.match(/#[0-9a-f]{6}/g)!;
    expect(contrastOnSurface(color, SURFACES.light, foregrounds[0]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastOnSurface(color, SURFACES.dark, foregrounds[1]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps signed legacy ARGB values equivalent and supports custom theme surfaces', () => {
    expect(etiquetaTint(RED | 0, SURFACES)).toEqual(etiquetaTint(RED, SURFACES));
    expect(etiquetaTint(RED, { light: '#000', dark: '#fff' })!.color).toBe(
      'light-dark(#ffffff, #000000)',
    );
  });
});
