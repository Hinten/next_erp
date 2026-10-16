/**
 * Import steps 3 (on a retry), 8, 9 and 10 (master plan steps 5 and 6, PR 5-c):
 * the pedido write and every pagamento write, decided from ONE pedido snapshot,
 * parsed, and committed in ONE atomic `WriteBatch` — each write under its own
 * precondition (root `CLAUDE.md` rule 7, tiers 0, 1 and 2; no multi-document
 * read-and-write call, which this app never names).
 *
 * ## One attempt
 *
 *  1. The pedido snapshot `S`: step 3's read on the first attempt, a fresh read
 *     on every later one. A stored watermark strictly newer than the order's ⇒
 *     `obsoleto`, and NOTHING is written (`montarEscritaPedidoLi` answers it
 *     before anything else).
 *  2. The pedido write against `S` (`montarEscritaPedidoLi`: every group — the
 *     verdict, the applied removal, the freeze, the fill-once refs, the merges,
 *     the watermark — re-derived from `S`), parsed through the handle: the
 *     whole document for a create (`parse`), the patch for an update
 *     (`parseMerge`). A `ZodError` refuses the order here, before any write.
 *  3. The pagamentos (`escritaPagamento.ts`): each read, decided from the
 *     payment statuses that SAME decision gives, and parsed. Nothing written.
 *  4. ONE batch:
 *     - the pedido `create`, or `update(patch, { lastUpdateTime: S.updateTime })`;
 *     - when the pedido's own patch is EMPTY but a pagamento write is in the
 *       batch, the PRECONDITION CARRIER: an update that re-writes the stored
 *       `lastMarketplaceUpdate` exactly as read (the raw value, never its µs
 *       reading) under the same precondition. The pagamento statuses were
 *       decided from `S`, so they must not land if `S` changed. On the emulator
 *       (`importarPedido.firestore.test.ts` pins both): a carrier that
 *       round-trips the stored value unchanged KEEPS the pedido's update time;
 *       a watermark stored as a double comes back re-typed as an integer (the
 *       SDK encodes every safe-integer number as one), which IS a change — the
 *       update time moves and the triggers see a write. Nothing here relies on
 *       either: no later step reads the pedido's update time;
 *     - each pagamento `create`, or `update(patch, { lastUpdateTime: <its own
 *       snapshot's updateTime> })`;
 *     - an EMPTY batch is not committed (`sem-mudanca`).
 *
 * ## A lost precondition aborts everything, and the retry re-derives everything
 *
 * The commit is all or nothing: `FAILED_PRECONDITION` (9), `NOT_FOUND` (5) or
 * `ALREADY_EXISTS` (6) on ANY write writes NOTHING, and the next attempt
 * re-reads `S′` and every pagamento and redoes 1–4 from them — at most
 * {@link MAX_TENTATIVAS_ESCRITA_PEDIDO_LI} attempts, then
 * {@link LiPedidoEmConflitoError} (the step-3 classifier answers `null`: the task
 * retries). So no pagamento is ever written without its pedido, or decided from
 * a stale snapshot: on the "keep both" arm `S′` decides `manter`, which writes
 * nothing, and a refund status decided from `S` never reaches the store. A
 * batch whose update names a document removed since its read answers 9 on the
 * emulator, and writes none of its other writes (the stamp replaces the SDK's
 * `exists` check; pinned in the emulator suite); the server's code is not
 * pinned, so 5 is re-read the same way. A commit the SDK retried after it had in fact landed fails its
 * own preconditions the same way, and the retry re-derives from what it wrote.
 *
 * The cliente, the endereço, the `mapa` row and the produto resolution (steps
 * 5–7) are NOT redone: their results reach every attempt through `mapearPedido`,
 * whose refs the fill-once group keeps only while `S′` holds none.
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';

import type { DecisaoEstadoLi } from './estadoPedidoLi';
import { decidirPagamentosLi, type PagamentosDecididosLi } from './escritaPagamento';
import type { PagamentoMapeadoLi } from './pagamentoMapeamento';
import {
  montarEscritaPedidoLi,
  type EscritaPedidoLi,
  type PedidoMapeadoLi,
} from './pedidoMapeamento';

/** Attempts of the whole batch before giving up (module header). */
export const MAX_TENTATIVAS_ESCRITA_PEDIDO_LI = 3;

/**
 * Persistent contention on one pedido: {@link MAX_TENTATIVAS_ESCRITA_PEDIDO_LI}
 * batches in a row lost a precondition. The step-3 classifier returns `null`
 * for it, so the task rethrows and the queue retries.
 *
 * A plain `Error` (the step-3 non-route shape): it is about this import, never
 * about a conta, and a `catch` written for a conta's refusal must not swallow it.
 */
export class LiPedidoEmConflitoError extends Error {
  readonly pedidoId: string;
  readonly tentativas: number;

  constructor(pedidoId: string, tentativas: number) {
    super(
      `Não foi possível gravar o pedido ${pedidoId} da Loja Integrada: ${String(tentativas)} ` +
        'lotes seguidos perderam uma precondição.',
    );
    this.name = 'LiPedidoEmConflitoError';
    this.pedidoId = pedidoId;
    this.tentativas = tentativas;
  }
}

/** A stored pedido's raw data. */
export type PedidoArmazenadoLi = Readonly<Record<string, unknown>>;

export interface EntradaEscritaPedidoLi {
  readonly pedidoId: string;
  /** Step 3's read: the first attempt decides from it, every later one re-reads. */
  readonly primeiraLeitura: DocumentSnapshot;
  /** The order's fields for the snapshot an attempt writes against (`null`: no pedido). */
  readonly mapearPedido: (armazenado: PedidoArmazenadoLi | null) => PedidoMapeadoLi;
  /** The order's payments for the decision that attempt took. */
  readonly mapearPagamentos: (decisao: DecisaoEstadoLi) => readonly PagamentoMapeadoLi[];
  readonly nowUs: number;
}

/** The pedido write an attempt decided, minus `obsoleto` (which writes nothing). */
export type EscritaPedidoDecididaLi = Exclude<EscritaPedidoLi, { tipo: 'obsoleto' }>;

export type GravacaoPedidoLi =
  /** The stored watermark is strictly newer: NOTHING was written. */
  | { readonly tipo: 'obsoleto'; readonly armazenadoUs: number; readonly tentativas: number }
  | {
      /** `gravado`: a batch was committed; `sem-mudanca`: nothing to write. */
      readonly tipo: 'gravado' | 'sem-mudanca';
      /** The winning attempt's pedido write (its decision drives the avisos). */
      readonly escrita: EscritaPedidoDecididaLi;
      /** The snapshot the winning attempt decided from (`null`: it created the pedido). */
      readonly armazenado: PedidoArmazenadoLi | null;
      readonly pagamentos: PagamentosDecididosLi;
      /** The batch carried the pedido's precondition on the carrier (module header). */
      readonly portador: boolean;
      readonly tentativas: number;
    };

function dadosDe(snap: DocumentSnapshot): PedidoArmazenadoLi | null {
  return snap.exists ? ((snap.data() ?? {}) as PedidoArmazenadoLi) : null;
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
  escrita: EscritaPedidoDecididaLi,
  snap: DocumentSnapshot,
  armazenado: PedidoArmazenadoLi | null,
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
        dados: pedidoCollection.parseMerge({ ...escrita.patch }),
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

/** A lost precondition anywhere in the batch: re-read and re-derive (module header). */
function perdeuPrecondicao(err: unknown): boolean {
  return isFailedPrecondition(err) || isNotFound(err) || isAlreadyExists(err);
}

/**
 * The pedido and its pagamentos, in ONE batch, re-derived on every lost
 * precondition (module header).
 *
 * @throws ZodError when a decided write does not parse — before any write.
 * @throws {LiPedidoEmConflitoError} after {@link MAX_TENTATIVAS_ESCRITA_PEDIDO_LI}
 *   lost preconditions.
 */
export async function gravarPedidoEPagamentosLi(
  db: Firestore,
  entrada: EntradaEscritaPedidoLi,
): Promise<GravacaoPedidoLi> {
  const { pedidoId, nowUs } = entrada;
  const ref: DocumentReference = pedidoCollection.docRef(db, {}, pedidoId);

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_ESCRITA_PEDIDO_LI; tentativa += 1) {
    // Every decision below is derived from THIS attempt's reads.
    const snap = tentativa === 0 ? entrada.primeiraLeitura : await ref.get();
    const armazenado = dadosDe(snap);
    const escrita = montarEscritaPedidoLi(armazenado, entrada.mapearPedido(armazenado), nowUs);
    // The watermark first: a strictly newer stored stamp writes nothing at all.
    if (escrita.tipo === 'obsoleto') {
      return { tipo: 'obsoleto', armazenadoUs: escrita.armazenadoUs, tentativas: tentativa + 1 };
    }

    const pagamentos = await decidirPagamentosLi(
      db,
      pedidoId,
      entrada.mapearPagamentos(escrita.decisao),
      nowUs,
    );
    const doPedido = escritaDoPedidoNoLote(
      escrita,
      snap,
      armazenado,
      pagamentos.escritas.length > 0,
    );

    if (doPedido.escrita === null && pagamentos.escritas.length === 0) {
      return {
        tipo: 'sem-mudanca',
        escrita,
        armazenado,
        pagamentos,
        portador: false,
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
    for (const p of pagamentos.escritas) {
      if (p.tipo === 'criar') lote.create(p.ref, p.dados);
      else lote.update(p.ref, p.dados, { lastUpdateTime: p.lastUpdateTime });
    }

    try {
      await lote.commit();
    } catch (err) {
      // Nothing landed (module header): loop, re-read, re-derive. Never re-apply.
      if (perdeuPrecondicao(err)) continue;
      throw err;
    }
    return {
      tipo: 'gravado',
      escrita,
      armazenado,
      pagamentos,
      portador: doPedido.portador,
      tentativas: tentativa + 1,
    };
  }
  throw new LiPedidoEmConflitoError(pedidoId, MAX_TENTATIVAS_ESCRITA_PEDIDO_LI);
}
