import { TIPO_MENSAGEM, ESTADO_ENVIO, type Filetype, type Mensagem } from '@delfrance/schemas';
import { mediaSubObject, tipoForFiletype } from './mediaKind';

/**
 * Outbound `mensagem` write builders for the chat composer. These produce the
 * EXACT document shape the #529 `sendOutbound` trigger keys on:
 *
 *     { estadoEnvio: salva (1), tipo not in {'e','!'}, mid: null }  on a
 *     `whatsapp`-origem conversa → the trigger sends it.
 *
 * ── PRESERVE the text shape byte-for-byte ──────────────────────────────────────
 * {@link buildTextMensagem} returns the identical 16-field object the original
 * `MensagemThread.handleSend` wrote (`mid:null, conteudo, tipo:'c', canal:0,
 * estadoEnvio:salva, user_id, timestamp, resposta:null, usarioMensagemOuterRef:
 * null, urlAvatar:null, midGroup:null, error:null, visualizado:null,
 * transcription:null, anexo:null, anexo_url:null`). Do not reorder/rename keys —
 * `MensagemThread.test.tsx` asserts on this write shape.
 *
 * ── resolveSendSpec dual-write (media) ─────────────────────────────────────────
 * The #529 sender's `resolveSendSpec` (apps/whatsapp/lib/whatsapp/outbound.ts)
 * reads ONLY `anexoStorage` (+ `conteudo`/`anexoDescription` for the caption) to
 * decide a media send — it never inspects the typed `image`/`video`/`audio`/
 * `genericDocument` sub-objects. So {@link buildMediaMensagem} DUAL-WRITES:
 *   - `anexoStorage` (the `Arquivo` outer-ref) so the trigger transmits the file;
 *   - the typed media sub-object so this app's thread renders it (parity with
 *     inbound media, which is written the same way).
 * `conteudo` carries the caption (what `resolveSendSpec` sends), and the
 * sub-object caption mirrors it for rendering. Keep both in sync.
 */

/** The client-only marker fields on an optimistic (not-yet-server) entry. */
export interface OptimisticMensagem extends Mensagem {
  _optimistic: true;
  /**
   * The Firestore doc id pre-minted for this send. The write lands under this
   * exact id, so the optimistic entry and its eventual server snapshot share one
   * identity and reconcile by doc id. `mid` stays `null` (the #529 contract).
   */
  _docId: string;
}

/** Build the exact text-mensagem write (salva / tipo 'c' / mid null). */
export function buildTextMensagem(input: {
  text: string;
  uid: string | null;
  now: number;
}): Mensagem {
  return {
    mid: null,
    conteudo: input.text,
    tipo: TIPO_MENSAGEM.comum,
    canal: 0,
    estadoEnvio: ESTADO_ENVIO.salva,
    user_id: input.uid,
    timestamp: input.now,
    resposta: null,
    usarioMensagemOuterRef: null,
    urlAvatar: null,
    midGroup: null,
    error: null,
    visualizado: null,
    transcription: null,
    anexo: null,
    anexo_url: null,
  };
}

/**
 * Build a media-mensagem write: the base outbound shape + the `anexoStorage`
 * dual-write (for the #529 sender) + the typed media sub-object (for rendering).
 * `caption` becomes both `conteudo` (what the sender transmits as the caption)
 * and the sub-object caption. `arquivoRef` is the `Arquivo` outer-ref string
 * (`documents/arquivos/<id>`); the sender's `resolveSendSpec` derefs it by id.
 */
export function buildMediaMensagem(input: {
  arquivoRef: string;
  filetype: Filetype;
  caption: string | null;
  uid: string | null;
  now: number;
  /** The companion text message's doc id, when a caption+media were split. */
  midGroup?: string | null;
}): Mensagem {
  const caption = input.caption && input.caption.trim() !== '' ? input.caption : null;
  return {
    mid: null,
    conteudo: caption,
    tipo: tipoForFiletype(input.filetype),
    canal: 0,
    estadoEnvio: ESTADO_ENVIO.salva,
    user_id: input.uid,
    timestamp: input.now,
    resposta: null,
    usarioMensagemOuterRef: null,
    urlAvatar: null,
    midGroup: input.midGroup ?? null,
    error: null,
    visualizado: null,
    transcription: null,
    anexo: null,
    anexo_url: null,
    // Dual-write #1: the trigger's resolveSendSpec sends the file via this ref.
    anexoStorage: input.arquivoRef,
    anexoDescription: caption,
    // Dual-write #2: the typed sub-object the thread renders from.
    ...mediaSubObject(input.filetype, input.arquivoRef, caption),
  };
}

/**
 * Wrap a freshly-built write into an OPTIMISTIC entry for immediate render.
 * `estadoEnvio` is shown as `enviando` (the write itself is `salva`) so the
 * bubble shows an in-flight tick until the server snapshot reconciles it.
 */
export function makeOptimistic(docId: string, write: Mensagem): OptimisticMensagem {
  return {
    ...write,
    estadoEnvio: ESTADO_ENVIO.enviando,
    _optimistic: true,
    _docId: docId,
  };
}
