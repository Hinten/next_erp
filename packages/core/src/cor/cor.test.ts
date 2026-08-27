import { describe, expect, it } from 'vitest';
import { corToEtiquetaArgb, corToHex, corToRgb, hexToCor } from './index';

/**
 * The two encodings the corpus carries for `integracao.cor` — see the module
 * docblock. Most cases below pin that BOTH decode identically, which is the
 * whole reason this codec exists.
 */
const AZUL_RGB = 0x2196f3; // this app's colour input
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

describe('hexToCor', () => {
  it('parses the full and shorthand hex forms', () => {
    expect(hexToCor('#2196f3')).toBe(0x2196f3);
    expect(hexToCor('2196F3')).toBe(0x2196f3);
    expect(hexToCor('#0af')).toBe(0x00aaff);
  });

  it('returns null for anything that is not a hex colour', () => {
    expect(hexToCor('')).toBeNull();
    expect(hexToCor('rgb(1,2,3)')).toBeNull();
    expect(hexToCor('#12345')).toBeNull();
  });
});

describe('corToHex ⇄ hexToCor round trip (the channel-form editor)', () => {
  it('round-trips a colour the editor wrote', () => {
    expect(hexToCor(corToHex(AZUL_RGB) as string)).toBe(AZUL_RGB);
  });

  it('REGRESSION: opening a legacy-coloured conta does not turn it white', () => {
    // The per-app copies this codec replaces CLAMPED to 0xffffff instead of
    // masking the alpha byte, so a legacy ARGB value (always > 0xFFFFFF)
    // displayed as `#ffffff` — and saving the form then wrote white over the
    // real colour.
    const shown = corToHex(AZUL_ARGB) as string;
    expect(shown).not.toBe('#ffffff');
    expect(hexToCor(shown)).toBe(AZUL_RGB);
  });
});

describe('corToEtiquetaArgb', () => {
  // The seven pickable etiqueta colours (apps/web lib/chat/etiquetaCores.ts) are
  // Flutter `Color.value` ARGB ints, and the chat filter matches them with an
  // exact `==`. A conta colour must land in THAT domain or it is unselectable.
  const VERMELHO_ETIQUETA = 0xfff44336;

  it('lifts a 24-bit conta colour into the etiqueta ARGB domain', () => {
    expect(corToEtiquetaArgb(0xf44336)).toBe(VERMELHO_ETIQUETA);
  });

  it('produces a value that EQUALS the palette constant (what the filter needs)', () => {
    // The bug this prevents: a raw copy stores 0xf44336, and
    // `where('cor_etiqueta','==',0xfff44336)` then matches nothing, forever.
    expect(corToEtiquetaArgb(0xf44336)).toBe(VERMELHO_ETIQUETA);
    expect(0xf44336).not.toBe(VERMELHO_ETIQUETA);
  });

  it('returns an UNSIGNED int — `|` alone would make it negative', () => {
    const argb = corToEtiquetaArgb(AZUL_RGB) as number;
    expect(argb).toBeGreaterThan(0);
    expect(argb).toBe(4280391411);
  });

  it('is idempotent on a value that is already ARGB', () => {
    expect(corToEtiquetaArgb(AZUL_ARGB)).toBe(corToEtiquetaArgb(AZUL_RGB));
  });

  it('lifts black to opaque black, not to zero ("no etiqueta")', () => {
    expect(corToEtiquetaArgb(0)).toBe(0xff000000);
  });

  it('returns null when the conta has no colour', () => {
    expect(corToEtiquetaArgb(null)).toBeNull();
    expect(corToEtiquetaArgb(undefined)).toBeNull();
  });
});
