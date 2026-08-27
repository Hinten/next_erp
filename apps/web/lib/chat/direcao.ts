/**
 * Which side of a thread a message belongs to — the ONE rule, shared by the
 * bubble, the sidebar tick and the list preview.
 *
 * It lives in one place because it used to live in three, each keying on a
 * different field: the bubble on `user_id === myUid`, the tile on `estadoEnvio`,
 * the preview on `user_id` again. They disagreed about the same message.
 */
import { ORIGEM_RULES, ehEstadoDeSaida } from '@delfrance/schemas';
import type { Mensagem, OrigemConversa } from '@delfrance/schemas';

/** The fields the rule reads — a full `Mensagem` satisfies it structurally. */
export type DirecaoMensagem = Pick<Mensagem, 'user_id'> & {
  readonly estadoEnvio?: Mensagem['estadoEnvio'];
};

export interface DirecaoContexto {
  /** The logged-in operator's uid. */
  readonly myUid?: string | null;
  /** The conversa's origem. Absent ⇒ fall back to the send state. */
  readonly origem?: OrigemConversa | null;
}

/**
 * Whether WE sent this message, rather than the contact.
 *
 * Two signals, and the order matters:
 *
 * 1. **An author wins.** `user_id` names WHICH operator, which no send state can,
 *    so a colleague's message is theirs and stays on the left with their name.
 * 2. **An AUTHORLESS message** is every message the marketplace importers write —
 *    identity is a `cliente` now, not a synthetic `usuario` (#768), so neither
 *    direction carries an author. For those:
 *    - on a channel whose inbound messages ALWAYS carry an author
 *      (`entradaSemAutor: false` — WhatsApp), an authorless doc is ours, full
 *      stop;
 *    - otherwise the send state decides (`ehEstadoDeSaida`).
 *
 * ⚠️ **Do not collapse 2 into "the state decides".** `recebido` is overloaded:
 * on a marketplace thread it means "the contact sent this", but WhatsApp's
 * `processStatus.ts` writes it onto OUR OWN message when the Cloud API reports
 * `read` (and `excluido` on `deleted`). A state-only rule therefore makes an
 * authorless WhatsApp auto-reply jump from our side to the customer's the instant
 * they read it, and the preview drop its `(Eu)` at the same moment. The origem
 * check is what keeps the answer stable across the delivery lifecycle.
 *
 * ⚠️ An unknown origem falls back to the state, which is the conservative half:
 * it can only ever misplace one of OUR messages onto the contact's side, never
 * the reverse. Showing someone else's message as ours is a misattribution an
 * operator cannot detect; the other way round is obvious.
 */
export function mensagemEhNossa(m: DirecaoMensagem, ctx: DirecaoContexto = {}): boolean {
  const autor = m.user_id;
  if (autor != null && autor !== '') {
    return ctx.myUid != null && autor === ctx.myUid;
  }
  const regra = ctx.origem == null ? null : ORIGEM_RULES[ctx.origem];
  if (regra != null && !regra.entradaSemAutor) return true;
  return ehEstadoDeSaida(m.estadoEnvio);
}
