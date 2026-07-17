/**
 * Conversa etiqueta (label) colours — a faithful port of the legacy Flutter
 * `_coresEtiqueta` palette (`.old/lib/chat/menu_lateral.dart:179-187`) and the
 * contrast-aware text-colour logic (`getContrastingTextColor`, same file
 * lines 576-583).
 *
 * The wire value is a Flutter `Color.value` — a 32-bit **ARGB** integer stored
 * on `conversa.cor_etiqueta` (`z.number().int().nullable()`). `0`/`null` mean
 * "no etiqueta" (no tint). The seven pickable colours below are the exact
 * Material constants the legacy picker offered.
 */

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
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance (0 = black, 1 = white) — a port of Flutter's
 * `Color.computeLuminance()`, which ignores alpha. Drives the contrast check
 * below exactly as the legacy tile did.
 */
export function relativeLuminance(argb: number): number {
  const { r, g, b } = argbChannels(argb);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Near-white text (Material `Colors.grey[100]`) for dark tints. */
export const ETIQUETA_TEXT_LIGHT = '#f5f5f5';
/** Black text for light tints (Material `Colors.black`). */
export const ETIQUETA_TEXT_DARK = '#000000';

/**
 * Contrast-aware foreground colour for text laid over an etiqueta tint — the
 * legacy rule: luminance > 0.5 → black, else near-white. See
 * `getContrastingTextColor` in `menu_lateral.dart`.
 */
export function contrastingTextColor(argb: number): string {
  return relativeLuminance(argb) > 0.5 ? ETIQUETA_TEXT_DARK : ETIQUETA_TEXT_LIGHT;
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
 * {@link ETIQUETA_TILE_ALPHA} (the legacy resting opacity); the contrast
 * decision uses the SOLID colour's luminance, exactly as legacy's
 * `computeLuminance()` did (it ignores alpha).
 */
export function etiquetaTint(
  cor: number | null | undefined,
): { background: string; color: string } | null {
  if (!hasEtiqueta(cor)) return null;
  const { r, g, b } = argbChannels(cor);
  return {
    background: `rgba(${r}, ${g}, ${b}, ${ETIQUETA_TILE_ALPHA})`,
    color: contrastingTextColor(cor),
  };
}
