/**
 * Mercado Livre price-sync **reconciliation phase** (#1072) — the half of the
 * account-wide job that reports what the plan could not have enumerated.
 *
 * `precoPlan.fetchPrecoPage` asks PRODUTOS "do you carry this conta?"; this asks
 * the LINKS "which produto owns you?" — the unit the legacy enumerated
 * (`ProdutoMercadoLivre.documents.contaOuterRef__isEqualTo(conta)`,
 * `.old/lib/canaisDeVenda/mercadoLivre/pages/table.dart:41-43`). Anything the
 * anchor terms cannot express surfaces here: a produto whose
 * `integracoesComProduto` denorm drifted (#804 class 2) and a link sitting on a
 * variation child (class 3). Class 1 is gone — `precoPlan` no longer gates on
 * `publicado`.
 *
 * ---- It is the INVERSE of the denorm trigger, and that is what makes it
 * correct rather than heuristic. `onProdutoMercadoLivreLinkChanged` runs
 * `linkHasLiveListing` over a link and writes the verdict onto that link's own
 * produto; this runs the SAME predicate over the SAME links and reports every
 * place the trigger's output disagrees with its input.
 *
 * ---- REPORT-ONLY, and the two classes differ in what the operator can do:
 *  - **class 2** is repairable from the UI — the produtos-table push reads
 *    anchors BY KEY (`fetchPrecoFamiliasByIds`) and carries none of the anchor
 *    terms, so the drifted produto sends fine from there;
 *  - **class 3 has NO send surface anywhere in the repo.** `precoManual`
 *    resolves a selection to `paiId ?? produtoId` and then refuses a row whose
 *    `paiId` is set (`FAMILIA_NAO_ENCONTRADA`), and `readFamilia` only ever
 *    reads `produtoMercadoLivre` UNDER the anchor. The stock stack anchors the
 *    same way. So a class-3 row is a request to repair the DATA (the link
 *    belongs on the family parent), not a button to press — the pt-BR wording
 *    in `precoManual.MENSAGEM_POR_MOTIVO` says exactly that.
 *
 * Building drafts for class 3 instead was considered and deliberately deferred:
 * `draft.produtoId` is both the price source and the writeback's subcollection
 * parent, and `mergeIfExists` no-ops on a missing document rather than throwing,
 * so re-keying discovery without re-keying the draft writes `estado 'E'` /
 * `precoPublicado` either NOWHERE (auto-id links from `publish.ts`) or onto the
 * ANCHOR's link (the deterministic ids `import.ts` mints, which two produtos
 * naming one ML item share). Both are silent. The fix is a third fila field and
 * belongs with the same change on the stock sweep.
 *
 * ---- Index ledger: `produtoMercadoLivre(contaOuterRef ASC, __name__ ASC)`,
 * **COLLECTION_GROUP**. The declared COLLECTION-scope twin serves
 * `readFamilia` and `sobrevivemLinksDoProduto` and cannot serve a group query.
 * The parent produtos are read with a batch key read (`getAll` + `fieldMask`),
 * which needs no index and runs in the emulator.
 */
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { linkHasLiveListing } from '@delfrance/schemas';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { envFlag, envInt } from './bulkEstoquePlan';
import { contaRefForms } from './integracoesComProduto';

/* ------------------------------ configuration ----------------------------- */

/**
 * Flag env for the whole phase — OFF unless exactly `'1'`, the `envFlag`
 * convention shared with `MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED` and
 * `MERCADO_LIVRE_MISSED_FEEDS_ENABLED`.
 *
 * ⚠️ It exists to decouple MERGING this code from DEPLOYING its index, and
 * default-OFF is the safe direction rather than the timid one: the phase pages
 * a collection group on `contaOuterRef`, and on Enterprise a missing index does
 * not throw — it full-scans every `produtoMercadoLivre` document in the
 * database and bills the bytes (root `CLAUDE.md` rule 1). Turn it on only once
 * the COLLECTION_GROUP entry is live.
 */
export const PRECO_RECONCILIACAO_FLAG_ENV = 'MERCADO_LIVRE_PRECO_RECONCILIACAO_ENABLED';

/** Whether the reconciliation phase runs — read LAZILY, like every tunable here. */
export function precoReconciliacaoHabilitada(): boolean {
  return envFlag(PRECO_RECONCILIACAO_FLAG_ENV);
}

/**
 * Links inspected per dispatch (`MERCADO_LIVRE_PRECO_RECON_PAGE_LIMIT`).
 *
 * Much larger than `precoPageLimit()` because a reconciliation page does ZERO
 * ML I/O and no per-anchor join fan-out: one group query plus one batched key
 * read. Floored at 1 — a 0 would inspect nothing and the job would self-enqueue
 * forever.
 */
export function precoReconPageLimit(): number {
  return Math.max(1, envInt('MERCADO_LIVRE_PRECO_RECON_PAGE_LIMIT', 500));
}

/**
 * Cap on reconciliation pages one job may walk before it gives up and says so.
 *
 * The bound exists for one specific failure: a cursor that silently fails to
 * advance returns the same page forever, and the job would chain Cloud Tasks
 * until something else killed it. Past the cap the phase concludes and records
 * `RECONCILIACAO_INCOMPLETA` — the `PRICE_SYNC_MAX_PAUSES` discipline, refuse
 * loudly rather than retry forever.
 */
export const PRECO_RECON_MAX_PAGES = 200;

/* --------------------------------- the walk -------------------------------- */

/** One anúncio the anchor pass could not have reached, and why. */
export interface PrecoLinkNaoEnumerado {
  /** The produto that OWNS the link — the subcollection parent, anchor or not. */
  produtoId: string;
  /** The ML item id off the link's `id` field. */
  itemId: string | null;
  /** An `EnvioPrecoSkip.code` — one of the `NAO_ENUMERADO_*` values below. */
  code: string;
}

/** One page of the reconciliation walk. */
export interface PrecoReconPage {
  naoEnumerados: PrecoLinkNaoEnumerado[];
  /** Live links inspected on this page — observability, not a skip count. */
  inspecionados: number;
  /**
   * Keyset cursor: the FULL DOCUMENT PATH of the last link read when the page
   * came back full, null when the walk is drained.
   *
   * ⚠️ A path, not a doc id. In a COLLECTION GROUP `__name__` is the full path,
   * so `startAfter` needs a `DocumentReference` rebuilt from this value; the
   * bare-id form `fetchPrecoPage` uses is a root-collection affordance and does
   * not transfer — it throws "must result in a valid document path".
   */
  nextAfterLinkPath: string | null;
}

export interface FetchPrecoReconPageArgs {
  /** Conta whose anúncios are walked. */
  integracaoId: string;
  /** Resume after this FULL document path (keyset); the first page omits it. */
  afterLinkPath?: string | null;
  /** Page size override — defaults to `precoReconPageLimit()`. */
  pageLimit?: number;
}

/** The reconciliation seam the job consumes — injectable so tests stub it. */
export type FetchPrecoReconPage = (
  db: Firestore,
  args: FetchPrecoReconPageArgs,
) => Promise<PrecoReconPage>;

export const fetchPrecoReconPage: FetchPrecoReconPage = async (db, args) => {
  const pageLimit = args.pageLimit ?? precoReconPageLimit();
  const afterLinkPath = args.afterLinkPath ?? null;

  let linksQuery = produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('contaOuterRef', 'in', contaRefForms(args.integracaoId))
    // `id` + `estado` are exactly what `linkHasLiveListing` reads and what the
    // skip row reports. Everything else is dead weight — a link doc carries
    // `descricao` at up to 50 000 chars plus an `attributes` array, and
    // Enterprise bills what is scanned.
    .select('id', 'estado')
    .orderBy(FieldPath.documentId())
    .limit(pageLimit);
  if (afterLinkPath != null) linksQuery = linksQuery.startAfter(linkRefDoCursor(db, afterLinkPath));
  const linksSnap = await linksQuery.get();

  // Only the links that name something still sellable. A produto can carry
  // several listings on one conta, so this is a list, not a map.
  const vivos: { produtoId: string; itemId: string | null }[] = [];
  for (const doc of linksSnap.docs) {
    const raw = doc.data() as Record<string, unknown>;
    // ⚠️ THE noise guard, and the reason this report is readable at all. A link
    // with no item id was never published and one at `estado 'c'` is closed —
    // `linkHasLiveListing` is false for both, which is exactly why
    // `onProdutoMercadoLivreLinkChanged` dropped the conta from
    // `integracoesComProduto`. Reporting them would emit a row for every
    // listing the seller has ever closed: the healthy steady state rendered as
    // drift, burying the real findings under it. This is also the ONLY use of
    // the stored ML status here — a classification, never a query predicate.
    if (!linkHasLiveListing(raw)) continue;
    // A link always sits two levels under a produto; a null grandparent means a
    // path this collection group should not have matched.
    const produtoId = doc.ref.parent.parent?.id ?? null;
    if (produtoId == null) continue;
    vivos.push({ produtoId, itemId: nonEmptyString(raw.id) });
  }

  const naoEnumerados: PrecoLinkNaoEnumerado[] = [];
  if (vivos.length > 0) {
    const produtoIds = [...new Set(vivos.map((v) => v.produtoId))];
    const snaps = await db.getAll(...produtoIds.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: ['paiId', 'integracoesComProduto'],
    });
    const porId = new Map(snaps.map((snap) => [snap.id, snap]));

    for (const vivo of vivos) {
      const snap = porId.get(vivo.produtoId);
      const code = classificarLinkNaoEnumerado(
        snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
        args.integracaoId,
      );
      if (code != null) naoEnumerados.push({ ...vivo, code });
    }
  }

  const full = linksSnap.docs.length === pageLimit;
  const lastPath = linksSnap.docs[linksSnap.docs.length - 1]?.ref.path ?? null;
  return {
    naoEnumerados,
    inspecionados: vivos.length,
    nextAfterLinkPath: full ? lastPath : null,
  };
};

/**
 * Why the anchor pass could not have enumerated a live link's produto — or
 * `null` when it could have, which is the healthy case and reports nothing.
 *
 * ⚠️ This IS `fetchPrecoPage`'s anchor predicate, re-derived. If that query
 * gains or loses a term this must move with it, or the report starts naming
 * rows the plan did see (noise) or missing rows it did not (the very silence
 * #1072 exists to end). `precoReconciliacao.test.ts` pins the pair.
 */
export function classificarLinkNaoEnumerado(
  produto: Record<string, unknown> | null,
  integracaoId: string,
): string | null {
  // The link outlived its produto — `onProdutoDeleted`'s cascade should have
  // taken it, so this is a real orphan rather than a coverage gap.
  if (produto == null) return 'NAO_ENUMERADO_PRODUTO_AUSENTE';
  // The link sits on a variation CHILD, and every anchor term is written for
  // family parents (#804 class 3). No surface in the repo can send to it.
  if (nonEmptyString(produto.paiId) != null) return 'NAO_ENUMERADO_LINK_EM_VARIACAO';
  // The denorm no longer names a conta this produto is still linked to (#804
  // class 2). `integracoesComProduto.ts` calls this exact state a SILENT stock
  // + price outage — and until now it was one on the price side too.
  const contas = Array.isArray(produto.integracoesComProduto)
    ? produto.integracoesComProduto.filter((c): c is string => typeof c === 'string')
    : [];
  if (!contas.includes(integracaoId)) return 'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO';
  return null;
}

/** A non-empty string, or null — the soft coercion `precoPlan` uses on raw docs. */
function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The stored cursor path as a `DocumentReference`, through the collection
 * HANDLE rather than a raw `db.doc()` (which the `no-inline-admin-collection`
 * rule bans, and rightly: the handle is the one place that knows this path
 * shape).
 *
 * Unlike everything else in this module, a bad value here THROWS rather than
 * degrading. The cursor is machine-written — it only ever comes from
 * `doc.ref.path` on this very query — so a shape that does not parse is
 * corruption, not an operating condition, and the two graceful options are both
 * worse: ignoring it restarts the walk from the beginning on every dispatch (a
 * loop), and concluding early truncates the report silently. Throwing rides the
 * job's existing retry-then-persist-failure path, which says so out loud.
 */
function linkRefDoCursor(db: Firestore, path: string) {
  // `produtos/<produtoId>/produtoMercadoLivre/<linkId>`
  const parts = path.split('/');
  const produtoId = parts.length === 4 ? parts[1] : undefined;
  const linkId = parts.length === 4 ? parts[3] : undefined;
  if (produtoId == null || produtoId === '' || linkId == null || linkId === '') {
    throw new Error(
      `[mercado-livre] cursor de reconciliação de preços inválido: ${JSON.stringify(path)}`,
    );
  }
  return produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkId);
}
