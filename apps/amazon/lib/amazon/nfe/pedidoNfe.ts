/**
 * The DECISIONS of the NF-e upload over Firestore snapshots already in memory
 * (step 14, PR 14-b): is this pedido Amazon's and ours to upload for, from
 * which order clock does a live read count, which of the pedido's NF-e goes to
 * Amazon, what its siblings say, and is a write an approved note being
 * cancelled. Pure: the caller does the reads and hands the RAW data in, so the
 * trigger can decide at zero extra reads and the tests need no Firestore.
 *
 * ## The pedido: ownership is PROVED, never inferred
 *
 * {@link provaDeIdentidadeAmazon} accepts a pedido only when its id RECOMPUTES
 * from `(conta, order id)` — the stored `integracaoPedidoOuterRef`'s document
 * id and `numero`, through the importer's own digest (`pedidos/orderIds.ts`).
 * A marker field (`marketplace.tipo`), a freight integradora or a number that
 * merely LOOKS like an Amazon order proves nothing, and uploading another
 * channel's note to an Amazon order is not a refusal anyone would see. Both
 * values are checked against their grammars FIRST, so a pedido of another
 * channel answers `null` — never the digest's `RangeError`.
 *
 * {@link avaliarPedidoParaNfeAmazon}, in this order: the proof
 * (`nao-amazon`), then `bloquearEmissaoNFe === true` (`emissao-bloqueada`: the
 * NF-e app refuses to emit under the flag, so an approved note under it means
 * the flag was set after emission), then the STORED pre-filter (`nao-dba`):
 * stored evidence that SAYS NO — a `marketplace` block this importer wrote with
 * `fulfilledBy: 'AMAZON'`, or with a `programs` LIST that lacks the
 * Delivery-by-Amazon key. Absence says nothing: a migrated pedido carries no
 * `marketplace` until its first re-import, so the decision stays the task's,
 * LIVE (step-14 plan §3 decision 3). ⚠️ Never key on `AMAZON_EASY_SHIP`: it is
 * absent from every real BR capture.
 *
 * ## The live-read floor ({@link pisoDoPedidoAmazon})
 *
 * The stored order clock (`lastMarketplaceUpdate`, µs) — ONLY on a pedido this
 * importer wrote (`marketplace.tipo === 'amazon'`, the importer's own watermark
 * condition) — so a live `getOrder` older than what the importer already
 * accepted is refused rather than trusted. `null` otherwise: a migrated pedido's
 * stamp is not this importer's watermark.
 *
 * ## The NF-e documents: one eligibility, two readers
 *
 * A document is ELIGIBLE when the shared LEVEL predicate says it is ready —
 * never the transition one — and its proc is not a legible NON-sale note (an
 * illegible one stays eligible: the task judges it loudly, never silently).
 * {@link motivoForaDoEnvioNfeAmazon} is that one rule, and every reader below
 * (and the re-drive route's explicit `nfeId`) goes through it.
 *
 * - {@link escolherNfeParaEnvioAmazon} — the slot rule of a caller with a
 *   pedido but no NF-e id (the re-drive route; the trigger and the task always
 *   carry one): the latest `data_autorizacao` wins, a tie goes to the lowest
 *   document id, an unknown date counts as the oldest — a total order. A
 *   cancelled slot is never chosen (the predicate reads it `nao-aprovada`).
 *   With nothing eligible, the answer is the reason of the document that got
 *   FURTHEST down the ladder. Shopee's rule, step-14 plan §3 decision 4.
 * - {@link irmaosDaNfeAmazon} — what the pedido's OTHER documents say:
 *   `outraElegivel` (another eligible sale note: two authorized NF-e for one
 *   sale is a fiscal anomaly a human resolves, `nfe-ambigua`) and
 *   `irmaCancelada` (a cancelled sale note beside ours: a re-issue, or the
 *   contingency duplicate Amazon never held — `nfe-substituta`, advisory).
 *
 * ## The a→c arm ({@link cancelamentoDeNfeAprovadaAmazon})
 *
 * A write that takes an ELIGIBLE document (above) to `'c'`: an approved sale
 * NF-e cancelled at SEFAZ. Nothing can be sent to Amazon (the Delivery API has
 * no cancel), so the trigger (`gatilhoNfe.ts`) tells the operator instead
 * (`nfe-cancelada`, step-14 plan §3 decision 17(b), "an aprovada sale NF-e").
 *
 * ⚠️ LIGHT on purpose: the NF-e trigger imports this module, and the trigger's
 * import closure is pinned file by file (`estrutura.test.ts`'s NF-e D11 guard,
 * type edges walked) to hold no SP-API value import and nothing of `pedidos/`
 * but `orderIds.ts` (the digest). So it spells the two stored Amazon values it
 * reads here — pinned EQUAL to the importer's constants by its test.
 */
import { coerceToMicros, coerceToMillis } from '@delfrance/core/datetime';
import {
  CONTA_ID_AMAZON_REGEX,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  MARKETPLACE_PEDIDO_TIPO,
  PEDIDO_AMAZON_REGEX,
  decideNfeUploadDispatch,
  finalidadeDaNfeProc,
  idFromRefOrNull,
  type NfeUploadDispatch,
} from '@delfrance/schemas';

import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { MOTIVO_NFE_AMAZON } from './motivosNfe';

/**
 * `programs[]`'s Delivery-by-Amazon key (Orders v2026). The live gate
 * (`gatesPedidoNfe.ts`) reads the same constant.
 */
export const PROGRAMA_DBA_AMAZON = 'DELIVERY_BY_AMAZON';

/**
 * `fulfilledBy` of an order Amazon itself fulfils — the importer's
 * `FULFILLED_BY_AMAZON.amazon`, spelled here so this module stays out of
 * `pedidos/` (module header); its test pins the two equal.
 */
export const ATENDIDO_PELA_AMAZON = 'AMAZON';

/* -------------------------------------------------------------------------- */
/*                                 the pedido                                  */
/* -------------------------------------------------------------------------- */

/** What the proof recovers: the conta and the Amazon order the pedido is. */
export interface IdentidadePedidoAmazon {
  readonly contaId: string;
  readonly orderId: string;
}

/**
 * The pedido's identity, PROVED by recomputing its id (module header), or
 * `null` when it is not an Amazon pedido of a conta — another channel's, a
 * malformed one, or one without the stored ref or number. Never throws.
 */
export function provaDeIdentidadeAmazon(
  pedidoId: string,
  raw: Readonly<Record<string, unknown>> | null,
): IdentidadePedidoAmazon | null {
  if (raw === null) return null;
  const contaId = idFromRefOrNull(raw.integracaoPedidoOuterRef);
  const orderId = raw.numero;
  if (contaId === null || !CONTA_ID_AMAZON_REGEX.test(contaId)) return null;
  if (typeof orderId !== 'string' || !PEDIDO_AMAZON_REGEX.test(orderId)) return null;
  return makePedidoIdAmazon(contaId, orderId) === pedidoId ? { contaId, orderId } : null;
}

/**
 * The pedido estados of a CANCELLED SALE (step 14, PR 14-c): the importer's
 * terminal pair (`pedidos/estadoPedidoAmazon.ts`'s `ESTADOS_TERMINAIS_AMAZON`,
 * spelled here so this module stays out of `pedidos/` — its test pins the two
 * EQUAL). `cancelado` is the CANCELLED predicate's target without a pagamento
 * (and an operator's own cancel); `estornadoIntegralmente` is its target for an
 * APPROVED, paid order — exactly the orders that carry an NF-e. Reading
 * `cancelado` alone would miss nearly every cancelled sale with an authorized
 * note.
 */
export const ESTADOS_VENDA_CANCELADA_AMAZON: ReadonlySet<string> = new Set<string>([
  ESTADO_PEDIDO.cancelado,
  ESTADO_PEDIDO.estornadoIntegralmente,
]);

/** Whether the stored pedido is a cancelled sale ({@link ESTADOS_VENDA_CANCELADA_AMAZON}). */
export function vendaCanceladaAmazon(raw: Readonly<Record<string, unknown>> | null): boolean {
  return (
    raw !== null && typeof raw.estado === 'string' && ESTADOS_VENDA_CANCELADA_AMAZON.has(raw.estado)
  );
}

/** An object field of a raw document, or `null`. */
function objeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/** The stored `marketplace` block, only when THIS importer wrote it. */
function marketplaceAmazon(
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const bloco = objeto(raw.marketplace);
  return bloco !== null && bloco.tipo === MARKETPLACE_PEDIDO_TIPO.amazon ? bloco : null;
}

/** Whether the STORED evidence says this is NOT a Delivery-by-Amazon order (module header). */
function armazenadoDizNaoDba(raw: Readonly<Record<string, unknown>>): boolean {
  const bloco = marketplaceAmazon(raw);
  if (bloco === null) return false;
  if (bloco.fulfilledBy === ATENDIDO_PELA_AMAZON) return true;
  const programas = bloco.programs;
  return Array.isArray(programas) && !programas.includes(PROGRAMA_DBA_AMAZON);
}

/** The pedido's verdict: proved and uploadable, or a log-only reason. */
export type AvaliacaoPedidoNfeAmazon =
  | ({ readonly ok: true } & IdentidadePedidoAmazon)
  | {
      readonly ok: false;
      readonly motivo:
        | typeof MOTIVO_NFE_AMAZON.naoAmazon
        | typeof MOTIVO_NFE_AMAZON.emissaoBloqueada
        | typeof MOTIVO_NFE_AMAZON.naoDba;
    };

/** The task's verdict: the proof and the emission block — never the stored pre-filter. */
export type AvaliacaoPedidoTarefaNfeAmazon =
  | ({ readonly ok: true } & IdentidadePedidoAmazon)
  | {
      readonly ok: false;
      readonly motivo:
        | typeof MOTIVO_NFE_AMAZON.naoAmazon
        | typeof MOTIVO_NFE_AMAZON.emissaoBloqueada;
    };

/**
 * The NF-e TASK's verdict (step 14, PR 14-c, its P3): the proof, then the
 * emission block — and NOT the stored pre-filter: the task decides Delivery by
 * Amazon LIVE, from its own `getOrder` read (step-14 plan §3 decision 3), and
 * the re-drive route bypasses the trigger's pre-filter on purpose. A missing
 * pedido is not proved.
 */
export function avaliarPedidoParaTarefaNfeAmazon(
  pedidoId: string,
  raw: Readonly<Record<string, unknown>> | null,
): AvaliacaoPedidoTarefaNfeAmazon {
  const prova = provaDeIdentidadeAmazon(pedidoId, raw);
  if (prova === null || raw === null) return { ok: false, motivo: MOTIVO_NFE_AMAZON.naoAmazon };
  if (raw.bloquearEmissaoNFe === true) {
    return { ok: false, motivo: MOTIVO_NFE_AMAZON.emissaoBloqueada };
  }
  return { ok: true, contaId: prova.contaId, orderId: prova.orderId };
}

/**
 * May this pedido's NF-e go to Amazon? The task's verdict
 * ({@link avaliarPedidoParaTarefaNfeAmazon}: the proof, then the emission
 * block), then the TRIGGER's stored pre-filter (module header). A missing
 * pedido is not proved.
 */
export function avaliarPedidoParaNfeAmazon(
  pedidoId: string,
  raw: Readonly<Record<string, unknown>> | null,
): AvaliacaoPedidoNfeAmazon {
  const daTarefa = avaliarPedidoParaTarefaNfeAmazon(pedidoId, raw);
  if (!daTarefa.ok) return daTarefa;
  if (raw !== null && armazenadoDizNaoDba(raw)) {
    return { ok: false, motivo: MOTIVO_NFE_AMAZON.naoDba };
  }
  return daTarefa;
}

/**
 * The floor a live order read must reach (module header): the stored
 * `lastMarketplaceUpdate` in µs on a pedido this importer wrote, else `null`.
 */
export function pisoDoPedidoAmazon(raw: Readonly<Record<string, unknown>> | null): number | null {
  if (raw === null || marketplaceAmazon(raw) === null) return null;
  return coerceToMicros(raw.lastMarketplaceUpdate);
}

/* -------------------------------------------------------------------------- */
/*                              the NF-e documents                             */
/* -------------------------------------------------------------------------- */

/** One `nfev4` document of the pedido, raw, with its id. */
export interface DocumentoNfeAmazon {
  readonly id: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The slot rule's own summary when no document is even aprovada. */
export const SEM_NFE_APROVADA_AMAZON = 'sem-nfe-aprovada';

/** A skip reason of the shared LEVEL predicate. */
type MotivoDoPredicado = Extract<NfeUploadDispatch, { action: 'skip' }>['reason'];

/** Why no document of the pedido goes to Amazon. */
export type MotivoSemNfeParaEnvioAmazon =
  | MotivoDoPredicado
  | typeof SEM_NFE_APROVADA_AMAZON
  | typeof MOTIVO_NFE_AMAZON.nfeNaoEDeVenda;

/** The slot rule's verdict. */
export type EscolhaNfeAmazon =
  | { readonly nfeId: string }
  | { readonly motivo: MotivoSemNfeParaEnvioAmazon };

/**
 * How far down the ladder each miss got — the higher, the closer the document
 * came to being sent. `apagada` and `nao-aprovada` never climb: a document that
 * is not aprovada is what `sem-nfe-aprovada` summarises.
 */
const PROFUNDIDADE_DA_FALTA: Readonly<Record<MotivoSemNfeParaEnvioAmazon, number>> = {
  apagada: 0,
  'nao-aprovada': 0,
  [SEM_NFE_APROVADA_AMAZON]: 0,
  'xml-ausente': 1,
  'tpamb-homologacao': 2,
  [MOTIVO_NFE_AMAZON.nfeNaoEDeVenda]: 3,
};

/**
 * Why this document is NOT eligible, or `null` when it is (module header):
 * the level predicate's skip reason, else `nfe-nao-e-de-venda` for a legible
 * non-sale proc. EXPORTED for the re-drive route's explicit `nfeId`
 * (`reenvioNfe.ts`, PR 14-d), so a document the body names is judged by the
 * very rule the slot reader applies to a listing — one eligibility, never a
 * second copy of it.
 */
export function motivoForaDoEnvioNfeAmazon(
  raw: Readonly<Record<string, unknown>>,
): MotivoSemNfeParaEnvioAmazon | null {
  const pronta = decideNfeUploadDispatch(undefined, raw);
  if (pronta.action === 'skip') return pronta.reason;
  const xml = raw.xml_nfe_proc;
  return typeof xml === 'string' && finalidadeDaNfeProc(xml) === 'outra'
    ? MOTIVO_NFE_AMAZON.nfeNaoEDeVenda
    : null;
}

/** `a` wins over `b`: the later authorization, then the lower id. */
function venceNaEscolha(
  a: { readonly id: string; readonly autorizadaMs: number | null },
  b: { readonly id: string; readonly autorizadaMs: number | null },
): boolean {
  const ma = a.autorizadaMs ?? Number.NEGATIVE_INFINITY;
  const mb = b.autorizadaMs ?? Number.NEGATIVE_INFINITY;
  if (ma !== mb) return ma > mb;
  return a.id < b.id;
}

/** The slot rule (module header). */
export function escolherNfeParaEnvioAmazon(docs: readonly DocumentoNfeAmazon[]): EscolhaNfeAmazon {
  let melhor: { readonly id: string; readonly autorizadaMs: number | null } | null = null;
  let falta: MotivoSemNfeParaEnvioAmazon = SEM_NFE_APROVADA_AMAZON;
  for (const doc of docs) {
    const motivo = motivoForaDoEnvioNfeAmazon(doc.raw);
    if (motivo !== null) {
      if (PROFUNDIDADE_DA_FALTA[motivo] > PROFUNDIDADE_DA_FALTA[falta]) falta = motivo;
      continue;
    }
    const candidata = { id: doc.id, autorizadaMs: coerceToMillis(doc.raw.data_autorizacao) };
    if (melhor === null || venceNaEscolha(candidata, melhor)) melhor = candidata;
  }
  return melhor === null ? { motivo: falta } : { nfeId: melhor.id };
}

/** What the pedido's OTHER `nfev4` documents say about ours. */
export interface IrmaosDaNfeAmazon {
  /** Another ELIGIBLE sale note (ready, and not a legible non-sale proc). */
  readonly outraElegivel: boolean;
  /** A cancelled document that is not a legible NON-sale note. */
  readonly irmaCancelada: boolean;
}

/**
 * The siblings of `nfeId` among `docs` (the pedido's whole, unfiltered
 * `nfev4` listing; ours is skipped by id). A cancelled document whose proc is a
 * legible non-sale note (a devolução) is no re-issue of the sale.
 */
export function irmaosDaNfeAmazon(
  nfeId: string,
  docs: readonly DocumentoNfeAmazon[],
): IrmaosDaNfeAmazon {
  let outraElegivel = false;
  let irmaCancelada = false;
  for (const doc of docs) {
    if (doc.id === nfeId) continue;
    if (motivoForaDoEnvioNfeAmazon(doc.raw) === null) outraElegivel = true;
    if (doc.raw.estado === ESTADO_NFE.cancelada) {
      const xml = doc.raw.xml_nfe_proc;
      if (typeof xml !== 'string' || finalidadeDaNfeProc(xml) !== 'outra') irmaCancelada = true;
    }
  }
  return { outraElegivel, irmaCancelada };
}

/**
 * Whether a write takes an ELIGIBLE document (`before`: the level predicate
 * says ready, and its proc is not a legible NON-sale note — the same one
 * eligibility the slot and sibling readers apply) to cancelled
 * (`after.estado === 'c'`): the a→c arm (module header). A cancelled devolução
 * or complementar is no sale note Amazon could hold.
 */
export function cancelamentoDeNfeAprovadaAmazon(
  before: Readonly<Record<string, unknown>> | undefined,
  after: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (before === undefined || after === undefined) return false;
  return motivoForaDoEnvioNfeAmazon(before) === null && after.estado === ESTADO_NFE.cancelada;
}
