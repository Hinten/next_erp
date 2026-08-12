import { describe, expect, it } from 'vitest';
import {
  ETIQUETA_CORES,
  ETIQUETA_TEXT_DARK,
  ETIQUETA_TEXT_LIGHT,
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
  it('uses black text over light tints (yellow) and near-white over dark tints', () => {
    expect(contrastingTextColor(YELLOW)).toBe(ETIQUETA_TEXT_DARK);
    expect(contrastingTextColor(RED)).toBe(ETIQUETA_TEXT_LIGHT);
    expect(contrastingTextColor(DEEP_PURPLE)).toBe(ETIQUETA_TEXT_LIGHT);
  });
});

describe('hasEtiqueta / etiquetaTint', () => {
  it('treats 0 and null/undefined as "no etiqueta"', () => {
    expect(hasEtiqueta(0)).toBe(false);
    expect(hasEtiqueta(null)).toBe(false);
    expect(hasEtiqueta(undefined)).toBe(false);
    expect(etiquetaTint(0)).toBeNull();
    expect(etiquetaTint(null)).toBeNull();
  });

  it('resolves a tint (softened background + contrast text) for a real colour', () => {
    const tint = etiquetaTint(RED);
    expect(tint).not.toBeNull();
    expect(tint!.background).toBe('rgba(244, 67, 54, 0.75)');
    expect(tint!.color).toBe(ETIQUETA_TEXT_LIGHT);
  });
});
