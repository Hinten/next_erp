/**
 * The four SKU rungs of a marketplace order line's produto resolution — the
 * promoted, channel-neutral form of the SKU stage that lived in
 * `apps/mercado-livre/lib/marketplace/pedidos/orderProdutoResolve.ts` until
 * #1513 (Shopee step 5).
 *
 * `packages/data/src/admin/clientes/findOrCreateCliente.ts` is the exact
 * precedent: promoted out of `orderCliente.ts` by #786 because every channel
 * that imports an order needs the same resolution, and a second copy of a
 * decision this expensive drifts toward plausible while reading correct.
 *
 * ## Why it can move at all
 *
 * Nothing here is ML-shaped. The stage touches `produtoCollection` plus
 * `ehFamiliaDeUm` / `unidadeVendavel` / `skuPaiDoMembroUnico` from
 * `@delfrance/schemas`; the channel enters only through `paiId` — whatever the
 * CALLER's link step resolved (an ML parent listing, a Shopee `prodshopee`
 * item) or `null` when it resolved nothing — and through `canal`, which is the
 * prefix of the two operator-facing warnings.
 *
 * ## Why it must not be copied
 *
 * Three guards carry the cost, and each one is a wrong bind rather than a
 * missing one — the kind nothing reports:
 *
 *  - **the kit guard**: binding a kit's sole member moves ZERO stock, and the
 *    line HAS a produto, so no incidente is raised either;
 *  - **`ehFamiliaDeUm` on `sku-pai-do-membro`**: without it a `-UN`-suffixed
 *    variation child of a família de muitos binds a parent that owns no estoque
 *    rows, and `aplicarPlano` creates one at `0 + delta` — negative, from
 *    nothing;
 *  - **`probeSkuUnico`'s `limit(2)`-as-a-detector**: sibling and root SKUs are
 *    legally non-unique in this data, so `limit(1)` with no `orderBy` bound
 *    whichever document the index happened to return first.
 *
 * ## Cost
 *
 * Every rung is served by the `produtos (sku, paiId)` composite already
 * declared in `firestore.indexes.json` (#779) — on Firestore Enterprise an
 * unindexed predicate silently full-scans and is billed by data scanned (root
 * `CLAUDE.md` rule 1). A rung that hits ends the stage, so the later ones were
 * unreachable in that state anyway; the only rung that adds a read on a path
 * that has already missed everything is the stripped probe, and it runs solely
 * for a sku that carries the sole-member suffix.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  ehFamiliaDeUm,
  skuPaiDoMembroUnico,
  unidadeVendavel,
  type ProdutoDeFamilia,
} from '@delfrance/schemas';

import { produtoCollection } from '../collections';

/**
 * Which SKU rung answered. Diagnostic for a HIT, but a MISS kind is persisted —
 * it picks the incidente's `subtipo` and message on every channel, so these
 * strings are not free to rename.
 */
export type SkuMatchKind =
  /** The SKU named exactly one child of the produto the link step found. */
  | 'sku-child'
  /** The SKU named exactly one ROOT produto (`paiId == null`). */
  | 'sku-root'
  /** The SKU named exactly one produto anywhere — neither conta- nor parent-verified. */
  | 'sku-any'
  /**
   * A SKU rung matched a produto that turned out to be the PARENT of a family
   * of one, and the line was bound to its sole member instead — the produto
   * that owns the stock (#1398). Distinct from the rung that found it, because
   * "the SKU named a wrapper" is a different fact from "the SKU named this".
   */
  | 'sku-membro-unico'
  /**
   * No produto carries the incoming SKU, but removing the sole-member suffix
   * named exactly one ROOT that is a família de um — so the SKU was its
   * MEMBER's. Distinct from `sku-root`/`sku-membro-unico`, which both mean the
   * SKU matched a produto literally: here nothing did, and the bind rests on a
   * string transform. A wrong bind on this rung has a different cause from a
   * wrong bind on those, so the diagnostic must not collapse them.
   */
  | 'sku-pai-do-membro';

/** Why nothing bound. `ambiguous-sku` = the SKU named more than one produto. */
export type SkuMissKind = 'ambiguous-sku' | 'unresolved';

/**
 * Discriminated on `produtoId` so `via: 'sku-child'` can never coexist with a
 * null produto: narrowing on `produtoId != null` gives the caller both halves.
 *
 * ⚠️ The colliding ids of an `ambiguous-sku` are deliberately NOT carried here.
 * They surface in the warning below — the one place that names both produtos —
 * and never in the value: no caller reads them (the incidente message is
 * operator-facing and stays short), and an extra key would make the two miss
 * verdicts structurally different for callers that compare the whole result.
 */
export type ResolvedProdutoPorSku =
  | { produtoId: string; via: SkuMatchKind }
  | { produtoId: null; via: SkuMissKind };

export interface ResolverProdutoPorSkuArgs {
  /** The marketplace-supplied seller SKU. Falsy ⇒ the whole stage is skipped. */
  readonly sku: string | null | undefined;
  /**
   * The produto the CALLER's link step resolved — an ML parent listing, a
   * Shopee `prodshopee` item — or `null`. Scopes the first rung; nothing else.
   */
  readonly paiId: string | null;
  /** Log prefix only, e.g. `'mercado-livre'` / `'shopee'`. Never a query filter. */
  readonly canal: string;
  /**
   * Extra fields merged into both warnings, so a channel keeps naming the
   * anúncio/variação an operator has to open. Diagnostic only — nothing here
   * takes part in a decision.
   */
  readonly contexto?: Readonly<Record<string, unknown>>;
}

/**
 * Resolve the ERP produto for one order line by SKU, narrowest scope first:
 *
 *  1. a child of the known parent (`sku` + `paiId == <paiId>`);
 *  2. a ROOT (`sku` + `paiId == null`) — redirected to the sole member when the
 *     root is a família de um wrapper, and NEVER when it is a kit;
 *  3. the same root rung asked with the sole-member suffix REMOVED, gated on
 *     `ehFamiliaDeUm`;
 *  4. unscoped (`sku` alone) — the only rung that can match a variation child of
 *     a different parent, hence the warning.
 *
 * Each rung binds only when the SKU names EXACTLY ONE produto; two hits end the
 * whole stage with `ambiguous-sku` — see {@link probeSkuUnico}. Ending rather
 * than widening costs nothing: a rung with >= 1 hit already returned, so the
 * later rungs were unreachable in that state anyway.
 *
 * An ambiguous SKU binds nothing and says so. The caller still creates the
 * pedido and still fills every other line field from the marketplace payload —
 * a line with `produtoUid: null` is inert for stock
 * (`calcularAlteracoesEstoque` skips null/`'NONE'`) and raises an incidente.
 */
export async function resolverProdutoPorSku(
  db: Firestore,
  args: ResolverProdutoPorSkuArgs,
): Promise<ResolvedProdutoPorSku> {
  const { sku, paiId, canal, contexto } = args;
  if (!sku) return { produtoId: null, via: 'unresolved' };

  const ambiguo = (rung: SkuMatchKind, ids: string[]): ResolvedProdutoPorSku => {
    // The only surface that names both colliding produtos — the incidente
    // message is operator-facing and must stay short.
    console.warn(`[${canal}] SKU do item corresponde a mais de um produto — não vinculado`, {
      ...contexto,
      sku,
      rung,
      produtoIds: ids,
    });
    return { produtoId: null, via: 'ambiguous-sku' };
  };

  if (paiId != null) {
    const childBySku = await probeSkuUnico(
      produtoCollection.ref(db, {}).where('sku', '==', sku).where('paiId', '==', paiId),
    );
    if (childBySku.kind === 'many') return ambiguo('sku-child', childBySku.ids);
    if (childBySku.kind === 'one') return { produtoId: childBySku.produtoId, via: 'sku-child' };
  }

  /**
   * The kit guard + the family hop: which produto a matched ROOT means.
   *
   * ⚠️ It is only ever handed the result of a `paiId == null` query, which is
   * what lets `probeSkuUnico` leave `paiId` out of the projected `familia`.
   * A rung that resolves anything else must project it and bring a test.
   *
   * It returns the id only — the `via` belongs to the RUNG, and the two rungs
   * below reach here having proved different things.
   */
  const alvoDaRaiz = (raiz: Extract<SkuProbe, { kind: 'one' }>): string =>
    raiz.ehKit ? raiz.produtoId : unidadeVendavel(raiz.familia);

  // Root-only — kept ahead of the unscoped rung so a simple listing's SKU
  // fallback still resolves to the same produto it always did.
  const rootBySku = await probeSkuUnico(
    produtoCollection.ref(db, {}).where('sku', '==', sku).where('paiId', '==', null),
  );
  if (rootBySku.kind === 'many') return ambiguo('sku-root', rootBySku.ids);
  if (rootBySku.kind === 'one') {
    // ⚠️ This rung filters `paiId == null`, so it can only ever match a ROOT —
    // and after #1398 a root with no variations is a WRAPPER whose stock lives
    // on its sole member. Binding the wrapper is not an ambiguity, it is a
    // wrong bind: `calcularAlteracoesEstoque` then moves stock on a produto
    // that owns no estoque rows, and `aplicarPlano` creates one at
    // `0 + delta` — negative, from nothing, on a live marketplace order.
    //
    // ⛔ ...unless it is a KIT. A kit's sole member is a MIRROR of the parent
    // (see `probeSkuUnico`), and the parent is the document that owns the
    // composition an operator edits. The ERP pick path reached the same
    // conclusion (`PrincipalTab.tsx`); this is the surface with LIVE traffic
    // and it must not disagree with it.
    //
    // The family fields ride along on the probe, so this costs no extra read.
    const alvo = alvoDaRaiz(rootBySku);
    return {
      produtoId: alvo,
      via: alvo === rootBySku.produtoId ? 'sku-root' : 'sku-membro-unico',
    };
  }

  // ⛔ The same rung, asked with the SUFFIX REMOVED — and it is the KIT guard
  // above that makes it load-bearing rather than tidy.
  //
  // A sole member's sku is derived (`<paiSku>-UN`) and the member is what
  // publish sends, so a marketplace `seller_sku` for a família de um is a string
  // NO root carries. Without this, resolution falls to the unscoped rung below,
  // which has no `ehKit` guard — so a KIT would bind its own sole member.
  //
  // ⚠️ That is wrong because the member's map is a MIRROR and the three-way
  // merge deliberately leaves a field the operator diverged alone — so parent
  // and member can legitimately disagree, and the parent is the document that
  // owns the composition an operator edits and that #1450's repointing
  // rewrites. Binding the member reads a copy; binding the parent reads the
  // answer. (An earlier version of this comment claimed the member carries no
  // `componentesKit`; that stopped being true when `planejarMembroUnico` moved
  // to `montarMembroUnico`, whose mirror copies all four kit fields.)
  //
  // It also keeps the diagnostic honest: the unscoped rung would report
  // `sku-any` with its "sem vínculo" warning for a line this rung can name.
  //
  // ⚠️ One extra indexed read, and only on the path that already missed both
  // the link and the scoped probes.
  const skuDoPai = skuPaiDoMembroUnico(sku);
  if (skuDoPai !== null && skuDoPai !== sku) {
    const raizDoMembro = await probeSkuUnico(
      produtoCollection.ref(db, {}).where('sku', '==', skuDoPai).where('paiId', '==', null),
    );
    // ⛔ `ehFamiliaDeUm`, and it is the whole correctness of this rung.
    //
    // Stripping is a STRING transform, so it also fires on a sku that was never
    // derived — above all a VARIATION CHILD of a família de muitos:
    // `cartesianVariations` builds a child as `parentSku + variante.codigo`, so
    // a variante whose código is `-UN` produces `X-UN`, byte-identical to what a
    // sole member of `X` would carry. Without this guard that child's sale finds
    // root `X`, `unidadeVendavel` returns `X` ITSELF (a família de muitos has no
    // `filhoUnicoId`), and the line binds a parent that owns no estoque rows —
    // `aplicarPlano` then creates one at `0 + delta`, negative from nothing,
    // which is the exact harm the rung above exists to prevent. A família de um
    // is the only shape whose member's sku this transform can legitimately have
    // produced.
    //
    // ⚠️ `many` FALLS THROUGH rather than ending the stage. The ambiguity would
    // be about `skuDoPai` — a string nobody sent — while the unscoped rung below
    // may still match the incoming `sku` exactly and bind correctly. Ending here
    // would suppress a resolution that works.
    if (raizDoMembro.kind === 'one' && ehFamiliaDeUm(raizDoMembro.familia)) {
      return { produtoId: alvoDaRaiz(raizDoMembro), via: 'sku-pai-do-membro' };
    }
  }

  // Unscoped — legacy parity (`sku__isEqualTo(sku).first()` had no `paiId`
  // filter) and the only rung that can match a variation child of a DIFFERENT
  // parent. Neither conta- nor parent-verified, hence the warning.
  const anyBySku = await probeSkuUnico(produtoCollection.ref(db, {}).where('sku', '==', sku));
  if (anyBySku.kind === 'many') return ambiguo('sku-any', anyBySku.ids);
  if (anyBySku.kind === 'one') {
    console.warn(`[${canal}] produto do item resolvido apenas pelo SKU (sem vínculo)`, {
      ...contexto,
      sku,
      produtoId: anyBySku.produtoId,
    });
    return { produtoId: anyBySku.produtoId, via: 'sku-any' };
  }

  // Nothing bound. The caller keeps `produtoUid: null` — inert for stock
  // (`calcularAlteracoesEstoque` skips null/`'NONE'`) — and records an incidente.
  return { produtoId: null, via: 'unresolved' };
}

/* -------------------------------------------------------------------------- */

/**
 * One SKU rung's verdict — same three-way shape as `queryContaId`
 * (`apps/whatsapp`) and the Mercado Pago collector lookup, which both park
 * rather than guess. `many` carries the ids: the only place they ever surface.
 */
type SkuProbe =
  | {
      kind: 'one';
      produtoId: string;
      familia: ProdutoDeFamilia;
      /** ⛔ A kit is never resolved — see the projection below. */
      ehKit: boolean;
    }
  | { kind: 'none' }
  | { kind: 'many'; ids: string[] };

/**
 * Run one SKU rung under `limit(2)`. The second document is never a candidate,
 * it is the AMBIGUITY SIGNAL: sibling and root SKUs are legally non-unique here
 * (a child's SKU is derived as `parentSku + variante.codigo`, so two variantes
 * without a `codigo` collide), and with `limit(1)` and no `orderBy` these rungs
 * bound whichever document the index happened to return first — a coin flip that
 * then moved stock off the wrong produto. Same limit-2-as-a-detector trick as
 * `resolveSkuBalanco.ts` and rule 2 of `importVariations.ts` (#1067).
 *
 * ⚠️ `docs.length`, NOT `snap.size` — the Admin `QuerySnapshot` has both, but the
 * unit-test double exposes only `docs`, and `undefined > 1` is `false`, which
 * would report every ambiguous rung as a clean bind. The limit lives HERE, once,
 * so no rung can be added without it.
 */
async function probeSkuUnico(query: FirebaseFirestore.Query): Promise<SkuProbe> {
  const snap = await query.limit(2).get();
  if (snap.docs.length === 0) return { kind: 'none' };
  if (snap.docs.length === 1) {
    const doc = snap.docs[0]!;
    const raw = doc.data() as Record<string, unknown>;
    // Carried, not resolved here: only the `sku-root` rung can match a
    // family-of-one PARENT, and folding the hop into this helper would read as a
    // rule the other two rungs obey when it is one they cannot reach.
    return {
      kind: 'one',
      produtoId: doc.id,
      // ⛔ A KIT is never resolved, and it costs nothing: a kit holds no stock of
      // its own, so the only thing the line needs from the produto it names is the
      // COMPOSITION — and the parent is where an operator edits it.
      //
      // ⚠️ This used to say the sole member carries `ehKit: true` and no
      // `componentesKit`. That stopped being true when `planejarMembroUnico` moved
      // to `montarMembroUnico`: the mirror copies all four kit fields, and
      // `upSoleMember.ts` records that omitting them once cost a live listing. The
      // rule survives its old reason for a better one — the member's map is a
      // MIRROR, and the three-way merge deliberately leaves a field the operator
      // diverged alone, so parent and member can legitimately disagree. Binding
      // the parent keeps the line on the document that owns the answer.
      ehKit: raw.ehKit === true,
      familia: {
        id: doc.id,
        // ⚠️ `paiId` is deliberately NOT projected. `unidadeVendavel`'s drift
        // guard reads it, and that guard cannot fire here: BOTH rungs that
        // consume `familia` — `sku-root` and `sku-pai-do-membro` — filter
        // `.where('paiId', '==', null)`, so the value is null by construction.
        // (`ehFamiliaDeUm` reads it too, and reaches the same `undefined`.)
        // Projecting it would look like coverage while being unreachable —
        // exactly the kind of comment-shaped guarantee this repo pays for. A
        // future rung that resolves must project it and bring a test that fails
        // without it.
        filhoUnicoId: raw.filhoUnicoId as string | null | undefined,
      },
    };
  }
  return { kind: 'many', ids: snap.docs.map((d) => d.id) };
}
