/**
 * The pagamento writes of one batch attempt (master plan step 6, PR 6): PR
 * 5-d's hook in `escritaPedido.ts`, filled. The decision itself is pure and
 * lives in `pagamentoAmazon.ts`, reached through the pedido decision of the
 * SAME attempt (`montarEscritaPedidoAmazon` answers both); this module turns it
 * into batch writes against THAT attempt's pagamento snapshot:
 *
 *  - a `create` (parsed through the pagamento handle: a `ZodError` refuses the
 *    order before any write);
 *  - an `update(patch, { lastUpdateTime: <the snapshot's updateTime> })`
 *    (`parseMerge`d);
 *  - or the pagamento's PRECONDITION CARRIER (below), or nothing.
 *
 * ## The pagamento is proven current at commit (closes PR 5-d's residue)
 *
 * Every pedido decision reads the pagamento: the CANCELLED predicate its
 * status, the status ladder too, `Z` and the row-10 comparison its `valor`. So
 * whenever the batch commits a PEDIDO write and the pagamento EXISTS, the batch
 * also carries the pagamento's precondition — its own update when one was
 * decided, otherwise a CARRIER: an update re-writing ONE stored field exactly as
 * read ({@link CAMPOS_PORTADOR_PAGAMENTO_AMAZON}), under the snapshot's
 * `lastUpdateTime`. That includes the arms that leave the pagamento alone (an
 * operator's off-ladder status, an `estornado` kept, a reversal). A
 * content-identical write: the server moves nothing and answers it with the
 * document's PREVIOUS update time (measured on the emulator), and the
 * pagamento's history trigger diffs nothing. A pagamento changed since the read
 * fails the carrier's precondition, the batch writes nothing, and the next
 * attempt re-derives from both documents.
 *
 * Residues, documented rather than guarded:
 *  - an ABSENT pagamento cannot be guarded without a write (beside `create`, the
 *    Admin SDK has no "still absent" precondition), so one created between the
 *    read and the commit is not seen by that attempt; the order's next import
 *    re-derives from it;
 *  - a stored pagamento holding none of the carrier fields cannot carry one, and
 *    is then not proven current (no such document is known: every writer of a
 *    pagamento stamps `status_pagamento`).
 */
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { pagamentoCollection } from '@delfrance/data/admin/collections';

import type {
  DecidirPagamentosAmazon,
  EscritaPagamentoAmazon,
  EscritaPedidoDecididaAmazon,
} from './escritaPedido';

/**
 * The stored fields a carrier may re-write, in preference order: top-level
 * scalars a pagamento carries (never a dotted name, which `update` reads as a
 * field path). `status_pagamento` first — the field the decision read, and an
 * integer, so re-writing the value read is byte-identical on the server.
 */
export const CAMPOS_PORTADOR_PAGAMENTO_AMAZON = [
  'status_pagamento',
  'id',
  'forma_de_pagamento',
  'dataCadastro',
  'valor',
  'ultimaModificacao',
] as const;

/** The carrier's one-field patch (the stored value, raw), or `null` when none can carry. */
export function portadorDoPagamentoAmazon(
  dados: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  for (const campo of CAMPOS_PORTADOR_PAGAMENTO_AMAZON) {
    if (Object.hasOwn(dados, campo) && dados[campo] !== undefined) return { [campo]: dados[campo] };
  }
  return null;
}

/**
 * PR 6's hook (module header): the pagamento writes of one attempt, from THAT
 * attempt's pagamento snapshot and pedido decision.
 */
export const decidirPagamentosAmazon: DecidirPagamentosAmazon = (
  pagamento: DocumentSnapshot,
  escrita: EscritaPedidoDecididaAmazon,
): readonly EscritaPagamentoAmazon[] => {
  const decidida = escrita.pagamento;
  const lastUpdateTime = pagamento.updateTime;
  if (decidida.tipo === 'criar') {
    if (pagamento.exists) {
      // Unreachable: a create is decided only against an absent pagamento.
      throw new RangeError('decidirPagamentosAmazon: criar sobre um pagamento existente');
    }
    return [
      {
        tipo: 'criar',
        ref: pagamento.ref,
        dados: pagamentoCollection.parse(decidida.corpo) as Record<string, unknown>,
      },
    ];
  }
  if (decidida.tipo === 'atualizar') {
    if (!pagamento.exists || lastUpdateTime === undefined) {
      // Unreachable: an update is decided only against a stored pagamento.
      throw new RangeError('decidirPagamentosAmazon: atualizar sem pagamento');
    }
    return [
      {
        tipo: 'atualizar',
        ref: pagamento.ref,
        dados: pagamentoCollection.parseMerge({ ...decidida.patch }) as Record<string, unknown>,
        lastUpdateTime,
        portador: false,
      },
    ];
  }
  // Nothing decided for the pagamento: its precondition still rides a pedido write.
  if (escrita.tipo === 'sem-mudanca' || !pagamento.exists || lastUpdateTime === undefined) {
    return [];
  }
  const dados = portadorDoPagamentoAmazon(pagamento.data() ?? {});
  return dados === null
    ? []
    : [{ tipo: 'atualizar', ref: pagamento.ref, dados, lastUpdateTime, portador: true }];
};
