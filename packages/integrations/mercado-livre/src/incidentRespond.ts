/**
 * `respondIncident` for Mercado Livre (#768) — the last unimplemented member of
 * the `MarketplaceChannel` contract.
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
 * `IncidentAction.offer_refund` carries `refundAmount` in minor units, which is
 * the contract's shape for every other channel; here it has to be matched
 * against `available-offers` and refused when it is not on the list. Inventing
 * one is not a validation error — ML defaults a missing percentage to **50%**,
 * so a wrong guess refunds half the order silently.
 */
import type { ChannelContext, IncidentAction, IncidentActionResult } from '@delfrance/core/plugins';

import { roundReais } from '@delfrance/core/money';

import type { MercadoLivreApi } from './api';
import type { MlClaim } from './types';
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
 * Raised when ML has not offered the seller this action. Distinct from
 * `MercadoLivreHttpError`: nothing was sent, and the operator can see what they
 * could do instead.
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
  _ctx: ChannelContext,
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

    default:
      // `attach_evidence`, `ship_replacement` and `custom` have no ML equivalent
      // on this surface. Refusing by name beats a silent `ok: false`.
      throw new ClaimActionUnavailableError(action.type, disponiveis);
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
 * `refundAmount` is MINOR units (the contract's `MinorUnits`); ML's `amount` is
 * a major-unit decimal. The comparison happens in MAJOR units through
 * `roundReais` — scaling to cents by hand is the ad-hoc rounding the money lint
 * rule forbids, and `roundReais` is what the rest of the ERP compares with.
 */
async function percentualParaValor(
  api: MercadoLivreApi,
  claimId: number,
  refundAmount: number,
): Promise<number> {
  const ofertas = await api.getClaimPartialRefundOffers(claimId);
  const alvoReais = roundReais(refundAmount / 100);
  const escolhida = ofertas.available_offers.find(
    (o) => o.amount != null && roundReais(o.amount) === alvoReais,
  );
  if (escolhida?.percentage == null) {
    const oferecidos = ofertas.available_offers
      .filter((o) => o.amount != null && o.percentage != null)
      .map((o) => `${String(o.percentage)}% = ${String(o.amount)}`)
      .join(', ');
    throw new MercadoLivreValidationError(
      `O Mercado Livre não oferece um reembolso parcial de ${String(alvoReais)}. ` +
        `Disponíveis: ${oferecidos !== '' ? oferecidos : 'nenhum'}`,
      ofertas,
    );
  }
  return escolhida.percentage;
}
