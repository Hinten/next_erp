import type { Filetype, TipoMensagem } from '@delfrance/schemas';

/**
 * Media-kind mapping for an OUTBOUND (composer) attachment — a port of the
 * legacy `TipoMensagem.fromFileType`
 * (`.old/packages/atendimento/lib/src/models.dart:442-463`) plus the media
 * sub-object shape the inbound pipeline writes
 * (`apps/whatsapp/lib/whatsapp/processMessages.ts:513-541`).
 *
 * ── tipo per legacy `fromFileType` ─────────────────────────────────────────────
 *   audio → 'a'; video → 'v'; application → 'f'; document → 'f'; system → 'e';
 *   error → '!'; everything else (image, sticker, txt, html, file, fallback, …)
 *   → 'c' (comum). So an IMAGE attachment is tipo `'c'` — verified against the
 *   legacy switch, matching how legacy sent an image as a comum message + anexo.
 */
export function tipoForFiletype(filetype: Filetype): TipoMensagem {
  switch (filetype) {
    case 'audio':
      return 'a';
    case 'video':
      return 'v';
    case 'application':
    case 'document':
      return 'f';
    case 'system':
      return 'e';
    case 'error':
      return '!';
    default:
      return 'c';
  }
}

/**
 * The typed media sub-object for a mensagem, keyed by the `Arquivo`'s filetype
 * — the SAME shapes the inbound pipeline writes so the thread renders operator
 * attachments identically to inbound media. `audio` carries no caption (its
 * schema sub-object has none; the caption rides on `conteudo`); the rest carry
 * the caption. The `else` (document/application/txt/…) uses `genericDocument`.
 *
 * The returned key is exactly one of `image` / `video` / `audio` /
 * `genericDocument`, each holding the `Arquivo` outer-ref string.
 */
export type MediaSubObject =
  | { image: { image: string; caption: string | null } }
  | { video: { video: string; caption: string | null } }
  | { audio: { audio: string } }
  | { genericDocument: { genericDocument: string; caption: string | null } };

export function mediaSubObject(
  filetype: Filetype,
  arquivoRef: string,
  caption: string | null,
): MediaSubObject {
  switch (filetype) {
    case 'image':
    case 'sticker':
      // Stickers are rare from the operator side; render them via the image slot.
      return { image: { image: arquivoRef, caption } };
    case 'video':
      return { video: { video: arquivoRef, caption } };
    case 'audio':
      return { audio: { audio: arquivoRef } };
    default:
      return { genericDocument: { genericDocument: arquivoRef, caption } };
  }
}
