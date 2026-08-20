/**
 * Mercado Livre **price-sync compute core** (Step 11 PR C) — the building
 * blocks behind the MANUAL per-conta "Atualizar preços" bulk job. No job-doc
 * checkpointing, no task enqueue and no ML API call lives here: this module
 * DISCOVERS the linked produto families one keyset page at a time
 * (`fetchPrecoPage`), turns one family row into ready-to-queue price drafts
 * (`buildPrecoDrafts` — pure), and gates a FRESHLY-fetched listing status at
 * send time (`podeEnviarPreco`). The job orchestration (one
 * `enviosPrecoMercadoLivre` doc + a self-continuing Cloud Tasks chain — the
 * Step-8 mass-import pattern, NOT the Step-10 sweep) lives in `precoSync.ts`.
 *
 * ---- CLASSIC admin-SDK queries, deliberately NOT pipelines: this is a
 * manual, low-frequency job (a user clicks a button) whose every access path
 * rides an already-declared index, so the pipeline machinery buys nothing —
 * and pipelines are untestable in unit tests (and never run in the emulator),
 * while these classic chains execute against the FakeDb seams directly.
 *
 * ---- Index ledger (Enterprise auto-creates NONE — an unindexed predicate
 * silently full-scans, billed by data scanned). Zero NEW entries: every query
 * below rides an index Step 10 already declared in `firestore.indexes.json`:
 *  - anchors: `produtos(paiId ASC, publicado ASC, integracoesComProduto
 *    ASC, __name__ ASC)` — the stock-sync composite (spike (b) / #705:
 *    `array-contains` rides ASC, not CONTAINS); the
 *    `orderBy(FieldPath.documentId())` keyset binds the `__name__` suffix;
 *  - children: the `paiId` equality rides the existing `produtos(paiId, nome)`
 *    index as a prefix;
 *  - links: the per-produto `contaOuterRef IN` probe rides the COLLECTION-scope
 *    `produtoMercadoLivre(contaOuterRef)` entry;
 *  - `variacaoMercadoLivre` is read whole (no predicate) — native key order,
 *    nothing for an index to serve.
 *
 * ---- Price source (owner-locked): the price pushed is the conta's tabela
 * normal entry, `produto.precos[<tabelaNormalId>].valor`, `roundReais`'d at
 * plan time. `propagatePriceToChildren: true` (the schema default) prices the
 * WHOLE family from the ANCHOR produto; `false` prices each User-Products
 * variation item from the CHILD's own `precos` entry (missing → that child
 * skips `PRECO_NAO_ENCONTRADO`, its siblings still draft). Legacy-model
 * listings ALWAYS send the anchor price regardless of the flag — ML legacy
 * variations only accept one uniform family price — and the draft carries NO
 * variation ids: the send step re-derives them from its fresh `GET items` (a
 * stale stored variation id would 400 the whole PUT).
 *
 * ---- Status gate (decision 6): unlike stock (`podeEnviarEstoque` — active or
 * paused/out_of_stock only), ML accepts price updates on ANY paused listing,
 * and on `under_review` unless the review is a `forbidden` one. The gate runs
 * at SEND time against the freshly-fetched status, never against the stored
 * link fields (the row still carries them for observability) — hence a
 * dedicated gate here instead of reusing the stock one.
 *
 * ---- Config: business tunables read `process.env` LAZILY via `bulkEstoquePlan`'s
 * `envInt` (call time, never module load); pure mechanics stay code constants.
 */
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { roundReais } from '@delfrance/core/money';
import { type EnvioPrecoFilaItem, type EnvioPrecoSkip, toOuterRef } from '@delfrance/schemas';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { envInt } from './bulkEstoquePlan';

/* ------------------------------ configuration ----------------------------- */

/** Anchor-page size of the plan's discovery query (`MERCADO_LIVRE_PRECO_PAGE_LIMIT`).
 * Floored at 1 — a 0 would plan nothing and the job would self-enqueue forever. */
export function precoPageLimit(): number {
  return Math.max(1, envInt('MERCADO_LIVRE_PRECO_PAGE_LIMIT', 25));
}

/** Fila items sent per task dispatch (`MERCADO_LIVRE_PRECO_ITEMS_PER_DISPATCH`).
 * Floored at 1 — a 0 would drain nothing and the job would self-enqueue forever. */
export function precoItemsPerDispatch(): number {
  return Math.max(1, envInt('MERCADO_LIVRE_PRECO_ITEMS_PER_DISPATCH', 10));
}

/** 429 pause (minutes) when ML sends no `Retry-After` (`MERCADO_LIVRE_PRECO_RATE_PAUSE_MIN`). */
export function precoRatePauseMin(): number {
  return envInt('MERCADO_LIVRE_PRECO_RATE_PAUSE_MIN', 5);
}

/** Cap on the job doc's `skips` sample list (the `pulados` counter stays exact). */
export const PRICE_SYNC_SKIPS_CAP = 200;

/** Cap on the job doc's `failures` sample list (the `falhas` counter stays exact). */
export const PRICE_SYNC_FAILURES_CAP = 100;

/**
 * Hard cap on one family's drafts. The fila is PERSISTED on the job doc a plan
 * page at a time, so a runaway family would blow the 1 MiB document limit and
 * wedge the job on every retry — past the cap the family builds NO drafts and
 * skips `FAMILIA_MUITO_GRANDE` instead (the `MAX_VARIATIONS_PER_TASK`
 * discipline: refuse loudly rather than re-attempt an unpersistable family
 * forever).
 */
export const MAX_DRAFTS_PER_FAMILY = 2000;

/**
 * Bound on ONE plan checkpoint's `fila`: the plan loop stops consuming page
 * rows BEFORE appending a family that would push the queued drafts past this
 * cap (a mid-page keyset resume on the last consumed anchor id), so
 * `pageLimit × MAX_DRAFTS_PER_FAMILY` can never approach Firestore's 1 MiB
 * document limit. A single family whose drafts alone exceed the cap still
 * lands whole — the per-family `MAX_DRAFTS_PER_FAMILY` cap governs that.
 */
export const PLAN_PAGE_DRAFTS_CAP = 2000;

/** Cap on 429 pauses one job may take before it fails terminally. */
export const PRICE_SYNC_MAX_PAUSES = 50;

/* --------------------------- discovery (the plan) -------------------------- */

/** One conta link on the family — soft-coerced off the raw link doc. */
export interface PrecoLinkRow {
  /** The `produtoMercadoLivre` link doc id (the send step's writeback target). */
  linkDocId: string;
  /** The ML item id (`id` field) — null when the listing was never published. */
  id: string | null;
  estado: string | null;
  /** Stored status/sub_status — observability only; the SEND gate re-fetches. */
  status: string | null;
  sub_status: string[] | null;
  isUserProductModel: boolean | null;
}

/** One variação link row of a child — soft-coerced off the raw doc. */
export interface PrecoVarLinkRow {
  docId: string;
  itemId: string | null;
  produtoMercadoLivreOuterRef: string | null;
}

/** One variation child with the fields the price plan needs. */
export interface PrecoFamilyChild {
  produtoId: string;
  precos: Record<string, { valor?: unknown }> | null;
  varLinks: PrecoVarLinkRow[];
}

/** One plan-page row: a family anchor with its links + children joined. */
export interface PrecoFamilyRow {
  produtoId: string;
  precos: Record<string, { valor?: unknown }> | null;
  /** Schema default TRUE — anything but a stored literal `false` propagates. */
  propagatePriceToChildren: boolean;
  /**
   * Always TRUE on a `fetchPrecoPage` row (the query filters on it). It is read
   * for real by {@link fetchPrecoFamiliasByIds}, which carries NO anchor
   * pre-filters — that is what turns #804's "unpublished produto with a live
   * listing" from a silent server-side exclusion into a visible skip row.
   */
  publicado: boolean;
  /**
   * Non-null only on a by-ids row: a 2-deep `paiId` chain, where the "anchor"
   * one hop up is itself a variation child. Pathological; the caller reports it
   * rather than pricing a family that is not one.
   */
  paiId: string | null;
  /** The conta's `produtoMercadoLivre` links on the family (both ref forms). */
  links: PrecoLinkRow[];
  children: PrecoFamilyChild[];
}

export interface FetchPrecoPageArgs {
  /** Conta whose linked families are planned — drives every filter below. */
  integracaoId: string;
  /** Resume after this anchor id (keyset) — the job's first page omits it. */
  afterAnchorId?: string | null;
  /** Page size override — defaults to `precoPageLimit()`. */
  pageLimit?: number;
}

/** One plan page. */
export interface PrecoPage {
  rows: PrecoFamilyRow[];
  /**
   * Keyset cursor: the last row's anchor id when the page came back FULL
   * (`rows.length === pageLimit`), null when the backlog is drained — the
   * `StockFamilyPage` contract.
   */
  nextAfterAnchorId: string | null;
}

/** The discovery seam the job consumes — injectable so tests stub it. */
export type FetchPrecoPage = (db: Firestore, args: FetchPrecoPageArgs) => Promise<PrecoPage>;

/**
 * One keyset page of linked produto families (module doc: classic queries on
 * declared indexes, deliberately no pipeline). Anchors are the published
 * family parents carrying the conta in `integracoesComProduto`, paged by
 * document id (`startAfter` takes the bare id — root-collection precedent:
 * `fetchArquivoPage`). Per anchor, the conta's links, the variation children
 * (field-masked to `precos`) and each child's `variacaoMercadoLivre` rows are
 * joined with plain reads — sequential per anchor (a page of 25 on a manual
 * job), `Promise.all` within one anchor. Every field is soft-coerced
 * (`typeof` checks): produtos docs can carry legacy-malformed data, and one
 * bad doc must skip-shape downstream (a junk `precos` reads as null →
 * `PRECO_NAO_ENCONTRADO`), never throw the page away.
 */
/**
 * Both accepted `contaOuterRef` forms (the linkRefs invariant, mirroring
 * refMatchesIntegracao): the canonical `documents/integracao/<id>` the apps
 * write plus the bare `integracao/<id>` legacy readers tolerate.
 */
function contaRefFormsDe(integracaoId: string): string[] {
  return [toOuterRef(`integracao/${integracaoId}`), `integracao/${integracaoId}`];
}

export const fetchPrecoPage: FetchPrecoPage = async (db, args) => {
  const pageLimit = args.pageLimit ?? precoPageLimit();
  const afterAnchorId = args.afterAnchorId ?? null;
  const contaRefForms = contaRefFormsDe(args.integracaoId);

  // Rides the DECLARED `produtos(paiId, publicado, integracoesComProduto
  // ASC, __name__)` composite (Step 10's entry, ASC form per #705 — zero new
  // indexes); the field mask keeps the page light (produtos docs carry heavy
  // media arrays).
  let anchorsQuery = produtoCollection
    .ref(db, {})
    .where('paiId', '==', null)
    .where('publicado', '==', true)
    .where('integracoesComProduto', 'array-contains', args.integracaoId)
    // `publicado`/`paiId` are two scalars the query already constrains — they
    // ride the mask anyway so a page row and a by-ids row are the SAME shape,
    // rather than a page row silently reading `publicado: false` off a field
    // the mask omitted.
    .select('precos', 'propagatePriceToChildren', 'publicado', 'paiId')
    .orderBy(FieldPath.documentId())
    .limit(pageLimit);
  if (afterAnchorId != null) anchorsQuery = anchorsQuery.startAfter(afterAnchorId);
  const anchorsSnap = await anchorsQuery.get();

  const rows: PrecoFamilyRow[] = [];
  for (const doc of anchorsSnap.docs) {
    rows.push(await readFamilia(db, doc.id, doc.data() as Record<string, unknown>, contaRefForms));
  }

  const full = anchorsSnap.docs.length === pageLimit;
  const lastId = anchorsSnap.docs[anchorsSnap.docs.length - 1]?.id ?? null;
  return { rows, nextAfterAnchorId: full ? lastId : null };
};

export interface FetchPrecoFamiliasByIdsArgs {
  /** Conta whose links are joined onto each family. */
  integracaoId: string;
  /** Exactly these anchors — already resolved child→anchor by the caller. */
  anchorIds: readonly string[];
}

/** The by-ids discovery seam — injectable so tests stub it. */
export type FetchPrecoFamiliasByIds = (
  db: Firestore,
  args: FetchPrecoFamiliasByIdsArgs,
) => Promise<PrecoFamilyRow[]>;

/**
 * The MANUAL push's target set (#804 S6) — the price twin of
 * `fetchStockFamiliesByIds`.
 *
 * ⚠️ It carries **none** of `fetchPrecoPage`'s three anchor terms — no
 * `paiId == null`, no `publicado == true`, no
 * `integracoesComProduto array-contains`. That is the whole point. Those terms
 * are what make #804's three classes vanish from the bulk job's report: an
 * unpublished produto with a live listing, a produto whose
 * `integracoesComProduto` denorm drifted, and a link sitting on a non-anchor
 * produto are all filtered out SERVER-SIDE, so the job has nothing to skip and
 * nothing to say. Reading the anchors by key instead means every one of them
 * reaches `enviarPrecoManual`, which reports each as an explicit row.
 *
 * A batch key read, so — unlike the stock side's `db.pipeline().documents(...)`
 * — there is no index to miss and it runs in the emulator. A missing document
 * is simply absent from the result; the caller diffs against `anchorIds` and
 * reports `FAMILIA_NAO_ENCONTRADA` rather than dropping it.
 */
/** Families joined per round of the by-ids read — see the loop's ⚠️ below. */
const FAMILIA_JOIN_CHUNK = 10;

export const fetchPrecoFamiliasByIds: FetchPrecoFamiliasByIds = async (db, args) => {
  const anchorIds = [...new Set(args.anchorIds)];
  if (anchorIds.length === 0) return [];
  const contaRefForms = contaRefFormsDe(args.integracaoId);

  const snaps = await db.getAll(...anchorIds.map((id) => produtoCollection.docRef(db, {}, id)), {
    fieldMask: ['precos', 'propagatePriceToChildren', 'publicado', 'paiId'],
  });

  // ⚠️ CHUNKED-parallel, unlike `fetchPrecoPage`'s serial loop. Same read count,
  // same shape — but this one sits in front of a HUMAN on a request capped at 50
  // produtos, and `readFamilia` costs at least one round trip plus one more per
  // variation child. Serially that is 50-150 round trips before the first `PUT`
  // goes out. Chunked rather than one unbounded `Promise.all` because the cap
  // belongs to the caller, not to this function.
  const presentes = snaps.filter((snap) => snap.exists);
  const rows: PrecoFamilyRow[] = [];
  for (let i = 0; i < presentes.length; i += FAMILIA_JOIN_CHUNK) {
    const lote = await Promise.all(
      presentes
        .slice(i, i + FAMILIA_JOIN_CHUNK)
        .map((snap) =>
          readFamilia(db, snap.id, (snap.data() ?? {}) as Record<string, unknown>, contaRefForms),
        ),
    );
    rows.push(...lote);
  }
  return rows;
};

/** Join one anchor's links + children + variação links into a family row. */
async function readFamilia(
  db: Firestore,
  anchorId: string,
  raw: Record<string, unknown>,
  contaRefForms: string[],
): Promise<PrecoFamilyRow> {
  const [linksSnap, childrenSnap] = await Promise.all([
    // Rides the COLLECTION-scope `produtoMercadoLivre(contaOuterRef)` entry.
    produtoMercadoLivreLinkCollection
      .ref(db, { produtoId: anchorId })
      .where('contaOuterRef', 'in', contaRefForms)
      .get(),
    // The `paiId` equality rides the existing `produtos(paiId, nome)` index as
    // a prefix; the mask trims the children to the one field the plan reads.
    produtoCollection.ref(db, {}).where('paiId', '==', anchorId).select('precos').get(),
  ]);

  const children = await Promise.all(
    childrenSnap.docs.map(async (childDoc): Promise<PrecoFamilyChild> => {
      // Whole-subcollection read, no predicate — native key order, no index.
      const varSnap = await variacaoMercadoLivreLinkCollection
        .ref(db, { produtoId: childDoc.id })
        .get();
      const childRaw = childDoc.data() as Record<string, unknown>;
      return {
        produtoId: childDoc.id,
        precos: coercePrecos(childRaw.precos),
        varLinks: varSnap.docs.map((varDoc) => {
          const v = varDoc.data() as Record<string, unknown>;
          return {
            docId: varDoc.id,
            itemId: nonEmptyString(v.itemId),
            produtoMercadoLivreOuterRef:
              typeof v.produtoMercadoLivreOuterRef === 'string'
                ? v.produtoMercadoLivreOuterRef
                : null,
          };
        }),
      };
    }),
  );

  return {
    produtoId: anchorId,
    precos: coercePrecos(raw.precos),
    // Schema default TRUE: only a stored literal `false` turns propagation off
    // (an absent or junk value reads as the default, like the schema parse).
    propagatePriceToChildren: raw.propagatePriceToChildren !== false,
    // Schema default FALSE — only a stored literal `true` counts as published.
    publicado: raw.publicado === true,
    paiId: nonEmptyString(raw.paiId),
    links: linksSnap.docs.map((linkDoc) => {
      const l = linkDoc.data() as Record<string, unknown>;
      return {
        linkDocId: linkDoc.id,
        id: nonEmptyString(l.id),
        estado: typeof l.estado === 'string' ? l.estado : null,
        status: typeof l.status === 'string' ? l.status : null,
        sub_status: Array.isArray(l.sub_status)
          ? l.sub_status.filter((s): s is string => typeof s === 'string')
          : null,
        isUserProductModel: typeof l.isUserProductModel === 'boolean' ? l.isUserProductModel : null,
      };
    }),
    children,
  };
}

/* ------------------------------- draft assembly ----------------------------- */

export interface BuildPrecoDraftsOpts {
  /** Conta being synced — log context only (the draft itself is conta-free). */
  integracaoId: string;
  /** The conta's tabela normal id — the `precos` map key every price reads. */
  tabelaNormalId: string;
}

export interface BuildPrecoDraftsResult {
  drafts: EnvioPrecoFilaItem[];
  skips: EnvioPrecoSkip[];
}

/**
 * Pure assembly: resolve one family row into fila drafts, reproducing the
 * legacy per-listing loop (a skipped listing never blocks its siblings).
 *
 * Family rung: no links at all (denorm drift — the anchor query already
 * filtered on `integracoesComProduto`) → ONE `SEM_LINK` skip, nothing else.
 *
 * Per-listing rungs (`continue` semantics): `SEM_ITEM_ID` (never published),
 * `AGUARDANDO_MIGRACAO` (`estado 'am'`, mid-UP-migration — stamped by
 * `itemsStatusSync` from ML's own migration tags, which is the value's only
 * producer now that the Flutter app is switched off at the cutover, #1087).
 * The STORED status is deliberately NOT gated here — the send step GETs the
 * item fresh and runs `podeEnviarPreco` on live data.
 *
 * Per surviving listing: legacy model (`isUserProductModel !== true`) → ONE
 * `'item'` draft with the ANCHOR price whether or not children exist (ML
 * legacy variations only accept a uniform family price; the send step reuses
 * the fresh GET's variation ids, so the draft carries none). A childless UP
 * listing degenerates to the same `'item'` draft. UP with children → one
 * `'variationItem'` draft per child variação link matched by
 * `produtoMercadoLivreOuterRef === toOuterRef(<THIS listing's docPath>)`
 * (exact string match is safe — migrated docs carry the same canonical
 * `documents/...` form, see importVariations.ts), priced from the anchor
 * (`propagatePriceToChildren`, the default) or the child's own `precos` entry;
 * an unmatched child skips `SEM_LINK`, an id-less varLink `SEM_ITEM_ID`, a
 * price-less member `PRECO_NAO_ENCONTRADO` — each per child, siblings ride.
 *
 * Cross-listing dedup: one `emittedItemIds` set spans the family — a draft
 * whose ML item id was already emitted drops silently (the legacy debug-print
 * discipline, no skip spam). A family that would emit more than
 * `MAX_DRAFTS_PER_FAMILY` drafts builds NOTHING: `console.error` + ONE
 * `FAMILIA_MUITO_GRANDE` skip (see the constant's doc).
 */
export function buildPrecoDrafts(
  row: PrecoFamilyRow,
  opts: BuildPrecoDraftsOpts,
): BuildPrecoDraftsResult {
  const anchorPreco = precoPositivo(row.precos, opts.tabelaNormalId);
  const propagate = row.propagatePriceToChildren !== false;

  if (row.links.length === 0) {
    return { drafts: [], skips: [{ itemId: null, produtoId: row.produtoId, code: 'SEM_LINK' }] };
  }

  const drafts: EnvioPrecoFilaItem[] = [];
  const skips: EnvioPrecoSkip[] = [];
  const emittedItemIds = new Set<string>();

  for (const link of row.links) {
    const itemId = link.id;
    if (itemId == null) {
      skips.push({ itemId: null, produtoId: row.produtoId, code: 'SEM_ITEM_ID' });
      continue;
    }
    if (link.estado === 'am') {
      skips.push({ itemId, produtoId: row.produtoId, code: 'AGUARDANDO_MIGRACAO' });
      continue;
    }

    if (link.isUserProductModel !== true || row.children.length === 0) {
      // Legacy always sends the anchor price (uniform family price is all ML
      // accepts there); a childless UP listing degenerates to the same draft.
      if (emittedItemIds.has(itemId)) continue; // cross-listing dedup — silent
      if (anchorPreco == null) {
        skips.push({ itemId, produtoId: row.produtoId, code: 'PRECO_NAO_ENCONTRADO' });
        continue;
      }
      emittedItemIds.add(itemId);
      drafts.push({
        kind: 'item',
        itemId,
        produtoId: row.produtoId,
        variacaoProdutoId: null,
        linkDocId: link.linkDocId,
        preco: anchorPreco,
      });
      continue;
    }

    // User Products with children: one draft per matched variação link — each
    // variation is its own ML item. Exact string match is safe here — both
    // apps write the canonical `documents/...` form (see importVariations.ts).
    const parentLinkOuterRef = toOuterRef(
      produtoMercadoLivreLinkCollection.docPath({ produtoId: row.produtoId }, link.linkDocId),
    );
    for (const child of row.children) {
      const matched = child.varLinks.filter(
        (v) => v.produtoMercadoLivreOuterRef === parentLinkOuterRef,
      );
      if (matched.length === 0) {
        skips.push({ itemId: null, produtoId: child.produtoId, code: 'SEM_LINK' });
        continue;
      }
      const preco = propagate ? anchorPreco : precoPositivo(child.precos, opts.tabelaNormalId);
      for (const varLink of matched) {
        if (varLink.itemId == null) {
          skips.push({ itemId: null, produtoId: child.produtoId, code: 'SEM_ITEM_ID' });
          continue;
        }
        if (emittedItemIds.has(varLink.itemId)) continue; // cross-listing dedup — silent
        if (preco == null) {
          skips.push({
            itemId: varLink.itemId,
            produtoId: child.produtoId,
            code: 'PRECO_NAO_ENCONTRADO',
          });
          continue;
        }
        emittedItemIds.add(varLink.itemId);
        drafts.push({
          kind: 'variationItem',
          itemId: varLink.itemId,
          produtoId: row.produtoId,
          variacaoProdutoId: child.produtoId,
          linkDocId: link.linkDocId,
          preco,
        });
      }
    }
  }

  if (drafts.length > MAX_DRAFTS_PER_FAMILY) {
    console.error('[mercado-livre] price-sync: família excede o limite de drafts por família', {
      integracaoId: opts.integracaoId,
      produtoId: row.produtoId,
      drafts: drafts.length,
      max: MAX_DRAFTS_PER_FAMILY,
    });
    return {
      drafts: [],
      skips: [{ itemId: null, produtoId: row.produtoId, code: 'FAMILIA_MUITO_GRANDE' }],
    };
  }

  return { drafts, skips };
}

/* ------------------------------- status gate ------------------------------- */

/**
 * The documented ML listing statuses (developers.mercadolivre.com.br,
 * 2026-07-24 — `bulkEstoquePlan`'s set, kept private there).
 */
const DOCUMENTED_ML_STATUSES = new Set([
  'active',
  'paused',
  'under_review',
  'closed',
  'inactive',
  'payment_required',
]);

/** `podeEnviarPreco`'s verdict — the `code` is the skip code the send records. */
export type PrecoStatusGate = { ok: true } | { ok: false; code: string };

/**
 * The price-update status gate (decision 6), run at SEND time against the
 * FRESHLY-fetched item, never the stored link. Unlike stock, ML accepts price
 * updates on any `paused` listing (whatever the sub_status) and on
 * `under_review` unless the review is `forbidden`; `closed` is terminal. A
 * null/blank status is `STATUS_desconhecido`, any other undocumented status is
 * `STATUS_<x>` — both never send, and only statuses OUTSIDE the documented set
 * warn (the `podeEnviarEstoque` desconhecido discipline).
 */
export function podeEnviarPreco(
  status: string | null | undefined,
  subStatus: readonly string[] | null | undefined,
): PrecoStatusGate {
  if (status === 'active' || status === 'paused') return { ok: true };
  if (status === 'under_review') {
    return (subStatus ?? []).includes('forbidden')
      ? { ok: false, code: 'FORBIDDEN' }
      : { ok: true };
  }
  if (status === 'closed') return { ok: false, code: 'CLOSED' };
  if (status == null || status === '') {
    console.warn('[mercado-livre] price-sync: status de anúncio ausente', {
      status: status ?? null,
    });
    return { ok: false, code: 'STATUS_desconhecido' };
  }
  if (!DOCUMENTED_ML_STATUSES.has(status)) {
    console.warn('[mercado-livre] price-sync: status de anúncio fora do conjunto documentado', {
      status,
    });
  }
  return { ok: false, code: `STATUS_${status}` };
}

/* --------------------------------- helpers --------------------------------- */

/**
 * The tabela's price off a raw `precos` map: a finite `valor > 0` →
 * `roundReais`'d (the ONE sanctioned rounding), anything else → null
 * (`PRECO_NAO_ENCONTRADO` downstream). Tolerates junk entries — legacy docs
 * can hold non-object values under a tabela key.
 */
function precoPositivo(precos: PrecoFamilyRow['precos'], tabelaId: string): number | null {
  const entry = precos?.[tabelaId];
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const valor = (entry as { valor?: unknown }).valor;
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0
    ? roundReais(valor)
    : null;
}

/** Narrow a raw `precos` field to the row's map shape — map-level narrowing only;
 * entry values are re-checked at use (`precoPositivo`). */
function coercePrecos(v: unknown): PrecoFamilyRow['precos'] {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as PrecoFamilyRow['precos'])
    : null;
}

/** Narrow a raw doc field to a non-empty string (tolerates legacy/missing data). */
function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
