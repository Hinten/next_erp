/**
 * The `grupoDeVariacoes` side of the Shopee listing import (#1517, step 9),
 * WRITTEN — the per-dispatch candidate memo and the applier of the
 * `GrupoPlanejado` entries the pure core produced.
 *
 * ## ⚠️ The candidates are a per-DISPATCH memo, not three queries
 *
 * Rung 1 of the grupo cascade has to find an OPERATOR-authored mapping stored in
 * `grupoDeVariacoes.linksVariacoesShopee[]` — an array of objects. Firestore
 * cannot query inside one (`array-contains` needs exact element equality, and
 * the field is `z.array(z.unknown())` anyway), so the only way to find that
 * mapping is to scan it in memory. Failing to find it mints a DUPLICATE grupo
 * and breaks a future publish, because step 11's export reads exactly that
 * mapping with a non-null assertion.
 *
 * So: ONE full read of the collection per dispatch, performed LAZILY on the
 * first item that has models, reused by every later item and every rung. Cost is
 * bounded — `maxConcurrentDispatches: 1`, so at most one such read is in flight.
 * A no-model catalogue pays nothing at all, which is why the memo is lazy rather
 * than eager; and a per-ITEM load would multiply the cost by the page size on a
 * database that bills DATA SCANNED (root `CLAUDE.md` rule 1).
 *
 * The cheaper arm, if the collection ever grows enough to bite: the three bounded
 * candidate queries (`docRef`, `nome ==`, `tipo ==`, all three indexed),
 * accepting the duplicate-grupo risk. The size is a register item.
 *
 * ## ⚠️ The write is ADR 0011 **tier 1**, and that is the whole design
 *
 * A guarded `update(patch, { lastUpdateTime })` naming ONLY `variacoes`,
 * `variacoesIds`, `linksVariacoesShopee` and `ultimaModificacao`. Three reasons
 * it beats the obvious alternative here:
 *
 *  1. **It cannot strip.** `grupoDeVariacoesSchema` has no `.passthrough()`, so a
 *     full-document write of a re-parsed doc would DELETE every key the Flutter
 *     app still authors and this repo does not model. An `update` masks at the
 *     top-level key: everything unnamed survives untouched, with no raw spread
 *     and no delta splice.
 *  2. **A lost race is a FAILED_PRECONDITION, never a silent lost update.** The
 *     patch is derived from the memo's copy of the document and asserts THAT
 *     read's stamp.
 *  3. It costs no retry-loop machinery and names no API whose mere mention would
 *     drag this file into an inventory it has nothing to say to.
 *
 * Retry policy: exactly ONE bounded retry, and it RE-READS and RE-PLANS.
 * Re-applying the same patch would defeat the guard — it would write the loser's
 * values over the winner's, which is precisely what the precondition exists to
 * stop. A second loss refuses the ITEM (`taxonomia-em-conflito`) BEFORE any
 * produto write: proceeding with a partial taxonomy leaves children whose
 * combinations mismatch on the next import, and the combination rung then mints
 * DUPLICATE children — a permanent duplicate bought for a transient conflict.
 *
 * ⚠️ `ordem` is written on CREATE only. An existing grupo's `ordem` belongs to
 * the operator: it is the order `reconstructFromVariacoesUid` joins names in, so
 * re-stamping it would silently rewrite every child name of every channel.
 *
 * Next-free, clock-free: `nowMs` is a parameter.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { isAlreadyExists, isFailedPrecondition } from '@delfrance/data/admin';
import { grupoDeVariacoesCollection } from '@delfrance/data/admin/collections';

import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from './errosImportacao';
import type { DocumentoDeGrupo, GrupoMemo, MemoDeGrupos } from './itemLido';
import type { GrupoPlanejado } from './taxonomiaShopeeCore';

/**
 * Build the per-dispatch memo.
 *
 * ⚠️ Lazy AND single-flight: `carregar()` performs at most ONE read for the life
 * of the object, whatever the concurrency, because it memoises the PROMISE and
 * not the result. Memoising the result would let two items that ask before the
 * first read resolves each issue their own.
 */
export function criarMemoDeGrupos(db: Firestore): MemoDeGrupos {
  let pendente: Promise<GrupoMemo> | null = null;
  return {
    carregar(): Promise<GrupoMemo> {
      pendente ??= lerTodosOsGrupos(db);
      return pendente;
    },
  };
}

async function lerTodosOsGrupos(db: Firestore): Promise<GrupoMemo> {
  const snap = await grupoDeVariacoesCollection.ref(db, {}).get();
  const docs: DocumentoDeGrupo[] = snap.docs.map((d) => ({
    id: d.id,
    // ⚠️ RAW, never `parseRead`: the cascade reads `linksVariacoesShopee`, which
    // the schema types as `z.array(z.unknown())`, and a parse would also spend
    // validation on every operator-authored grupo in the database.
    raw: (d.data() ?? {}) as Record<string, unknown>,
    updateTime: d.updateTime,
  }));
  return { docs };
}

export interface ArgsAplicarTaxonomia {
  /** What the pure core planned, in tier order. */
  readonly grupos: readonly GrupoPlanejado[];
  /** The memo the plan was built from — it carries the stamps the patches assert. */
  readonly memo: GrupoMemo;
  /** MILLISECONDS. */
  readonly nowMs: number;
  /** For the refusal's message. */
  readonly itemId: number;
}

/**
 * Create every new grupo and apply every guarded patch.
 *
 * Runs FIRST in the write order, so a refusal here costs no half-written produto.
 *
 * ⚠️ A lost precondition (or a lost create race) THROWS
 * `taxonomia-em-conflito` — it never re-applies. The bounded RE-PLAN lives one
 * level up, in `importarAnuncio.ts`, which re-runs the whole item once against a
 * FRESH memo: the planning input is the whole listing (tiers, models, category,
 * candidates) and the planner is pure, so re-planning there costs one re-read
 * and cannot grow a second copy of the cascade here. A second loss propagates
 * the same refusal, and because this step is FIRST it has still written no
 * produto.
 */
export async function aplicarTaxonomiaShopee(
  db: Firestore,
  args: ArgsAplicarTaxonomia,
): Promise<void> {
  const perdeu = await aplicarUmaVez(db, args.grupos, args.memo, args.nowMs);
  if (perdeu) {
    throw new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.taxonomiaEmConflito,
      args.itemId,
      'outro gravador alterou o mesmo grupoDeVariacoes durante o planejamento',
    );
  }
}

/**
 * One pass over the planned grupos. Answers `true` when a write LOST its
 * precondition (or lost a create race), which is the caller's signal to re-plan.
 */
async function aplicarUmaVez(
  db: Firestore,
  grupos: readonly GrupoPlanejado[],
  memo: GrupoMemo,
  nowMs: number,
): Promise<boolean> {
  const carimbos = new Map(memo.docs.map((d) => [d.id, d.updateTime]));

  for (const grupo of grupos) {
    if (grupo.criar) {
      if (grupo.docNovo === null) continue;
      try {
        await grupoDeVariacoesCollection
          .docRef(db, {}, grupo.grupoId)
          .create(grupoDeVariacoesCollection.parse(grupo.docNovo));
      } catch (err) {
        // Someone else created the same grupo between the memo read and now.
        // That is a lost race like any other — re-plan against what they wrote
        // instead of overwriting it.
        if (isAlreadyExists(err)) return true;
        throw err;
      }
      continue;
    }

    if (grupo.patch === null) continue;

    // ⚠️ `ultimaModificacao` is added HERE, not in the pure core: the core plans
    // the CONTENT and this layer stamps the write. The patch names four keys and
    // nothing else, so every key the Flutter app owns survives.
    const patch = { ...grupo.patch, ultimaModificacao: nowMs };
    const ref = grupoDeVariacoesCollection.docRef(db, {}, grupo.grupoId);
    const lastUpdateTime = carimbos.get(grupo.grupoId);
    try {
      // The unguarded arm exists only so an in-memory double may omit the stamp;
      // a real snapshot of an existing document always carries one.
      // The cast is the seam's, not a shortcut: the memo carries the stamp as
      // `unknown` because nothing in this repo reads it — it is handed straight
      // back to the SDK that produced it (or to the double that mimics it).
      await (lastUpdateTime !== undefined
        ? ref.update(patch, { lastUpdateTime: lastUpdateTime as Timestamp })
        : ref.update(patch));
    } catch (err) {
      if (isFailedPrecondition(err)) return true;
      throw err;
    }
  }

  return false;
}
