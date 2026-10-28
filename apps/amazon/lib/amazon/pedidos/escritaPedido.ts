/**
 * Import step 7 (master plan step 5, PR 5-d; PR 6): the pedido write and its
 * pagamento writes, decided from ONE snapshot of BOTH documents and committed in
 * ONE atomic `WriteBatch`, each write under its own precondition.
 * The app's ONLY batch site (`estrutura.test.ts`), and its only multi-document
 * atomic write: there is no multi-document read-and-write call in this app (plan
 * §3 decision 1), and none is named here.
 *
 * ## One attempt
 *
 *  1. The snapshot: the pedido AND its pagamento, in ONE `getAll` (one
 *     consistent read time) — the importer's own read on the first attempt, a
 *     fresh one on every later attempt. The pagamento is read even before PR 6
 *     writes it: the ONE CANCELLED predicate decides from its status (plan §3
 *     decision 42).
 *  2. `montarEscritaPedidoAmazon` over THAT snapshot — every group (the
 *     watermark, the estado, the lines, the money, the fill-once refs, the
 *     freight — since PR 7 its estado, the `pacotes[]` diary and `codRastreio`
 *     from Easy Ship's packages) re-derived from it, the CANCELLED predicate
 *     from THIS pagamento and the package fold of THIS attempt.
 *     `obsoleto` and `nao-importado` write NOTHING and return at once.
 *  3. The write parsed through the pedido handle: the whole document for a
 *     create (`parse`), the patch for an update (`parseMerge`) — a `ZodError`
 *     refuses the order here, before any write.
 *  4. The pagamento writes, from the same snapshot and the same decision
 *     (`escritaPagamento.ts`): its create or its update, or — when the pedido
 *     writes and the pagamento exists — the pagamento's precondition CARRIER.
 *  5. ONE batch:
 *     - the pedido `create`, or `update(patch, { lastUpdateTime: <its
 *       snapshot's updateTime> })`;
 *     - when the pedido's own patch is EMPTY but a pagamento write is in the
 *       batch, the PRECONDITION CARRIER: an update re-writing the stored
 *       `lastMarketplaceUpdate` exactly as read (the raw value) under the same
 *       precondition — the pagamento was decided from that snapshot, so it must
 *       not land if the pedido moved;
 *     - each pagamento `create`, or `update(patch, { lastUpdateTime })` on its
 *       own snapshot (its carrier included);
 *     - an EMPTY batch is never committed (`sem-mudanca`).
 *  6. The commit's clock: the LATEST `writeTime` across the batch's results.
 *     A carrier is content-identical, and the server answers such a write with
 *     the document's PREVIOUS update time — the stamp the previous writing
 *     import already clocked its avisos with, which an equal-clock guard drops.
 *     The latest is the commit's own time whenever anything changed.
 *
 * ## A lost precondition aborts everything; the retry re-derives everything
 *
 * The commit is all or nothing: `FAILED_PRECONDITION` (9), `NOT_FOUND` (5) or
 * `ALREADY_EXISTS` (6) on ANY write writes NOTHING, and the next attempt
 * re-reads both documents and redoes 2–5 from them — never re-applies what the
 * losing attempt decided (root rule 7's closure trap cannot occur: nothing is
 * captured across attempts but the order itself and the importer's resolved
 * inputs). At most {@link MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON} attempts, then
 * `AmazonPedidoEmConflitoError` (retryable). A commit the SDK retried after it
 * had in fact landed fails its own preconditions the same way, and the retry
 * re-derives from what it wrote.
 *
 * Why it is tier 2 with no transaction: the watermark is compared on a pedido
 * snapshot the precondition proves is still current at commit, and the winning
 * write always carries the accepted watermark (plan §3 decision 1).
 *
 * ## What the preconditions do NOT cover
 *
 * BOTH documents are proven current at commit whenever the batch writes the
 * pedido: the pagamento by its own update or its carrier (`escritaPagamento.ts`,
 * PR 6 — which closed PR 5-d's residue, a pagamento-only change between the read
 * and the commit). An ABSENT pagamento cannot be guarded without a write, so a
 * pagamento created between the read and the commit is not seen by that attempt
 * (the next import re-derives from it).
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { pagamentoCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import type { MotivoNaoImportadoAmazon } from './codigosPedidoAmazon';
import { AmazonPedidoEmConflitoError } from './erros';
import { decidirPagamentosAmazon } from './escritaPagamento';
import {
  montarEscritaPedidoAmazon,
  type EscritaPedidoAmazon,
  type PedidoMapeadoAmazon,
} from './pedidoMapeamento';

/** Attempts of the whole batch before giving up (module header). */
export const MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON = 3;

/** A stored document's raw data. */
export type DocumentoArmazenadoAmazon = Readonly<Record<string, unknown>>;

/** The pedido and its pagamento, read together (one consistent read time). */
export interface LeituraDoPedidoAmazon {
  readonly pedido: DocumentSnapshot;
  readonly pagamento: DocumentSnapshot;
}

/** The pedido write an attempt decided, minus the two that write nothing. */
export type EscritaPedidoDecididaAmazon = Extract<
  EscritaPedidoAmazon,
  { tipo: 'criar' | 'sem-mudanca' | 'atualizar' }
>;

/** One pagamento write the batch carries (`escritaPagamento.ts` decides them). */
export type EscritaPagamentoAmazon =
  | {
      readonly tipo: 'criar';
      readonly ref: DocumentReference;
      readonly dados: Record<string, unknown>;
    }
  | {
      readonly tipo: 'atualizar';
      readonly ref: DocumentReference;
      readonly dados: Record<string, unknown>;
      /** The pagamento snapshot's own `updateTime`. */
      readonly lastUpdateTime: Timestamp;
      /** A content-identical carrier of the pagamento's precondition, not a decided change. */
      readonly portador: boolean;
    };

/**
 * The pagamento hook: the writes decided from THIS attempt's pagamento snapshot
 * and pedido decision (`escritaPagamento.ts`; a test may inject another).
 */
export type DecidirPagamentosAmazon = (
  pagamento: DocumentSnapshot,
  escrita: EscritaPedidoDecididaAmazon,
) => readonly EscritaPagamentoAmazon[];

export interface EntradaEscritaPedidoAmazon {
  /** For the conflict error (ids only). */
  readonly contaId: string;
  readonly orderId: string;
  readonly pedidoId: string;
  /** The importer's read: the first attempt decides from it, every later one re-reads. */
  readonly primeiraLeitura: LeituraDoPedidoAmazon;
  /** The order mapped for the snapshot an attempt writes against (`null`: no pedido). */
  readonly mapear: (armazenado: DocumentoArmazenadoAmazon | null) => PedidoMapeadoAmazon;
  readonly nowUs: number;
  /** Test seam; the default is the one of `escritaPagamento.ts`. */
  readonly decidirPagamentos?: DecidirPagamentosAmazon;
}

export type GravacaoPedidoAmazon =
  /** A newer write already landed (a pedido this importer wrote): NOTHING written. */
  | {
      readonly tipo: 'obsoleto';
      readonly watermarkArmazenadoUs: number;
      readonly tentativas: number;
    }
  /** A first-seen order that is not imported: NOTHING written. */
  | {
      readonly tipo: 'nao-importado';
      readonly motivo: MotivoNaoImportadoAmazon;
      readonly tentativas: number;
    }
  | {
      /** `gravado`: a batch was committed; `sem-mudanca`: nothing to write. */
      readonly tipo: 'gravado' | 'sem-mudanca';
      /** The WINNING attempt's pedido write (its decision drives the incidentes and avisos). */
      readonly escrita: EscritaPedidoDecididaAmazon;
      /** The snapshot the winning attempt decided from. */
      readonly leitura: LeituraDoPedidoAmazon;
      /** Its pedido's raw data (`null`: the attempt created the pedido). */
      readonly armazenado: DocumentoArmazenadoAmazon | null;
      /** The LATEST `writeTime` of the commit's results (`gravado`), or `null` (`sem-mudanca`). */
      readonly writeTime: Timestamp | null;
      /** The batch carried the pedido's precondition on the carrier (module header). */
      readonly portador: boolean;
      /** The batch carried the pagamento's precondition on ITS carrier (`escritaPagamento.ts`). */
      readonly portadorPagamento: boolean;
      readonly tentativas: number;
    };

/** The pedido and its pagamento, in ONE `getAll` (module header, step 1). */
export async function lerPedidoEPagamentoAmazon(
  db: Firestore,
  pedidoId: string,
): Promise<LeituraDoPedidoAmazon> {
  const [pedido, pagamento] = await db.getAll(
    pedidoCollection.docRef(db, {}, pedidoId),
    pagamentoCollection.docRef(db, { pedidoId }, pedidoId),
  );
  if (pedido === undefined || pagamento === undefined) {
    // Unreachable: `getAll` answers one snapshot per ref, in order.
    throw new RangeError('lerPedidoEPagamentoAmazon: getAll sem os dois snapshots');
  }
  return { pedido, pagamento };
}

export function dadosDoSnapshotAmazon(snap: DocumentSnapshot): DocumentoArmazenadoAmazon | null {
  return snap.exists ? ((snap.data() ?? {}) as DocumentoArmazenadoAmazon) : null;
}

/** The pedido's own write in the batch, or `null` when it adds none. */
type EscritaDoPedidoNoLote =
  | { readonly tipo: 'create'; readonly dados: Record<string, unknown> }
  | {
      readonly tipo: 'update';
      readonly dados: Record<string, unknown>;
      readonly lastUpdateTime: Timestamp;
    };

function escritaDoPedidoNoLote(
  escrita: EscritaPedidoDecididaAmazon,
  snap: DocumentSnapshot,
  armazenado: DocumentoArmazenadoAmazon | null,
  comPagamentos: boolean,
): { readonly escrita: EscritaDoPedidoNoLote | null; readonly portador: boolean } {
  if (escrita.tipo === 'criar') {
    return {
      escrita: {
        tipo: 'create',
        dados: pedidoCollection.parse(escrita.corpo) as Record<string, unknown>,
      },
      portador: false,
    };
  }
  const lastUpdateTime = snap.updateTime;
  if (armazenado === null || lastUpdateTime === undefined) {
    // Unreachable: an update or a `sem-mudanca` is decided only against a stored pedido.
    throw new RangeError('escritaDoPedidoNoLote: pedido sem snapshot');
  }
  if (escrita.tipo === 'atualizar') {
    return {
      escrita: {
        tipo: 'update',
        dados: pedidoCollection.parseMerge({ ...escrita.patch }) as Record<string, unknown>,
        lastUpdateTime,
      },
      portador: false,
    };
  }
  if (!comPagamentos) return { escrita: null, portador: false };
  // The carrier: the stored watermark exactly as read, raw (module header).
  const bruto = armazenado.lastMarketplaceUpdate;
  if (bruto === undefined) {
    // Unreachable: `sem-mudanca` means the stored stamp read equal to the incoming one.
    throw new RangeError('escritaDoPedidoNoLote: portador sem lastMarketplaceUpdate');
  }
  return {
    escrita: { tipo: 'update', dados: { lastMarketplaceUpdate: bruto }, lastUpdateTime },
    portador: true,
  };
}

/**
 * The later of two commit stamps, compared in microseconds through the app's
 * ONE stamp conversion (`relogioDoDocumentoUs`, the same reading the aviso
 * clock makes) — never through milliseconds, where two commits can tie.
 */
function maisRecente(a: Timestamp, b: Timestamp): Timestamp {
  return relogioDoDocumentoUs(a) >= relogioDoDocumentoUs(b) ? a : b;
}

/** A lost precondition anywhere in the batch: re-read and re-derive (module header). */
function perdeuPrecondicao(err: unknown): boolean {
  return isFailedPrecondition(err) || isNotFound(err) || isAlreadyExists(err);
}

/**
 * The pedido and its pagamento in ONE batch, re-derived on every
 * lost precondition (module header).
 *
 * @throws ZodError when a decided write does not parse — before any write.
 * @throws {AmazonPedidoEmConflitoError} after
 *   {@link MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON} lost preconditions.
 */
export async function gravarPedidoAmazon(
  db: Firestore,
  entrada: EntradaEscritaPedidoAmazon,
): Promise<GravacaoPedidoAmazon> {
  const { pedidoId, nowUs } = entrada;
  const decidirPagamentos = entrada.decidirPagamentos ?? decidirPagamentosAmazon;
  const ref = pedidoCollection.docRef(db, {}, pedidoId);

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON; tentativa += 1) {
    // Every decision below is derived from THIS attempt's reads.
    const leitura =
      tentativa === 0 ? entrada.primeiraLeitura : await lerPedidoEPagamentoAmazon(db, pedidoId);
    const armazenado = dadosDoSnapshotAmazon(leitura.pedido);
    const escrita = montarEscritaPedidoAmazon(
      armazenado,
      dadosDoSnapshotAmazon(leitura.pagamento),
      entrada.mapear(armazenado),
      { nowUs },
    );
    if (escrita.tipo === 'obsoleto') {
      return {
        tipo: 'obsoleto',
        watermarkArmazenadoUs: escrita.watermarkArmazenadoUs,
        tentativas: tentativa + 1,
      };
    }
    if (escrita.tipo === 'nao-importado') {
      return { tipo: 'nao-importado', motivo: escrita.motivo, tentativas: tentativa + 1 };
    }

    const pagamentos = decidirPagamentos(leitura.pagamento, escrita);
    const doPedido = escritaDoPedidoNoLote(
      escrita,
      leitura.pedido,
      armazenado,
      pagamentos.length > 0,
    );
    if (doPedido.escrita === null && pagamentos.length === 0) {
      return {
        tipo: 'sem-mudanca',
        escrita,
        leitura,
        armazenado,
        writeTime: null,
        portador: false,
        portadorPagamento: false,
        tentativas: tentativa + 1,
      };
    }

    const lote = db.batch();
    if (doPedido.escrita?.tipo === 'create') lote.create(ref, doPedido.escrita.dados);
    if (doPedido.escrita?.tipo === 'update') {
      lote.update(ref, doPedido.escrita.dados, {
        lastUpdateTime: doPedido.escrita.lastUpdateTime,
      });
    }
    for (const p of pagamentos) {
      if (p.tipo === 'criar') lote.create(p.ref, p.dados);
      else lote.update(p.ref, p.dados, { lastUpdateTime: p.lastUpdateTime });
    }

    let resultados: Awaited<ReturnType<typeof lote.commit>>;
    try {
      resultados = await lote.commit();
    } catch (err) {
      // Nothing landed (module header): loop, re-read, re-derive. Never re-apply.
      if (perdeuPrecondicao(err)) continue;
      throw err;
    }
    // The LATEST stamp (module header, step 6): a carrier answers the previous one.
    const primeiro = resultados[0]?.writeTime;
    if (primeiro === undefined) {
      // Unreachable: a committed batch answers one result per write, and it had one.
      throw new RangeError('gravarPedidoAmazon: commit sem writeTime');
    }
    const writeTime = resultados.reduce((max, r) => maisRecente(max, r.writeTime), primeiro);
    return {
      tipo: 'gravado',
      escrita,
      leitura,
      armazenado,
      writeTime,
      portador: doPedido.portador,
      portadorPagamento: pagamentos.some((p) => p.tipo === 'atualizar' && p.portador),
      tentativas: tentativa + 1,
    };
  }
  throw new AmazonPedidoEmConflitoError(
    entrada.contaId,
    entrada.orderId,
    MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON,
  );
}
