/**
 * The User-Products SOLE MEMBER (#1087) — the Firestore half.
 *
 * `upSoleMember.ts` decides WHAT the child looks like; this writes it. Kept apart
 * so the planner stays importable without `firebase-admin` — the one-time
 * `tools/migrations` script shares the planner and brings its own writer.
 *
 * ---- Write ORDER is load-bearing, not stylistic
 *
 * Child produto → child estoques → child member link → parent estoque zeros →
 * parent link patch. The parent link goes **last** because `linkHasLiveListing`
 * (`id` non-empty AND `estado !== 'c'`) is what puts the produto in
 * `produtos.integracoesComProduto`, the anchor pre-filter BOTH sweeps open with.
 * Staging the parent through any state where that predicate is false would drop
 * the produto out of stock and price sync — silently, with nothing logged, until
 * some later write happened to put it back.
 *
 * ---- Idempotence
 *
 * The child produto and its link are `create()`d at a deterministic id, and an
 * ALREADY_EXISTS is an ADOPTION, not an error: a retried publish, a Cloud Tasks
 * redelivery and a concurrent second publish all converge on the same documents
 * (root `CLAUDE.md` rule 7, tier 0 — the race is made impossible rather than
 * guarded). The estoque move is the one step that is not naturally idempotent, so
 * it is skipped whenever the child already had a row: re-running the move after a
 * partial write would copy an already-zeroed parent quantity over a good child one.
 */
import type { Firestore } from 'firebase-admin/firestore';

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
 * Throws {@link MercadoLivrePublishError} when the planner refuses (today: an open
 * reservation on the stock being moved), so the route's existing 422 mapping
 * carries the reason to the operator unchanged.
 */
export async function garantirMembroUnico(
  deps: GarantirMembroUnicoDeps,
  args: GarantirMembroUnicoArgs,
): Promise<{ id: string; data: Produto }> {
  const { db, integracaoId } = deps;
  const { produtoId, produto, parentLinkDocId } = args;

  // ⚠️ Does the child ALREADY exist? Asked first, and it decides whether there is a
  // stock move at all. A republish — by far the common case — has nothing to move:
  // the child was materialised on an earlier run and already owns the stock.
  // Planning a move anyway would re-copy the parent's now-ZEROED quantity over a
  // good child row, AND hit the reservation refusal below, blocking a publish that
  // touches no stock whatsoever.
  const childIdPrevisto = membroUnicoChildId(args.acao, produtoId, parentLinkDocId, args.link.id);
  const childJaExiste = (await produtoCollection.docRef(db, {}, childIdPrevisto).get()).exists;

  // The parent's stock, per depósito, as it stands before the move. Empty when the
  // child already exists — nothing to move, and therefore nothing to refuse.
  const estoqueSnap = childJaExiste ? null : await estoqueCollection.ref(db, { produtoId }).get();
  const estoques: MembroUnicoEstoque[] = (estoqueSnap?.docs ?? []).map((d): MembroUnicoEstoque => {
    const raw = d.data() as Record<string, unknown>;
    return {
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

  // ---- 1. the child produto -------------------------------------------------
  const childRef = produtoCollection.docRef(db, {}, plano.childProdutoId);
  let childCreated = true;
  try {
    await childRef.create(plano.produto);
  } catch (err) {
    // Not an error: a retry, a redelivery or a concurrent publish already minted
    // it. Adopt rather than overwrite — the stored child may carry operator edits.
    if (!isAlreadyExists(err)) throw err;
    childCreated = false;
  }

  // ---- 2. the child's stock, and only on the run that minted the child -------
  // ⚠️ Gated on `childCreated`, or a second pass copies the parent's ALREADY
  // ZEROED quantity over a good child row.
  if (childCreated) {
    for (const e of plano.estoques) {
      await estoqueCollection.docRef(db, { produtoId: plano.childProdutoId }, e.docId).set(e.data);
    }
  }

  // ---- 3. the member link ---------------------------------------------------
  // ⛔ Before the fan-out reads it. `publish.ts`'s `findVariacaoLink` is what turns
  // an adoption into a PUT; without this doc the fan-out POSTs a second item and
  // the orphan sweep closes the original.
  const memberRef = variacaoMercadoLivreLinkCollection.docRef(
    db,
    { produtoId: plano.childProdutoId },
    plano.childLinkDocId,
  );
  try {
    await memberRef.create(plano.link);
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }

  // ---- 4. what the parent keeps: its RESERVED units -------------------------
  // ⚠️ Rewritten, never deleted: `onEstoqueDeleted` cascades into the row's whole
  // `historicoEstoque` subcollection, so a delete here would destroy the produto's
  // stock audit trail — and would also remove the row an open pedido's release
  // still decrements.
  if (childCreated) {
    for (const z of plano.parentEstoqueRestos) {
      await estoqueCollection.docRef(db, { produtoId }, z.docId).set(z.data, { merge: true });
    }
  }

  // ---- 5. the parent link, LAST — see the module docblock -------------------
  await produtoMercadoLivreLinkCollection
    .docRef(db, { produtoId }, parentLinkDocId)
    .set(plano.parentLinkPatch, { merge: true });

  const childSnap = await childRef.get();
  return {
    id: plano.childProdutoId,
    data: produtoCollection.parseRead(
      childSnap.data() ?? plano.produto,
      produtoCollection.docPath({}, plano.childProdutoId),
    ),
  };
}
