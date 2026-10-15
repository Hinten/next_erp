/**
 * Shopee **stock discovery** (step 12, #1520) — the three Firestore **Pipelines**
 * reads the stock sync is built on, and nothing else. No scheduling, no task
 * enqueue, no Shopee call, no write: this module DISCOVERS the produto families
 * that may need a new `update_stock` (`buscarFamiliasShopee` — THE query),
 * answers the same question for an explicit id list (`buscarFamiliasShopeePorIds`
 * — the manual push's force-send) and sums the stock ledger once per tick
 * (`buscarMovimentosDaJanela` — the uncorrelated movement pre-pass).
 *
 * The shapes it returns are `planoEstoque.ts`'s (`LinhaDeFamiliaShopee`,
 * `FilhoDaFamilia`, `LinkShopeeCru`, `VarLinkShopeeCru`, `PaginaDeFamiliasShopee`)
 * and the promoted core's (`MembroDaFamilia`, `RawEstoqueRow`,
 * `MovimentosDaJanela`). Nothing is re-declared here — a second declaration of a
 * row shape is exactly how the planner and the query drift while both compile.
 *
 * ---- Template and provenance. Every stage below mirrors Mercado Livre's
 * `apps/mercado-livre/lib/marketplace/estoque/bulkEstoquePlan.ts` — the join
 * thunks (`stockJoinBuilders`), the S6 projection inside `fetchStockFamilies`,
 * `fetchStockFamilies` itself, `fetchStockFamiliesByIds` and
 * `fetchMovimentosDaJanela`. The ARITHMETIC those two channels
 * share was promoted to `@delfrance/data/admin/estoque` (#1520 R9); the
 * PIPELINES were not and could not be — `packages/data` declares no dependency
 * on the admin SDK's Pipelines package, and an import there would fail nothing
 * in that package's own gates and break at resolution time in whichever app
 * imported it next. So each channel keeps its own query beside its own sender
 * and injects it. That is also what makes this module testable: pipelines do
 * not run in vitest and cannot run in the Firestore emulator at all.
 *
 * ---- ⚠️ Read **ADR 0014** before changing what this query joins. Two things
 * here look like omissions and are decisions:
 *  - S3 adds `maxOwn` and `maxChildren` and deliberately **no** component arm.
 *    ~2000 kits share one blank shirt and one print, so a component arm makes
 *    every one of them a candidate on every sale. A kit sale instead stamps the
 *    kit's OWN estoque document at the pedido line, so `maxOwn` sees it;
 *  - the window therefore UNDER-sends by design. A kit whose component moved but
 *    which did not itself sell waits for the monthly reconciliação pass, which
 *    force-sends (`changedSinceMs = -1`).
 *
 * ---- Discovery scope (#1087 / #804; the "Discovery scope" section of
 * `bulkEstoquePlan.ts`'s module docblock). The S1 anchor
 * terms are `paiId == null` plus `integracoesComProduto array-contains <conta>`
 * — and deliberately **NOT** `publicado == true`. That array is the produto-side
 * denorm of the CHANNEL's publication status, maintained by the link triggers,
 * so it already asks the question that matters: does this produto hold a live
 * listing on this conta? `publicado` is an ERP CATALOGUE flag and answers a
 * different one; the legacy sweep gated on it and this repo removed that gate
 * because it dropped every unpublished produto WITH a live listing — server
 * side, with no skip row and no log line, leaving the anúncio advertising a
 * stale quantity for ever, which oversells. `publicado` still rides the S6
 * projection for SHAPE PARITY and observability only (an absent field coerces to
 * `false`, so dropping it would make every row claim the produto is oculto).
 *
 * ---- Index ledger (ruling C-p: this step declares **ZERO** new entries;
 * Enterprise auto-creates none and an unindexed predicate silently full-scans,
 * billed by data scanned):
 *  - S1 anchors were designed to ride
 *    `produtos(paiId ASC, integracoesComProduto ASC, __name__ ASC)`, the entry
 *    Mercado Livre's `bulkEstoquePlan.ts` names for its own S1. ⚠️ The staging
 *    measurement of 2026-09-23 found the planner on
 *    `produtos(paiId, integracoesComProduto, nome)` instead, range-bounding
 *    `paiId == null` only, with the conta term a residual filter over the index
 *    rows — the same shape as Mercado Livre's, tracked for both channels as
 *    #1638;
 *  - the `estoques` joins ride the existing COLLECTION_GROUP
 *    `estoques(parentId ASC, depositoOuterRef ASC, ultimaModificacao ASC)` and
 *    the COLLECTION-scope `estoques(depositoOuterRef ASC, ultimaModificacao ASC)`;
 *  - the children's `paiId` equality rides `produtos(paiId, …)` as a prefix;
 *  - the ledger aggregate rides the COLLECTION_GROUP
 *    `historicoEstoque(timestamp ASC, parentId ASC, depositoOuterRef ASC)`. It
 *    must COVER the aggregate, not merely serve the `where`: an uncovered
 *    `aggregate` buffers every group in the 128 MiB budget and can
 *    `RESOURCE_EXHAUSTED`;
 *  - the two link probes get **no** entry, because they carry **no `where`** —
 *    see {@link construtoresDeJuncao}.
 *
 * ⚠️ The 128 MiB materialization ceiling spans the WHOLE query including every
 * joined document, which is why every subquery selects a minimal field set.
 */
import type { Firestore } from 'firebase-admin/firestore';

import * as pipelines from '@google-cloud/firestore/pipelines';

import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  type FetchMovimentosDaJanela,
  type MembroDaFamilia,
  type MovimentoDaJanela,
  type RawEstoqueRow,
  chaveMovimento,
} from '@delfrance/data/admin/estoque';

import { anchorPageLimit } from './constantesEstoque';
import type {
  FilhoDaFamilia,
  LinhaDeFamiliaShopee,
  LinkShopeeCru,
  PaginaDeFamiliasShopee,
  VarLinkShopeeCru,
} from './planoEstoque';

/* -------------------------------------------------------------------------- */
/*                                 THE SEAMS                                  */
/* -------------------------------------------------------------------------- */

/** Arguments of THE query — one conta, one depósito, one window, one page. */
export interface ArgsBuscarFamiliasShopee {
  /** Conta being swept — the S1 `arrayContains` term. */
  readonly integracaoId: string;
  /** Depósito doc id — both accepted `depositoOuterRef` encodings are derived. */
  readonly depositoId: string;
  /**
   * Exclusive window start, MILLISECONDS. `-1` is force-all and is a LEGAL
   * stored value (the reconciliação tier), never a malformed one.
   */
  readonly changedSinceMs: number;
  /** Page size override — defaults to `anchorPageLimit()`, read lazily. */
  readonly pageLimit?: number;
  /** Keyset resume point; page 1 of a fresh sweep omits it. */
  readonly afterAnchorId?: string | null;
}

/** The seam the sweep consumes — injectable so tests stub it. */
export type BuscarFamiliasShopee = (
  db: Firestore,
  args: ArgsBuscarFamiliasShopee,
) => Promise<PaginaDeFamiliasShopee>;

/** Arguments of the by-ids read — the manual push's force-send. */
export interface ArgsBuscarFamiliasShopeePorIds {
  /**
   * Conta being pushed. ⚠️ Deliberately **not** a query term on this path: the
   * by-ids read carries no anchor predicate at all, which is what lets the
   * planner's `conta-fora-do-produto` rung actually fire and produce an
   * operator-visible line instead of a silent server-side drop. It is declared
   * so the caller threads ONE argument object into both readers.
   */
  readonly integracaoId: string;
  /** Depósito doc id — both accepted `depositoOuterRef` encodings are derived. */
  readonly depositoId: string;
  /**
   * The ids to read, used VERBATIM as the `documents()` source: each one is read
   * as its OWN family anchor, and callers must pass anchors.
   *
   * ⚠️ Nothing on the manual path resolves a variation child to its anchor —
   * `enviarEstoqueManualShopee` and the `enviar:estoque` CLI hand over the
   * deduped request exactly as it arrived. A child id therefore comes back as a
   * row whose `anchorId` IS the child: the child's own `integracoesComProduto`,
   * the child's own `prodshopee` links and, as `children`, the produtos whose
   * `paiId` is the child. The listing link lives on the anchor (the link trigger
   * stamps the conta onto the produto that owns the `prodshopee` document), so
   * the planner normally answers `conta-fora-do-produto` (or `sem-link`),
   * nothing is sent, and the manual push reports the id in `produtosSemEnvio`.
   * An id with no document yields no row at all (`documents()` omits it).
   */
  readonly produtoIds: readonly string[];
}

/** The seam the manual push consumes — injectable so tests stub it. */
export type BuscarFamiliasShopeePorIds = (
  db: Firestore,
  args: ArgsBuscarFamiliasShopeePorIds,
) => Promise<readonly LinhaDeFamiliaShopee[]>;

/* -------------------------------------------------------------------------- */
/*                        THE JOINS AND THE PROJECTION                        */
/* -------------------------------------------------------------------------- */

/**
 * The pipeline SOURCE stage over `produtos`, in ONE place.
 *
 * ⚠️ Three call sites need it (THE query, the children subquery and the
 * `maxChildren` rollup) and a Pipeline expression may not be reused across
 * stages, so this is a THUNK: every call mints a fresh chain.
 *
 * ⚠️ This is the app's `no-restricted-syntax` guard against RAW admin refs
 * firing on a Pipelines STAGE NAME that happens to share the method name. A
 * `defineAdminCollection` handle has no pipeline surface — there is nothing to
 * route this through — and the stage takes a collection PATH, not a reference,
 * so nothing here bypasses a schema-validated handle: every DOCUMENT this module
 * addresses by id still goes through `produtoCollection.docRef`. Centralised so
 * the exemption is granted once and reviewed once.
 */
function fonteDeProdutos(db: Firestore) {
  // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; see the docblock above
  return db.pipeline().collection('produtos');
}

/**
 * The depósito predicate, in ONE place — both accepted `*OuterRef` encodings
 * (the `outerRef.ts` invariant: readers tolerate the bare form).
 *
 * ⚠️ It is a THUNK for the usual reason (a Pipeline expression object may not be
 * reused across stages — see `stockJoinBuilders` in `bulkEstoquePlan.ts`), and
 * it is declared HERE
 * rather than inside {@link construtoresDeJuncao} because the ledger pre-pass
 * needs the same disjunction and takes none of the other joins. The template
 * spells it twice and says in a comment that the two agree; two encodings that
 * agree by comment are free to drift, and the failure is silent in the worst
 * direction — a bare-form document stops matching one of the two readers, so the
 * window sees no movement and the send policy SKIPS a real change.
 */
function depMatchDe(depositoId: string) {
  return () =>
    pipelines.or(
      pipelines.equal(pipelines.field('depositoOuterRef'), `documents/depositos/${depositoId}`),
      pipelines.equal(pipelines.field('depositoOuterRef'), `depositos/${depositoId}`),
    );
}

/**
 * Every join THE query is made of, bound to one depósito.
 *
 * Extracted so the paged reader ({@link buscarFamiliasShopee}) and the by-ids
 * reader ({@link buscarFamiliasShopeePorIds}) cannot drift: both destructure
 * from here, so there is exactly ONE definition of each join and — via
 * {@link projecaoDaFamiliaShopee} — of the S6 projection. The number an operator
 * pushes by hand must be derived exactly like the one the sweep sends minutes
 * later.
 *
 * Every builder is a THUNK: a Pipeline expression object may not be reused
 * across stages (see `stockJoinBuilders` in `bulkEstoquePlan.ts`), so each call
 * mints a fresh one.
 *
 * ⚠️ Unlike Mercado Livre's `linkJoin`, **neither Shopee link probe carries a
 * `where`** and neither is filtered by conta — the conta is compared IN MEMORY
 * by the planner (ruling C-p). The reason is a measurement, not a preference:
 * a `subcollection()` probe carrying a WHERE with no COLLECTION-scope index
 * compiles to a collection-GROUP index scan with the parent as a RESIDUAL
 * filter — every family's link documents scanned per row — while a probe with no
 * `where` compiles to a partition-bounded `TableScan` over the one produto's
 * subcollection (the "Index ledger" section of `bulkEstoquePlan.ts`'s module
 * docblock). Declaring the index is not
 * deploying it, and deploying belongs to a human window. ⚠️ Written-down
 * reversal condition: if the MEDIAN number of `prodshopee` documents per produto
 * on staging exceeds **2**, declare the COLLECTION-scope entries, deploy them in
 * a window, and only then add the `where`.
 */
function construtoresDeJuncao(db: Firestore, depositoId: string) {
  // The ONE depósito disjunction, shared with the ledger pre-pass.
  const depMatch = depMatchDe(depositoId);

  // The current row's own estoque at the depósito. `subcollection()` binds to
  // the row being processed, so this serves the anchor AND each child alike.
  const ownEstoque = () =>
    pipelines
      .subcollection('estoques')
      .where(depMatch())
      .limit(1)
      .select(
        pipelines.documentId(pipelines.field('__name__')).as('estoqueDocId'),
        'quantidade',
        'quantidadeReservada',
        'ultimaModificacao',
      )
      .toScalarExpression();

  const ownEstoqueMax = () =>
    pipelines
      .subcollection('estoques')
      .where(depMatch())
      .aggregate(pipelines.maximum('ultimaModificacao').as('max'))
      .toScalarExpression();

  // The UNNEST-join: component estoques of the row's kit keys, riding the
  // estoque `parentId` produto-id denorm. Empty-IN semantics for `equalAny` are
  // undocumented, so a `conditional` short-circuits the empty-key-list path (a
  // non-kit — the dominant case) instead of relying on them.
  const compEstoques = (keysVar: string) =>
    pipelines.conditional(
      pipelines.variable(keysVar).length().greaterThan(0),
      // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage, not a raw ref
      db
        .pipeline()
        .collectionGroup('estoques')
        .where(
          pipelines.and(
            pipelines.field('parentId').equalAny(pipelines.variable(keysVar)),
            depMatch(),
          ),
        )
        .select(
          pipelines.documentId(pipelines.field('__name__')).as('estoqueDocId'),
          'parentId',
          'quantidade',
          'quantidadeReservada',
          'ultimaModificacao',
        )
        .toArrayExpression(),
      pipelines.array([]),
    );

  // ⚠️ `coalesce`, never `ifNull`: an ABSENT field passes straight through
  // `ifNull`, so a produto that never had `componentesKitKeys` would bind the
  // variable to nothing and the `length()` guard above would throw rather than
  // short-circuit (the `conditional` in `stockJoinBuilders`' `compEstoques`,
  // `bulkEstoquePlan.ts`).
  const kitKeysDefine = (name: string) =>
    pipelines.coalesce(pipelines.field('componentesKitKeys'), pipelines.array([])).as(name);

  // The children's OWN estoque high-water mark. No component arm nests inside
  // (ADR 0014), which keeps this at one level of correlated nesting.
  const maxChildren = () =>
    fonteDeProdutos(db)
      .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
      .select(ownEstoqueMax().as('m'))
      .aggregate(pipelines.maximum('m').as('max'))
      .toScalarExpression();

  // ALL of the produto's listing links, every conta included — see the ⚠️ in
  // this function's docblock for why there is no `where` here. The planner
  // compares `contaProdutoShopeeOuterRef` in memory and answers `sem-link` for a
  // produto that holds no listing on the conta being swept.
  const linksShopee = () =>
    pipelines
      .subcollection('prodshopee')
      .select(
        'contaProdutoShopeeOuterRef',
        'item_id',
        'item_status',
        'estadoAnuncio',
        'pausadoPeloErp',
        'category_id',
        'kitNativo',
        'estoqueRecusaEm',
        'estoqueRecusaAte',
        'estoqueRecusaEstado',
        'estoqueRecusaItemStatus',
        'estoqueEnviadoEm',
        pipelines.documentId(pipelines.field('__name__')).as('linkDocId'),
      )
      .toArrayExpression();

  // Variation children with their own estoques and their own model links. Each
  // nested row is a CHILD, so `subcollection()` joins on the child's `__name__`.
  const filhosShopee = () =>
    fonteDeProdutos(db)
      .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
      .define(kitKeysDefine('childKitKeys'))
      .select(
        pipelines.documentId(pipelines.field('__name__')).as('childId'),
        'ehKit',
        'ehKitVirtual',
        'publicado',
        'componentesKit',
        'timestamp',
        ownEstoque().as('estoque'),
        compEstoques('childKitKeys').as('componentEstoques'),
        pipelines
          .subcollection('variashopee')
          .select(
            'contaVariacaoShopeeOuterRef',
            // ⚠️ LOAD-BEARING. Two `prodshopee` documents under ONE produto are
            // legal, so a model link is bound to its parent LINK, never to the
            // produto. Drop this and a family holding two listings hands each
            // one the other's models — a structure error at Shopee at best, and
            // the wrong quantity on the wrong anúncio at worst.
            'produtoShopeeOuterRef',
            'model_id',
            'tier_index',
            'model_status',
            'modeloAusenteEm',
            pipelines.documentId(pipelines.field('__name__')).as('varLinkDocId'),
          )
          .toArrayExpression()
          .as('varLinks'),
      )
      .toArrayExpression();

  return {
    depMatch,
    ownEstoque,
    ownEstoqueMax,
    compEstoques,
    kitKeysDefine,
    maxChildren,
    linksShopee,
    filhosShopee,
  };
}

/**
 * The S6 projection — the ONE definition both readers select with.
 *
 * A TUPLE (`as const`), not an array: `select(...)` takes a rest parameter and
 * TypeScript only spreads a tuple into one.
 */
function projecaoDaFamiliaShopee(b: ReturnType<typeof construtoresDeJuncao>) {
  return [
    // A variable is omitted from the output unless re-selected, and `anchorId`
    // is both the row identity and the keyset cursor.
    pipelines.variable('anchorId').as('anchorId'),
    'ehKit',
    'ehKitVirtual',
    // ⚠️ Not a gate and not a query term (#1087): it rides here for SHAPE PARITY
    // and observability. `coagirMembro` reads an absent field as `false`, so
    // dropping it would make every row silently claim the produto is oculto.
    'publicado',
    'componentesKit',
    'integracoesComProduto',
    'timestamp',
    b.ownEstoque().as('estoque'),
    b.compEstoques('anchorKitKeys').as('componentEstoques'),
    b.linksShopee().as('links'),
    b.filhosShopee().as('children'),
  ] as const;
}

/* -------------------------------------------------------------------------- */
/*                                 THE QUERY                                  */
/* -------------------------------------------------------------------------- */

/**
 * THE query: exactly ONE pipeline execution per CALL. The reader is page-aware
 * and never drains internally — the sweep loops pages (feeding
 * `nextAfterAnchorId` back as `afterAnchorId`), bounds pages per tick and
 * advances its durable cursor between ticks.
 *
 * Stages, in order:
 *  - **S1** anchor predicate, server-side: `paiId == null` plus
 *    `integracoesComProduto arrayContains <conta>` — and deliberately NOT
 *    `publicado == true` (see the module docblock). A resumed page adds
 *    `__name__ > <afterAnchorId ref>`; the reference is rebuilt through
 *    `produtoCollection.docRef` because `select` drops references.
 *  - **S2** `define`: `anchorId` plus `anchorKitKeys` — PLAIN expressions only,
 *    which is what `define` is documented for.
 *  - **S3** `addFields`, the documented subquery-embed site: `maxOwn` and
 *    `maxChildren`, two indexed MAX-aggregate seeks per anchor. ⚠️ No component
 *    arm — ADR 0014, see the module docblock.
 *  - **S4** the window filter, SERVER-SIDE, over the ADDED FIELDS (the
 *    documented HAVING-style where-after-addFields pattern):
 *    `coalesce(logicalMaximum(maxOwn, maxChildren), 0) > changedSinceMs`. The
 *    heavy S6 projection then runs only for surviving anchors; the `coalesce`
 *    keeps no-estoque families out for a positive window and makes
 *    `changedSinceMs = -1` force-all free.
 *  - **S5** `sort(__name__)` + `limit` — `__name__` is unique, so the keyset
 *    needs no tuple.
 *  - **S6** the projection.
 *
 * Returns ONE page: `rows` plus `nextAfterAnchorId` — the last row's `anchorId`
 * when the page came back FULL, null when the backlog is drained.
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam.
 */
export const buscarFamiliasShopee: BuscarFamiliasShopee = async (db, args) => {
  const pageLimit = args.pageLimit ?? anchorPageLimit();
  const construtores = construtoresDeJuncao(db, args.depositoId);
  const { ownEstoqueMax, kitKeysDefine, maxChildren } = construtores;

  const termoPai = pipelines.equal(pipelines.field('paiId'), null);
  const termoConta = pipelines.field('integracoesComProduto').arrayContains(args.integracaoId);
  const afterAnchorId = args.afterAnchorId ?? null;
  const predicadoDeAncora =
    afterAnchorId == null
      ? pipelines.and(termoPai, termoConta)
      : pipelines.and(
          termoPai,
          termoConta,
          // `constant()` accepts a DocumentReference — the keyset cursor.
          pipelines.greaterThan(
            pipelines.field('__name__'),
            pipelines.constant(produtoCollection.docRef(db, {}, afterAnchorId)),
          ),
        );

  const snap = await fonteDeProdutos(db)
    .where(predicadoDeAncora)
    .define(
      pipelines.documentId(pipelines.field('__name__')).as('anchorId'),
      kitKeysDefine('anchorKitKeys'),
    )
    .addFields(ownEstoqueMax().as('maxOwn'), maxChildren().as('maxChildren'))
    .where(
      pipelines.greaterThan(
        pipelines.coalesce(
          pipelines.logicalMaximum(pipelines.field('maxOwn'), pipelines.field('maxChildren')),
          0,
        ),
        args.changedSinceMs,
      ),
    )
    .sort(pipelines.ascending(pipelines.field('__name__')))
    .limit(pageLimit)
    .select(...projecaoDaFamiliaShopee(construtores))
    .execute();

  const rows = linhasDoResultado(snap);
  const ultima = rows.length === pageLimit ? rows[rows.length - 1] : undefined;
  return { rows, nextAfterAnchorId: ultima?.anchorId ?? null };
};

/**
 * THE query scoped to an explicit set of anchors — the manual "enviar estoque
 * agora" push. Same joins, same projection, so the number an operator sends by
 * hand is derived exactly like the one the sweep sends minutes later.
 *
 * Three deliberate differences from {@link buscarFamiliasShopee}:
 *
 *  1. **`documents([...])` is the SOURCE stage**, not a collection scan. That is
 *     a batch KEY read: there is no index to ride and none to miss, so the
 *     Enterprise trap where an unindexed predicate silently full-scans and bills
 *     the bytes (root `CLAUDE.md` rule 1) is structurally unaskable here.
 *  2. **No `addFields` and no window filter.** A manual push is force-send by
 *     definition — the operator is asserting the published number is wrong — so
 *     it must not run two correlated MAX aggregates per anchor to ask "did it
 *     change". Consequently the caller runs NO ledger pre-pass on this path
 *     either.
 *  3. **No anchor terms at all.** They exist to bound the SWEEP's scan and buy
 *     nothing against at most fifty point reads. Dropping them is what makes the
 *     planner's `conta-fora-do-produto` and `sem-link` rungs fire, turning a
 *     silent server-side drop into an operator-visible line.
 *
 * ⚠️ `documents()` requires a NON-EMPTY, DUPLICATE-FREE list and **silently
 * omits a missing document**. This function therefore dedupes, and REFUSES an
 * empty list rather than letting a collection source full-scan; the caller
 * short-circuits before calling and reports a requested anchor that comes back
 * with no row.
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam.
 */
export const buscarFamiliasShopeePorIds: BuscarFamiliasShopeePorIds = async (db, args) => {
  const produtoIds = [...new Set(args.produtoIds)];
  if (produtoIds.length === 0) {
    throw new Error(
      'buscarFamiliasShopeePorIds: produtoIds vazio — o chamador deve curto-circuitar.',
    );
  }

  const construtores = construtoresDeJuncao(db, args.depositoId);

  // No eslint exemption needed here, unlike the sources above: the references
  // come from `produtoCollection.docRef`, so nothing raw is addressed.
  const snap = await db
    .pipeline()
    .documents(produtoIds.map((id) => produtoCollection.docRef(db, {}, id)))
    .define(
      pipelines.documentId(pipelines.field('__name__')).as('anchorId'),
      construtores.kitKeysDefine('anchorKitKeys'),
    )
    .sort(pipelines.ascending(pipelines.field('__name__')))
    .select(...projecaoDaFamiliaShopee(construtores))
    .execute();

  return linhasDoResultado(snap);
};

/* -------------------------------------------------------------------------- */
/*                            ROW COERCION (tolerant)                         */
/* -------------------------------------------------------------------------- */

/** The shape both readers get back from `execute()`. */
interface ResultadoDePipeline {
  readonly results: ReadonlyArray<{ data: () => unknown }>;
}

/** Every projected row that carries a usable `anchorId`, coerced. */
function linhasDoResultado(snap: ResultadoDePipeline): LinhaDeFamiliaShopee[] {
  const rows: LinhaDeFamiliaShopee[] = [];
  for (const resultado of snap.results) {
    const data = objetoOuNulo(resultado.data());
    if (data === null) continue;
    const anchorId = textoNaoVazio(data.anchorId);
    // Projected server-side, so this is purely defensive.
    if (anchorId === null) continue;
    rows.push(mapearLinhaDaFamilia(anchorId, data));
  }
  return rows;
}

/** A finite number, or null — the one numeric tolerance this module needs. */
function numeroFinito(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/** A non-empty string, or null. */
function textoNaoVazio(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** A plain object (never an array, never null), or null. */
function objetoOuNulo(valor: unknown): Record<string, unknown> | null {
  return valor != null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/** Every plain object in an array-valued projection; anything else reads `[]`. */
function objetosDaLista(valor: unknown): Record<string, unknown>[] {
  if (!Array.isArray(valor)) return [];
  const saida: Record<string, unknown>[] = [];
  for (const item of valor) {
    const obj = objetoOuNulo(item);
    if (obj !== null) saida.push(obj);
  }
  return saida;
}

/**
 * One projected row into the family shape — junk-tolerant throughout.
 *
 * Tolerance is not politeness here: the projection reads documents the Flutter
 * app wrote and documents the step-9 import wrote, and a row that throws takes
 * the whole page — and therefore every OTHER conta's listings on that page —
 * down with it.
 */
function mapearLinhaDaFamilia(
  anchorId: string,
  data: Record<string, unknown>,
): LinhaDeFamiliaShopee {
  const children: FilhoDaFamilia[] = [];
  for (const child of objetosDaLista(data.children)) {
    const childId = textoNaoVazio(child.childId);
    if (childId === null) continue;
    children.push({
      ...coagirMembro(childId, child),
      varLinks: objetosDaLista(child.varLinks) as VarLinkShopeeCru[],
    });
  }
  // The children subquery has no sort, so the order is unstable — sorted by id
  // purely for output determinism.
  children.sort((a, b) => (a.produtoId < b.produtoId ? -1 : a.produtoId > b.produtoId ? 1 : 0));

  return {
    anchorId,
    anchor: coagirMembro(anchorId, data),
    integracoesComProduto: Array.isArray(data.integracoesComProduto)
      ? data.integracoesComProduto.filter((x): x is string => typeof x === 'string')
      : [],
    links: objetosDaLista(data.links) as LinkShopeeCru[],
    children,
  };
}

/** One family member — the anchor or a child. Booleans coerce with `=== true`. */
function coagirMembro(produtoId: string, raw: Record<string, unknown>): MembroDaFamilia {
  return {
    produtoId,
    ehKit: raw.ehKit === true,
    ehKitVirtual: raw.ehKitVirtual === true,
    // ⚠️ An ABSENT `publicado` reads FALSE. That is why the field rides the
    // projection at all — see {@link projecaoDaFamiliaShopee}.
    publicado: raw.publicado === true,
    // Stays RAW: the kit-min helper in the promoted core tolerates junk.
    componentesKit: (raw.componentesKit ?? null) as MembroDaFamilia['componentesKit'],
    timestampMs: numeroFinito(raw.timestamp),
    estoque: objetoOuNulo(raw.estoque) as RawEstoqueRow | null,
    componentEstoques: objetosDaLista(raw.componentEstoques) as RawEstoqueRow[],
  };
}

/* -------------------------------------------------------------------------- */
/*                          THE LEDGER PRE-PASS                               */
/* -------------------------------------------------------------------------- */

/**
 * The UNCORRELATED ledger pre-pass: **ONE** pipeline execution per tick,
 * returning the net stock movement of every `(produto, depósito)` pair that
 * moved inside the window. `anterior = atual − Σmovimento` then falls out
 * locally, for every family, at no per-family cost.
 *
 * It is the same grouped aggregate Mercado Livre runs (`fetchMovimentosDaJanela`
 * in `bulkEstoquePlan.ts`), typed
 * against the PROMOTED `FetchMovimentosDaJanela`. Only the types moved: the
 * implementation is a Pipelines execution and pipelines do not move.
 *
 * ⚠️ Requires `historicoEstoque` v2, where `movimento` is a signed delta on
 * **every** row including a balanço. v1 stored a balanço's absolute counted
 * value in the same field, which would make this sum silently wrong rather than
 * visibly absent.
 *
 * Fails OPEN **explicitly**, never by omission. A row whose `movimento` key is
 * absent — a legacy v1 row, and the migrated corpus is full of them — is skipped
 * by `sum`, which on its own would make the window look like it moved nothing
 * and let the send policy SKIP a real movement. So the aggregate also COUNTS
 * those rows per group and reports `desconhecido`; the reconstruction then drops
 * the pair and the policy sends. A pair simply ABSENT from the result did not
 * move at all — that one is genuinely unchanged, and skipping it is the point.
 *
 * ⚠️ The aggregate groups by the RAW `depositoOuterRef` while the filter accepts
 * BOTH encodings, so ONE pair can come back as TWO groups. The scope is a single
 * depósito either way, so the reducer keys on the ARGUMENT and **ACCUMULATES** —
 * a `set` here would drop whichever group arrived first and reconstruct a
 * confidently wrong `anterior`.
 *
 * ⚠️ Still blind to a quantity written with NO ledger row whatsoever (the step-9
 * import's unaudited merge): there is nothing in the window to count. The
 * planner's `estoqueDesauditado` arm is what closes that gap from the other
 * side, by comparing the member's own stamp against the window.
 *
 * ⚠️ Memoisation is the SWEEP's, not this module's: a tick must hold the
 * in-flight PROMISE (not the resolved value) so two contas on one depósito share
 * ONE execution, and an idle tick must never call this at all.
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam.
 */
export const buscarMovimentosDaJanela: FetchMovimentosDaJanela = async (db, args) => {
  // The SAME disjunction THE query joins on — the one declaration, not a copy
  // that a comment promises agrees with it ({@link depMatchDe}).
  const depMatch = depMatchDe(args.depositoId);

  // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref
  const snap = await db
    .pipeline()
    .collectionGroup('historicoEstoque')
    .where(pipelines.and(pipelines.field('timestamp').greaterThanOrEqual(args.desdeMs), depMatch()))
    .aggregate({
      accumulators: [
        pipelines.sum('movimento').as('dq'),
        // ⚠️ `movimentoReservada` is `quantidadeReservada`'s LEDGER sibling: the
        // signed change in the held reservation over the window. It is summed
        // and deliberately NOT floored — flooring one leg of a movement destroys
        // units — and the floor lives downstream, in the promoted quantity core.
        pipelines.sum('movimentoReservada').as('dr'),
        // The fail-open counter: rows `sum` silently ignored because they carry
        // no `movimento` at all. Same scan, no extra query.
        pipelines.countIf(pipelines.not(pipelines.exists('movimento'))).as('nDesconhecido'),
      ],
      groups: ['parentId', 'depositoOuterRef'],
    })
    .execute();

  const movimentos = new Map<string, MovimentoDaJanela>();
  for (const resultado of snap.results) {
    const row = objetoOuNulo(resultado.data());
    if (row === null) continue;
    const parentId = textoNaoVazio(row.parentId);
    if (parentId === null) continue;
    const chave = chaveMovimento(parentId, args.depositoId);
    const anterior = movimentos.get(chave);
    movimentos.set(chave, {
      dq: (anterior?.dq ?? 0) + (numeroFinito(row.dq) ?? 0),
      dr: (anterior?.dr ?? 0) + (numeroFinito(row.dr) ?? 0),
      desconhecido: (anterior?.desconhecido ?? false) || (numeroFinito(row.nDesconhecido) ?? 0) > 0,
    });
  }
  return movimentos;
};
