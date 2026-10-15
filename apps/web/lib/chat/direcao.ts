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
  readonly clienteMensagemOuterRef?: Mensagem['clienteMensagemOuterRef'];
};

export interface DirecaoContexto {
  /** The logged-in operator's uid. */
  readonly myUid?: string | null;
  /** The conversa's origem. Absent ⇒ fall back to the send state. */
  readonly origem?: OrigemConversa | null;
}

/**
 * Customer references win over legacy usuario fields. Otherwise an explicit
 * operator uid decides alignment, and authorless messages use the channel rule.
 * WhatsApp authorless automatic replies remain ours after `read`: that receipt
 * also writes estadoEnvio=recebido, so state alone cannot identify the sender.
 */
export function mensagemEhNossa(m: DirecaoMensagem, ctx: DirecaoContexto = {}): boolean {
  // Client authorship survives read receipts and the removal of synthetic users.
  if (m.clienteMensagemOuterRef) return false;
  const autor = m.user_id;
  if (autor != null && autor !== '') {
    return ctx.myUid != null && autor === ctx.myUid;
  }
  const regra = ctx.origem == null ? null : ORIGEM_RULES[ctx.origem];
  if (regra != null && !regra.entradaSemAutor) return true;
  return ehEstadoDeSaida(m.estadoEnvio);
}
