/**
 * What the seller may do on one Shopee return RIGHT NOW, and the live state the
 * reclamação panel shows (#1525, step 17) — THE actions gate, pure.
 *
 * ## ONE gate (#1369)
 *
 * Every availability rule of the three seller actions lives HERE and nowhere
 * else: {@link avaliarAcoesDevolucao} answers "which action is open, and if not,
 * why" from a LIVE `get_return_detail` (+ `get_available_solutions`), and
 * {@link recusaDaAcaoPedida} adds the rules that need the operator's REQUEST —
 * the pedido cross-check, the "what you saw" echo and the offer amount. Both
 * routes read their output (`acoesDevolucao.ts` re-runs them immediately before
 * every write); the web reads only `acoesDisponiveis` and holds NO rule — a
 * browser copy would be the size-chart panel's two-copies defect, which drifted
 * toward plausible while disagreeing.
 *
 * ⚠️ **Shopee stays the arbiter.** This gate refuses what the pages DOCUMENT
 * Shopee would refuse, so the operator reads a sentence that names the remedy
 * instead of a provider code. A rule here that is too loose costs one Shopee
 * refusal (classified by `recusaDevolucao.ts`); a rule that is too STRICT hides
 * an action the seller is owed — so nothing here is a guess beyond the pages.
 *
 * ## Read through the importer's readers
 *
 * Every token and amount is read off `mapearDevolucaoShopee(detalhe).bloco` —
 * the SAME readers the importer stores (`''`/`-` are absences, `'NONE'` on the
 * reassessed reason is `null`, the solution through
 * `normalizarSolucaoDeDevolucao`) — so the panel, the gate and the stored
 * incidente can never read one wire value two ways. Only the deadlines are read
 * off the wire directly: the block holds them in µs, and the HTTP estado speaks
 * MILLISECONDS — Shopee seconds × 1000, the `authTime` precedent — so this
 * module converts NOTHING into µs and is not a site of `apps/shopee/CLAUDE.md`'s
 * µs list (R-10).
 *
 * Pure and total: no clock, no I/O, no environment, no `console`.
 */
import { z } from 'zod';
import { centavosDeReais } from '@delfrance/core/money';
import {
  SHOPEE_RETURN_SOLUTION,
  type ShopeeReturnAvailableSolutions,
  type ShopeeReturnDetail,
  type ShopeeReturnSolution,
} from '@delfrance/integrations-shopee';

import { makePedidoIdShopee } from '../pedidos/orderIds';
import { segundosShopeeUtilizaveis } from '../pedidos/orderMapping';
import {
  NEGOCIACAO_AGUARDANDO_VENDEDOR,
  PROVA_PENDENTE,
  STATUS_DEVOLUCAO_CONHECIDOS,
  STATUS_DEVOLUCAO_SHOPEE,
  STATUS_DEVOLUCAO_TERMINAIS,
  mapearDevolucaoShopee,
  type DevolucaoShopeeArmazenada,
} from './devolucaoMapping';
import {
  FRASE_RECUSA_DEVOLUCAO,
  MOTIVO_RECUSA_DEVOLUCAO,
  type MotivoRecusaDevolucao,
} from './recusaDevolucao';

/* -------------------------------------------------------------------------- */
/*                               the vocabularies                              */
/* -------------------------------------------------------------------------- */

/**
 * The seller actions the ERP runs on a Shopee return — the `reclamacao/acao`
 * route's `acao`, and the members of `acoesDisponiveis`. ⚠️ PERSISTED on the
 * wire: the web (`apps/web/lib/shopee/wire.ts`) sends these slugs back.
 *
 * Deliberately absent (R-5): `dispute`, `cancel_dispute`, `upload_proof` — they
 * send the operator's email to Shopee and need an evidence-image path. The panel
 * names them as {@link PENDENCIA_FORA_DO_ERP} instead.
 */
export const acaoDevolucaoShopeeSchema = z.enum(['confirmar', 'ofertar', 'aceitar-oferta']);
export type AcaoDevolucaoShopee = z.infer<typeof acaoDevolucaoShopeeSchema>;
export const ACAO_DEVOLUCAO_SHOPEE = {
  /** `v2.returns.confirm` — agree to the buyer's request: full refund, the buyer KEEPS the product. */
  confirmar: 'confirmar',
  /** `v2.returns.offer` — propose a solution (and an adjusted amount) to the buyer. */
  ofertar: 'ofertar',
  /** `v2.returns.accept_offer` — accept the BUYER's latest proposal. */
  aceitarOferta: 'aceitar-oferta',
} as const satisfies Record<string, AcaoDevolucaoShopee>;

/** The fixed order every list of actions here follows. */
const ORDEM_DAS_ACOES: readonly AcaoDevolucaoShopee[] = [
  ACAO_DEVOLUCAO_SHOPEE.confirmar,
  ACAO_DEVOLUCAO_SHOPEE.ofertar,
  ACAO_DEVOLUCAO_SHOPEE.aceitarOferta,
];

/**
 * What the seller must do on the Seller Centre because the ERP does not do it
 * (v1) — the panel only LABELS these codes.
 */
export const PENDENCIA_FORA_DO_ERP = {
  /** Dispute the return (`v2.returns.dispute`, deferred — R-5). */
  contestar: 'contestar',
  /** Upload the evidence Shopee asked for (`upload_proof`, deferred). */
  enviarEvidencias: 'enviar-evidencias',
  /** Collect the goods back yourself (`is_seller_arrange`, TW/BR) — told, not modelled (register 242). */
  organizarColeta: 'organizar-coleta',
} as const;
export type PendenciaForaDoErp = (typeof PENDENCIA_FORA_DO_ERP)[keyof typeof PENDENCIA_FORA_DO_ERP];

/** Which seller/buyer deadline a {@link PrazoDevolucaoShopee} is. */
export const TIPO_PRAZO_DEVOLUCAO = {
  /** `return_seller_due_date` — past it, "the refund will be issued to the buyer" (faq 477). */
  respostaVendedor: 'resposta-vendedor',
  /** `due_date` — "the last time seller deal with this return". */
  finalVendedor: 'final-vendedor',
  /** `return_ship_due_date` — the buyer's ship-back deadline. */
  envioComprador: 'envio-comprador',
  /** `seller_proof.seller_evidence_deadline`. */
  evidencias: 'evidencias',
  /** `seller_compensation.seller_compensation_due_date`. */
  compensacao: 'compensacao',
  /** `negotiation.offer_due_date`. */
  proposta: 'proposta',
} as const;
export type TipoPrazoDevolucao = (typeof TIPO_PRAZO_DEVOLUCAO)[keyof typeof TIPO_PRAZO_DEVOLUCAO];

/* -------------------------------------------------------------------------- */
/*                              the wire tokens read                           */
/* -------------------------------------------------------------------------- */

/**
 * Shopee holds the case — `error_ongoing_dispute` and "Shopee is reviewing the
 * case" are the pages' refusals of every action in these two.
 */
const STATUS_EM_DISPUTA: ReadonlySet<string> = new Set<string>([
  STATUS_DEVOLUCAO_SHOPEE.sellerDispute,
  STATUS_DEVOLUCAO_SHOPEE.judging,
]);

/**
 * `confirm` answers the buyer's REQUEST, so only while the request waits for
 * the seller. PROCESSING is included on the pages' word alone (register 237).
 */
const STATUS_QUE_ACEITAM_CONFIRMAR: ReadonlySet<string> = new Set<string>([
  STATUS_DEVOLUCAO_SHOPEE.requested,
  STATUS_DEVOLUCAO_SHOPEE.processing,
]);

/** The statuses in which the seller may still dispute on the Seller Centre (`v2.returns.dispute`). */
const STATUS_QUE_ACEITAM_CONTESTAR: ReadonlySet<string> = new Set<string>([
  STATUS_DEVOLUCAO_SHOPEE.requested,
  STATUS_DEVOLUCAO_SHOPEE.processing,
  STATUS_DEVOLUCAO_SHOPEE.accepted,
]);

/** `return_refund_request_type` 0 — Normal. 1 (in transit) and 2 (on the spot) refuse `confirm`. */
const TIPO_REQUISICAO_NORMAL = 0;
/** `validation_type` — "Action cannot be performed by shop because … = warehouse_validation". */
const VALIDACAO_PELO_ARMAZEM = 'warehouse_validation';
/** `return_refund_type` — `rraoc_refund_not_allowed` on `confirm`. */
const TIPO_REEMBOLSO_RRAOC = 'RRAOC';

type Bloco = Omit<DevolucaoShopeeArmazenada, 'revisao'>;

/** The importer's own reading of the detail — see the module header. */
function blocoDe(detalhe: ShopeeReturnDetail): Bloco {
  return mapearDevolucaoShopee(detalhe).bloco;
}

/* -------------------------------------------------------------------------- */
/*                                  the gate                                   */
/* -------------------------------------------------------------------------- */

/** One action's verdict. `motivo` is `null` exactly when `disponivel`. */
export interface AvaliacaoAcaoDevolucao {
  readonly acao: AcaoDevolucaoShopee;
  readonly disponivel: boolean;
  readonly motivo: MotivoRecusaDevolucao | null;
}

/**
 * The rows that refuse EVERY action, from the status alone, in this order:
 * terminal ⇒ `devolucao-encerrada`; not one of the seven documented values ⇒
 * `status-nao-permite` (fail CLOSED — a new status opens nothing); `SELLER_DISPUTE`
 * / `JUDGING` ⇒ `devolucao-em-disputa`. `null` ⇒ the status lets the per-action
 * rules decide.
 *
 * ⚠️ Exact, case-sensitive and untrimmed — the status is the importer's
 * VERBATIM token, so `' REQUESTED'` is unknown here exactly as it is open there.
 */
export function recusaGeralDaDevolucao(detalhe: ShopeeReturnDetail): MotivoRecusaDevolucao | null {
  const status = detalhe.status;
  if (STATUS_DEVOLUCAO_TERMINAIS.has(status)) return MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada;
  if (!STATUS_DEVOLUCAO_CONHECIDOS.has(status)) return MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite;
  if (STATUS_EM_DISPUTA.has(status)) return MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa;
  return null;
}

/**
 * `confirm`'s rows, in order. ⚠️ Listed ONLY when there is an amount to echo:
 * the operator confirms "R$ x", and the action route refuses a confirm whose
 * displayed amount differs from the live one — with no amount, there is nothing
 * the operator could have seen. The vocabulary has no "amount unknown" reason,
 * so that row reads `status-nao-permite` ("refresh and check"), the honest
 * remedy for a REQUESTED return Shopee sent without `refund_amount`.
 */
function recusaDeConfirmar(bloco: Bloco): MotivoRecusaDevolucao | null {
  if (!STATUS_QUE_ACEITAM_CONFIRMAR.has(bloco.status)) {
    return MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite;
  }
  // ⚠️ `!==` against 0, so an ABSENT request type refuses too (fail closed).
  if (bloco.tipoRequisicao !== TIPO_REQUISICAO_NORMAL) {
    return MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite;
  }
  if (bloco.tipoValidacao === VALIDACAO_PELO_ARMAZEM) {
    return MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem;
  }
  if (bloco.tipoReembolso === TIPO_REEMBOLSO_RRAOC) {
    return MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite;
  }
  if (bloco.valorReembolso === null) return MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite;
  return null;
}

/** One solution as `get_available_solutions` offers it (its `offer_*` object), or `null`. */
type OfertaDeSolucao = NonNullable<ShopeeReturnAvailableSolutions['offer_refund']>;

/**
 * The `offer_*` object of one solution. `null` when the solutions were not read,
 * were refused, or that object drifted (the package catches it to `null`).
 */
function ofertaDaSolucao(
  solucoes: ShopeeReturnAvailableSolutions | null,
  solucao: ShopeeReturnSolution | undefined,
): OfertaDeSolucao | null {
  if (solucoes === null || solucao === undefined) return null;
  if (solucao === SHOPEE_RETURN_SOLUTION.devolucaoEReembolso) {
    return solucoes.offer_return_refund ?? null;
  }
  if (solucao === SHOPEE_RETURN_SOLUTION.soReembolso) return solucoes.offer_refund ?? null;
  return null;
}

/** ⚠️ `=== true`: an absent or drifted `eligibility` is NOT eligible. */
function elegivel(oferta: OfertaDeSolucao | null): oferta is OfertaDeSolucao {
  return oferta !== null && oferta.eligibility === true;
}

/** Both solutions in the wire's order — `offer_return_refund`, then `offer_refund`. */
const SOLUCOES_EM_ORDEM: readonly ShopeeReturnSolution[] = [
  SHOPEE_RETURN_SOLUTION.devolucaoEReembolso,
  SHOPEE_RETURN_SOLUTION.soReembolso,
];

/**
 * THE availability of the three actions — the only copy (see the module
 * header). Always three verdicts, in the fixed order `confirmar`, `ofertar`,
 * `aceitar-oferta`.
 *
 * - every action: {@link recusaGeralDaDevolucao};
 * - `confirmar`: status `REQUESTED`/`PROCESSING`, request type `0` (Normal),
 *   not `warehouse_validation`, not `RRAOC`, and an amount to echo;
 * - `ofertar`: at least one solution with `eligibility === true`. `solucoes`
 *   `null` (not read, or refused) ⇒ none — `solucao-indisponivel`;
 * - `aceitar-oferta`: `negotiation_status === 'PENDING_RESPOND'` — the buyer
 *   proposed and it is the seller's turn (`sem-proposta-do-comprador` otherwise).
 */
export function avaliarAcoesDevolucao(
  detalhe: ShopeeReturnDetail,
  solucoes: ShopeeReturnAvailableSolutions | null,
): readonly AvaliacaoAcaoDevolucao[] {
  const geral = recusaGeralDaDevolucao(detalhe);
  const bloco = blocoDe(detalhe);

  const motivoDe = (acao: AcaoDevolucaoShopee): MotivoRecusaDevolucao | null => {
    if (geral !== null) return geral;
    switch (acao) {
      case ACAO_DEVOLUCAO_SHOPEE.confirmar:
        return recusaDeConfirmar(bloco);
      case ACAO_DEVOLUCAO_SHOPEE.ofertar:
        return SOLUCOES_EM_ORDEM.some((s) => elegivel(ofertaDaSolucao(solucoes, s)))
          ? null
          : MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel;
      case ACAO_DEVOLUCAO_SHOPEE.aceitarOferta:
        return bloco.statusNegociacao === NEGOCIACAO_AGUARDANDO_VENDEDOR
          ? null
          : MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador;
    }
  };

  return ORDEM_DAS_ACOES.map((acao) => {
    const motivo = motivoDe(acao);
    return { acao, disponivel: motivo === null, motivo };
  });
}

/** The open actions of a verdict list, in its order. */
export function acoesDisponiveisDe(
  avaliacoes: readonly AvaliacaoAcaoDevolucao[],
): AcaoDevolucaoShopee[] {
  return avaliacoes.filter((a) => a.disponivel).map((a) => a.acao);
}

/* -------------------------------------------------------------------------- */
/*                        the request half of the gate                         */
/* -------------------------------------------------------------------------- */

/**
 * What the operator asked for, and what they SAW when they asked (R-15) —
 * structurally `acoesDevolucao.ts`'s `PedidoDeAcaoDevolucao`.
 */
export interface AcaoPedidaDevolucao {
  readonly integracaoId: string;
  /** The pedido the panel was opened from — cross-checked against the LIVE `order_sn`. */
  readonly pedidoId: string;
  readonly acao: AcaoDevolucaoShopee;
  /** `ofertar` only. */
  readonly solucao?: ShopeeReturnSolution;
  /** `ofertar` only — integer CENTAVOS (R-14). Absent ⇒ no amount is proposed. */
  readonly valorReembolsoMinor?: number;
  /** `confirmar` and `aceitar-oferta` — the amount the panel showed, in centavos, or `null` (none shown). */
  readonly valorExibidoMinor?: number | null;
  /** `aceitar-oferta` — the buyer's solution the panel showed, or `null` (none shown). */
  readonly solucaoExibida?: ShopeeReturnSolution | null;
}

/**
 * The refusals that need NO `get_available_solutions`, in order: the pedido
 * cross-check (`pedido-divergente` when `makePedidoIdShopee(integracaoId,
 * order_sn)` is not the pedido the panel was opened from — a stale tab acting on
 * return X from pedido Y), then {@link recusaGeralDaDevolucao}. The action route
 * reads the solutions only when this is `null`.
 */
export function recusaPreviaDaAcao(
  detalhe: ShopeeReturnDetail,
  pedido: Pick<AcaoPedidaDevolucao, 'integracaoId' | 'pedidoId'>,
): MotivoRecusaDevolucao | null {
  if (makePedidoIdShopee(pedido.integracaoId, detalhe.order_sn) !== pedido.pedidoId) {
    return MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente;
  }
  return recusaGeralDaDevolucao(detalhe);
}

/** An amount in REAIS → integer centavos, or `null`. The one reais → centavos crossing of this module. */
function centavosOuNull(reais: number | null): number | null {
  return reais === null ? null : centavosDeReais(reais);
}

/** `ofertar`'s request rows, against the CHOSEN solution's offer. */
function recusaDaOferta(
  solucoes: ShopeeReturnAvailableSolutions | null,
  pedido: AcaoPedidaDevolucao,
): MotivoRecusaDevolucao | null {
  const oferta = ofertaDaSolucao(solucoes, pedido.solucao);
  if (!elegivel(oferta)) return MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel;

  const valor = pedido.valorReembolsoMinor;
  const ajustavel = oferta.refund_amount_adjustable === true;
  // "The proposed solution cannot have adjusted refund amount" / "Please fill a
  // value for proposed adjusted refund amount" — the page's own pair.
  if (valor !== undefined && !ajustavel) return MOTIVO_RECUSA_DEVOLUCAO.valorNaoAjustavel;
  if (valor === undefined) return ajustavel ? MOTIVO_RECUSA_DEVOLUCAO.valorObrigatorio : null;

  // ⚠️ Compared in CENTAVOS (R-14), and an out-of-range amount is REFUSED,
  // never clamped to the nearest bound: the money is the operator's choice. A
  // bound Shopee did not send is not checked — its own refusal stays the arbiter.
  const minimo = centavosOuNull(oferta.min_refund_amount);
  const maximo = centavosOuNull(oferta.max_refund_amount);
  if ((minimo !== null && valor < minimo) || (maximo !== null && valor > maximo)) {
    return MOTIVO_RECUSA_DEVOLUCAO.valorForaDaFaixa;
  }
  return null;
}

/**
 * Should THIS request be refused — and why? `null` ⇒ send it to Shopee.
 *
 * In order: {@link recusaPreviaDaAcao}; the action's
 * {@link avaliarAcoesDevolucao} verdict; then the request rows —
 *
 * - `confirmar`: the live `refund_amount` in centavos must EQUAL
 *   `valorExibidoMinor` (`valor-mudou`) — the operator confirms the amount
 *   they read, never one that moved since;
 * - `ofertar`: the chosen solution must be eligible (`solucao-indisponivel`); an
 *   amount only when adjustable (`valor-nao-ajustavel`) and always when
 *   adjustable (`valor-obrigatorio`); inside `[min, max]` in centavos
 *   (`valor-fora-da-faixa`, never clamped);
 * - `aceitar-oferta`: the live `latest_solution` (normalised) must equal
 *   `solucaoExibida` (`proposta-mudou`), then the live `latest_offer_amount` in
 *   centavos must equal `valorExibidoMinor` (`valor-mudou`) — a counter-offer
 *   landing between the panel's read and the click is never accepted unseen.
 *
 * ⚠️ An ABSENT echo (`undefined`) is a drift, never a pass: a request that does
 * not say what was shown cannot prove it saw the live value (rule 7, tier 3).
 * `null` is a real echo ("nothing was shown") and matches only a live `null`.
 */
export function recusaDaAcaoPedida(
  detalhe: ShopeeReturnDetail,
  solucoes: ShopeeReturnAvailableSolutions | null,
  pedido: AcaoPedidaDevolucao,
): MotivoRecusaDevolucao | null {
  const previa = recusaPreviaDaAcao(detalhe, pedido);
  if (previa !== null) return previa;

  const veredito = avaliarAcoesDevolucao(detalhe, solucoes).find((a) => a.acao === pedido.acao);
  // An `acao` outside the enum (a cast) has no verdict: refused, never sent.
  if (veredito === undefined) return MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido;
  if (!veredito.disponivel) return veredito.motivo;

  const bloco = blocoDe(detalhe);
  switch (pedido.acao) {
    case ACAO_DEVOLUCAO_SHOPEE.confirmar:
      return pedido.valorExibidoMinor === undefined ||
        centavosOuNull(bloco.valorReembolso) !== pedido.valorExibidoMinor
        ? MOTIVO_RECUSA_DEVOLUCAO.valorMudou
        : null;
    case ACAO_DEVOLUCAO_SHOPEE.ofertar:
      return recusaDaOferta(solucoes, pedido);
    case ACAO_DEVOLUCAO_SHOPEE.aceitarOferta:
      if (pedido.solucaoExibida === undefined || bloco.solucaoOfertada !== pedido.solucaoExibida) {
        return MOTIVO_RECUSA_DEVOLUCAO.propostaMudou;
      }
      return pedido.valorExibidoMinor === undefined ||
        centavosOuNull(bloco.valorOfertado) !== pedido.valorExibidoMinor
        ? MOTIVO_RECUSA_DEVOLUCAO.valorMudou
        : null;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  the estado                                 */
/* -------------------------------------------------------------------------- */

/** One seller- or buyer-facing deadline. Only present ones are listed. */
export interface PrazoDevolucaoShopee {
  readonly tipo: TipoPrazoDevolucao;
  /** MILLISECONDS since epoch — Shopee's seconds × 1000. */
  readonly prazoMs: number;
  /** Shopee refunds the buyer on its own when this deadline lapses (faq 477). */
  readonly reembolsoAutomatico: boolean;
}

/** One solution the seller may OFFER (eligible ones only). Bounds in REAIS, as Shopee sent them. */
export interface SolucaoOfertavelDevolucao {
  readonly solucao: ShopeeReturnSolution;
  readonly ajustavel: boolean;
  readonly minimo: number | null;
  readonly maximo: number | null;
}

/**
 * The live state of one Shopee return — the `GET …/reclamacao/estado` answer.
 *
 * ⚠️ Field names are IDENTICAL to the browser's `shopeeReclamacaoEstadoSchema`
 * (`apps/web/lib/shopee/wire.ts`), its known twin across the app boundary: a
 * rename here is a rename there. A SNAPSHOT, never a cache — the panel refetches.
 */
export interface EstadoDevolucaoShopee {
  readonly returnSn: string;
  readonly orderSn: string;
  /** `makePedidoIdShopee(integracaoId, order_sn)` — echoed back on every action. */
  readonly pedidoId: string;
  /** The raw `ReturnStatus` token. */
  readonly status: string;
  readonly terminal: boolean;
  readonly solucao: ShopeeReturnSolution | null;
  /** Raw Shopee reason tokens; the reassessed one's `'NONE'` is `null`. */
  readonly motivo: string | null;
  readonly motivoReavaliado: string | null;
  /** REAIS. */
  readonly valorReembolso: number | null;
  readonly valorAntesDesconto: number | null;
  readonly moeda: string | null;
  /** 0 Normal / 1 In-transit / 2 Return-on-the-Spot. */
  readonly tipoRequisicao: number | null;
  readonly tipoValidacao: string | null;
  readonly negociacao: {
    readonly status: string | null;
    readonly solucaoOfertada: ShopeeReturnSolution | null;
    readonly valorOfertado: number | null;
    readonly contrapropostasRestantes: number | null;
  } | null;
  readonly prova: { readonly status: string | null } | null;
  readonly compensacao: { readonly status: string | null; readonly valor: number | null } | null;
  readonly prazos: readonly PrazoDevolucaoShopee[];
  /** Eligible solutions only; `[]` when none, not read, or refused. */
  readonly solucoes: readonly SolucaoOfertavelDevolucao[];
  readonly acoesDisponiveis: readonly AcaoDevolucaoShopee[];
  /** A pt-BR sentence when `acoesDisponiveis` is empty and ONE reason closes every action; else `null`. */
  readonly motivoSemAcao: string | null;
  readonly pendenciasForaDoErp: readonly PendenciaForaDoErp[];
}

/**
 * A wire SECONDS deadline → milliseconds, or `null` when absent, zero-filled or
 * before 2020 — the importer's own floor (`segundosShopeeUtilizaveis`), so the
 * panel and the stored block agree on which deadlines exist.
 */
function msDoPrazo(segundos: number | null | undefined): number | null {
  const s = segundosShopeeUtilizaveis(segundos);
  return s === null ? null : s * 1000;
}

/**
 * The six deadlines, in a FIXED order (the panel's label order), present ones
 * only. ⚠️ `reembolsoAutomatico` on the two seller deadlines whose lapse refunds
 * the buyer (`return_seller_due_date`, `due_date`) and on the buyer's ship-back
 * deadline ONLY under seller self-collection (`is_seller_arrange === true`):
 * there it is "the deadline for the seller to retrieve the goods", and missing
 * it approves the return (faq 477) — otherwise a lapse CANCELS the buyer's
 * request, the opposite consequence.
 */
function prazosDaDevolucao(detalhe: ShopeeReturnDetail): PrazoDevolucaoShopee[] {
  const coletaPeloVendedor = detalhe.is_seller_arrange === true;
  const candidatos: readonly [TipoPrazoDevolucao, number | null, boolean][] = [
    [TIPO_PRAZO_DEVOLUCAO.respostaVendedor, msDoPrazo(detalhe.return_seller_due_date), true],
    [TIPO_PRAZO_DEVOLUCAO.finalVendedor, msDoPrazo(detalhe.due_date), true],
    [
      TIPO_PRAZO_DEVOLUCAO.envioComprador,
      msDoPrazo(detalhe.return_ship_due_date),
      coletaPeloVendedor,
    ],
    [
      TIPO_PRAZO_DEVOLUCAO.evidencias,
      msDoPrazo(detalhe.seller_proof?.seller_evidence_deadline),
      false,
    ],
    [
      TIPO_PRAZO_DEVOLUCAO.compensacao,
      msDoPrazo(detalhe.seller_compensation?.seller_compensation_due_date),
      false,
    ],
    [TIPO_PRAZO_DEVOLUCAO.proposta, msDoPrazo(detalhe.negotiation?.offer_due_date), false],
  ];
  const prazos: PrazoDevolucaoShopee[] = [];
  for (const [tipo, prazoMs, reembolsoAutomatico] of candidatos) {
    if (prazoMs !== null) prazos.push({ tipo, prazoMs, reembolsoAutomatico });
  }
  return prazos;
}

/** The eligible solutions, in the wire's order. */
function solucoesOfertaveis(
  solucoes: ShopeeReturnAvailableSolutions | null,
): SolucaoOfertavelDevolucao[] {
  const ofertaveis: SolucaoOfertavelDevolucao[] = [];
  for (const solucao of SOLUCOES_EM_ORDEM) {
    const oferta = ofertaDaSolucao(solucoes, solucao);
    if (!elegivel(oferta)) continue;
    ofertaveis.push({
      solucao,
      ajustavel: oferta.refund_amount_adjustable === true,
      minimo: oferta.min_refund_amount,
      maximo: oferta.max_refund_amount,
    });
  }
  return ofertaveis;
}

/** What the seller must do on the Seller Centre, in a fixed order. */
function pendenciasForaDoErp(detalhe: ShopeeReturnDetail, bloco: Bloco): PendenciaForaDoErp[] {
  const pendencias: PendenciaForaDoErp[] = [];
  if (STATUS_QUE_ACEITAM_CONTESTAR.has(bloco.status)) {
    pendencias.push(PENDENCIA_FORA_DO_ERP.contestar);
  }
  if (bloco.statusProva === PROVA_PENDENTE) pendencias.push(PENDENCIA_FORA_DO_ERP.enviarEvidencias);
  if (detalhe.is_seller_arrange === true && !STATUS_DEVOLUCAO_TERMINAIS.has(bloco.status)) {
    pendencias.push(PENDENCIA_FORA_DO_ERP.organizarColeta);
  }
  return pendencias;
}

/**
 * The sentence for an empty action list — `FRASE_RECUSA_DEVOLUCAO` of the ONE
 * reason that closes all three (terminal, in dispute, an unknown status), never
 * a sentence of its own. Mixed reasons ⇒ `null`: no single sentence is true of
 * all three, and the panel's generic line is ("A Shopee não oferece nenhuma
 * ação…").
 */
function motivoSemAcaoDe(avaliacoes: readonly AvaliacaoAcaoDevolucao[]): string | null {
  if (avaliacoes.some((a) => a.disponivel)) return null;
  const motivos = new Set(avaliacoes.map((a) => a.motivo));
  if (motivos.size !== 1) return null;
  const [unico] = motivos;
  return unico === undefined || unico === null ? null : FRASE_RECUSA_DEVOLUCAO[unico];
}

/**
 * The live detail (+ the solutions, when read) → {@link EstadoDevolucaoShopee}.
 * Total: every parsed detail projects.
 */
export function projetarEstadoDevolucao(p: {
  integracaoId: string;
  detalhe: ShopeeReturnDetail;
  solucoes: ShopeeReturnAvailableSolutions | null;
}): EstadoDevolucaoShopee {
  const { detalhe, solucoes } = p;
  const bloco = blocoDe(detalhe);
  const avaliacoes = avaliarAcoesDevolucao(detalhe, solucoes);
  return {
    returnSn: bloco.returnSn,
    orderSn: bloco.orderSn,
    pedidoId: makePedidoIdShopee(p.integracaoId, bloco.orderSn),
    status: bloco.status,
    terminal: STATUS_DEVOLUCAO_TERMINAIS.has(bloco.status),
    solucao: bloco.solucao,
    motivo: bloco.motivo,
    motivoReavaliado: bloco.motivoReavaliado,
    valorReembolso: bloco.valorReembolso,
    valorAntesDesconto: bloco.valorAntesDesconto,
    moeda: bloco.moeda,
    tipoRequisicao: bloco.tipoRequisicao,
    tipoValidacao: bloco.tipoValidacao,
    negociacao:
      detalhe.negotiation === null
        ? null
        : {
            status: bloco.statusNegociacao,
            solucaoOfertada: bloco.solucaoOfertada,
            valorOfertado: bloco.valorOfertado,
            contrapropostasRestantes: bloco.contrapropostasRestantes,
          },
    prova: detalhe.seller_proof === null ? null : { status: bloco.statusProva },
    compensacao:
      detalhe.seller_compensation === null
        ? null
        : { status: bloco.statusCompensacao, valor: bloco.valorCompensacao },
    prazos: prazosDaDevolucao(detalhe),
    solucoes: solucoesOfertaveis(solucoes),
    acoesDisponiveis: acoesDisponiveisDe(avaliacoes),
    motivoSemAcao: motivoSemAcaoDe(avaliacoes),
    pendenciasForaDoErp: pendenciasForaDoErp(detalhe, bloco),
  };
}
