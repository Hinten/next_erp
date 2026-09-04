import { arrayRemove, arrayUnion, type WriteBatch } from 'firebase/firestore';
import { ESTADO_CONVERSA } from '@delfrance/schemas';
import { conversaCollection } from '@/lib/data/conversaCollection';
import type { getFirebaseFirestore } from '@/lib/firebase/client';
import { writeEvent } from './writeEvent';

/**
 * PURE batch writers for the conversa-actions menu (PR-C4) — the single-conversa
 * ports of `ConversaProvider`'s action methods
 * (`.old/lib/chat/providers/conversaProvider.dart:1015-1361`). Each appends a
 * converter-STRIPPED conversa patch (only the intended keys, `ultima_modificacao`
 * bumped to `now`) PLUS one or two lifecycle EVENT mensagens ({@link writeEvent},
 * `tipo: 'e'`, excluded from the #529 outbound sender) to a caller-owned
 * `WriteBatch`, so the menu commits an action atomically. None commit — the menu
 * owns commit + notifications.
 *
 * ── Converter-stripped patch ───────────────────────────────────────────────────
 * The conversa converter's `toFirestore` runs a full `schema.parse`, which fills
 * EVERY defaulted field — a converted merge would clobber `nome`/`origem`/refs/
 * `cor_etiqueta` with schema defaults. So every patch goes through
 * `docRef(...).withConverter(null)` + `{ merge: true }`, writing only the keys we
 * set (same rationale as the `[id]/page` estado patch and BulkActionsBar).
 * `arrayUnion`/`arrayRemove` inside a raw patch are legitimate FieldValues.
 *
 * ── EXACT legacy event strings (verified against
 *    `.old/packages/atendimento/lib/src/models.dart:805-880` + the provider) ─────
 *   enter   → `${displayName} entrou na conversa.`   (trailing period; provider:1288)
 *   leave   → `${displayName} saiu da conversa`       (Mensagem.sairDaConversa)
 *   finish  → `${displayName} encerrou a conversa`    (participant) /
 *             `Conversa encerrada`                     (non-participant)
 *   rename  → `${displayName} renomeou a conversa de ${old} para ${new}` (participant) /
 *             `Conversa renomeada de ${old} para ${new}`                  (non-participant)
 *   etiqueta→ `${displayName} alterou a cor da conversa` (participant) /
 *             `Cor da conversa alterada`                 (non-participant)
 *   include → `${target.displayName} entrou na conversa.` (trailing period; provider:1356)
 *   transfer→ leave(me) + include(target)
 *
 * The user-vs-system branch mirrors legacy exactly: the provider passes the
 * acting user to the event ONLY when `conversa.containsUserUid(me)` — a
 * non-participant renaming/tagging/closing writes the anonymous system string.
 * When it IS user-authored the event also carries the actor's
 * `usarioMensagemOuterRef` (via {@link writeEvent}'s `actor` param), parity with
 * legacy's `Mensagem.evento(user: ...)`; the system branches, `enter` and
 * `include` (which legacy builds with no `user`) stay anonymous.
 */

type Db = ReturnType<typeof getFirebaseFirestore>;

/** The acting operator: their auth uid + a resolved display label. */
export interface ActionActor {
  uid: string;
  displayName: string;
}

/**
 * Resolve the operator's display label the same way the composer does
 * (`displayName ?? email ?? 'Operador'`), so the menu and the composer emit
 * identical event authorship.
 */
export function resolveActor(
  user: { uid: string; displayName?: string | null; email?: string | null } | null | undefined,
): ActionActor | null {
  if (!user?.uid) return null;
  return { uid: user.uid, displayName: user.displayName ?? user.email ?? 'Operador' };
}

interface ActionBase {
  batch: WriteBatch;
  db: Db;
  conversaId: string;
  actor: ActionActor;
  now: number;
}

/** Append a converter-stripped conversa merge (with a bumped `ultima_modificacao`). */
function patchConversa(
  batch: WriteBatch,
  db: Db,
  conversaId: string,
  patch: Record<string, unknown>,
  now: number,
): void {
  batch.set(
    conversaCollection.docRef(db, {}, conversaId).withConverter(null),
    { ...patch, ultima_modificacao: now },
    { merge: true },
  );
}

/** Whether `uid` is currently a participant of the conversa. */
function isParticipant(usuarios: string[] | null | undefined, uid: string): boolean {
  return (usuarios ?? []).includes(uid);
}

/**
 * ENTER — `entrarConversa` (provider:1276-1331). Adds the operator to
 * `usuarios` (`arrayUnion`), moves the conversa to `emResposta`, and writes the
 * entry event. Shared by the composer's "Entrar na conversa" gate and the menu
 * so a single impl drives both.
 */
export function enterConversa(ctx: ActionBase): void {
  patchConversa(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    { usuarios: arrayUnion(ctx.actor.uid), estadoConversa: ESTADO_CONVERSA.emResposta },
    ctx.now,
  );
  writeEvent(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    `${ctx.actor.displayName} entrou na conversa.`,
    ctx.now,
  );
}

/**
 * LEAVE — `sairConversa` (provider:1069-1084). Removes the operator from
 * `usuarios` (`arrayRemove`); when the conversa is left with NO participants it
 * falls back to `naoRespondido` (legacy's post-removal `usuarios.isEmpty` check).
 * The menu only offers this to a current participant, so it always writes the
 * user-authored "saiu" event.
 */
export function leaveConversa(ctx: ActionBase & { usuarios: string[] | null }): void {
  const remaining = (ctx.usuarios ?? []).filter((u) => u !== ctx.actor.uid);
  const patch: Record<string, unknown> = { usuarios: arrayRemove(ctx.actor.uid) };
  // Empty after leaving → back to naoRespondido (0), matching legacy.
  if (remaining.length === 0) patch.estadoConversa = ESTADO_CONVERSA.naoRespondido;
  patchConversa(ctx.batch, ctx.db, ctx.conversaId, patch, ctx.now);
  writeEvent(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    `${ctx.actor.displayName} saiu da conversa`,
    ctx.now,
    // Always participant-authored (the menu only offers "leave" to a participant),
    // matching legacy `sairDaConversa(user: ...)`.
    { uid: ctx.actor.uid },
  );
}

/**
 * FINISH — `finalizarConversa` (provider:1086-1105). Moves the conversa to
 * `atendimentoFinalizado` (always); when the operator is a participant it also
 * removes them (`arrayRemove`) and writes the user-authored close event,
 * otherwise it writes the anonymous system event and leaves `usuarios` untouched.
 */
export function finishConversa(ctx: ActionBase & { usuarios: string[] | null }): void {
  const participant = isParticipant(ctx.usuarios, ctx.actor.uid);
  const patch: Record<string, unknown> = {
    estadoConversa: ESTADO_CONVERSA.atendimentoFinalizado,
  };
  if (participant) patch.usuarios = arrayRemove(ctx.actor.uid);
  patchConversa(ctx.batch, ctx.db, ctx.conversaId, patch, ctx.now);
  writeEvent(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    participant ? `${ctx.actor.displayName} encerrou a conversa` : 'Conversa encerrada',
    ctx.now,
    // Actor only on the participant branch (legacy `encerrarConversa(user: ...)`);
    // the system close carries no user.
    participant ? { uid: ctx.actor.uid } : null,
  );
}

/**
 * TRANSFER — the `_transferirConversaDialog` flow (`conversa_popup_menu.dart:187`
 * → `sairConversa` then `incluirAtendenteConversa`). The target atendente is
 * added and the operator removed. Firestore forbids `arrayUnion` + `arrayRemove`
 * on the SAME field in one write, so the resulting `usuarios` is computed from
 * the passed snapshot (remove me, add target) and written as a plain array; the
 * conversa moves to `emResposta`. Emits the "saiu" event (only if the operator
 * was a participant, per legacy) followed by the target's "entrou" event. The
 * "saiu" event is the legacy `sairConversa` leg (participant-authored → carries
 * the actor); the target "entrou" is the `incluirAtendenteConversa` leg, which
 * legacy builds with no `user`, so it stays anonymous.
 */
export function transferConversa(
  ctx: ActionBase & { usuarios: string[] | null; target: ActionActor },
): void {
  const wasParticipant = isParticipant(ctx.usuarios, ctx.actor.uid);
  const next = Array.from(
    new Set((ctx.usuarios ?? []).filter((u) => u !== ctx.actor.uid).concat(ctx.target.uid)),
  );
  patchConversa(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    { usuarios: next, estadoConversa: ESTADO_CONVERSA.emResposta },
    ctx.now,
  );
  if (wasParticipant) {
    writeEvent(
      ctx.batch,
      ctx.db,
      ctx.conversaId,
      `${ctx.actor.displayName} saiu da conversa`,
      ctx.now,
      { uid: ctx.actor.uid },
    );
  }
  writeEvent(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    `${ctx.target.displayName} entrou na conversa.`,
    ctx.now,
  );
}

/**
 * INCLUDE — `incluirAtendenteConversa` (provider:1333-1361). Adds the target
 * atendente (`arrayUnion`), moves the conversa to `emResposta`, and writes the
 * TARGET-authored entry event (legacy names the included colaborador, not the
 * operator).
 */
export function includeAtendente(ctx: ActionBase & { target: ActionActor }): void {
  patchConversa(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    { usuarios: arrayUnion(ctx.target.uid), estadoConversa: ESTADO_CONVERSA.emResposta },
    ctx.now,
  );
  writeEvent(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    `${ctx.target.displayName} entrou na conversa.`,
    ctx.now,
  );
}

/**
 * RENAME — `renomearConversa` (provider:1107-1132). Sets `nome`; writes the
 * rename event carrying both the old and new names (user-authored when the
 * operator is a participant, system-authored otherwise).
 */
export function renameConversa(
  ctx: ActionBase & { usuarios: string[] | null; oldNome: string; newNome: string },
): void {
  patchConversa(ctx.batch, ctx.db, ctx.conversaId, { nome: ctx.newNome }, ctx.now);
  const participant = isParticipant(ctx.usuarios, ctx.actor.uid);
  writeEvent(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    participant
      ? `${ctx.actor.displayName} renomeou a conversa de ${ctx.oldNome} para ${ctx.newNome}`
      : `Conversa renomeada de ${ctx.oldNome} para ${ctx.newNome}`,
    ctx.now,
    participant ? { uid: ctx.actor.uid } : null,
  );
}

/**
 * SET ETIQUETA — `trocarCorEtiqueta` (provider:1135-1154), the single-conversa
 * equivalent of the BulkActionsBar etiqueta action. Sets `cor_etiqueta` (an ARGB
 * int, or `null` to clear — the web convention; legacy coerced a clear to `0`)
 * and writes the colour-change event (user-authored when the operator is a
 * participant, system-authored otherwise).
 */
export function setEtiqueta(
  ctx: ActionBase & { usuarios: string[] | null; cor: number | null },
): void {
  patchConversa(ctx.batch, ctx.db, ctx.conversaId, { cor_etiqueta: ctx.cor }, ctx.now);
  const participant = isParticipant(ctx.usuarios, ctx.actor.uid);
  writeEvent(
    ctx.batch,
    ctx.db,
    ctx.conversaId,
    participant ? `${ctx.actor.displayName} alterou a cor da conversa` : 'Cor da conversa alterada',
    ctx.now,
    participant ? { uid: ctx.actor.uid } : null,
  );
}
