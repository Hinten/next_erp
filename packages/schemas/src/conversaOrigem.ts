import type { OrigemConversa } from './conversa';

/**
 * Per-origem UI/composition rules for a conversa's outbound reply — a faithful
 * port of the legacy Flutter `Origem` enum getters
 * (`.old/packages/atendimento/lib/src/models.dart:981-1112`). These drive the
 * chat composer (character limit, whether attachments are allowed, how many,
 * which formats, the per-attachment byte cap, and whether the body is HTML).
 *
 * Most values are copied verbatim from the legacy source with the exact
 * `models.dart` line cited inline. Two legacy getters (`formatoAnexoPermitidos`,
 * `maximoTamanhoAnexoBytes`) `throw UnimplementedError` on their `default`
 * branch (site + comentario): `formatosAnexo` models that gap as `null` (its
 * type is nullable); `maxTamanhoAnexoBytes` — a required `number` — falls back
 * to the 25 MB cap the four implemented channels use.
 *
 * ⚠️ **Three deliberate divergences from the legacy source**, each marked at its
 * line. Parity is not the goal where the legacy was factually wrong about ML's
 * API: `mlped.limiteCaracteres` was 300 (ML says 350, and returns the live value
 * per thread), and `mlclaims` attachments were the post-sale limits (25 MB, plus
 * `txt`) applied to a different endpoint that actually accepts 5 MB and no `txt`.
 * The third addition, `temEnvio`, has no legacy counterpart at all — the legacy
 * chat could reply on every origem it modelled, so it never had to ask.
 */
export interface OrigemRule {
  /** `limite_characteres` (models.dart:1003-1020). */
  limiteCaracteres: number;
  /** `permiteAnexo` (models.dart:1056-1063). */
  permiteAnexo: boolean;
  /** `maximoAnexos` (models.dart:1065-1079); `0` when attachments are disallowed. */
  maximoAnexos: number;
  /**
   * `formatoAnexoPermitidos` (models.dart:1081-1095). `[]` when attachments are
   * disallowed (mlperg); `null` where the legacy getter throws (site,
   * comentario — no format list was ever implemented for them).
   */
  formatosAnexo: readonly string[] | null;
  /**
   * `maximoTamanhoAnexoBytes` (models.dart:1097-1111). `0` when attachments are
   * disallowed (mlperg); `25_000_000` (25 MB) otherwise — the value the four
   * implemented channels share, reused as the fallback where legacy throws.
   */
  maxTamanhoAnexoBytes: number;
  /** `isHtml` (models.dart:1022-1033). */
  isHtml: boolean;
  /**
   * Whether an outbound sender exists for this origem AT ALL — the static half
   * of the #817 composer gate. NOT from the legacy source: the legacy chat had a
   * working reply path for every origem it modelled, so it never needed to ask.
   *
   * `false` means "this channel cannot transmit, full stop". Today only
   * `whatsapp` is `true`; `site`, `facebook` and `comentario` have no sender
   * either, so the composer was silently dropping their replies too — the same
   * bug #817 reports for Mercado Livre, just not the one that was noticed.
   *
   * The dynamic half is per-thread and lives on the conversa
   * (`respostaBloqueada`): a channel can have a sender while a particular thread
   * has gone unanswerable.
   */
  temEnvio: boolean;
}

/** The 25 MB per-attachment cap shared by every attachment-capable origem. */
const CAP_25MB = 25_000_000;

/**
 * Legacy `facebook`/`whatsapp` `formatoAnexoPermitidos` list (models.dart:1089
 * and 1091). NB: `'mmpeg'` is a typo in the legacy source (for `mpeg`) —
 * preserved verbatim for wire/behaviour parity, do NOT "fix" it.
 */
const FORMATS_FB_WA = [
  'jpg',
  'jpeg',
  'png',
  'pdf',
  'txt',
  'aac',
  'mp4',
  'mmpeg',
  'amr',
  'ogg',
  '3gp',
] as const;

/** Legacy `mlped`/`mlclaims` `formatoAnexoPermitidos` list (models.dart:1085 and 1087). */
const FORMATS_ML = ['jpg', 'jpeg', 'png', 'pdf', 'txt'] as const;

/**
 * Claim attachments, per ML's current post-purchase reference — NOT the legacy
 * list. `POST /post-purchase/v1/claims/{id}/attachments` accepts JPG, PNG and
 * PDF only (no `txt`) at **5 MB**, a fifth of the post-sale message cap the
 * legacy source applied to both surfaces.
 */
const FORMATS_ML_CLAIMS = ['jpg', 'jpeg', 'png', 'pdf'] as const;

export const ORIGEM_RULES: Record<OrigemConversa, OrigemRule> = {
  // limite default 1000 (L1018); permiteAnexo default true (L1061); maximoAnexos
  // default 5 (L1076); formatoAnexoPermitidos default → throws (→ null);
  // maximoTamanhoAnexoBytes default → throws (→ 25 MB fallback); isHtml default false (L1031).
  site: {
    limiteCaracteres: 1000,
    permiteAnexo: true,
    maximoAnexos: 5,
    formatosAnexo: null,
    maxTamanhoAnexoBytes: CAP_25MB,
    isHtml: false,
    temEnvio: false, // webchat has no outbound sender in this app
  },
  // limite 2000 (L1006); permiteAnexo true (default); maximoAnexos 1 (L1073);
  // formats L1089; size 25 MB (L1105); isHtml false (default).
  facebook: {
    limiteCaracteres: 2000,
    permiteAnexo: true,
    maximoAnexos: 1,
    formatosAnexo: FORMATS_FB_WA,
    maxTamanhoAnexoBytes: CAP_25MB,
    isHtml: false,
    temEnvio: false, // no Messenger sender ported
  },
  // limite 2000 (L1008); permiteAnexo true (default); maximoAnexos 5 (default);
  // formats default → throws (→ null); size default → throws (→ 25 MB); isHtml false (default).
  comentario: {
    limiteCaracteres: 2000,
    permiteAnexo: true,
    maximoAnexos: 5,
    formatosAnexo: null,
    maxTamanhoAnexoBytes: CAP_25MB,
    isHtml: false,
    temEnvio: false, // no Facebook-comment sender ported
  },
  // limite 2000 (L1010); permiteAnexo true (default); maximoAnexos 1 (L1075);
  // formats L1091; size 25 MB (L1107); isHtml false (default).
  whatsapp: {
    limiteCaracteres: 2000,
    permiteAnexo: true,
    maximoAnexos: 1,
    formatosAnexo: FORMATS_FB_WA,
    maxTamanhoAnexoBytes: CAP_25MB,
    isHtml: false,
    // The only channel that can actually transmit today: `sendOutbound`
    // (apps/whatsapp/functions) picks up the mensagem doc and sends it.
    temEnvio: true,
  },
  // limite 2000 (L1012); permiteAnexo FALSE (L1059) → maximoAnexos 0 (L1066),
  // formats [] (L1082), size 0 (L1098); isHtml true (L1026).
  mlperg: {
    // 2000 matches ML today: `POST /answers` caps an answer at 2000 characters.
    limiteCaracteres: 2000,
    permiteAnexo: false,
    maximoAnexos: 0,
    formatosAnexo: [],
    maxTamanhoAnexoBytes: 0,
    isHtml: true,
    // #533 — the ML chat responder route transmits this origem.
    temEnvio: true,
  },
  // permiteAnexo true (default); maximoAnexos 1 (L1069); formats L1085;
  // size 25 MB (L1101); isHtml true (L1028).
  mlped: {
    // ⚠️ CORRECTED from the legacy 300 (L1014). ML's post-sale reference caps a
    // seller message at **350**, and returns the live value as
    // `seller_max_message_length` on every read — so this is only the fallback
    // for a thread we have not read yet. Prefer the per-conversa value when the
    // importer has recorded one.
    limiteCaracteres: 350,
    permiteAnexo: true,
    maximoAnexos: 1,
    formatosAnexo: FORMATS_ML,
    maxTamanhoAnexoBytes: CAP_25MB,
    isHtml: true,
    // #533 — the ML chat responder route transmits this origem.
    temEnvio: true,
  },
  // maximoAnexos 3 (L1071); isHtml true (L1030).
  mlclaims: {
    // ⚠️ Legacy said 300 (L1016) and ML's claims reference states no explicit
    // character cap for a claim message, so the legacy value is kept as a
    // conservative fallback rather than invented upward.
    limiteCaracteres: 300,
    permiteAnexo: true,
    maximoAnexos: 3,
    // ⚠️ CORRECTED from the legacy 25 MB + `txt` (L1087, L1103). Claim
    // attachments are a DIFFERENT ML endpoint from post-sale message
    // attachments: 5 MB, JPG/PNG/PDF only. The legacy source applied the
    // post-sale limits to both surfaces, so a 10 MB PDF passed the composer and
    // was rejected by ML.
    formatosAnexo: FORMATS_ML_CLAIMS,
    maxTamanhoAnexoBytes: 5_000_000,
    isHtml: true,
    temEnvio: false, // #768
  },
};

/**
 * WhatsApp per-media-type byte caps — port of the legacy `TamanhoAnexoWhatsapp`
 * enum (`.old/packages/canais_de_venda/facebook/lib/src/models.dart:134-140`).
 * Distinct from `ORIGEM_RULES.whatsapp.maxTamanhoAnexoBytes` (the coarse 25 MB
 * composer cap): these are the finer Graph-API limits legacy enforced per media
 * kind before an outbound send. The legacy `verificarTamanhoAnexoWhatsapp`
 * (models.dart:173-192) additionally routes `image/webp` to the `sticker` cap.
 */
export const WHATSAPP_ANEXO_LIMITS = {
  image: 5_000_000, // models.dart:135
  video: 16_000_000, // models.dart:136
  audio: 16_000_000, // models.dart:137
  text: 100_000_000, // models.dart:138
  application: 100_000_000, // models.dart:139
  sticker: 500_000, // models.dart:140
} as const;

export type WhatsappAnexoTipo = keyof typeof WHATSAPP_ANEXO_LIMITS;
