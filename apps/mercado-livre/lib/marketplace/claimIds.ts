/**
 * Deterministic ids for the Mercado Livre CLAIMS import (Step 14) — pure
 * digests over EXACT legacy preimage strings, so re-processing the same claim
 * always lands on the same Firestore docs the Flutter app wrote for years
 * (idempotent import; a redelivery updates instead of forking history).
 * Ported character-for-character from the legacy Dart call sites — no
 * reformatting of the interpolated strings.
 *
 * Sources:
 *  - generateUid (top-level)      `.old/packages/global/lib/src/utils.dart:75-79`
 *  - incidente id (`toIncidente`) `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:3920`
 *  - conversa id (`toConversa`)   `.old/.../models.dart:3947`
 *  - claim-message id             `.old/.../models.dart:3580` (`generateMessageId`)
 *  - attachment mensagem id       `.old/.../tasks.dart:1962,1970`
 *  - usuario externalId           `.old/.../models.dart:3891-3904` (`getOrCreateUser` →
 *                                 `Usuario.getOrCreateUsuarioSemAuth(canalDeVendas, externalId)`)
 *
 * ⚠️ Every preimage here starts with the conta's legacy Flutter
 * `DocumentId.path` — `/documents/integracao/{contaId}` with a LEADING slash
 * (see `contaPathLegacyMl` below). That is a DIFFERENT convention from the
 * `documents/<col>/<id>` OuterRef wire format used elsewhere in this app
 * (which has no leading slash) — never normalize these preimages through
 * `toOuterRef`, it strips the slash and changes every digest (the same trap
 * documented at `orderIds.ts:60-76`; the whatsapp `ids.ts` `contaPath` has no
 * slash either and must not be reused here).
 */
import { createHash } from 'node:crypto';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The conta's legacy Flutter `DocumentId.path` — `/documents/integracao/{id}`,
 * LEADING slash included (see the module doc warning).
 */
export function contaPathLegacyMl(contaId: string): string {
  return `/documents/integracao/${contaId}`;
}

/**
 * The legacy top-level `generateUid(canalDeVendas, id)` —
 * `sha256(utf8("$canalDeVendas-${id.toString()}"))`
 * (`.old/packages/global/lib/src/utils.dart:75-79`).
 */
export function generateUid(key: string, id: string): string {
  return sha256Hex(`${key}-${id}`);
}

/**
 * `pedidos/{pedidoId}/incidentes/{id}` doc id for one ML claim. Mirrors
 * `Claims.toIncidente`'s `generateUid(conta.docId!.path!, '$resource_id($id)')`
 * (models.dart:3920).
 */
export function makeIncidenteIdClaim(contaId: string, resourceId: number, claimId: number): string {
  return generateUid(contaPathLegacyMl(contaId), `${resourceId}(${claimId})`);
}

/**
 * `chat/{id}` doc id for one ML claim's conversa. Mirrors `Claims.toConversa`'s
 * `generateUid(conta.docId!.path!, "claims$resource_id${id.toString()}")`
 * (models.dart:3947).
 */
export function makeConversaIdClaim(contaId: string, resourceId: number, claimId: number): string {
  return generateUid(contaPathLegacyMl(contaId), `claims${resourceId}${claimId}`);
}

/**
 * `chat/{conversaId}/mensagem/{id}` doc id for one claim message. Mirrors
 * `ClaimsMessage.generateMessageId` (models.dart:3580):
 * `generateUid(conta.docId!.path!, '$sender_role$receiver_role$stage${date_created.toString()}$message')`.
 *
 * The Dart interpolation calls `toString()` on the enhanced enums, which
 * yields `'_RolePlayes.complainant'` / `'_StageClaims.claim'` etc. — the enum
 * member names equal the wire values, so the generic `'_RolePlayes.' + raw`
 * rule reproduces the legacy preimage for every documented value. Legacy
 * CRASHED on unknown vocabulary (`fromValue` threw), so any deterministic
 * choice for an unknown/null value is parity-safe; `?? ''` is ours.
 * `date_created.toString()` is Dart's `DateTime.toString()` — see
 * {@link dartUtcDateTimeToString}.
 */
export function makeClaimMessageId(
  contaId: string,
  msg: {
    sender_role: string | null;
    receiver_role: string | null;
    stage: string | null;
    date_created: string;
    message: string;
  },
): string {
  const preimage =
    `_RolePlayes.${msg.sender_role ?? ''}` +
    `_RolePlayes.${msg.receiver_role ?? ''}` +
    `_StageClaims.${msg.stage ?? ''}` +
    `${dartUtcDateTimeToString(msg.date_created)}${msg.message}`;
  return generateUid(contaPathLegacyMl(contaId), preimage);
}

/**
 * `chat/{conversaId}/mensagem/{id}` doc id for one claim-message ATTACHMENT.
 * Mirrors the legacy call site's `generateUid(api.conta_ml.docId!.path!,
 * attachment.filename)` (tasks.dart:1962,1970 — the same digest doubles as the
 * uploaded file's Storage name in legacy).
 */
export function makeAttachmentMensagemId(contaId: string, filename: string): string {
  return generateUid(contaPathLegacyMl(contaId), filename);
}

/**
 * The `usuarios` `externalId` for one ML buyer on one conta. Mirrors
 * `Usuario.getOrCreateUsuarioSemAuth(canalDeVendas: conta.docId!.path!,
 * externalId: getClientId)` (models.dart:3891-3904) — the legacy user-dedup
 * key the claims import resolves buyers by.
 */
export function usuarioExternalIdMl(contaId: string, mlUserId: number): string {
  return generateUid(contaPathLegacyMl(contaId), String(mlUserId));
}

/**
 * Replicate Dart `DateTime.parse(iso).toString()` for the claim-message id
 * preimage.
 *
 * When the source string carries an offset or `Z`, Dart parses it as a UTC
 * instant and prints `'yyyy-MM-dd HH:mm:ss.mmm'` + three extra MICROSECOND
 * digits ONLY when the µs remainder is non-zero, then `'Z'`. The fractional
 * digits come from the SOURCE STRING (padded right to 6: first 3 = ms, last
 * 3 = µs) — JS `Date` truncates µs, so they are never derived from a `Date`.
 * Epoch/date parts come from `Date.parse` of the string truncated to ms,
 * formatted in UTC with zero-padding (handles the day rollover an offset can
 * cause).
 *
 * Defensive branch: a string with NO offset/`Z` parses as LOCAL time in Dart
 * and prints the same wall-clock parts WITHOUT the trailing `Z` — emitted
 * textually here (ML always sends offsets; the branch just avoids a silent
 * mismatch). A string Dart couldn't parse at all is returned verbatim
 * (deterministic; legacy crashed, so no legacy id exists to collide with).
 */
export function dartUtcDateTimeToString(iso: string): string {
  const fracMatch = /\.(\d+)/.exec(iso);
  const frac6 = (fracMatch?.[1] ?? '').padEnd(6, '0').slice(0, 6);
  const ms3 = frac6.slice(0, 3);
  const us3 = frac6.slice(3, 6);
  const usSuffix = us3 === '000' ? '' : us3;

  const hasOffset = /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(iso);
  if (hasOffset) {
    // Truncate the fraction to ms BEFORE Date.parse — engines differ on >3
    // fractional digits, and the µs digits are re-appended from the source.
    const msIso = fracMatch ? iso.replace(/\.\d+/, `.${ms3}`) : iso;
    const epochMs = Date.parse(msIso);
    if (Number.isNaN(epochMs)) return iso;
    const d = new Date(epochMs);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const p4 = (n: number) => String(n).padStart(4, '0');
    return (
      `${p4(d.getUTCFullYear())}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
      `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${ms3}${usSuffix}Z`
    );
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (!m) return iso;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}.${ms3}${usSuffix}`;
}
