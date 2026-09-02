/**
 * The claim buyer as a **cliente** (#768) — the replacement for
 * `claimUsuario.ts`, which minted a sem-auth `usuarios` doc per ML buyer.
 *
 * `usuarios` is now only for people who can log into the ERP. A marketplace
 * contact is a cliente, and for a claim the cliente is already known: the claim
 * hangs off a pedido, and the pedido carries `clientePedidoOuterRef`. So there
 * is nothing to find-or-create here — only one thing worth writing back.
 *
 * ⚠️ **This stamps an identity key; it does NOT merge clientes.** A buyer can
 * already own a second doc: `questionImport.ts` resolves a pre-sale asker BY
 * `idMercadoLivre`, while `orderImport.ts` may create a different cliente from
 * the billing identity on the same person's order. Writing the ML id onto the
 * pedido's cliente when another doc already claims it would leave **two strong
 * owners of one identity**, and `findOrCreateCliente`'s match leg could then
 * return either — the ambiguity #1067 exists to prevent, manufactured here.
 *
 * So the stamp is refused whenever the id already belongs to a different
 * cliente, and the split is logged for a human. Merging two clientes moves
 * pedidos, conversas and endereços; that is a migration, not a webhook's job.
 *
 * ⚠️ **Fill-only-when-absent, and the write carries a precondition.** The
 * decision is made from a snapshot, so an unguarded merge would be
 * last-write-wins: two claim deliveries carrying different buyer ids can both
 * observe an empty field, and the later write would silently replace the first
 * while this file claims it never overwrites. `lastUpdateTime` (root
 * `CLAUDE.md` rule 7, tier 1 — Admin-only) makes the loser fail loudly and
 * re-read instead.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { isFailedPrecondition } from '@delfrance/data/admin';
// `otherOwnerOfMlId` was this file's own `outroDonoDoId` until #1087. It moved
// to `@delfrance/data` because `findOrCreateCliente`'s fill-when-absent stamp
// needs the identical answer, and two implementations of "who else owns this?"
// would drift toward disagreeing about which buyers exist.
import { otherOwnerOfMlId } from '@delfrance/data/admin/clientes';
import { clienteCollection } from '@delfrance/data/admin/collections';
import { idFromRef } from '@delfrance/schemas';

export interface VincularClienteResult {
  /** `documents/clientes/<id>`, echoed back for the mappers. */
  readonly clienteOuterRef: string;
  /** True when this run wrote the ML id onto a cliente that had none. */
  readonly carimbouIdMercadoLivre: boolean;
  /**
   * Set when the id already belonged to a DIFFERENT cliente. The stamp is
   * refused and this names the other doc, so the split is visible in the result
   * as well as in the log.
   */
  readonly clienteConflitante?: string;
}

/**
 * Record the buyer's ML user id on the pedido's cliente, when it has none and
 * no one else already owns it.
 *
 * Never creates a cliente: on this path one always exists (the caller has
 * already refused a pedido without `clientePedidoOuterRef`). A cliente doc that
 * has since been deleted is a no-op, not an error.
 */
export async function vincularClienteMercadoLivre(
  db: Firestore,
  args: { clienteOuterRef: string; buyerUserId: number },
): Promise<VincularClienteResult> {
  const clienteId = idFromRef(args.clienteOuterRef);
  const ref = clienteCollection.docRef(db, {}, clienteId);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn('[mercado-livre] claim: cliente do pedido não existe mais', {
      clienteOuterRef: args.clienteOuterRef,
    });
    return { clienteOuterRef: args.clienteOuterRef, carimbouIdMercadoLivre: false };
  }

  const dados = snap.data() as Record<string, unknown>;
  const armazenado = typeof dados.idMercadoLivre === 'string' ? dados.idMercadoLivre.trim() : '';
  const desejado = String(args.buyerUserId);

  if (armazenado === desejado) {
    return { clienteOuterRef: args.clienteOuterRef, carimbouIdMercadoLivre: false };
  }
  if (armazenado !== '') {
    // Two ML accounts sharing one cliente, or an earlier wrong stamp. Either
    // way it is a human's call, not a webhook's.
    console.warn('[mercado-livre] claim: cliente já tem outro idMercadoLivre — mantido', {
      clienteId,
      armazenado,
      recebido: desejado,
    });
    return { clienteOuterRef: args.clienteOuterRef, carimbouIdMercadoLivre: false };
  }

  // ⚠️ Before creating a second owner of this identity, check whether one
  // exists. A pre-sale question resolves its asker BY this key, so the buyer's
  // question-cliente and their order-cliente are routinely different docs.
  const conflito = await otherOwnerOfMlId(db, desejado, clienteId);
  if (conflito != null) {
    console.warn(
      '[mercado-livre] claim: idMercadoLivre já pertence a outro cliente — não vinculado',
      {
        clienteDoPedido: clienteId,
        clienteExistente: conflito,
        idMercadoLivre: desejado,
      },
    );
    return {
      clienteOuterRef: args.clienteOuterRef,
      carimbouIdMercadoLivre: false,
      clienteConflitante: conflito,
    };
  }

  try {
    // Tier 1: the patch is derived from `snap`, so the write only lands if the
    // doc has not moved since. A concurrent delivery that filled the field
    // first makes this fail rather than silently overwrite it.
    await ref.update({ idMercadoLivre: desejado }, { lastUpdateTime: snap.updateTime });
  } catch (err) {
    if (!isFailedPrecondition(err)) throw err;
    console.warn('[mercado-livre] claim: cliente mudou durante a vinculação — carimbo descartado', {
      clienteId,
      idMercadoLivre: desejado,
    });
    return { clienteOuterRef: args.clienteOuterRef, carimbouIdMercadoLivre: false };
  }
  return { clienteOuterRef: args.clienteOuterRef, carimbouIdMercadoLivre: true };
}
