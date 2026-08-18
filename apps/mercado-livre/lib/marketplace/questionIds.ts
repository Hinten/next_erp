/**
 * Deterministic document ids for the Mercado Livre questions import (#532).
 *
 * Every formula here is a BYTE-EXACT replica of the legacy Flutter one, for the
 * same reason `claimIds.ts` is: the Flutter app wrote question conversas into
 * `chat/*` for years, and a re-processed question must UPDATE those documents
 * rather than fork a second copy of a thread the operator already knows.
 *
 * ⚠️ The preimage uses `contaPathLegacyMl`, which keeps the LEADING slash
 * (`/documents/integracao/<id>`). Never normalize it through `toOuterRef` — that
 * strips the slash and changes every digest. See `claimIds.ts` for the full note.
 */
import { contaPathLegacyMl, generateUid } from './claimIds';

/**
 * The conversa document for one question —
 * `generateUid(conta.docId.path, id)` (legacy `QuestionML.toConversa`,
 * `models.dart:6658`).
 */
export function makeConversaIdQuestion(contaId: string, questionId: number): string {
  return generateUid(contaPathLegacyMl(contaId), String(questionId));
}

/**
 * The mensagem carrying the buyer's question — the RAW question id, not a digest
 * (legacy `QuestionML.toMensagem`, `models.dart:6672`, which sets both
 * `docIdString` and `mid` to `id.toString()`).
 *
 * It is a subcollection id under `chat/{conversaId}/mensagem`, so a plain
 * numeric string is unambiguous.
 */
export function makeQuestionMensagemId(questionId: number): string {
  return String(questionId);
}

/**
 * The mensagem carrying the SELLER'S ANSWER.
 *
 * ⚠️ Yes, this is a constant, and yes, it reads like a bug — because it replicas
 * one. Legacy built the id as `"ja_respondida${mensagem.mid}"`
 * (`tasks.dart:1443`), but `_AnswerML.toMensagem` (`models.dart:6741-6753`)
 * never sets `mid`, so the interpolation always produced the literal string
 * `"ja_respondidanull"`. Every answer the Flutter app ever wrote is stored under
 * that id.
 *
 * It is kept because it is *correct enough by accident*: there is exactly one
 * answer per question, and the id is scoped to the question's own conversa
 * subcollection, so it is idempotent where it matters. Minting a cleaner id
 * instead would render a SECOND answer bubble on every legacy thread that
 * receives a fresh notification — a visible artifact, traded for cosmetics in a
 * string nobody reads. This is the same call `claimIds.ts` makes when it embeds
 * Dart enum `toString()` tokens.
 */
export const ANSWER_MENSAGEM_ID = 'ja_respondidanull';
