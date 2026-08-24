import { describe, expect, it } from 'vitest';
import { corToHex, corToRgb, integracaoBadgeStyle } from './cor';

/**
 * The two encodings the corpus carries for `integracao.cor` — see the module
 * docblock. Every case below pins that BOTH decode to the same colour, which is
 * the whole reason this module exists.
 */
const AZUL_RGB = 0x2196f3; // this app's ColorInput
const AZUL_ARGB = 0xff2196f3; // legacy Flutter `Colors.blue.value`
// A Dart `Color.value` fits in a SIGNED int on the wire, so the same blue can
// arrive negative (`0xFF2196F3 | 0` in JS).
const AZUL_ARGB_ASSINADO = 0xff2196f3 | 0;

describe('corToRgb', () => {
  it('passes a 24-bit RGB value through', () => {
    expect(corToRgb(AZUL_RGB)).toBe(0x2196f3);
  });

  it('masks the alpha byte off a legacy 32-bit ARGB value', () => {
    expect(corToRgb(AZUL_ARGB)).toBe(0x2196f3);
  });

  it('normalizes a signed legacy value before masking', () => {
    expect(AZUL_ARGB_ASSINADO).toBeLessThan(0);
    expect(corToRgb(AZUL_ARGB_ASSINADO)).toBe(0x2196f3);
  });

  it('decodes legacy black without collapsing it into "unset"', () => {
    // `0xFF000000` is legacy's black. Masking gives 0, which is a real colour
    // here — `null` is the only unset value.
    expect(corToRgb(0xff000000)).toBe(0);
    expect(corToRgb(0)).toBe(0);
  });

  it('returns null for an absent or non-numeric value', () => {
    expect(corToRgb(null)).toBeNull();
    expect(corToRgb(undefined)).toBeNull();
    expect(corToRgb(Number.NaN)).toBeNull();
  });
});

describe('corToHex', () => {
  it('renders both encodings as the same hex', () => {
    expect(corToHex(AZUL_RGB)).toBe('#2196f3');
    expect(corToHex(AZUL_ARGB)).toBe('#2196f3');
    expect(corToHex(AZUL_ARGB_ASSINADO)).toBe('#2196f3');
  });

  it('zero-pads a short value', () => {
    expect(corToHex(0x0000ff)).toBe('#0000ff');
    expect(corToHex(0)).toBe('#000000');
  });

  it('returns null when there is no colour', () => {
    expect(corToHex(null)).toBeNull();
  });
});

describe('integracaoBadgeStyle', () => {
  it('paints the badge and picks a readable foreground for a dark colour', () => {
    // Legacy's rule: luminance > 0.5 → black text, else near-white.
    expect(integracaoBadgeStyle(AZUL_ARGB)).toEqual({
      backgroundColor: '#2196f3',
      color: '#f5f5f5',
    });
  });

  it('picks black text on a pale colour', () => {
    expect(integracaoBadgeStyle(0xffffe0)).toEqual({
      backgroundColor: '#ffffe0',
      color: '#000000',
    });
  });

  it('agrees across the two encodings', () => {
    expect(integracaoBadgeStyle(AZUL_RGB)).toEqual(integracaoBadgeStyle(AZUL_ARGB));
  });

  it('returns null when no colour is registered, so the caller can fall back', () => {
    expect(integracaoBadgeStyle(null)).toBeNull();
    expect(integracaoBadgeStyle(undefined)).toBeNull();
  });
});
