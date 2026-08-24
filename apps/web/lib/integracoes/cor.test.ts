import { describe, expect, it } from 'vitest';
import { integracaoBadgeStyle } from './cor';

// The codec itself (corToRgb / corToHex / hexToCor / corToEtiquetaArgb) is
// covered in `packages/core/src/cor/cor.test.ts`, where it lives. These cover
// only the web-side presentation built on top of it.
const AZUL_RGB = 0x2196f3; // this app's colour input
const AZUL_ARGB = 0xff2196f3; // legacy Flutter `Colors.blue.value`

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

  it('agrees across the two stored encodings', () => {
    expect(integracaoBadgeStyle(AZUL_RGB)).toEqual(integracaoBadgeStyle(AZUL_ARGB));
  });

  it('returns null when no colour is registered, so the caller can fall back', () => {
    expect(integracaoBadgeStyle(null)).toBeNull();
    expect(integracaoBadgeStyle(undefined)).toBeNull();
  });
});
