/**
 * Mercado Livre price-sync **reconciliation phase** (#1072) — the half of the
 * account-wide job that reports what the plan could not have enumerated.
 *
 * `precoPlan.fetchPrecoPage` asks PRODUTOS "do you carry this conta?"; this asks
 * the LINKS "which produto owns you?". The walk itself — the group query, the
 * `linkHasLiveListing` noise guard, the masked parent read and the classifier —
 * lives in `anuncios/linksNaoEnumerados.ts` since #1200, because the stock
 * sweep's S1 carries the SAME two anchor terms and its monthly audit walks the
 * same links. Read that module's doc for what is found and why it is correct;
 * this file keeps only what is PRICE-shaped: the flag, the page-size tunable, the
 * page cap, and the job-facing types `precoSync` consumes.
 *
 * ---- REPORT-ONLY, and the classes differ in what happens to them:
 *  - **class 2** (the produto's `integracoesComProduto` lost the conta) is now
 *    HEALED monthly by `estoque/auditoriaNaoEnumerados.ts`, which re-adds the
 *    conta to the produto — one array, so that fixes this job's anchor query as
 *    much as the stock sweep's. This phase still reports it, because drift
 *    arising between two audits is real until the next one runs, and the
 *    produtos-table push stays the immediate remedy: it reads anchors BY KEY
 *    (`fetchPrecoFamiliasByIds`) and carries none of the anchor terms, so the
 *    drifted produto sends fine from there;
 *  - **class 3 has NO send surface anywhere in the repo.** `precoManual`
 *    resolves a selection to `paiId ?? produtoId` and then refuses a row whose
 *    `paiId` is set (`FAMILIA_NAO_ENCONTRADA`), and `readFamilia` only ever
 *    reads `produtoMercadoLivre` UNDER the anchor. The stock stack anchors the
 *    same way. So a class-3 row is a request to repair the DATA (the link
 *    belongs on the family parent), not a button to press — the pt-BR wording
 *    in `precoMotivos.MENSAGEM_POR_MOTIVO` says exactly that, and the stock
 *    audit raises it as an aviso.
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
 * **COLLECTION_GROUP** — see `linksNaoEnumerados.ts`, which owns the query.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { envFlag, envInt } from '../estoque/bulkEstoquePlan';
import { fetchLinksNaoEnumeradosPage } from '../anuncios/linksNaoEnumerados';

// The classifier moved with the walk; re-exported so this module's API — and
// its suite, which pins the classifier's cases — is unchanged by the move.
export { classificarLinkNaoEnumerado } from '../anuncios/linksNaoEnumerados';

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
  /** An `EnvioPrecoSkip.code` — one of `CODIGO_NAO_ENUMERADO`'s values. */
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

/**
 * The price binding of the shared walk: the one thing it adds is the env
 * default for the page size, which the shared module deliberately does not read.
 * The returned page is the shared one — a structural superset of
 * {@link PrecoReconPage} (it also carries `lidos`/`produtosLidos`/`limpos`), so nothing
 * `precoSync` reads changed.
 */
export const fetchPrecoReconPage: FetchPrecoReconPage = (db, args) =>
  fetchLinksNaoEnumeradosPage(db, {
    integracaoId: args.integracaoId,
    afterLinkPath: args.afterLinkPath ?? null,
    pageLimit: args.pageLimit ?? precoReconPageLimit(),
  });
