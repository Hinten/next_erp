/**
 * One Shopee return → the incidente the importer writes, and every rule that
 * reads one back (#1525, step 17).
 *
 * PURE and TOTAL: no clock, no Firestore, no wire call, no `console`, and every
 * input maps (the two RangeErrors below guard a CONTRACT, not the wire). This
 * is the ONE home of each rule below — the transaction (`devolucaoTx.ts`), the
 * aviso (`avisoDevolucao.ts`), the poller (`devolucoesSweep.ts`) and the dry-run
 * CLI all import it, and none of them re-states a set, a fold or a field list
 * (#1369: two copies drift toward plausible).
 *
 * ## The incidente, field by field
 *
 * | field | value | owner |
 * |---|---|---|
 * | `origem` | `ORIGEM_INCIDENTE.pedidoShopee` (5) — never 2, which the web reads as an ML claim | importer, RE-ASSERTED |
 * | `tipo` | `TIPO_INCIDENTE.devolucao` (`'returns'`) FOR LIFE — a return blocks `finalizar` only (R-1) | importer, re-asserted |
 * | `externalId` | the `return_sn` | importer |
 * | `claimStatus` | `'closed'` iff the status is in {@link STATUS_DEVOLUCAO_TERMINAIS}, else `'opened'` | importer |
 * | `claimStage`, `entregue` | `null` — `STAGE_CLAIM_LABELS.dispute` reads "Mediação do Mercado Livre"; the raw status lives in the block | importer |
 * | `timestamp` | {@link DevolucaoMapeada.timestampUs} | CREATE only |
 * | `motivoDoIncidente` | {@link DevolucaoMapeada.motivoInicial} | CREATE only, then the operator's |
 * | `relogioProvedorUs` | THE watermark — `update_time` through `microsDeSegundosShopee` | importer |
 * | `devolucaoShopee` | the block, {@link DevolucaoShopeeArmazenada} | importer |
 *
 * ## Units
 *
 * Every µs value here comes out of `microsDeSegundosShopee` — the ONE seconds →
 * µs crossing of this channel (R-10), and NO converter is named in this file.
 * ⚠️ Never the magnitude-classifying stored-value coercion on a wire value (its
 * trap is spelled out on `microsDeSegundosShopee`): it reads Shopee SECONDS as
 * MILLISECONDS — 1970 — and `devolucaoMapping.test.ts` pins that near-miss.
 * Every deadline goes through the 2020 floor first (`segundosShopeeUtilizaveis`):
 * Shopee zero-fills an absent timestamp, and a `0` stored as a prazo is a
 * deadline fifty years in the past that an aviso would then call overdue.
 *
 * ## What is never stored
 *
 * The package's returns schemas STRIP (R-11), so `user`, the pickup address,
 * `image[]`, `buyer_videos[]`, `text_reason`, `dispute_text_reason`, the reverse
 * `tracking_number` and `negotiation.latest_offer_creator` never reach this
 * module. The block below names only TOKENS, amounts, ids and clocks — and its
 * schema strips too, so a stored block re-parsed here can never carry a key
 * this file does not name.
 */
import { z } from 'zod';
import {
  ORIGEM_INCIDENTE,
  PENDENCIA_RECLAMACAO,
  STATUS_CLAIM,
  TIPO_INCIDENTE,
  type PendenciaReclamacao,
  type StatusClaim,
} from '@delfrance/schemas';
import {
  normalizarSolucaoDeDevolucao,
  shopeeReturnSolutionSchema,
  type ShopeeReturnDetail,
  type ShopeeReturnListRow,
  type ShopeeReturnSolution,
} from '@delfrance/integrations-shopee';

import {
  microsDeSegundosShopee,
  segundosShopeeUtilizaveis,
  textoShopeeUtilizavel,
} from '../pedidos/orderMapping';

/* -------------------------------------------------------------------------- */
/*                              the status vocabulary                          */
/* -------------------------------------------------------------------------- */

/**
 * Shopee's `ReturnStatus` — the seven documented values (`guide 31` =
 * `guide 227`). ⚠️ The field stays a FREE string everywhere: an eighth token
 * must parse, and the SETS below decide what each one means.
 */
export const STATUS_DEVOLUCAO_SHOPEE = {
  requested: 'REQUESTED',
  accepted: 'ACCEPTED',
  cancelled: 'CANCELLED',
  judging: 'JUDGING',
  closed: 'CLOSED',
  processing: 'PROCESSING',
  sellerDispute: 'SELLER_DISPUTE',
} as const;

/**
 * The statuses after which a return no longer blocks — `CLOSED` and
 * `CANCELLED`, the only two any Shopee text treats as an end
 * (`announcement 1556`).
 *
 * ⚠️ **Fail CLOSED: everything else is OPEN**, `ACCEPTED` included (dispute,
 * compensation and evidence all happen in it) and ANY unknown token — a new
 * status keeps blocking `finalizar` rather than silently releasing it (R-3).
 * The set is this ONE constant, and the poller re-imports a stored row whose
 * `claimStatus` disagrees with {@link statusClaimDaDevolucao}
 * (`motivoDeReimportacao`'s `invariante`) — ⚠️ but ONLY a row for a return
 * `get_return_list` still lists, i.e. one Shopee updated inside the poller's
 * trailing 15-day window. So correcting the set heals those rows within one
 * poll and NOT the older ones: a return that stopped moving before the window
 * keeps its stale `claimStatus`, and its block. The remedies are a one-shot
 * `runShopeeDevolucoesSweep` run over the earlier windows (its `deps.nowMs`
 * places the window), which re-imports them, or the superuser
 * `liberarBloqueioIncidente`, which releases a block by hand — either one a
 * human ASKS for (rule 8), never a side effect of the correction. Settle-live
 * register 232.
 *
 * ⚠️ Exact, case-sensitive membership — `'Closed'` and `' CLOSED'` are OPEN.
 */
export const STATUS_DEVOLUCAO_TERMINAIS: ReadonlySet<string> = new Set<string>([
  STATUS_DEVOLUCAO_SHOPEE.closed,
  STATUS_DEVOLUCAO_SHOPEE.cancelled,
]);

/**
 * The seven documented `ReturnStatus` tokens as a set — the ONE copy the
 * importer's `statusDesconhecido` log flag, the actions gate (an unknown status
 * opens no action) and the `importar:devolucao` CLI read. Derived from
 * {@link STATUS_DEVOLUCAO_SHOPEE}, so a member added there is known everywhere.
 *
 * ⚠️ Knowing a status is NOT closing it: membership here says nothing about
 * {@link STATUS_DEVOLUCAO_TERMINAIS}, and an unknown token is still OPEN.
 * Exact, case-sensitive membership, like the terminal set.
 */
export const STATUS_DEVOLUCAO_CONHECIDOS: ReadonlySet<string> = new Set<string>(
  Object.values(STATUS_DEVOLUCAO_SHOPEE),
);

/** `'closed'` iff the status is terminal, else `'opened'` — never anything else. */
export function statusClaimDaDevolucao(status: string): StatusClaim {
  return STATUS_DEVOLUCAO_TERMINAIS.has(status) ? STATUS_CLAIM.fechada : STATUS_CLAIM.aberta;
}

/* -------------------------------------------------------------------------- */
/*                                the stored block                             */
/* -------------------------------------------------------------------------- */

/**
 * `incidente.devolucaoShopee` — the return as the importer last saw it. A
 * PASSTHROUGH map on the incidente (`incidenteSchema` is `.passthrough()`), so
 * no ruleset and no collection schema names it.
 *
 * ⚠️ Every token is RAW (Shopee's own spelling): a table correction must
 * retro-apply with no wire event (#1369), which it cannot do if only a
 * projection survives.
 */
export interface DevolucaoShopeeArmazenada {
  /** ≥ 1; +1 per CONTENT change, assigned inside the transaction. Never moves on a watermark-only advance. */
  revisao: number;
  returnSn: string;
  orderSn: string;
  /** The raw `ReturnStatus` token, verbatim. */
  status: string;
  /** `return_solution` (0/1 on the read pages) through `normalizarSolucaoDeDevolucao`. */
  solucao: ShopeeReturnSolution | null;
  /** The raw `reason` token. ⚠️ `'NONE'` is a REAL value of that list and is kept. */
  motivo: string | null;
  /** The raw `reassessed_request_reason`; its literal `'NONE'` ("not reassessed") is stored as `null`. */
  motivoReavaliado: string | null;
  /** `return_refund_request_type` — 0 Normal / 1 In-transit / 2 Return-on-the-Spot. ⚠️ `0` is a value. */
  tipoRequisicao: number | null;
  tipoValidacao: string | null;
  tipoReembolso: string | null;
  statusLogistica: string | null;
  statusLogisticaReversa: string | null;
  statusNegociacao: string | null;
  statusProva: string | null;
  statusCompensacao: string | null;
  /** `negotiation.latest_solution` through `normalizarSolucaoDeDevolucao`. */
  solucaoOfertada: ShopeeReturnSolution | null;
  /** REAIS (the return's `currency`), as Shopee sent them — never rounded here. */
  valorOfertado: number | null;
  /** `negotiation.counter_limit`. ⚠️ `0` is a value ("no counter-offer left"). */
  contrapropostasRestantes: number | null;
  valorReembolso: number | null;
  valorAntesDesconto: number | null;
  valorCompensacao: number | null;
  moeda: string | null;
  /** `is_seller_arrange` — "would only be True for TW and BR". */
  vendedorProvidenciaColeta: boolean | null;
  /** The six seller/buyer deadlines, µs; an absent or zero-filled one is `null`, never `0`. */
  prazos: {
    /** `due_date` — "the last time seller deal with this return". */
    vendedorUs: number | null;
    /** `return_ship_due_date` — the buyer's ship-back deadline. */
    envioCompradorUs: number | null;
    /** `return_seller_due_date` — past it, "the refund will be issued to the buyer" (faq 477). */
    respostaVendedorUs: number | null;
    /** `seller_proof.seller_evidence_deadline`. */
    provaUs: number | null;
    /** `seller_compensation.seller_compensation_due_date`. */
    compensacaoUs: number | null;
    /** `negotiation.offer_due_date`. */
    ofertaUs: number | null;
  };
  /** `create_time`, µs, or `null`. */
  criadaEmUs: number | null;
}

const textoArmazenado = () => z.string().nullable().default(null);
const numeroArmazenado = () => z.number().nullable().default(null);
/** A µs stamp: an integer (`microsDeSegundosShopee` makes nothing else). */
const usArmazenado = () => z.number().int().nullable().default(null);
const solucaoArmazenada = () => shopeeReturnSolutionSchema.nullable().default(null);

function prazosVazios(): DevolucaoShopeeArmazenada['prazos'] {
  return {
    vendedorUs: null,
    envioCompradorUs: null,
    respostaVendedorUs: null,
    provaUs: null,
    compensacaoUs: null,
    ofertaUs: null,
  };
}

const devolucaoShopeeArmazenadaObjeto = z.object({
  revisao: z.number().int().min(1),
  returnSn: z.string().min(1),
  orderSn: z.string().min(1),
  status: z.string().min(1),
  solucao: solucaoArmazenada(),
  motivo: textoArmazenado(),
  motivoReavaliado: textoArmazenado(),
  tipoRequisicao: z.number().int().nullable().default(null),
  tipoValidacao: textoArmazenado(),
  tipoReembolso: textoArmazenado(),
  statusLogistica: textoArmazenado(),
  statusLogisticaReversa: textoArmazenado(),
  statusNegociacao: textoArmazenado(),
  statusProva: textoArmazenado(),
  statusCompensacao: textoArmazenado(),
  solucaoOfertada: solucaoArmazenada(),
  valorOfertado: numeroArmazenado(),
  contrapropostasRestantes: z.number().int().nullable().default(null),
  valorReembolso: numeroArmazenado(),
  valorAntesDesconto: numeroArmazenado(),
  valorCompensacao: numeroArmazenado(),
  moeda: textoArmazenado(),
  vendedorProvidenciaColeta: z.boolean().nullable().default(null),
  prazos: z
    .object({
      vendedorUs: usArmazenado(),
      envioCompradorUs: usArmazenado(),
      respostaVendedorUs: usArmazenado(),
      provaUs: usArmazenado(),
      compensacaoUs: usArmazenado(),
      ofertaUs: usArmazenado(),
    })
    .default(prazosVazios),
  criadaEmUs: usArmazenado(),
});

/**
 * The stored block's reader — what the transaction re-parses BOTH sides with
 * before comparing them, so `null` ≡ an absent key (R-9).
 *
 * PERMISSIVE where it can be: every token is a free string and every optional
 * field `.nullable().default(null)` (`prazos` defaults to all-null). ⚠️ STRICT
 * where it must be: `revisao`, `returnSn`, `orderSn` and `status` are required
 * and a wrong TYPE anywhere fails the parse — use `safeParse`. A block that
 * fails is not "probably fine": the caller treats it as UNREADABLE (the
 * transaction rewrites it, the poller re-imports it), which is what heals it.
 * It STRIPS: a key this file does not name never survives a re-parse.
 */
export const devolucaoShopeeArmazenadaSchema: z.ZodType<DevolucaoShopeeArmazenada> =
  devolucaoShopeeArmazenadaObjeto;

/* -------------------------------------------------------------------------- */
/*                             the wire → block readers                        */
/* -------------------------------------------------------------------------- */

/** `reassessed_request_reason`'s "not reassessed" literal. */
const MOTIVO_REAVALIADO_NENHUM = 'NONE';

/** `incidenteSchema.motivoDoIncidente`'s bound. */
const MAX_MOTIVO_DO_INCIDENTE = 2000;

/**
 * A Shopee SECONDS deadline → µs, or `null` when absent / zero-filled / before
 * 2020. The ONE reader every prazo of this module goes through — the detail's
 * AND the list row's, so the poller compares like with like.
 */
function usDoFio(segundos: number | null | undefined): number | null {
  const s = segundosShopeeUtilizaveis(segundos);
  return s === null ? null : microsDeSegundosShopee(s);
}

/**
 * A Shopee string token: `''`, blank and the `-` sentinel are absences
 * (`textoShopeeUtilizavel`, the channel's one reader). Shared by the detail AND
 * the list row for the {@link usDoFio} reason.
 */
function tokenDoFio(v: string | null | undefined): string | null {
  return textoShopeeUtilizavel(v);
}

/** An amount, verbatim (REAIS), or `null`. ⚠️ `0` is kept: a zero refund is a statement, not an absence. */
function valorDoFio(v: number | null | undefined): number | null {
  return v ?? null;
}

/** The block, minus `revisao` (the transaction assigns it). */
function blocoDaDevolucao(d: ShopeeReturnDetail): Omit<DevolucaoShopeeArmazenada, 'revisao'> {
  const reavaliado = tokenDoFio(d.reassessed_request_reason);
  return {
    returnSn: d.return_sn,
    orderSn: d.order_sn,
    // VERBATIM, never trimmed: `statusClaimDaDevolucao` must see exactly what
    // Shopee sent, and a padded token reads OPEN (fail closed).
    status: d.status,
    solucao: normalizarSolucaoDeDevolucao(d.return_solution),
    motivo: tokenDoFio(d.reason),
    motivoReavaliado: reavaliado === MOTIVO_REAVALIADO_NENHUM ? null : reavaliado,
    tipoRequisicao: d.return_refund_request_type ?? null,
    tipoValidacao: tokenDoFio(d.validation_type),
    tipoReembolso: tokenDoFio(d.return_refund_type),
    statusLogistica: tokenDoFio(d.logistics_status),
    statusLogisticaReversa: tokenDoFio(d.reverse_logistics_status),
    statusNegociacao: tokenDoFio(d.negotiation?.negotiation_status),
    statusProva: tokenDoFio(d.seller_proof?.seller_proof_status),
    statusCompensacao: tokenDoFio(d.seller_compensation?.seller_compensation_status),
    solucaoOfertada: normalizarSolucaoDeDevolucao(d.negotiation?.latest_solution),
    valorOfertado: valorDoFio(d.negotiation?.latest_offer_amount),
    contrapropostasRestantes: d.negotiation?.counter_limit ?? null,
    valorReembolso: valorDoFio(d.refund_amount),
    valorAntesDesconto: valorDoFio(d.amount_before_discount),
    valorCompensacao: valorDoFio(d.seller_compensation?.compensation_amount),
    moeda: tokenDoFio(d.currency),
    vendedorProvidenciaColeta: d.is_seller_arrange ?? null,
    prazos: {
      vendedorUs: usDoFio(d.due_date),
      envioCompradorUs: usDoFio(d.return_ship_due_date),
      respostaVendedorUs: usDoFio(d.return_seller_due_date),
      provaUs: usDoFio(d.seller_proof?.seller_evidence_deadline),
      compensacaoUs: usDoFio(d.seller_compensation?.seller_compensation_due_date),
      ofertaUs: usDoFio(d.negotiation?.offer_due_date),
    },
    criadaEmUs: usDoFio(d.create_time),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  the mapping                                */
/* -------------------------------------------------------------------------- */

/** One `get_return_detail` → everything the transaction may write. */
export interface DevolucaoMapeada {
  readonly origem: typeof ORIGEM_INCIDENTE.pedidoShopee;
  readonly tipo: typeof TIPO_INCIDENTE.devolucao;
  readonly externalId: string;
  readonly claimStatus: StatusClaim;
  readonly claimStage: null;
  readonly entregue: null;
  /**
   * The incidente's `timestamp` — `criadaEmUs`, else the watermark. CREATE-only:
   * it feeds `devolucaoAbertaEm` (the OLDEST open block), so it is the return's
   * own opening, never a wall clock and never re-stamped on an update.
   */
  readonly timestampUs: number;
  /** `'Devolução Shopee'` + ` — <reason>` when there is one, ≤ 2000. CREATE-only: then it is the operator's. */
  readonly motivoInicial: string;
  /**
   * THE watermark: `microsDeSegundosShopee(update_time)`. ⚠️ Never
   * `ultimaModificacao`, which the web editor stamps with wall-clock µs on every
   * save — a guard on it would compare Shopee's clock with an operator's.
   */
  readonly relogioProvedorUs: number;
  readonly bloco: Omit<DevolucaoShopeeArmazenada, 'revisao'>;
}

function motivoInicialDaDevolucao(motivo: string | null): string {
  const texto = motivo === null ? 'Devolução Shopee' : `Devolução Shopee — ${motivo}`;
  return texto.slice(0, MAX_MOTIVO_DO_INCIDENTE);
}

/**
 * `get_return_detail.response` → {@link DevolucaoMapeada}. Total: every parsed
 * detail maps (the package already refused a detail without its four required
 * fields — `return_sn`, `order_sn`, `status`, `update_time`).
 */
export function mapearDevolucaoShopee(detalhe: ShopeeReturnDetail): DevolucaoMapeada {
  const bloco = blocoDaDevolucao(detalhe);
  const relogioProvedorUs = microsDeSegundosShopee(detalhe.update_time);
  return {
    origem: ORIGEM_INCIDENTE.pedidoShopee,
    // FOR LIFE — never `mediations` on SELLER_DISPUTE/JUDGING (R-1): the disputa
    // class needs a mid-life tipo flip, and a Shopee return is post-delivery.
    tipo: TIPO_INCIDENTE.devolucao,
    externalId: detalhe.return_sn,
    claimStatus: statusClaimDaDevolucao(detalhe.status),
    claimStage: null,
    entregue: null,
    timestampUs: bloco.criadaEmUs ?? relogioProvedorUs,
    motivoInicial: motivoInicialDaDevolucao(bloco.motivo),
    relogioProvedorUs,
    bloco,
  };
}

/* -------------------------------------------------------------------------- */
/*                               content equality                              */
/* -------------------------------------------------------------------------- */

/** What "the content changed" is decided over — the importer-owned keys minus the clocks. */
export type ConteudoDevolucao = Pick<
  DevolucaoMapeada,
  'origem' | 'tipo' | 'externalId' | 'claimStatus' | 'claimStage' | 'entregue'
> & { bloco: Omit<DevolucaoShopeeArmazenada, 'revisao'> };

/** `undefined` ≡ `null` (an absent key is the same stored fact), and NOTHING else is folded. */
function igual(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Did the CONTENT change?
 *
 * ⚠️ **Written out field by field, and strictly — NO generic deep-equal**, the
 * `freteTx.ts` precedent (#1372): a fold decides which edits count as "no
 * change", and an over-fold is an edit that is silently never written. Here
 * that means: a 1 µs deadline move, `'ACCEPTED'` vs `'Accepted'` and
 * `10.5` vs `10.51` are all DIFFERENT; only `null` vs an absent key is the
 * same. `devolucaoMapping.test.ts` changes every field of the stored schema one
 * at a time, so a field added there and forgotten here reds CI.
 *
 * ⚠️ `origem` and `tipo` ARE content: an operator who retypes an imported row
 * makes the stored content differ, so the next fresher-or-equal delivery
 * re-asserts them (R-16). `revisao` is NOT: it is derived from this answer.
 */
export function mesmoConteudoDevolucao(a: ConteudoDevolucao, b: ConteudoDevolucao): boolean {
  return (
    igual(a.origem, b.origem) &&
    igual(a.tipo, b.tipo) &&
    igual(a.externalId, b.externalId) &&
    igual(a.claimStatus, b.claimStatus) &&
    igual(a.claimStage, b.claimStage) &&
    igual(a.entregue, b.entregue) &&
    mesmoBloco(a.bloco, b.bloco)
  );
}

function mesmoBloco(
  a: Omit<DevolucaoShopeeArmazenada, 'revisao'>,
  b: Omit<DevolucaoShopeeArmazenada, 'revisao'>,
): boolean {
  return (
    igual(a.returnSn, b.returnSn) &&
    igual(a.orderSn, b.orderSn) &&
    igual(a.status, b.status) &&
    igual(a.solucao, b.solucao) &&
    igual(a.motivo, b.motivo) &&
    igual(a.motivoReavaliado, b.motivoReavaliado) &&
    igual(a.tipoRequisicao, b.tipoRequisicao) &&
    igual(a.tipoValidacao, b.tipoValidacao) &&
    igual(a.tipoReembolso, b.tipoReembolso) &&
    igual(a.statusLogistica, b.statusLogistica) &&
    igual(a.statusLogisticaReversa, b.statusLogisticaReversa) &&
    igual(a.statusNegociacao, b.statusNegociacao) &&
    igual(a.statusProva, b.statusProva) &&
    igual(a.statusCompensacao, b.statusCompensacao) &&
    igual(a.solucaoOfertada, b.solucaoOfertada) &&
    igual(a.valorOfertado, b.valorOfertado) &&
    igual(a.contrapropostasRestantes, b.contrapropostasRestantes) &&
    igual(a.valorReembolso, b.valorReembolso) &&
    igual(a.valorAntesDesconto, b.valorAntesDesconto) &&
    igual(a.valorCompensacao, b.valorCompensacao) &&
    igual(a.moeda, b.moeda) &&
    igual(a.vendedorProvidenciaColeta, b.vendedorProvidenciaColeta) &&
    mesmosPrazos(a.prazos, b.prazos) &&
    igual(a.criadaEmUs, b.criadaEmUs)
  );
}

/** ⚠️ A missing `prazos` object is the all-null one — the schema's own default. */
function mesmosPrazos(
  a: DevolucaoShopeeArmazenada['prazos'] | null | undefined,
  b: DevolucaoShopeeArmazenada['prazos'] | null | undefined,
): boolean {
  const x = a ?? prazosVazios();
  const y = b ?? prazosVazios();
  return (
    igual(x.vendedorUs, y.vendedorUs) &&
    igual(x.envioCompradorUs, y.envioCompradorUs) &&
    igual(x.respostaVendedorUs, y.respostaVendedorUs) &&
    igual(x.provaUs, y.provaUs) &&
    igual(x.compensacaoUs, y.compensacaoUs) &&
    igual(x.ofertaUs, y.ofertaUs)
  );
}

/* -------------------------------------------------------------------------- */
/*                         what the seller owes, and by when                   */
/* -------------------------------------------------------------------------- */

/** The return waits for the seller's answer to the REQUEST. */
const STATUS_AGUARDANDO_RESPOSTA_DO_VENDEDOR: ReadonlySet<string> = new Set<string>([
  STATUS_DEVOLUCAO_SHOPEE.requested,
  STATUS_DEVOLUCAO_SHOPEE.processing,
]);

/**
 * `NegotiationStatus` — the buyer made an offer and it is the SELLER's turn.
 * Exported: `estadoDevolucao.ts` gates `aceitar-oferta` on the same token, so
 * the aviso's `responder-proposta` and the panel's action can never disagree.
 */
export const NEGOCIACAO_AGUARDANDO_VENDEDOR = 'PENDING_RESPOND';
/** `SellerProofStatus` — evidence is owed (exported for the same reason). */
export const PROVA_PENDENTE = 'PENDING';

/** The one thing the seller owes now, and its deadline (µs, copied from Shopee — never computed). */
export interface PendenciaDoVendedor {
  readonly pendencia: PendenciaReclamacao;
  readonly prazoUs: number | null;
}

function menorPresente(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * What the seller owes on an OPEN return, or `null` (nothing — or the return is
 * not open).
 *
 * Three pendências can hold at once, checked in this order:
 *  1. `responder-solicitacao` — status `REQUESTED`/`PROCESSING`; prazo the
 *     nearer of `return_seller_due_date` and `due_date`;
 *  2. `responder-proposta` — `negotiation_status === 'PENDING_RESPOND'`; prazo
 *     `offer_due_date`;
 *  3. `enviar-evidencias` — `seller_proof_status === 'PENDING'`; prazo
 *     `seller_evidence_deadline`.
 *
 * ⚠️ **The CHOSEN one is the one with the NEAREST present deadline**, not the
 * first in that order: the aviso shows ONE prazo, and showing a later one while
 * an earlier one runs out is how a seller loses a return by default (faq 477).
 * A pendência with no deadline goes last; a tie keeps the order above.
 *
 * Compensation (`PENDING_REQUEST`) is NOT a pendência: it is an opportunity,
 * not a loss. `organizar-coleta` is not one either in v1 (register 242).
 */
export function pendenciaDoVendedor(
  claimStatus: StatusClaim | null,
  bloco: Omit<DevolucaoShopeeArmazenada, 'revisao'>,
): PendenciaDoVendedor | null {
  if (claimStatus !== STATUS_CLAIM.aberta) return null;

  const candidatas: PendenciaDoVendedor[] = [];
  if (STATUS_AGUARDANDO_RESPOSTA_DO_VENDEDOR.has(bloco.status)) {
    candidatas.push({
      pendencia: PENDENCIA_RECLAMACAO.responderSolicitacao,
      prazoUs: menorPresente(bloco.prazos.respostaVendedorUs, bloco.prazos.vendedorUs),
    });
  }
  if (bloco.statusNegociacao === NEGOCIACAO_AGUARDANDO_VENDEDOR) {
    candidatas.push({
      pendencia: PENDENCIA_RECLAMACAO.responderProposta,
      prazoUs: bloco.prazos.ofertaUs,
    });
  }
  if (bloco.statusProva === PROVA_PENDENTE) {
    candidatas.push({
      pendencia: PENDENCIA_RECLAMACAO.enviarEvidencias,
      prazoUs: bloco.prazos.provaUs,
    });
  }

  let escolhida: PendenciaDoVendedor | null = null;
  for (const candidata of candidatas) {
    if (escolhida === null) {
      escolhida = candidata;
    } else if (
      candidata.prazoUs !== null &&
      (escolhida.prazoUs === null || candidata.prazoUs < escolhida.prazoUs)
    ) {
      // Strict `<`: a TIE keeps the earlier pendência of the fixed order.
      escolhida = candidata;
    }
  }
  return escolhida;
}

/* -------------------------------------------------------------------------- */
/*                         the poller's re-import predicate                    */
/* -------------------------------------------------------------------------- */

/**
 * Why a `get_return_list` row is re-imported (R-7), in precedence order:
 *
 *  - `ausente` — no incidente at the derived id;
 *  - `relogio` — the row's `update_time` is NEWER than the stored watermark
 *    (or the stored one is missing: an absent clock is not evidence of order);
 *  - `divergente` — a list-visible field differs from the stored block, at an
 *    equal or older clock. Whether negotiation/compensation/due-date changes
 *    move `update_time` at all is UNVERIFIED (register 233), and this reason
 *    is what carries the load if they do not;
 *  - `invariante` — the stored doc breaks what the importer always writes:
 *    origem ≠ 5, tipo ≠ `returns`, `externalId` ≠ the return_sn, a stored
 *    `claimStatus` ≠ {@link statusClaimDaDevolucao} of the row's status (how a
 *    corrected terminal set heals), or a block that does not parse.
 */
export type MotivoReimportacao = 'ausente' | 'relogio' | 'divergente' | 'invariante';

function numeroFinitoOuNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The list-visible fields, through the SAME readers the block was built with —
 * `status`, the three flat sub-statuses, the three common deadlines and
 * `refund_amount`. Nothing else is compared: a field the list does not carry
 * cannot diverge, and one it carries under a different spelling would re-import
 * every return on every tick.
 *
 * ⚠️ Register 240: the list's `seller_compensation_status` may be spelled
 * differently from the detail's (prefixed vs not). If BR confirms that, this
 * reason loops — one `get_return_detail` per such return per tick, bounded by
 * the poller's per-conta caps — and the fix is ONE fold here, never two.
 */
function mesmaProjecaoDaLinha(
  linha: ShopeeReturnListRow,
  bloco: Omit<DevolucaoShopeeArmazenada, 'revisao'>,
): boolean {
  return (
    igual(linha.status, bloco.status) &&
    igual(tokenDoFio(linha.negotiation_status), bloco.statusNegociacao) &&
    igual(tokenDoFio(linha.seller_proof_status), bloco.statusProva) &&
    igual(tokenDoFio(linha.seller_compensation_status), bloco.statusCompensacao) &&
    igual(usDoFio(linha.due_date), bloco.prazos.vendedorUs) &&
    igual(usDoFio(linha.return_seller_due_date), bloco.prazos.respostaVendedorUs) &&
    igual(usDoFio(linha.return_ship_due_date), bloco.prazos.envioCompradorUs) &&
    igual(valorDoFio(linha.refund_amount), bloco.valorReembolso)
  );
}

/**
 * Should the poller enqueue a re-import of this list row? `null` = no.
 *
 * `armazenado` is the RAW incidente (`snap.data()`, `undefined` when absent);
 * nothing here writes, and the importer — the single writer — re-reads the
 * detail and decides under its own transaction. A false positive therefore
 * costs one `get_return_detail`, never a wrong write; a false negative is a
 * return the push missed staying stale until it changes again.
 *
 * ⚠️ µs against µs: the row's SECONDS go through `microsDeSegundosShopee`, the
 * same crossing that produced the stored watermark.
 */
export function motivoDeReimportacao(
  linha: ShopeeReturnListRow,
  armazenado: Record<string, unknown> | undefined,
): MotivoReimportacao | null {
  if (armazenado === undefined) return 'ausente';

  const relogioArmazenadoUs = numeroFinitoOuNull(armazenado.relogioProvedorUs);
  if (
    relogioArmazenadoUs === null ||
    microsDeSegundosShopee(linha.update_time) > relogioArmazenadoUs
  ) {
    return 'relogio';
  }

  const bloco = devolucaoShopeeArmazenadaSchema.safeParse(armazenado.devolucaoShopee);
  if (!bloco.success) return 'invariante';
  if (!mesmaProjecaoDaLinha(linha, bloco.data)) return 'divergente';

  if (
    armazenado.origem !== ORIGEM_INCIDENTE.pedidoShopee ||
    armazenado.tipo !== TIPO_INCIDENTE.devolucao ||
    armazenado.externalId !== linha.return_sn ||
    armazenado.claimStatus !== statusClaimDaDevolucao(linha.status)
  ) {
    return 'invariante';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                the aviso's clock                            */
/* -------------------------------------------------------------------------- */

/**
 * The cap on `revisao` inside the aviso clock — one µs under a whole second.
 */
export const TETO_REVISAO_NO_RELOGIO_DO_AVISO = 999_999;

/**
 * The aviso's `relogioEvento` for one confirmed return state:
 * `relogioProvedorUs + min(revisao, 999 999)`.
 *
 * ⚠️ **Not the bare `revisao`.** `escreverAviso` DROPS a plan whose clock is
 * `<=` the stored one (EQUAL dropped), so the clock must rise strictly on every
 * content change — `revisao` does that within one incidente's life, but
 * restarts at 1 when the incidente is deleted and re-created, and every raise
 * after that would be dropped against the old row's larger number. Anchoring on
 * the watermark makes it monotone ACROSS a re-creation in a later second, and
 * the cap keeps two revisions of one second below the next second's first.
 *
 * Throws `RangeError` on a contract violation (a non-integer or negative
 * watermark, a `revisao` < 1): a clock built from garbage would be monotone
 * against nothing, and the aviso would silently stop moving.
 */
export function relogioDoAvisoDeDevolucao(relogioProvedorUs: number, revisao: number): number {
  if (!Number.isSafeInteger(relogioProvedorUs) || relogioProvedorUs < 0) {
    throw new RangeError('relogioDoAvisoDeDevolucao: relogioProvedorUs não é um µs inteiro');
  }
  if (!Number.isSafeInteger(revisao) || revisao < 1) {
    throw new RangeError('relogioDoAvisoDeDevolucao: revisao precisa ser um inteiro >= 1');
  }
  return relogioProvedorUs + Math.min(revisao, TETO_REVISAO_NO_RELOGIO_DO_AVISO);
}
