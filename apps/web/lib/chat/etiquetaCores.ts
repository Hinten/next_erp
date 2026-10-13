/**
 * Conversa etiqueta (label) colours — a faithful port of the legacy Flutter
 * `_coresEtiqueta` palette (`.old/lib/chat/menu_lateral.dart:179-187`) and the
 * foreground selected for the contrast of the rendered background.
 *
 * The wire value is a Flutter `Color.value` — a 32-bit **ARGB** integer stored
 * on `conversa.cor_etiqueta` (`z.number().int().nullable()`). `0`/`null` mean
 * "no etiqueta" (no tint). The seven pickable colours below are the exact
 * Material constants the legacy picker offered.
 */

import { hexToCor } from '@delfrance/core';

/** The seven pickable etiqueta colours, as Flutter `Color.value` ARGB ints. */
export const ETIQUETA_CORES = [
  0xfff44336, // red      (Colors.red)
  0xffff9800, // orange   (Colors.orange)
  0xffffeb3b, // yellow   (Colors.yellow)
  0xff4caf50, // green    (Colors.green)
  0xff2196f3, // blue     (Colors.blue)
  0xff673ab7, // deepPurple (Colors.deepPurple)
  0xff9c27b0, // purple   (Colors.purple)
] as const;

export type EtiquetaCor = (typeof ETIQUETA_CORES)[number];

/** Decoded ARGB channels (each 0-255). */
export interface Argb {
  a: number;
  r: number;
  g: number;
  b: number;
}

/** Split a 32-bit ARGB int into its four 0-255 channels. */
export function argbChannels(argb: number): Argb {
  // `>>> 0` normalizes negative ints (a Dart `Color.value` fits in a signed
  // int on the wire) back into the unsigned 32-bit space before masking.
  const v = argb >>> 0;
  return {
    a: (v >>> 24) & 0xff,
    r: (v >>> 16) & 0xff,
    g: (v >>> 8) & 0xff,
    b: v & 0xff,
  };
}

/** CSS `rgba(...)` string for a Flutter ARGB int (alpha as a 0-1 fraction). */
export function argbToRgba(argb: number): string {
  const { a, r, g, b } = argbChannels(argb);
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** sRGB → linear component, per WCAG / Flutter `_linearizeColorComponent`. */
function linearize(component: number): number {
  const c = component / 0xff;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance (0 = black, 1 = white) — a port of Flutter's
 * `Color.computeLuminance()`, which ignores alpha. Drives the contrast check
 * below for opaque integration badges and composited chat labels.
 */
export function relativeLuminance(argb: number): number {
  const { r, g, b } = argbChannels(argb);
  return channelsLuminance({ r, g, b });
}

function channelsLuminance({ r, g, b }: Pick<Argb, 'r' | 'g' | 'b'>): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** White and black maximise contrast, including the middle-luminance boundary. */
export const ETIQUETA_TEXT_LIGHT = '#ffffff';
/** Black text for light tints (Material `Colors.black`). */
export const ETIQUETA_TEXT_DARK = '#000000';

/**
 * Choose the more readable of black/white against the rendered colour. An
 * opaque badge omits the surface; a translucent tile supplies its underlay.
 */
export function contrastingTextColor(
  argb: number,
  surface?: { color: string; opacity: number },
): string {
  const foreground = argbChannels(argb);
  let luminance = channelsLuminance(foreground);
  if (surface) {
    const rgb = hexToCor(surface.color);
    if (rgb === null) throw new TypeError('A label surface must be a hexadecimal theme colour.');
    const underlay = argbChannels(rgb);
    const { opacity } = surface;
    luminance = channelsLuminance({
      r: foreground.r * opacity + underlay.r * (1 - opacity),
      g: foreground.g * opacity + underlay.g * (1 - opacity),
      b: foreground.b * opacity + underlay.b * (1 - opacity),
    });
  }
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? ETIQUETA_TEXT_DARK : ETIQUETA_TEXT_LIGHT;
}

/** `true` when `cor_etiqueta` is a real tint (present, non-zero). */
export function hasEtiqueta(cor: number | null | undefined): cor is number {
  return typeof cor === 'number' && cor !== 0;
}

/**
 * Alpha the tile background is drawn at — legacy tinted the whole row with the
 * solid colour at `withOpacity(0.75)` in its resting state
 * (`_ConversaWidgetState.build`), so the port keeps the row visibly coloured
 * rather than a faint wash.
 */
export const ETIQUETA_TILE_ALPHA = 0.75;

/**
 * Resolve a `conversa.cor_etiqueta` to a background/foreground pair, or `null`
 * when there is no etiqueta (`0`/`null`). The background is the tint at
 * {@link ETIQUETA_TILE_ALPHA}. CSS resolves each foreground against the theme's
 * actual list surface without a client-only colour-scheme read during hydration.
 */
export function etiquetaTint(
  cor: number | null | undefined,
  surfaces: { light: string; dark: string },
): { background: string; color: string } | null {
  if (!hasEtiqueta(cor)) return null;
  const { r, g, b } = argbChannels(cor);
  return {
    background: `rgba(${r}, ${g}, ${b}, ${ETIQUETA_TILE_ALPHA})`,
    color: `light-dark(${contrastingTextColor(cor, {
      color: surfaces.light,
      opacity: ETIQUETA_TILE_ALPHA,
    })}, ${contrastingTextColor(cor, {
      color: surfaces.dark,
      opacity: ETIQUETA_TILE_ALPHA,
    })})`,
  };
}
