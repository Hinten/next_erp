/**
 * The seller's WRITE surface against a Mercado Livre claim (#768). Reached from
 * `apps/mercado-livre/lib/marketplace/claims/claimResolve.ts`.
 *
 * ⚠️ It used to be described as the last unimplemented member of the
 * `MarketplaceChannel` contract, and took a `ChannelContext` it never read. Both
 * are gone (#815, ADR 0015); the `IncidentAction` union it dispatches on now
 * lives in `@delfrance/core/marketplace`.
 *
 * Maps the channel-agnostic {@link IncidentAction} union onto ML's claim
 * endpoints. Everything here is a WRITE against a live claim, so the module's
 * job is to refuse anything ML would reject rather than to be permissive:
 * a rejected write costs a slice of the shared 500 rpm post-sale budget and
 * hands the operator an error they cannot act on.
 *
 * ⚠️ **Every action is gated on `players[role=respondent].available_actions`.**
 * ML decides what a seller may do from the claim's stage and status, and the
 * list empties as the claim closes. Attempting an unavailable action is a 400
 * (`"Action allow_partial_refund not available for player"`), so the gate turns
 * that into a refusal naming what IS available.
 *
 * ⚠️ **Partial refund takes a PERCENTAGE off an allow-list, never an amount.**
 * `IncidentAction.offer_refund` carries `refundAmount` in **reais** (#815 — the
 * model is reais throughout, because that is what the produto price tables and
 * ML's own wire both speak). Here it has to be matched against
 * `available-offers` and refused when it is not on the list. Inventing one is
 * not a validation error — ML defaults a missing percentage to **50%**, so a
 * wrong guess refunds half the order silently.
 */
import type { IncidentAction, IncidentActionResult } from '@delfrance/core/marketplace';

import { roundReais } from '@delfrance/core/money';

import type { MercadoLivreApi } from './api';
import type { MlClaim, MlPartialRefundOffers } from './types';
import { MercadoLivreValidationError } from './errors';

/** ML's seller-side action verbs, as published in the claims reference. */
export const ACAO_ML = {
  mensagemAoComprador: 'send_message_to_complainant',
  mensagemAoMediador: 'send_message_to_mediator',
  reembolso: 'refund',
  reembolsoParcial: 'allow_partial_refund',
  aceitarDevolucao: 'allow_return',
  aceitarDevolucaoEtiqueta: 'allow_return_label',
  abrirMediacao: 'open_dispute',
} as const satisfies Record<string, string>;

/** `receiver_role` for each of the seller's two message actions. */
const DESTINO_DA_ACAO: Readonly<Record<string, string>> = {
  [ACAO_ML.mensagemAoComprador]: 'complainant',
  [ACAO_ML.mensagemAoMediador]: 'mediator',
};

/**
 * Raised when the amount the operator authorised is not one Mercado Livre
 * offers for this claim.
 *
 * ⚠️ Its own class rather than `MercadoLivreValidationError`, because of how the
 * two are MAPPED. `respond.ts` turns a validation error into
 * **502 ML_BAD_RESPONSE — "ML returned an unexpected shape (a field changed),
 * upstream problem"** — the wrong sentence for the most operator-actionable
 * condition in the feature: the message already names exactly which percentages
 * ARE available. Carrying `ofertas` lets the caller re-render the picker in
 * place instead of sending the operator back to the start.
 *
 * ⚠️⚠️ **It extends `Error`, NOT `MercadoLivreError` — so every route that can
 * raise it MUST catch it explicitly.** `isMercadoLivreError` in
 * `apps/mercado-livre/lib/marketplace/respond.ts` does not match it, and that
 * file's contract is that the route rethrows whatever the guard rejects. Left
 * unmapped this is a bare **500 with the message gone**, which is strictly worse
 * than the 502 it replaced — the 502 sentence was wrong, but it still carried
 * the string the whole refusal turns on. `/reclamacao/acao` maps it to a 409
 * with `ofertas`; a new caller has to do the same.
 */
export class ClaimPartialRefundOfferError extends Error {
  constructor(
    message: string,
    readonly ofertas: MlPartialRefundOffers,
  ) {
    super(message);
    this.name = 'ClaimPartialRefundOfferError';
  }
}

/**
 * Raised when ML has not offered the seller this action. Distinct from
 * `MercadoLivreHttpError`: nothing was sent, and the operator can see what they
 * could do instead.
 *
 * ⚠️ Also extends `Error`, not `MercadoLivreError` — same explicit-catch
 * requirement as the class above.
 */
export class ClaimActionUnavailableError extends Error {
  constructor(
    readonly acao: string,
    readonly disponiveis: readonly string[],
  ) {
    super(
      `Ação "${acao}" não disponível nesta reclamação. Disponíveis: ${
        disponiveis.length > 0 ? disponiveis.join(', ') : 'nenhuma'
      }`,
    );
    this.name = 'ClaimActionUnavailableError';
  }
}

/** The seller's currently-available action verbs on a claim. */
export function acoesDoVendedor(claim: MlClaim): readonly string[] {
  const respondent = claim.players.find((p) => p.role === 'respondent');
  return (respondent?.available_actions ?? [])
    .map((a) => (a.action ?? '').trim())
    .filter((a) => a !== '');
}

function exigir(disponiveis: readonly string[], ...aceitas: string[]): string {
  const achada = aceitas.find((a) => disponiveis.includes(a));
  if (achada == null) throw new ClaimActionUnavailableError(aceitas[0]!, disponiveis);
  return achada;
}

function claimIdNumerico(externalIncidentId: string): number {
  const n = Number(externalIncidentId);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new MercadoLivreValidationError(
      `Id de reclamação inválido: ${externalIncidentId}`,
      externalIncidentId,
    );
  }
  return n;
}

/**
 * Dispatch one {@link IncidentAction} onto ML.
 *
 * Reads the claim FIRST on every call — `available_actions` is the authority and
 * it is stale the moment it leaves ML, so the alternative is deciding from a
 * snapshot the caller happened to be holding.
 */
export async function respondIncidentMl(
  api: MercadoLivreApi,
  externalIncidentId: string,
  action: IncidentAction,
): Promise<IncidentActionResult> {
  const claimId = claimIdNumerico(externalIncidentId);
  const claim = await api.getClaim(claimId);
  const disponiveis = acoesDoVendedor(claim);

  switch (action.type) {
    case 'reply_message': {
      // ⚠️ The mediator action wins when both are offered: once a mediation is
      // open ML refuses a message aimed at the complainant.
      const acao = exigir(disponiveis, ACAO_ML.mensagemAoMediador, ACAO_ML.mensagemAoComprador);
      await api.sendClaimMessage(claimId, {
        receiverRole: DESTINO_DA_ACAO[acao]!,
        message: action.text,
        attachments: action.attachments,
      });
      return { ok: true, status: claim.status ?? undefined };
    }

    case 'escalate_mediation': {
      exigir(disponiveis, ACAO_ML.abrirMediacao);
      const atualizada = await api.openClaimDispute(claimId);
      return { ok: true, status: atualizada.status ?? undefined };
    }

    case 'accept_return': {
      // ML publishes two verbs for the same outcome depending on whether a
      // return label is minted; either one authorises this endpoint.
      exigir(disponiveis, ACAO_ML.aceitarDevolucao, ACAO_ML.aceitarDevolucaoEtiqueta);
      await api.allowClaimReturn(claimId);
      return { ok: true };
    }

    case 'offer_refund': {
      if (action.partial !== true) {
        exigir(disponiveis, ACAO_ML.reembolso);
        await api.refundClaim(claimId);
        return { ok: true };
      }
      exigir(disponiveis, ACAO_ML.reembolsoParcial);
      const percentual = await percentualParaValor(api, claimId, action.refundAmount);
      await api.partialRefundClaim(claimId, percentual);
      return { ok: true };
    }

    // No ML equivalent on this surface. Refusing by name beats a silent
    // `ok: false`. Named explicitly rather than left to `default` so the
    // exhaustiveness check proves the list is complete: a new `IncidentAction`
    // member now fails lint here instead of quietly inheriting this refusal.
    case 'attach_evidence':
    case 'ship_replacement':
    case 'custom':
      throw new ClaimActionUnavailableError(action.type, disponiveis);

    default:
      // Unreachable through the type; a value from outside it still refuses by
      // name rather than resolving `undefined` into `IncidentActionResult`.
      throw new ClaimActionUnavailableError((action as IncidentAction).type, disponiveis);
  }
}

/**
 * Translate a refund AMOUNT into one of ML's allowed percentages.
 *
 * ⚠️ Exact match only, and that is deliberate. ML's list is coarse (10% steps in
 * the reference example), so "nearest" would routinely refund a different sum
 * than the operator authorised — and a refund is not a value worth approximating.
 * A miss lists what IS on offer so the caller can pick one.
 *
 * Both sides are **reais**: `refundAmount` since #815, and ML's `amount` always.
 * The comparison still goes through `roundReais` rather than `===` — ML sends a
 * decimal and the caller computed one, so two values that mean the same money
 * can differ in the last bit. `roundReais` is also what the rest of the ERP
 * compares with, so a match here means a match everywhere.
 *
 * ⚠️ The centavos→reais conversion now happens at the CALLER
 * (`claimResolve.ts`), on purpose: the `/reclamacao/acao` wire between apps/web
 * and this backend still carries `valorReembolsoMinor`, and changing a live
 * refund's wire format would make a web deploy against an older backend refund
 * 100× the intended amount.
 */
async function percentualParaValor(
  api: MercadoLivreApi,
  claimId: number,
  refundAmount: number,
): Promise<number> {
  const ofertas = await api.getClaimPartialRefundOffers(claimId);
  const alvoReais = roundReais(refundAmount);
  const escolhida = ofertas.available_offers.find(
    (o) => o.amount != null && roundReais(o.amount) === alvoReais,
  );
  if (escolhida?.percentage == null) {
    const oferecidos = ofertas.available_offers
      .filter((o) => o.amount != null && o.percentage != null)
      .map((o) => `${String(o.percentage)}% = ${String(o.amount)}`)
      .join(', ');
    throw new ClaimPartialRefundOfferError(
      `O Mercado Livre não oferece um reembolso parcial de ${String(alvoReais)}. ` +
        `Disponíveis: ${oferecidos !== '' ? oferecidos : 'nenhum'}`,
      ofertas,
    );
  }
  return escolhida.percentage;
}
