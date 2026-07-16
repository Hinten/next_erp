import { ESTADO_CONVERSA, type EstadoConversa } from '@delfrance/schemas';

/**
 * Composer availability gate — a port of the legacy "estou atendendo" check
 * (`.old/lib/chat/conversa.dart`: the composer shows only for a participant of
 * an in-progress conversa; otherwise an "Entrar na conversa" affordance).
 *
 *   - `compose` — the operator is in `usuarios` AND the conversa is
 *     `emResposta` (1): show the full composer;
 *   - `enter`   — otherwise: show the "Entrar na conversa" button (which adds
 *     the operator to `usuarios`, flips estado → `emResposta`, and records the
 *     entry event);
 *   - `no-uid`  — no authenticated uid (defensive; `useRequireAuth` normally
 *     guarantees one): render nothing actionable.
 */
export type ComposerGate = 'compose' | 'enter' | 'no-uid';

export function composerGate(input: {
  usuarios: readonly string[] | null | undefined;
  estadoConversa: EstadoConversa;
  uid: string | null | undefined;
}): ComposerGate {
  const { usuarios, estadoConversa, uid } = input;
  if (!uid) return 'no-uid';
  const isParticipant = usuarios?.includes(uid) ?? false;
  if (isParticipant && estadoConversa === ESTADO_CONVERSA.emResposta) return 'compose';
  return 'enter';
}
