/**
 * Rendering an integração's registered `cor` as a badge.
 *
 * The colour CODEC itself lives in `@delfrance/core` (`./cor`) — it is shared
 * with `apps/mercado-livre` and `apps/whatsapp`, which write the same value
 * into `conversa.cor_etiqueta` and must convert it rather than copy it. Only
 * the presentation half is here, because it depends on the chat module's
 * contrast rule.
 *
 * ⚠️ Do NOT decode `cor` with `argbToRgba` / `etiquetaTint` from
 * `lib/chat/etiquetaCores`. Those read the alpha channel, which is `0` on a
 * 24-bit value — a badge painted with them is fully transparent. The luminance
 * helpers in that module are alpha-blind and ARE reused below.
 */

import { corToRgb } from '@delfrance/core';
import { contrastingTextColor } from '@/lib/chat/etiquetaCores';

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
