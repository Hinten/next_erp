/**
 * Resolve the `produtoMercadoLivre` link an ML item id belongs to — the pure,
 * testable half of `scripts/inspect-anuncio.ts`.
 *
 * ⚠️ **This module exists because a lookup that only knows stage 1 reports every
 * User-Products family member as unknown to the ERP**, and the #1087 live run
 * filed a bug against a perfectly healthy listing because of it (#1342). Under
 * User Products the parent link's `id` is `familyId ?? itemIds[0]`
 * (`publish.ts:629`), so a member's own `MLB…` never appears on a
 * `produtoMercadoLivre` doc at all — it lives on `variacaoMercadoLivre.itemId`,
 * a different collection group. A single-stage query cannot see it, and the miss
 * is silent in the sense that matters: it reads as "no link", not "wrong stage".
 *
 * ⚠️ It lives in `lib/` rather than beside the script for the reason
 * `pedidoMoneyAudit.ts` does: `scripts/` is outside every vitest `include`
 * (`{app,lib,functions}/**`), so logic written there can never be tested. The
 * script keeps the rendering; the decisions are here.
 *
 * The shape is a faithful port of `resolveLink` in `itemsStatusSync.ts` (the
 * #1142 fix) and reuses its member hop, `resolveUpFamilyByMemberItemId`.
 * ⚠️ That function is deliberately NOT refactored to call this one: its return is
 * shaped for the family-fold path, it owns the diagnostic `console.warn`, and it
 * sits on the live `items` webhook. Collapsing the two is worth doing and is not
 * this change — a script fix must not reach into the notification pipeline.
 *
 * Pure — no Firestore, no IO, no clock. The one impure piece is
 * {@link anuncioLinkPortFirestore} at the bottom, which is the seam.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { refMatchesIntegracao } from '../core/linkRefs';
import { resolveUpFamilyByMemberItemId, type UpMemberResolution } from './upMemberLink';

/** One `produtoMercadoLivre` doc whose `id` matched, before any conta filter. */
export interface LinkPaiCandidato {
  /** The owning produto (`ref.parent.parent.id`); null for an orphaned ref. */
  produtoId: string | null;
  linkDocId: string;
  link: Record<string, unknown>;
}

/**
 * The two queries the resolution needs, injected so the decision logic can be
 * tested without a Firestore double.
 *
 * ⚠️ Both rides are already declared in `firestore.indexes.json` —
 * `produtoMercadoLivre(id)` and `variacaoMercadoLivre(itemId)`, both
 * `COLLECTION_GROUP`. Firestore is Enterprise here: a filter combination absent
 * from that file does not throw, it silently full-scans and bills data scanned
 * (root `CLAUDE.md` rule 1). So neither stage may gain a filter — in particular
 * the conta check stays in code, where both reference implementations put it.
 */
export interface AnuncioLinkPort {
  /** Stage 1 — parent links whose `id` equals this item id, on ANY conta. */
  linksPorId(itemId: string): Promise<readonly LinkPaiCandidato[]>;
  /** Stage 2 — the UP family this item id is a member of, on THIS conta. */
  familiaPorMembro(itemId: string): Promise<UpMemberResolution | null>;
}

/** The member link behind an item id, when the resolved link is a UP family. */
export interface MembroDoLink {
  /** The variation CHILD produto that owns the member link. */
  produtoId: string;
  /** The `variacaoMercadoLivre` doc id. */
  docId: string;
  raw: Record<string, unknown>;
  pmlOuterRef: string;
  /**
   * Which stage answered. `familia` — the id matched no parent link and was
   * found as a member. `id-do-pai` — the parent link's own `id` IS this member's
   * item id, which happens when ML omits `family_id` and `publish.ts` falls back
   * to `itemIds[0]`.
   */
  via: 'id-do-pai' | 'familia';
}

export type AnuncioLinkLookup =
  | {
      achado: true;
      /** The FAMILY / parent produto — never a variation child. */
      produtoId: string;
      linkDocId: string;
      link: Record<string, unknown>;
      membro: MembroDoLink | null;
    }
  | {
      achado: false;
      /** `produtoMercadoLivre` docs carrying this id, before the conta filter. */
      candidatos: number;
      /** How many of those belonged to a DIFFERENT integração. */
      deOutraConta: number;
    };

/**
 * The link this item id resolves to on this account, or why it resolved to none.
 *
 * TWO stages, and the order is the cost model — stage 1 first because it answers
 * every simple listing and every UP single-item one; stage 2 costs one more
 * indexed group query, paid only by ids the first stage could not place.
 *
 * ⚠️ Ownership is proven through the PARENT link's `contaOuterRef`, NEVER the
 * member's own. `variacaoMercadoLivre.contaOuterRef` is `.nullable()` and is null
 * on every row predating #920 until the backfill runs, so trusting it would
 * resolve nothing for exactly the oldest listings.
 *
 * ⚠️ A stage-1 hit on a User-Products link is not automatically a simple
 * listing (the remaining half of #1142): when ML omits `family_id` the parent's
 * `id` is member 0's item id, so a UP hit pays one more lookup to ask whether
 * this id is also a member of the family it just matched. A UP single-item
 * listing has no member link and answers no; a legacy `variations[]` member has
 * `itemId: null` and cannot match either.
 *
 * The miss carries two counts rather than a bare null, because "never linked
 * here" and "linked, but under another conta" are different problems with the
 * same symptom — and the caller has to say which one it found.
 */
export async function resolverLinkDoAnuncio(
  port: AnuncioLinkPort,
  itemId: string,
  integracaoId: string,
): Promise<AnuncioLinkLookup> {
  const candidatos = await port.linksPorId(itemId);
  let deOutraConta = 0;

  for (const c of candidatos) {
    if (!refMatchesIntegracao(c.link.contaOuterRef, integracaoId)) {
      deOutraConta += 1;
      continue;
    }
    const { produtoId, linkDocId, link } = c;
    if (produtoId == null) continue;
    if (link.isUserProductModel !== true) {
      return { achado: true, produtoId, linkDocId, link, membro: null };
    }

    const membro = await port.familiaPorMembro(itemId);
    // Only a member of THIS link. A different family that happens to hold the
    // same item id cannot be reached from here, and the parent this loop matched
    // stays the answer.
    const daMesmaFamilia =
      membro != null && membro.produtoId === produtoId && membro.linkDocId === linkDocId;
    return {
      achado: true,
      produtoId,
      linkDocId,
      link,
      membro: daMesmaFamilia ? paraMembro(membro, 'id-do-pai') : null,
    };
  }

  // Stage 2 — a User-Products family MEMBER. The id lives on the member's own
  // `variacaoMercadoLivre` doc and matches no parent link at all.
  const membro = await port.familiaPorMembro(itemId);
  if (membro != null) {
    return {
      achado: true,
      produtoId: membro.produtoId,
      linkDocId: membro.linkDocId,
      link: membro.linkRaw,
      membro: paraMembro(membro, 'familia'),
    };
  }

  return { achado: false, candidatos: candidatos.length, deOutraConta };
}

function paraMembro(m: UpMemberResolution, via: MembroDoLink['via']): MembroDoLink {
  return {
    produtoId: m.childProdutoId ?? '',
    docId: m.memberDocId,
    raw: m.memberRaw,
    pmlOuterRef: m.pmlOuterRef,
    via,
  };
}

/**
 * The Firestore-backed port — the only part of this module that touches a
 * database, kept thin so the untested surface is trivially reviewable.
 *
 * ⚠️ Stage 1 is deliberately UNBOUNDED, matching both reference implementations.
 * It is an equality on an indexed field, so it is a seek rather than a scan, and
 * a `limit()` would turn `candidatos` into a truncated count in the very message
 * that reports it.
 */
export function anuncioLinkPortFirestore(db: Firestore, integracaoId: string): AnuncioLinkPort {
  return {
    async linksPorId(itemId) {
      const snap = await produtoMercadoLivreLinkCollection
        .groupQuery(db)
        .where('id', '==', itemId)
        .get();
      return snap.docs.map((d) => ({
        produtoId: d.ref.parent?.parent?.id ?? null,
        linkDocId: d.id,
        link: d.data() as Record<string, unknown>,
      }));
    },
    familiaPorMembro: (itemId) => resolveUpFamilyByMemberItemId(db, itemId, integracaoId),
  };
}

/** Stored `attributes`, tolerating the `.nullable()` both link schemas declare. */
function atributosDoLink(raw: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(raw.attributes) ? (raw.attributes as Record<string, unknown>[]) : [];
}

/**
 * The stored attributes to diff against ML, for a link that may be a UP family.
 *
 * ⚠️ A UNION KEYED BY `id`, never a concatenation, and that is not a style
 * preference — `printAttributes` consumes its ML map destructively
 * (`mlById.delete(id)` on a match), so a duplicate id makes the SECOND copy fall
 * into the unmatched branch and print `✗ … o Mercado Livre NÃO devolveu este
 * atributo` for an attribute ML returned perfectly well. That is the same
 * phantom class this module exists to remove, one table further down.
 *
 * ⚠️ Both provenances are real, which is why neither list alone is right:
 *  - a family PUBLISHED from the ERP keeps the axes only on the member link —
 *    `buildParentAttributes` never puts COLOR/SIZE on the parent — so the parent
 *    alone reports every axis as `+ só no Mercado Livre`;
 *  - a family IMPORTED from ML has them on BOTH, because `itemPayload.ts` posts a
 *    member's identity attributes in its ordinary `attributes` array and
 *    `importCore.ts:445` then stores that array on the PARENT link while `:834`
 *    stores the combinations on the MEMBER link.
 *
 * The member wins by id — the precedence `buildUserProductItemPayload` itself
 * uses ("Family-level attributes lose to the member's own by id"). Parent order
 * is preserved; member-only ids append.
 *
 * Id-less custom characteristics pass through untouched: they never reach
 * `mlById`, so a duplicate there is a repeated informational line, not a finding.
 */
export function atributosParaDiff(
  link: Record<string, unknown>,
  membro: { raw: Record<string, unknown> } | null,
): Record<string, unknown>[] {
  const porId = new Map<string, Record<string, unknown>>();
  const semId: Record<string, unknown>[] = [];
  for (const a of [...atributosDoLink(link), ...(membro ? atributosDoLink(membro.raw) : [])]) {
    if (typeof a.id === 'string' && a.id.length > 0) porId.set(a.id, a);
    else semId.push(a);
  }
  return [...porId.values(), ...semId];
}
