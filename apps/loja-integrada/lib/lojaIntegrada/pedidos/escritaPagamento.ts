/**
 * Import step 9 (master plan step 6, PR 5-c): each of the order's payments READ
 * and DECIDED — never written here. `escritaPedido.ts` puts every write this
 * returns into the ONE atomic batch it commits with the pedido (step 10), each
 * under its own precondition, and calls this again from fresh reads whenever a
 * precondition is lost.
 *
 * Every rule of the decision is `pagamentoMapeamento.ts`'s (its "Rule 7" header
 * is the batch contract): the forma, the card block, the instalments, the
 * status ladder, the dates, the watermark compare. This module only reads each
 * stored document raw, hands it to `montarEscritaPagamentoLi`, and parses what
 * comes back through the handle — the full document for a create, the patch for
 * an update — so a `ZodError` refuses the order BEFORE anything is written.
 *
 * Each document is read through the admin handle with NO converter: the
 * decision compares raw stored values, and a soft-parsed read would hand it the
 * schema's defaults instead of what is there.
 */
import type { DocumentReference, Firestore, Timestamp } from 'firebase-admin/firestore';
import { pagamentoCollection } from '@delfrance/data/admin/collections';

import { montarEscritaPagamentoLi, type PagamentoMapeadoLi } from './pagamentoMapeamento';

/** One payment write, decided and parsed, ready for the batch. */
export type EscritaPagamentoDecididaLi =
  | {
      readonly tipo: 'criar';
      readonly docId: string;
      readonly ref: DocumentReference;
      readonly dados: Readonly<Record<string, unknown>>;
    }
  | {
      readonly tipo: 'atualizar';
      readonly docId: string;
      readonly ref: DocumentReference;
      readonly dados: Readonly<Record<string, unknown>>;
      /** The update time of the snapshot this write was decided from: its precondition. */
      readonly lastUpdateTime: Timestamp;
      /** A dead status was left (logged by the importer). */
      readonly statusRessuscitado: boolean;
    };

export interface PagamentosDecididosLi {
  /** The writes, in the order of the order's `pagamentos[]`. */
  readonly escritas: readonly EscritaPagamentoDecididaLi[];
  /** Payments whose stored stamp is strictly newer: nothing written for them. */
  readonly obsoletos: readonly string[];
  /** Payments whose stored document already says everything: nothing written. */
  readonly semMudanca: readonly string[];
}

/**
 * Read and decide every payment of the pedido `pedidoId` (module header).
 *
 * @throws ZodError when a decided write does not parse — before any write.
 */
export async function decidirPagamentosLi(
  db: Firestore,
  pedidoId: string,
  mapeados: readonly PagamentoMapeadoLi[],
  nowUs: number,
): Promise<PagamentosDecididosLi> {
  const lidos = await Promise.all(
    mapeados.map(async (mapeado) => {
      const ref = pagamentoCollection.docRef(db, { pedidoId }, mapeado.docId);
      return { mapeado, ref, snap: await ref.get() };
    }),
  );

  const escritas: EscritaPagamentoDecididaLi[] = [];
  const obsoletos: string[] = [];
  const semMudanca: string[] = [];
  for (const { mapeado, ref, snap } of lidos) {
    const armazenado = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
    const escrita = montarEscritaPagamentoLi(armazenado, mapeado, nowUs);
    switch (escrita.tipo) {
      case 'criar':
        escritas.push({
          tipo: 'criar',
          docId: mapeado.docId,
          ref,
          dados: pagamentoCollection.parse(escrita.corpo) as Record<string, unknown>,
        });
        break;
      case 'atualizar': {
        const lastUpdateTime = snap.updateTime;
        if (lastUpdateTime === undefined) {
          // Unreachable: `montarEscritaPagamentoLi` answers `atualizar` only for a stored document.
          throw new RangeError('decidirPagamentosLi: atualizar sem updateTime');
        }
        escritas.push({
          tipo: 'atualizar',
          docId: mapeado.docId,
          ref,
          dados: pagamentoCollection.parseMerge({ ...escrita.patch }),
          lastUpdateTime,
          statusRessuscitado: escrita.statusRessuscitado,
        });
        break;
      }
      case 'obsoleto':
        obsoletos.push(mapeado.docId);
        break;
      case 'sem-mudanca':
        semMudanca.push(mapeado.docId);
        break;
    }
  }
  return { escritas, obsoletos, semMudanca };
}
