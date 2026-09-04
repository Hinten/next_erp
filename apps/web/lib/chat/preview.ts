/**
 * Last-message preview text for a conversa tile — a faithful port of the
 * `Text.rich` builder in the legacy Flutter tile
 * (`.old/lib/chat/menu_lateral.dart:671-754`, `_ConversaWidgetState.build`).
 *
 * Pure + synchronous so it can be unit-tested exhaustively and rendered without
 * a per-tile listener (the tile feeds it the one message it fetched via
 * `useLastMensagem`). The media-kind strings use accented Portuguese
 * ("áudio"/"vídeo"/"figurinha") — the modern copy for the legacy
 * "audio"/"video"/"sticker" placeholders.
 */
import type { Mensagem, OrigemConversa } from '@delfrance/schemas';
import { TIPO_MENSAGEM } from '@delfrance/schemas';
import { mensagemEhNossa } from './direcao';

/**
 * The subset of a `Mensagem` this preview reads. Accepts a full `Mensagem`
 * (structural) or any partial with these fields, so tests can pass minimal
 * fixtures.
 */
export type PreviewMensagem = { estadoEnvio?: Mensagem['estadoEnvio'] } & Pick<
  Mensagem,
  | 'tipo'
  | 'conteudo'
  | 'transcription'
  | 'user_id'
  | 'audio'
  | 'image'
  | 'video'
  | 'sticker'
  | 'genericDocument'
  | 'reaction'
>;

export interface PreviewOptions {
  /** The current operator's uid — a message from them is prefixed "(Eu) ". */
  meuUid?: string | null;
  /**
   * Display name of the message author when it is neither the operator nor a
   * system event — prefixed as "(nome) ". Legacy resolved this lazily from the
   * `usuarios` doc; the tile may pass it when known, else omit it.
   */
  autorNome?: string | null;
  /** The conversa's origem — decides direction for an authorless message. */
  origem?: OrigemConversa | null;
}

/** Collapse newlines/tabs to single spaces and trim (legacy `conteudoNoBreaks`). */
function noBreaks(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function nonEmpty(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.trim() !== '';
}

/**
 * Body of the preview (without the author/event affixes). Mirrors the legacy
 * priority chain: text → transcription → audio → document → image → video →
 * sticker → reaction → generic fallback.
 */
function previewBody(m: PreviewMensagem): string {
  if (nonEmpty(m.conteudo)) return noBreaks(m.conteudo);
  if (nonEmpty(m.transcription)) return noBreaks(m.transcription);
  // Media: detect via the typed sub-objects first (what the pipeline writes),
  // then fall back to the single-char `tipo` (a=áudio, v=vídeo, f=arquivo).
  if (m.audio || m.tipo === TIPO_MENSAGEM.audio) return 'Enviou um áudio';
  if (m.genericDocument) return 'Enviou um documento';
  if (m.image) return 'Enviou uma imagem';
  if (m.video || m.tipo === TIPO_MENSAGEM.video) return 'Enviou um vídeo';
  if (m.sticker) return 'Enviou uma figurinha';
  if (m.reaction) return `Reagiu com ${m.reaction.emoji}`;
  if (m.tipo === TIPO_MENSAGEM.arquivo) return 'Enviou um arquivo';
  // A message with no readable content (e.g. an unmapped interactive payload).
  return 'Nova mensagem';
}

/**
 * Render the preview line for a conversa's most-recent message. Returns
 * "Sem mensagens" when there is none (`m == null`).
 *
 *  - event (`tipo: 'e'`)  → wrapped in `[ … ]` (no author prefix);
 *  - error (`tipo: '!'`)  → prefixed "(!) ";
 *  - otherwise, when the message carries a `user_id`, prefixed "(Eu) " for the
 *    operator or "(nome) " for a known author.
 */
export function lastMensagemPreview(
  m: PreviewMensagem | null | undefined,
  { meuUid, autorNome, origem }: PreviewOptions = {},
): string {
  if (!m) return 'Sem mensagens';

  const body = previewBody(m);

  if (m.tipo === TIPO_MENSAGEM.evento) return `[${body}]`;
  if (m.tipo === TIPO_MENSAGEM.erro) return `(!) ${body}`;

  if (nonEmpty(m.user_id)) {
    if (meuUid != null && m.user_id === meuUid) return `(Eu) ${body}`;
    if (nonEmpty(autorNome)) return `(${autorNome}) ${body}`;
  }
  // ⚠️ Same rule the thread uses (`mensagemEhNossa`): every marketplace reply is
  // AUTHORLESS, so keying on `user_id` alone dropped the prefix on exactly the
  // messages we did send.
  //
  // ⚠️ Gated on `meuUid` like the arm above, deliberately. `MensagemQuote` calls
  // this with no options at all, and it already prints the author on its own line
  // — so without the gate a quoted ML reply gained an `(Eu)` that a quoted
  // colleague's message never gets, and the two prefixes disagreed about when
  // they apply.
  if (meuUid != null && !nonEmpty(m.user_id) && mensagemEhNossa(m, { myUid: meuUid, origem })) {
    return `(Eu) ${body}`;
  }
  return body;
}
