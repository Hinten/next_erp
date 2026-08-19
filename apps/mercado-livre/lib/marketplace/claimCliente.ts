/**
 * The claim buyer as a **cliente** (#768) — the replacement for
 * `claimUsuario.ts`, which minted a sem-auth `usuarios` doc per ML buyer.
 *
 * `usuarios` is now only for people who can log into the ERP. A marketplace
 * contact is a cliente, and for a claim the cliente is already known: the claim
 * hangs off a pedido, and the pedido carries `clientePedidoOuterRef`. So there
 * is nothing to find-or-create here — only one thing worth writing back.
 *
 * ⚠️ **Stamping `idMercadoLivre` is the whole point of this module.** A buyer
 * who asks a pre-sale question is resolved BY that id (`questionImport.ts`),
 * while an order-imported cliente is resolved by CPF/e-mail/telefone and carries
 * no ML id at all. Without this write the same person forks into two clientes —
 * one from their question, one from their order — and neither ever converges.
 * The claim is the first place both facts are in hand at once.
 *
 * ⚠️ **Fill-only-when-absent**, never overwrite. A stored id that disagrees is
 * either a cliente shared by two ML accounts or an earlier mistake; silently
 * rewriting it would move the identity under whichever claim arrived last —
 * root `CLAUDE.md` rule 7, tier 3. It is logged and left alone.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { clienteCollection } from '@delfrance/data/admin/collections';
import { idFromRef } from '@delfrance/schemas';

export interface VincularClienteResult {
  /** `documents/clientes/<id>`, echoed back for the mappers. */
  readonly clienteOuterRef: string;
  /** True when this run wrote the ML id onto a cliente that had none. */
  readonly carimbouIdMercadoLivre: boolean;
}

/**
 * Record the buyer's ML user id on the pedido's cliente, when it has none.
 *
 * Never creates a cliente: on this path one always exists (the caller has
 * already refused a pedido without `clientePedidoOuterRef`). A cliente doc that
 * has since been deleted is a no-op, not an error — the conversa still imports,
 * it just carries a ref to a gone document, exactly as it would have with the
 * old usuario path.
 */
export async function vincularClienteMercadoLivre(
  db: Firestore,
  args: { clienteOuterRef: string; buyerUserId: number },
): Promise<VincularClienteResult> {
  const clienteId = idFromRef(args.clienteOuterRef);
  const snap = await clienteCollection.docRef(db, {}, clienteId).get();
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

  await clienteCollection.merge(db, {}, clienteId, { idMercadoLivre: desejado });
  return { clienteOuterRef: args.clienteOuterRef, carimbouIdMercadoLivre: true };
}
