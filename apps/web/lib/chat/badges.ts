/**
 * Pure helpers for the inbox tab badges (legacy `MenuLateral` TabBar badges,
 * `.old/lib/chat/menu_lateral.dart:363-448`).
 *
 *  - Pendentes: a live count of `estadoConversa == 0` conversas, capped "9+".
 *  - Atendimento: count of the operator's in-progress conversas whose LAST
 *    message came from the customer (`estadoEnvio == recebido`) — i.e. the ones
 *    still awaiting the operator's reply.
 */
import { ESTADO_ENVIO, type Mensagem } from '@delfrance/schemas';

/**
 * Format a badge count the legacy way: hidden (`null`) at zero, the number up
 * to 9, then a "9+" cap. Legacy queried with `limit(10)`, so a count of 10 is
 * the "9+" trigger.
 */
export function formatBadgeCount(n: number): string | null {
  if (n <= 0) return null;
  return n > 9 ? '9+' : String(n);
}

/**
 * Count conversas whose last message is from the customer — the Atendimento
 * badge. A customer inbound message lands with `estadoEnvio == recebido (7)`
 * (the pipeline's `createOrUpdateMensagem`); an operator reply / event never
 * does. Entries with no fetched last message (still loading, or empty) don't
 * count.
 *
 * DELIBERATE divergence from legacy: legacy fetched the newest FIVE messages
 * and skipped event/error tipos before testing authorship, so a conversa whose
 * newest doc is an event over an unanswered customer message still counted.
 * This port reads only the newest ONE (the tile preview fetch — zero extra
 * reads); that narrow event-tail case undercounts. Accepted for cost — the
 * preview cache is the budget's backbone.
 */
export function countAwaitingReply(
  lastMessages: ReadonlyArray<Pick<Mensagem, 'estadoEnvio'> | null | undefined>,
): number {
  return lastMessages.filter((m) => m != null && m.estadoEnvio === ESTADO_ENVIO.recebido).length;
}
