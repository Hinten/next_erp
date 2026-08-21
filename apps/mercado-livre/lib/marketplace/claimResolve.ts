/**
 * Reading and RESOLVING one Mercado Livre claim — the domain half of the two
 * `/reclamacao/*` routes (#364, #768).
 *
 * `respondIncidentMl` has existed since #768 and, until these routes, **no
 * caller reached it**: refund, partial refund, allow-return and open-dispute
 * were implemented and unreachable. This module is what finally calls it.
 *
 * ---- ⚠️ **`deps` deliberately has no `db`, and that absence IS the
 * enforcement.** Nothing here may write to Firestore. The `claims` importer is
 * the single writer of incidente state: `claimImport.ts` merges
 * `{ ultimaModificacao, resolucao }` on every run and re-derives `resolucao`
 * from `claim.resolution` through the fixed tipo table. A resolução written here
 * would either be clobbered by the next `claims` notification or win a race and
 * permanently disagree with ML. Root `CLAUDE.md` rule 7, tier **0** — the race
 * is made impossible rather than guarded, by having no second writer. A module
 * holding no Firestore handle cannot become one by accident.
 *
 * ---- ⚠️ **Availability is read LIVE, every time.** ML decides what a seller
 * may do from the claim's stage and status, and the list empties as the claim
 * closes. `respondIncidentMl` re-reads the claim on every call for that reason;
 * the read path does the same, and the UI must treat its answer as a snapshot
 * rather than a cache.
 *
 * ---- ⚠️ **The 50% default cannot be reached from here.** ML treats a MISSING
 * `percentage` as 50%, so a partial refund whose amount or displayed percentage
 * is absent or malformed is refused **before** any ML call — the money cannot
 * move on a value the operator never chose.
 */
import {
  type MercadoLivreApi,
  type MlClaim,
  type MlExpectedResolution,
  type MlPartialRefundOffers,
  respondIncidentMl,
} from '@delfrance/integrations-mercado-livre';
import type { ChannelContext } from '@delfrance/core/plugins';

import { claimActionability } from './claimActionability';
import { isMercadoLivreRequestError } from './respond';

/** The verbs this surface exposes. An ALLOW-LIST, never a denylist. */
export const ACOES_RECLAMACAO = [
  'reembolso',
  'reembolso_parcial',
  'aceitar_devolucao',
  'abrir_mediacao',
] as const;
export type AcaoReclamacao = (typeof ACOES_RECLAMACAO)[number];

export type CodigoRecusaReclamacao =
  | 'ML_CLAIM_ID_INVALIDO'
  | 'ML_PERCENTUAL_AUSENTE'
  | 'ML_PERCENTUAL_INVALIDO'
  | 'ML_VALOR_AUSENTE';

/**
 * A refusal the OPERATOR can act on, carrying its own machine code.
 *
 * Mirrors `ChatOutboundRefusedError`: the route turns it into a 409 whose body
 * the UI renders verbatim, because paraphrasing loses the only thing that tells
 * the operator what to do next.
 */
export class ClaimResolveRefusedError extends Error {
  constructor(
    readonly motivo: string,
    readonly codigo: CodigoRecusaReclamacao,
  ) {
    super(motivo);
    this.name = 'ClaimResolveRefusedError';
  }
}

export interface ClaimResolveDeps {
  readonly api: MercadoLivreApi;
}

/** One party's stated expectation, flattened for the UI. */
export interface ExpectativaReclamacao {
  readonly playerRole: string | null;
  readonly expectedResolution: string | null;
  readonly status: string | null;
}

export interface PrazoAcao {
  readonly acao: string;
  readonly obrigatoria: boolean;
  readonly prazo: string | null;
}

export interface ReclamacaoEstado {
  readonly claimId: number;
  readonly status: string | null;
  readonly stage: string | null;
  readonly tipo: string | null;
  readonly reasonId: string | null;
  readonly tipoReclamacao: 'PNR' | 'PDD' | null;
  readonly acoesDisponiveis: readonly string[];
  readonly prazos: readonly PrazoAcao[];
  readonly podeResponder: boolean;
  readonly motivoSemResposta: string | null;
  readonly expectativas: readonly ExpectativaReclamacao[] | null;
  readonly expectativasIndisponiveis: boolean;
  readonly ofertasParciais: MlPartialRefundOffers | null;
}

/**
 * PNR (pago e não recebido) vs PDD (produto com defeito), from the first three
 * letters of `reason_id`.
 *
 * ⚠️ **Caption copy, never a gate.** It says which options ML *tends* to offer,
 * not which the seller may take — that is `available_actions`, live. A new ML
 * prefix must not be able to hide a legitimate action, so an unrecognised one is
 * `null` and changes nothing.
 */
export function tipoDeReclamacao(claim: MlClaim): 'PNR' | 'PDD' | null {
  const prefixo = (claim.reason_id ?? '').slice(0, 3).toUpperCase();
  return prefixo === 'PNR' || prefixo === 'PDD' ? prefixo : null;
}

function acoesDoRespondent(
  claim: MlClaim,
): readonly { action: string; mandatory: boolean; dueDate: string | null }[] {
  const respondent = claim.players.find((p) => p.role === 'respondent');
  return (respondent?.available_actions ?? []).map((a) => ({
    action: a.action ?? '',
    mandatory: a.mandatory ?? false,
    dueDate: a.due_date ?? null,
  }));
}

/**
 * Everything the panel needs about one claim, in at most three ML calls.
 *
 * ⚠️ The offers read is issued ONLY when `allow_partial_refund` is actually
 * available — otherwise it is a call per panel open for a picker that will never
 * render, and ML answers 422 for a claim that is not eligible anyway.
 */
export async function lerReclamacaoMercadoLivre(
  deps: ClaimResolveDeps,
  args: { claimId: number },
): Promise<ReclamacaoEstado> {
  const claim = await deps.api.getClaim(args.claimId);
  const acoes = acoesDoRespondent(claim);
  const verbos = acoes.map((a) => a.action).filter((a) => a !== '');
  const acionabilidade = claimActionability(claim);

  // ⚠️ A side read that must DEGRADE, not fail: without it the operator loses
  // the whole panel over a nice-to-have. `isMercadoLivreRequestError` is the
  // guard for exactly this, and it deliberately EXCLUDES the re-auth error, so a
  // dead grant still surfaces as 409 instead of being swallowed here.
  let expectativas: ExpectativaReclamacao[] | null = null;
  let expectativasIndisponiveis = false;
  try {
    const brutas: MlExpectedResolution[] = await deps.api.getClaimExpectedResolutions(args.claimId);
    expectativas = brutas.map((e) => ({
      playerRole: e.player_role,
      expectedResolution: e.expected_resolution,
      status: e.status,
    }));
  } catch (err) {
    if (!isMercadoLivreRequestError(err)) throw err;
    expectativasIndisponiveis = true;
    console.warn('[mercado-livre] expected-resolutions indisponivel — painel segue sem ele', {
      claimId: args.claimId,
    });
  }

  let ofertasParciais: MlPartialRefundOffers | null = null;
  if (verbos.includes('allow_partial_refund')) {
    try {
      ofertasParciais = await deps.api.getClaimPartialRefundOffers(args.claimId);
    } catch (err) {
      if (!isMercadoLivreRequestError(err)) throw err;
      console.warn('[mercado-livre] available-offers indisponivel — sem reembolso parcial', {
        claimId: args.claimId,
      });
    }
  }

  return {
    claimId: args.claimId,
    status: claim.status,
    stage: claim.stage,
    tipo: claim.type,
    reasonId: claim.reason_id,
    tipoReclamacao: tipoDeReclamacao(claim),
    acoesDisponiveis: verbos,
    prazos: acoes.map((a) => ({ acao: a.action, obrigatoria: a.mandatory, prazo: a.dueDate })),
    podeResponder: acionabilidade.podeResponder,
    motivoSemResposta: acionabilidade.motivo,
    expectativas,
    expectativasIndisponiveis,
    ofertasParciais,
  };
}

export interface ResolverReclamacaoInput {
  readonly claimId: number;
  readonly acao: AcaoReclamacao;
  /** Minor units. REQUIRED for `reembolso_parcial`, ignored otherwise. */
  readonly valorReembolsoMinor?: number;
  /** The percentage the operator actually SAW and clicked. Required for a partial. */
  readonly percentualExibido?: number;
}

export interface ResolverReclamacaoResult {
  readonly ok: boolean;
  readonly status: string | null;
  readonly acao: AcaoReclamacao;
}

/**
 * Run one resolution verb, through `respondIncidentMl` so the live
 * `available_actions` gate and the exact-offer match stay in one place.
 *
 * ⚠️ Every branch is validated BEFORE the ML call. That ordering is the guard:
 * a partial refund missing its amount or its displayed percentage never reaches
 * ML, so ML's 50% default has no path to fire.
 */
export function validarAcaoReclamacao(input: ResolverReclamacaoInput): void {
  if (!Number.isSafeInteger(input.claimId) || input.claimId <= 0) {
    throw new ClaimResolveRefusedError('Id da reclamação inválido.', 'ML_CLAIM_ID_INVALIDO');
  }

  if (input.acao === 'reembolso_parcial') {
    // ⚠️ BOTH halves are required, and neither is decoration. The amount is what
    // ML matches against its offer list; the percentage is what the operator saw
    // on screen. Demanding the percentage too is what makes "left blank"
    // unrepresentable — ML would read a missing one as 50%.
    if (
      typeof input.valorReembolsoMinor !== 'number' ||
      !Number.isSafeInteger(input.valorReembolsoMinor) ||
      input.valorReembolsoMinor <= 0
    ) {
      throw new ClaimResolveRefusedError(
        'Escolha um valor de reembolso parcial entre as ofertas do Mercado Livre.',
        'ML_VALOR_AUSENTE',
      );
    }
    if (typeof input.percentualExibido !== 'number' || !Number.isFinite(input.percentualExibido)) {
      throw new ClaimResolveRefusedError(
        'Escolha um percentual de reembolso parcial — o Mercado Livre assume 50% quando nenhum é enviado.',
        'ML_PERCENTUAL_AUSENTE',
      );
    }
    // ⚠️ 100% is refused HERE as well as by ML: it is the full-refund action, and
    // this endpoint rejects it outright. Zero or negative is nonsense.
    if (input.percentualExibido <= 0 || input.percentualExibido >= 100) {
      throw new ClaimResolveRefusedError(
        'O reembolso parcial aceita apenas percentuais entre 0 e 100 — para devolver tudo, use o reembolso integral.',
        'ML_PERCENTUAL_INVALIDO',
      );
    }
  }
}

/**
 * Run one resolution verb, through `respondIncidentMl` so the live
 * `available_actions` gate and the exact-offer match stay in one place.
 *
 * ⚠️ Re-validates even though the route already did. The route's call is what
 * keeps an under-specified partial refund from ever loading the account; this
 * one is what keeps a FUTURE caller from bypassing the guard entirely. Neither
 * is redundant — they protect different entry points.
 */
export async function resolverReclamacaoMercadoLivre(
  deps: ClaimResolveDeps,
  input: ResolverReclamacaoInput,
): Promise<ResolverReclamacaoResult> {
  validarAcaoReclamacao(input);

  // `respondIncidentMl` ignores its `ChannelContext` argument (it takes the api
  // directly); the cast keeps that explicit rather than threading a value the
  // callee never reads.
  const ctx = {} as ChannelContext;

  switch (input.acao) {
    case 'reembolso': {
      // `refundAmount` is inert on this branch — `respondIncidentMl` never reads
      // it when `partial !== true`. Left explicit so nobody "fixes" it later.
      const r = await respondIncidentMl(deps.api, ctx, String(input.claimId), {
        type: 'offer_refund',
        refundAmount: 0,
        partial: false,
      });
      return { ok: r.ok, status: r.status ?? null, acao: input.acao };
    }
    case 'reembolso_parcial': {
      const r = await respondIncidentMl(deps.api, ctx, String(input.claimId), {
        type: 'offer_refund',
        refundAmount: input.valorReembolsoMinor as number,
        partial: true,
      });
      return { ok: r.ok, status: r.status ?? null, acao: input.acao };
    }
    case 'aceitar_devolucao': {
      const r = await respondIncidentMl(deps.api, ctx, String(input.claimId), {
        type: 'accept_return',
      });
      return { ok: r.ok, status: r.status ?? null, acao: input.acao };
    }
    case 'abrir_mediacao': {
      const r = await respondIncidentMl(deps.api, ctx, String(input.claimId), {
        type: 'escalate_mediation',
      });
      return { ok: r.ok, status: r.status ?? null, acao: input.acao };
    }
  }
}
