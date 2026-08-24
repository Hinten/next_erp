/**
 * Decoding `integracao.cor` for display.
 *
 * The field is `z.number().int().nullable()` (`packages/schemas/src/integracao.ts`)
 * and the corpus carries TWO encodings for it, because two apps have written it:
 *
 *  - **Legacy Flutter** stored a raw `Color.value` — a 32-bit **ARGB** integer
 *    (`0xAARRGGBB`) straight off the Material picker, so alpha is always `0xFF`
 *    and the number exceeds `0xFFFFFF` (`.old/lib/global/formFields.dart`).
 *  - **This app** stores a 24-bit **RGB** integer (`0xRRGGBB`), what its
 *    `ColorInput` round-trips through `#rrggbb`.
 *
 * Both arrive here: the migration carries the legacy values over verbatim
 * (root `CLAUDE.md` rule 8 — read-tolerance for legacy shapes is mandatory),
 * and anything re-saved through the channel forms comes back 24-bit. So a
 * reader must accept either, which is exactly what {@link corToRgb} does.
 *
 * ⚠️ Do NOT decode `cor` with `argbToRgba` / `etiquetaTint` from
 * `lib/chat/etiquetaCores`. Those read the alpha channel, which is `0` on a
 * 24-bit value — a badge painted with them is fully transparent. The luminance
 * helpers in that module are alpha-blind and ARE reused below.
 */

import { contrastingTextColor } from '@/lib/chat/etiquetaCores';

/**
 * Normalize a stored `cor` to a plain 24-bit RGB integer, or `null` when there
 * is no colour to show.
 *
 * `>>> 0` first: a Dart `Color.value` fits in a SIGNED int on the wire, so a
 * value with alpha `0xFF` can arrive negative. Anything still above `0xFFFFFF`
 * after that carries an alpha byte, which is masked off — the legacy picker
 * only ever wrote fully-opaque colours, so there is no transparency to lose.
 *
 * ⚠️ `0` is BLACK here, not "unset" — unlike `conversa.cor_etiqueta`, where
 * `hasEtiqueta` reads it as no-label. The legacy picker could not produce it
 * (alpha is always `0xFF`, so its black is `0xFF000000`), which leaves this
 * app's own `ColorInput` as the only writer of a bare `0` — and there it means
 * the operator deliberately picked `#000000`. `null` is the unset value.
 */
export function corToRgb(cor: number | null | undefined): number | null {
  if (typeof cor !== 'number' || !Number.isFinite(cor)) return null;
  const v = Math.trunc(cor) >>> 0;
  return v > 0xffffff ? v & 0xffffff : v;
}

/** Stored `cor` → `#rrggbb`, or `null` when unset. */
export function corToHex(cor: number | null | undefined): string | null {
  const rgb = corToRgb(cor);
  return rgb === null ? null : `#${rgb.toString(16).padStart(6, '0')}`;
}

/**
 * `#rrggbb` (or the `#rgb` shorthand) → the 24-bit RGB int this app stores.
 * Anything else → `null`. The write half of {@link corToHex}.
 */
export function hexToCor(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return null;
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return Number.parseInt(full, 16);
}

/**
 * Inline styles for a badge painted in an integração's registered colour, or
 * `null` when it has none (the caller falls back to a neutral badge).
 *
 * The foreground is the WCAG-luminance choice `contrastingTextColor` makes for
 * chat etiquetas — the same rule the legacy app used — so a pale channel colour
 * gets black text instead of unreadable white.
 */
export function integracaoBadgeStyle(
  cor: number | null | undefined,
): { backgroundColor: string; color: string } | null {
  const rgb = corToRgb(cor);
  if (rgb === null) return null;
  return {
    backgroundColor: `#${rgb.toString(16).padStart(6, '0')}`,
    color: contrastingTextColor(rgb),
  };
}
