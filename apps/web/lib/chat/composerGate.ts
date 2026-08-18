import {
  ESTADO_CONVERSA,
  ORIGEM_RULES,
  type EstadoConversa,
  type OrigemConversa,
} from '@delfrance/schemas';

/**
 * Composer availability gate — a port of the legacy "estou atendendo" check
 * (`.old/lib/chat/conversa.dart`: the composer shows only for a participant of
 * an in-progress conversa; otherwise an "Entrar na conversa" affordance), plus
 * the send-CAPABILITY check the legacy never needed (#817).
 *
 *   - `compose`         — the operator is in `usuarios` AND the conversa is
 *     `emResposta` (1): show the full composer;
 *   - `enter`           — otherwise: show the "Entrar na conversa" button (which
 *     adds the operator to `usuarios`, flips estado → `emResposta`, and records
 *     the entry event);
 *   - `somente-leitura` — nothing we write can reach the contact. Show WHY, and
 *     no composer and no "Entrar" button;
 *   - `no-uid`          — no authenticated uid (defensive; `useRequireAuth`
 *     normally guarantees one): render nothing actionable.
 *
 * ⚠️ **`somente-leitura` is checked FIRST, before participation.** Two reasons.
 * The obvious one: a channel that cannot transmit cannot transmit to a
 * participant either. The load-bearing one: the `enter` arm's button calls
 * `enterConversa`, which flips `estadoConversa` to `emResposta` — so leaving it
 * reachable on a dead thread lets an operator reopen it and land on a fully
 * enabled composer, which is #817 with one extra click.
 *
 * ⚠️ This is UX, **not enforcement**. Both inputs are stale by construction:
 * `temEnvio` is compile-time, and `respostaBloqueada` records what the channel
 * last observed, which can be minutes old. The send route re-derives the
 * capability from the live provider and is the only authority.
 */
export type ComposerGate =
  | { kind: 'compose' }
  | { kind: 'enter' }
  | { kind: 'somente-leitura'; motivo: string }
  | { kind: 'no-uid' };

/**
 * The reason shown when a whole channel has no sender. Deliberately about the
 * SYSTEM, not the thread — nothing the operator or the contact did causes it.
 */
export const SEM_ENVIO_MOTIVO =
  'Este canal ainda não envia mensagens pelo ERP. Responda pelo painel do canal.';

export function composerGate(input: {
  usuarios: readonly string[] | null | undefined;
  estadoConversa: EstadoConversa;
  uid: string | null | undefined;
  origem: OrigemConversa;
  /** `conversa.respostaBloqueada` — null when the thread is still answerable. */
  respostaBloqueada: string | null | undefined;
}): ComposerGate {
  const { usuarios, estadoConversa, uid, origem, respostaBloqueada } = input;
  if (!uid) return { kind: 'no-uid' };

  // Per-thread first: it carries a specific, useful reason ("Pergunta já
  // respondida no Mercado Livre") where the channel-wide one is generic.
  if (respostaBloqueada != null && respostaBloqueada !== '') {
    return { kind: 'somente-leitura', motivo: respostaBloqueada };
  }
  if (!ORIGEM_RULES[origem].temEnvio) {
    return { kind: 'somente-leitura', motivo: SEM_ENVIO_MOTIVO };
  }

  const isParticipant = usuarios?.includes(uid) ?? false;
  if (isParticipant && estadoConversa === ESTADO_CONVERSA.emResposta) {
    return { kind: 'compose' };
  }
  return { kind: 'enter' };
}
