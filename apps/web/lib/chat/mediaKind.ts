import type { Filetype, TipoMensagem } from '@delfrance/schemas';
import { FILETYPE } from '@delfrance/schemas';
import { TIPO_MENSAGEM } from '@delfrance/schemas';

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
    case FILETYPE.audio:
      return TIPO_MENSAGEM.audio;
    case FILETYPE.video:
      return TIPO_MENSAGEM.video;
    case FILETYPE.application:
    case FILETYPE.document:
      return TIPO_MENSAGEM.arquivo;
    case FILETYPE.system:
      return TIPO_MENSAGEM.evento;
    case FILETYPE.error:
      return TIPO_MENSAGEM.erro;
    case FILETYPE.html:
    case FILETYPE.image:
    case FILETYPE.txt:
    case FILETYPE.fallback:
    case FILETYPE.file:
    case FILETYPE.interactive:
    case FILETYPE.button:
    case FILETYPE.order:
    case FILETYPE.sticker:
    case FILETYPE.unknown:
    case FILETYPE.unsupported:
    case FILETYPE.reaction:
      return TIPO_MENSAGEM.comum;
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
    case FILETYPE.image:
    case FILETYPE.sticker:
      // Stickers are rare from the operator side; render them via the image slot.
      return { image: { image: arquivoRef, caption } };
    case FILETYPE.video:
      return { video: { video: arquivoRef, caption } };
    case FILETYPE.audio:
      return { audio: { audio: arquivoRef } };
    case FILETYPE.html:
    case FILETYPE.txt:
    case FILETYPE.error:
    case FILETYPE.unknown:
    case FILETYPE.file:
    case FILETYPE.document:
    case FILETYPE.application:
    case FILETYPE.reaction:
    case FILETYPE.fallback:
    case FILETYPE.interactive:
    case FILETYPE.button:
    case FILETYPE.order:
    case FILETYPE.system:
    case FILETYPE.unsupported:
      return { genericDocument: { genericDocument: arquivoRef, caption } };
  }
}
