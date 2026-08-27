import { ORIGEM_CONVERSA, type OrigemConversa } from '@delfrance/schemas';

/**
 * The copy shown before a send that cannot be taken back.
 *
 * `confirmar` is deliberately NOT the label of the affordance that opened the
 * dialog. The operator must be clicking the modal on purpose, not repeating a
 * muscle-memory action one pixel away — the same discipline spelled out at
 * `apps/web/app/(app)/pedidos/_components/ReclamacaoMlPanel.tsx`.
 */
export interface ConfirmacaoEnvio {
  titulo: string;
  aviso: string;
  confirmar: string;
}

/**
 * Whether replying on this origem needs an explicit confirmation first, and what
 * to say when it does.
 *
 * Only `mlperg` qualifies, and the bar is narrow on purpose: a Mercado Livre
 * question accepts **exactly one** answer. `POST /answers` is single-shot and
 * public — the reply lands on the anúncio, cannot be edited or retracted, the
 * question flips to `ANSWERED`, and `chatOutbound.ts` then merges
 * `respostaBloqueada` + `atendido: true` onto the conversa, which turns the
 * composer read-only on the next snapshot. One click ends the atendimento.
 *
 * `mlped` and `mlclaims` go through the same route and are equally un-editable
 * at the API, but they are MULTI-TURN: both return `respostaBloqueada: null` and
 * the operator can keep writing. Confirming there would be fatigue that trains
 * people to click through the one dialog that matters.
 *
 * ⚠️ **Total on purpose.** `satisfies Record<OrigemConversa, …>` means a new
 * origem does not compile until someone decides. Same reasoning as its neighbour
 * {@link ./transporteEnvio.ts} — read that file's header for what a hand-kept
 * set of origens costs (#768).
 */
export const CONFIRMACAO_ENVIO = {
  [ORIGEM_CONVERSA.site]: null,
  [ORIGEM_CONVERSA.facebook]: null,
  [ORIGEM_CONVERSA.comentarioFacebook]: null,
  [ORIGEM_CONVERSA.whatsapp]: null,
  [ORIGEM_CONVERSA.mercadoLivrePerguntas]: {
    titulo: 'Responder e encerrar o atendimento?',
    aviso:
      'O Mercado Livre aceita apenas UMA resposta por pergunta. Ela será publicada ' +
      'no anúncio e não poderá ser editada nem apagada. O atendimento será ' +
      'encerrado e esta ação não pode ser desfeita.',
    confirmar: 'Responder e encerrar',
  },
  [ORIGEM_CONVERSA.mercadoLivrePedido]: null,
  [ORIGEM_CONVERSA.mercadoLivreReclamacoes]: null,
} as const satisfies Record<OrigemConversa, ConfirmacaoEnvio | null>;

/**
 * The confirmation this origem's reply needs, or `null` when it needs none.
 *
 * ⚠️ Takes `OrigemConversa`, deliberately NOT a widened `string` — the same
 * argument `enviaPorRota` makes: a widened parameter lets a typo
 * (`'mlperg '`, `'mlpergunta'`) compile and silently answer "no confirmation
 * needed", which is the failure this table exists to prevent.
 */
export function confirmacaoEnvio(origem: OrigemConversa): ConfirmacaoEnvio | null {
  return CONFIRMACAO_ENVIO[origem];
}
