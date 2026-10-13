/**
 * Rendering an integração's registered `cor` as a badge.
 *
 * The colour CODEC itself lives in `@delfrance/core` (`./cor`) — it is shared
 * with `apps/mercado-livre` and `apps/whatsapp`, which write the same value
 * into `conversa.cor_etiqueta` and must convert it rather than copy it. Only
 * the presentation half is here, because it depends on the chat module's
 * contrast rule.
 *
 * An opaque badge must decode `cor` with the shared codec: `argbToRgba` sees
 * zero alpha on a 24-bit value, while `etiquetaTint` applies the chat tile's
 * translucency. Its contrast selector is reused against the opaque RGB here.
 */

import { corToRgb } from '@delfrance/core';
import { contrastingTextColor } from '@/lib/chat/etiquetaCores';

/**
 * Inline styles for a badge painted in an integração's registered colour, or
 * `null` when it has none (the caller falls back to a neutral badge).
 *
 * The foreground uses the same contrast selector as chat etiquetas, with the
 * badge's opaque background rather than the chat tile's translucent one.
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
