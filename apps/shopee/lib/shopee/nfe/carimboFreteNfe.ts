/**
 * The NF-e upload's ONE Firestore write to the pedido (#1522, step 14): when the
 * channel PROVABLY refused this NF-e, `freteInicial.estado` becomes
 * `ESTADO_FRETE.error` — the stamp. Class **C**; the inventory entry is in
 * `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 *
 * ## What decides that a stamp happens — not this module
 *
 * WHETHER an outcome stamps is `MOTIVOS_QUE_CARIMBAM` (`errosNfe.ts`), the only
 * source of that answer, and the caller consults it before calling here. This
 * module decides only whether the STORED frete may still take the stamp. It never
 * sees a motivo, so there is nothing here that could grow a second copy of the
 * set.
 *
 * ## The race class — **C**, and the named guard
 *
 * The handler reads the pedido, then talks to Shopee (the upload, the read-back),
 * and only THEN opens this transaction — so a network round trip sits between the
 * outside read and the write, which is class B with a much wider window. The
 * guard is that NOTHING from the outside read reaches the write: the callback
 * re-reads the pedido with its own `tx.get` (RAW, deliberately not `parseRead` —
 * the step-7 reason in `pedidos/freteTx.ts`), and every guard and every written
 * value is re-derived from that snapshot by the pure {@link preverCarimboNfeShopee}.
 * The only inputs from outside are the pedido id and `nowUs`, a clock. So an OCC
 * retry recomputes the whole decision: when step 7 commits `aguardandoPostagem`
 * between our read and our commit, the retry answers `fora-do-escopo` and writes
 * nothing — correct, the parcel shipped.
 *
 * ## The guards, in order (each one is a no-write answer)
 *
 *  1. no pedido ⇒ `sem-pedido`. Step 5 owns creation; a stamp never creates;
 *  2. `freteInicial` not a map ⇒ `sem-frete`. A synthesized block would carry no
 *     `modalidade` and no owner, so the Frete tab would render a freight nobody
 *     chose;
 *  3. `externalOptionIntegracao` not EXACTLY `INTEGRACAO_FRETE.shopee` ⇒
 *     `outra-integradora`. An absent owner refuses too: a block we cannot prove is
 *     the channel's is never ours to mark;
 *  4. stored estado already `error` ⇒ `ja-carimbado`, and ZERO writes — the replay
 *     of a refusal (a retried task, a second NF-e slot) must not re-stamp, or every
 *     replay would move `ultimaModificacao` and file one more audit row;
 *  5. stored estado not an `EstadoFrete` member ⇒ `estado-ilegivel`. We cannot tell
 *     whether an illegible block is past shipment, so it is left alone; the aviso
 *     still carries the signal;
 *  6. stored estado outside {@link ESTADOS_FRETE_CARIMBAVEIS_NFE} ⇒
 *     `fora-do-escopo`. Never over `empacotado`, `aguardandoPostagem` or anything
 *     past shipment (the channel already accepted the dispatch), nor over
 *     `cancelado`, `despachoNegado`, a return or another modality's estado.
 *
 * ## The write
 *
 * `freteInicial` is ONE top-level key and `tx.update` masks at top-level keys, so
 * the block is rebuilt WHOLE from the snapshot — `{ ...armazenado, estado: error }`
 * — carrying `pacotes`, `codRastreio`, `freteInicial.ultimaModificacao` and every
 * passthrough field. Plus the top-level `ultimaModificacao`, monotone in **µs**:
 * `maiorUs(coerceToMicros(stored), nowUs)`. The stored side goes through
 * `coerceToMicros` because the legacy corpus holds ms integers and ISO strings
 * there — this module READS a clock in the pedido's own unit and converts none of
 * its own; `nowUs` arrives already in µs, computed ONCE by the caller.
 *
 * ⚠️ Two fields are deliberately NEVER written. The ORDER clock
 * (`lastMarketplaceUpdate`) is step 5's alone — writing it would make the next
 * order import read our stamp as a fresher Shopee observation. And the
 * operator-interaction flag is not a guard either: the frete block stays
 * channel-owned whatever an operator did to the rest of the pedido.
 *
 * ⚠️ Stock-neutral by construction: `error ∈ ESTADOS_FRETE_IGNORAR_REMOCAO` and is
 * only ever written over an estado outside `ESTADOS_FRETE_REMOVE_ESTOQUE`, so the
 * pedido→estoque sync never sees a removal undone. Step 7 keeps the stamp
 * (`erro-preservado`) until it writes an estado of the removal set — and, as
 * step 15 corrected, that is when step 7 observes `LOGISTICS_REQUEST_CREATED`
 * (`aguardandoPostagem`), i.e. right after OUR `ship_order`, not after a
 * physical pickup.
 *
 * No log line here: the handler's ONE completion line carries the returned
 * motivo as `carimbo`.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { coerceToMicros } from '@delfrance/core/datetime';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  ESTADO_FRETE,
  ESTADOS_FRETE_NAO_POSTADO,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  INTEGRACAO_FRETE,
  estadoFreteSchema,
  type EstadoFrete,
} from '@delfrance/schemas';

import { ESTADOS_FRETE_SHOPEE_TERMINAL } from '../pedidos/freteShopeeMapping';
import { maiorUs } from '../pedidos/orderMapping';

/* -------------------------------------------------------------------------- */
/*                               the stampable set                             */
/* -------------------------------------------------------------------------- */

/**
 * The estados a refused NF-e may turn into `error`: not yet posted, not yet out
 * of stock, and not an ending — `NAO_POSTADO ∖ REMOVE_ESTOQUE ∖ SHOPEE_TERMINAL`.
 *
 * ⚠️ DERIVED, never enumerated, so it cannot disagree with the three sets it is
 * made of — and `carimboFreteNfe.test.ts` pins its eight members literally, so a
 * change to any of those sets upstream reds a test instead of silently widening
 * what this module stamps.
 */
export const ESTADOS_FRETE_CARIMBAVEIS_NFE: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>(
  [...ESTADOS_FRETE_NAO_POSTADO].filter(
    (estado) =>
      !ESTADOS_FRETE_REMOVE_ESTOQUE.has(estado) && !ESTADOS_FRETE_SHOPEE_TERMINAL.has(estado),
  ),
);

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

/** What one stamp attempt did. Only `carimbado` wrote anything. */
export type MotivoCarimbo =
  | 'carimbado'
  | 'sem-pedido'
  | 'sem-frete'
  | 'outra-integradora'
  | 'ja-carimbado'
  | 'estado-ilegivel'
  | 'fora-do-escopo';

function objetoDe(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/* -------------------------------------------------------------------------- */
/*                                 the decision                                */
/* -------------------------------------------------------------------------- */

/**
 * The whole stamp DECISION, as a pure function of the stored pedido.
 *
 * The transaction below runs it on its own `tx.get` snapshot, which is what makes
 * the OCC retry re-derive every guard; a rehearsal may run it on a plain read and
 * print exactly what a live stamp would write. `raw` is `null` when the pedido
 * does not exist. Nothing here writes, reads a clock or touches the network, and
 * `raw` is never mutated — the block is rebuilt by spread.
 *
 * The patch is non-null exactly when the motivo is `carimbado` — the type says so.
 */
export function preverCarimboNfeShopee(
  raw: Record<string, unknown> | null,
  nowUs: number,
):
  | {
      readonly motivo: 'carimbado';
      readonly patch: {
        readonly freteInicial: Record<string, unknown>;
        readonly ultimaModificacao: number;
      };
    }
  | { readonly motivo: Exclude<MotivoCarimbo, 'carimbado'>; readonly patch: null } {
  if (raw === null) return { motivo: 'sem-pedido', patch: null };

  const armazenado = objetoDe(raw.freteInicial);
  if (armazenado === null) return { motivo: 'sem-frete', patch: null };

  // Strict equality on the stored slug: an absent owner, another channel or a
  // differently-cased value all refuse — a block not PROVED the channel's is
  // never stamped.
  if (armazenado.externalOptionIntegracao !== INTEGRACAO_FRETE.shopee) {
    return { motivo: 'outra-integradora', patch: null };
  }

  // BEFORE the membership read: `error` is a real member, and the replay must be
  // told apart from "outside the scope" so the handler's log says which it was.
  if (armazenado.estado === ESTADO_FRETE.error) return { motivo: 'ja-carimbado', patch: null };

  const lido = estadoFreteSchema.safeParse(armazenado.estado);
  if (!lido.success) return { motivo: 'estado-ilegivel', patch: null };

  if (!ESTADOS_FRETE_CARIMBAVEIS_NFE.has(lido.data)) {
    return { motivo: 'fora-do-escopo', patch: null };
  }

  return {
    motivo: 'carimbado',
    patch: {
      // ⚠️ `...armazenado` FIRST — `tx.update` masks at the top-level key, so any
      // field of the block not carried here would be ERASED.
      freteInicial: { ...armazenado, estado: ESTADO_FRETE.error },
      ultimaModificacao: maiorUs(coerceToMicros(raw.ultimaModificacao), nowUs),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                               the transaction                               */
/* -------------------------------------------------------------------------- */

/**
 * Stamp ONE pedido's frete after a proven refusal. Class **C** — see the module
 * header. A Firestore failure PROPAGATES: the caller has already raised the aviso,
 * and a swallowed stamp would leave the pedido looking dispatchable.
 */
export async function carimbarFreteNfeShopee(
  db: Firestore,
  pedidoId: string,
  nowUs: number,
): Promise<MotivoCarimbo> {
  return db.runTransaction(async (tx: Transaction) => {
    const ref = pedidoCollection.docRef(db, {}, pedidoId);
    const snap = await tx.get(ref);
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;

    // ⚠️ Every decision re-derived from THIS attempt's own read — the snapshot is
    // the only input that can have moved since the handler looked.
    const previsao = preverCarimboNfeShopee(raw, nowUs);

    if (previsao.patch !== null) {
      // `tx.update`, never `tx.set`: a set would wipe the pedido's itens, money
      // and estado, and an update of an absent pedido fails instead of creating.
      tx.update(
        ref,
        pedidoCollection.parseMerge({
          freteInicial: previsao.patch.freteInicial,
          ultimaModificacao: previsao.patch.ultimaModificacao,
        }),
      );
    }

    return previsao.motivo;
  });
}
