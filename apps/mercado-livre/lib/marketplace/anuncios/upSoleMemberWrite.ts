/**
 * The User-Products SOLE MEMBER (#1087) — the Firestore half.
 *
 * `upSoleMember.ts` decides WHAT the child looks like; this writes it. Kept apart
 * so the planner stays importable without `firebase-admin` — the one-time
 * `tools/migrations` script shares the planner and brings its own writer.
 *
 * ---- ⛔ The reshape is ONE atomic WriteBatch, and it has to be
 *
 * `garantirMembroUnico` is only ever reached while the produto has NO children, so
 * the instant the child produto exists every later publish sees
 * `children.length === 1`, `classificarMembroUnico` answers `'nenhum'`, and this
 * code is never called again. That makes a partial write PERMANENT rather than
 * merely untidy, in one of two directions:
 *
 *   - child minted, stock not moved → the child owns nothing, and the family
 *     publishes and sweeps at quantidade 0 for ever on a produto that has stock;
 *   - child's rows written, parent's not reduced → both hold the units and the ERP
 *     counts the same stock twice.
 *
 * Neither is reachable from a batch: it commits whole or not at all, and "not at
 * all" leaves the produto childless — exactly the state the next publish expects,
 * so the retry is simply the next publish. Same argument `aplicarEstoque` makes for
 * its own reshape ("ONE atomic WriteBatch").
 *
 * The parent LINK patch stays outside the batch: it is idempotent, and it must also
 * run on the adoption path where the batch is skipped. It never touches `id` or
 * `estado`, so it cannot drop the produto out of `integracoesComProduto` — the
 * anchor pre-filter BOTH sweeps open with.
 *
 * ---- Rule 7: the parent's stock moves as a DELTA
 *
 * The quantities come from a read taken several `await`s earlier. Writing an
 * absolute `quantidade` back would erase any *entrada* booked in that window, with
 * no `historicoEstoque` row and nothing to reconcile against — so the parent is
 * reduced with `FieldValue.increment(-movido)` and its clock advanced with
 * `FieldValue.maximum(now)`, both tier 0. The CHILD row stays an absolute `create`:
 * it is a brand-new document, so there is no concurrent writer to lose.
 *
 * ---- Idempotence
 *
 * The child produto and its link are `create()`d at a deterministic id, so an
 * ALREADY_EXISTS is an ADOPTION, not an error: a retried publish, a Cloud Tasks
 * redelivery and a concurrent second publish all converge on the same documents
 * (rule 7 tier 0 — the race is made impossible rather than guarded). Because the
 * four writes share one batch, that ALREADY_EXISTS also proves the other three
 * landed, so there is nothing left to reconcile.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import { isAlreadyExists } from '@delfrance/data/admin';
import {
  estoqueCollection,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import { type Produto, idFromRef } from '@delfrance/schemas';

import { MercadoLivrePublishError } from './publishCore';
import { membroUnicoChildId, planejarMembroUnico, type MembroUnicoEstoque } from './upSoleMember';

export interface GarantirMembroUnicoDeps {
  db: Firestore;
  integracaoId: string;
}

export interface GarantirMembroUnicoArgs {
  acao: 'criar' | 'adotar';
  produtoId: string;
  produto: Produto;
  parentLinkDocId: string;
  /** The parent link as stored — `id` is the ML item id when adopting. */
  link: {
    id: string | null;
    status: string | null;
    sub_status: string[] | null;
    userProductId: string | null;
    moderacoes: unknown;
  };
  now: number;
}

/**
 * Make sure this UP produto has its sole member child, and return it in the shape
 * `publish.ts` already uses for a variation child.
 *
 * Throws {@link MercadoLivrePublishError} when the planner refuses — today only an
 * adoption asked for with no anúncio to adopt — so the route's existing 422 mapping
 * carries the reason to the operator unchanged. ⚠️ A reserved depósito is NOT a
 * refusal: it splits the move (see `planejarMembroUnico`).
 */
export async function garantirMembroUnico(
  deps: GarantirMembroUnicoDeps,
  args: GarantirMembroUnicoArgs,
): Promise<{ id: string; data: Produto }> {
  const { db, integracaoId } = deps;
  const { produtoId, produto, parentLinkDocId } = args;

  // ⚠️ Does the child ALREADY exist? Asked first, because it decides whether there
  // is a stock move at all. This is a RACE guard rather than the common path: once
  // the child exists the produto has a child, so `classificarMembroUnico` answers
  // `'nenhum'` and this function is not called. It only fires when a concurrent
  // publish minted the child between our own read of `children` and here — and
  // re-applying the move there would double the delta.
  const childIdPrevisto = membroUnicoChildId(args.acao, produtoId, parentLinkDocId, args.link.id);
  const childJaExiste = (await produtoCollection.docRef(db, {}, childIdPrevisto).get()).exists;

  // The parent's stock, per depósito, as it stands before the move. Empty when the
  // child already exists — nothing to move, and therefore nothing to refuse.
  const estoqueSnap = childJaExiste ? null : await estoqueCollection.ref(db, { produtoId }).get();
  const estoques: MembroUnicoEstoque[] = (estoqueSnap?.docs ?? []).map((d): MembroUnicoEstoque => {
    const raw = d.data() as Record<string, unknown>;
    return {
      docId: d.id,
      depositoId: idFromRef(String(raw.depositoOuterRef ?? '')),
      quantidade: typeof raw.quantidade === 'number' ? raw.quantidade : 0,
      quantidadeReservada: raw.quantidadeReservada,
    };
  });

  const resultado = planejarMembroUnico({
    acao: args.acao,
    produtoId,
    parentLinkDocId,
    integracaoId,
    produto: {
      nome: produto.nome,
      sku: produto.sku ?? null,
      ehKit: produto.ehKit ?? false,
      ehUsado: produto.ehUsado ?? false,
      precos: produto.precos ?? null,
      pesoLiquidoKg: produto.pesoLiquidoKg,
      pesoBrutoKg: produto.pesoBrutoKg,
      alturaCm: produto.alturaCm,
      larguraCm: produto.larguraCm,
      profundidadeCm: produto.profundidadeCm,
      categoriaProdutoOuterRef: produto.categoriaProdutoOuterRef,
    },
    link: {
      id: args.link.id,
      status: args.link.status,
      sub_status: args.link.sub_status,
      userProductId: args.link.userProductId,
      moderacoes: (args.link.moderacoes ?? null) as never,
    },
    estoques,
    now: args.now,
  });

  if (!resultado.ok) throw new MercadoLivrePublishError(resultado.recusas);
  const plano = resultado.plano;

  const childRef = produtoCollection.docRef(db, {}, plano.childProdutoId);
  const memberRef = variacaoMercadoLivreLinkCollection.docRef(
    db,
    { produtoId: plano.childProdutoId },
    plano.childLinkDocId,
  );

  // ---- 1. the whole reshape, atomically — see the module docblock -----------
  // True unless OUR batch is the one that landed: either the child already existed
  // when we looked, or our `create` lost to a concurrent publish.
  let perdeuACorrida = true;
  if (!childJaExiste) {
    const batch = db.batch();
    batch.create(childRef, plano.produto);
    for (const e of plano.estoques) {
      batch.create(
        estoqueCollection.docRef(db, { produtoId: plano.childProdutoId }, e.docId),
        e.data,
      );
    }
    // ⛔ The member link, and it is what makes an adoption safe: `publish.ts`'s
    // `findVariacaoLink` reads it to decide PUT vs POST. Without it the fan-out
    // POSTs a SECOND item and `sweepRemovedMembers` closes the original.
    batch.create(memberRef, plano.link);
    for (const s of plano.parentEstoqueSaidas) {
      // Nothing moved (a fully reserved depósito) ⇒ no write at all, rather than a
      // no-op that still bumps the row's clock.
      if (s.movido === 0) continue;
      batch.update(estoqueCollection.docRef(db, { produtoId }, s.docId), {
        quantidade: FieldValue.increment(-s.movido),
        ultimaModificacao: FieldValue.maximum(args.now),
      });
    }

    try {
      await batch.commit();
      perdeuACorrida = false;
    } catch (err) {
      // A concurrent publish won the race and committed the SAME four writes,
      // atomically. Nothing to redo — and, the point of the batch, no half-move
      // left behind to repair.
      if (!isAlreadyExists(err)) throw err;
    }
  }

  // ⛔ Whoever LOSES the race still has to end up with a member link, and this is
  // not housekeeping. `publish.ts`'s `findVariacaoLink` reads it to decide PUT vs
  // POST: without it the loser's fan-out treats the member as new, `createItem`
  // POSTs a SECOND ML item, and `sweepRemovedMembers` then confirms the original as
  // an orphan and closes it. The batch that would have written this link is exactly
  // the one that just failed, so the recovery has to be here.
  //
  // The stock move is deliberately NOT retried: the winner's batch already applied
  // it whole, and re-applying a delta would double it.
  if (perdeuACorrida) {
    try {
      await memberRef.create(plano.link);
    } catch (err) {
      // The winner's own batch already wrote it, carrying the same item id.
      if (!isAlreadyExists(err)) throw err;
    }
  }

  // ---- 2. the parent link ---------------------------------------------------
  // `mergeIfExists`, not a raw `set(..., { merge: true })`: if the link doc was
  // deleted between the read at the top of `publishProduto` and here, an upsert
  // would resurrect a ghost carrying only `userProductId` and a clock. Same helper
  // `writeLinkDoc` uses, for the same reason.
  // ⚠️ No `ultimaModificacao` here, deliberately. Every path out of `publishProduto`
  // already stamps it on this doc — `writeLinkDoc` on success, `stampErrorLinkDoc`
  // on an ML failure — so writing it too would be redundant, and it could only be a
  // PLAIN write: `mergeIfExists` validates through Zod, which rejects a
  // `FieldValue` sentinel, and a plain `now` captured at the top of the request can
  // move the field backwards over a later commit.
  await produtoMercadoLivreLinkCollection.mergeIfExists(
    db,
    { produtoId },
    parentLinkDocId,
    plano.parentLinkPatch,
  );

  const childSnap = await childRef.get();
  return {
    id: plano.childProdutoId,
    data: produtoCollection.parseRead(
      childSnap.data() ?? plano.produto,
      produtoCollection.docPath({}, plano.childProdutoId),
    ),
  };
}
