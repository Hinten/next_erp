/**
 * Hash primitives and legacy ID formulas, retained for imported data/fixtures.
 * New conversations use the integration + cliente reservation in contatos.ts.
 * mensagemDocId remains the live provider-message ID formula.
 */
import { createHash } from 'node:crypto';

/** The canal-de-vendas key for every WhatsApp identity derivation. */
export const WHATSAPP_CANAL = 'whatsapp';

/** Lowercase hex SHA-256 of the UTF-8 bytes of `s`. */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * `generateUid` — the universal deterministic id: `sha256("<canal>-<id>")`.
 * Legacy `generateUid(canalDeVendas, id)` (utils.dart:74). `id` is stringified
 * exactly as passed (callers already pass strings here).
 */
export function generateUid(canal: string, id: string): string {
  return sha256Hex(`${canal}-${id}`);
}

/**
 * `Usuario.generateExternalId(canal, id)` — byte-identical to {@link generateUid}
 * (models.dart:100). The value stored in `usuarios/<uid>.externalId` for a
 * sem-auth external-channel contact, e.g. `externalId('whatsapp', '5511999998888')`.
 */
export function externalId(canal: string, id: string): string {
  return generateUid(canal, id);
}

/**
 * `conta.docId.pathWithDocuments` — the seed the conversa/mensagem ids hash
 * against. A `Conta_Whatsapp` lives in the `integracao` collection (the legacy
 * path, unchanged), so its `pathWithDocuments` is `documents/integracao/<contaId>`.
 */
export function contaPath(contaId: string): string {
  return `documents/integracao/${contaId}`;
}

/**
 * `generateConversaSenderId(displayPhone, from)` — `"${displayPhone}_${from}"`
 * (generate_conversa_sender_id.dart). `displayPhone` is the account's own
 * `display_phone_number`; `from` is the sender's `wa_id`.
 */
export function senderId(displayPhone: string, from: string): string {
  return `${displayPhone}_${from}`;
}

/**
 * `getFromNumberFromSenderId` — the sender number back out of a sender id:
 * everything after the first `_`, re-joined so a `from` that itself contains an
 * underscore round-trips (generate_conversa_sender_id.dart).
 */
export function fromNumberFromSenderId(sender: string): string {
  return sender.split('_').slice(1).join('_');
}

/**
 * The `chat/<conversaId>` document id for an inbound conversa:
 * `generateUid(contaPath(contaId), senderId)` (messages.dart:60).
 */
export function conversaDocId(contaId: string, sender: string): string {
  return generateUid(contaPath(contaId), sender);
}

/**
 * The `chat/<conversaId>/mensagem/<mensagemId>` document id for an inbound
 * message: `generateUid(contaPath(contaId), wamid)` where `wamid` is the Meta
 * message id (`message.id`) (messages.dart:298). Deterministic on the wamid, so
 * a redelivered webhook maps to the same doc — idempotent.
 */
export function mensagemDocId(contaId: string, wamid: string): string {
  return generateUid(contaPath(contaId), wamid);
}
