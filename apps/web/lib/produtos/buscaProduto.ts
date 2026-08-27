import { getDocs, type Firestore } from 'firebase/firestore';
import {
  buildQuery,
  groupQuery,
  limit as limitConstraint,
  whereEqual,
  whereOp,
} from '@delfrance/data';
import { parseProdutoMercadoLivreOuterRef } from '@delfrance/schemas';
import type { SearchIdResolution } from '@delfrance/ui';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoMercadoLivreLinkCollection } from '@/lib/data/produtoMercadoLivreLinkCollection';
import { variacaoMercadoLivreLinkCollection } from '@/lib/data/variacaoMercadoLivreLinkCollection';
import { getDocsByIds } from '@/lib/data/getDocsByIds';

/**
 * Ceiling on how many produtos one search term may resolve to.
 *
 * 30 is not a taste call: the resolved ids reach Firestore as a `documentId()`
 * `in` restriction, and the JS SDK caps that filter at 30 values. Past it the
 * list would have to be chunked into several queries and merged, which buys
 * nothing here — a search that matches 30 produtos has already failed at being
 * a search. Hitting the cap is reported (`truncated`) rather than silently
 * trimmed.
 */
export const MAX_PRODUTOS_BUSCA = 30;

/**
 * Fewest digits a BARE number is treated as a marketplace item id.
 *
 * ML item ids run 10–13 digits, so a short number is far more likely an SKU —
 * and it still resolves, because the SKU lookups below run for every term
 * regardless. The threshold only decides whether we ALSO spend three queries
 * probing the id fields for it.
 */
const MIN_DIGITOS_ID_NU = 5;

/**
 * A marketplace item id, in either form an operator can paste.
 *
 * ⚠️ `MLB-123` and `MLB123` are the same listing. ML's own surfaces are not
 * consistent about the hyphen, so the stored value (always unhyphenated) is not
 * what a copy-paste necessarily produces — legacy normalised the same two forms
 * (`.old/lib/produtos/pages/produtoTableView.dart:98-102`).
 *
 * The prefix is matched as `M` + two letters rather than any three letters:
 * every ML site code starts with `M` (MLB, MLA, MLM, MLU, MLC, MCO, MPE, MEC,
 * MRD, MPT, MLV), and requiring it keeps an SKU shaped like `AB-1234` out of
 * the id branch — where a miss means "no such listing" and would otherwise
 * suppress the name search for a perfectly ordinary term.
 *
 * ⚠️ Case-insensitive across the WHOLE prefix, leading `M` included. An id
 * gets pasted as often as it gets typed, and a term that differs from a
 * working one only in case is the kind of miss nobody reports as a bug.
 */
const RE_ID_COM_SITE = /^(M[A-Z]{2})-?(\d+)$/i;
const RE_SO_DIGITOS = /^\d+$/;

/**
 * Site prefixes tried for a BARE number. Legacy only ever prepended `MLB`
 * (`produtoTableView.dart:100`); `MLU` is here because this seller also lists
 * on Uruguay. Both are cheap — they ride ONE `in` filter, not a query each.
 */
const SITES_PARA_NUMERO = ['MLB', 'MLU'] as const;

export interface MarketplaceIdTerm {
  /** Normalised, site-prefixed candidates for the string id fields. */
  candidates: string[];
  /**
   * The legacy `variacaoMercadoLivre.id` — a plain integer, unique only WITHIN
   * its parent item. Only a bare-number term can be one.
   */
  variationId: number | null;
}

/**
 * Read a search term as a marketplace item id, or decide it is not one.
 *
 * Returning `null` is what makes the single search box work: the caller falls
 * back to the nome search only for terms this rejects.
 */
export function parseMarketplaceIdTerm(term: string): MarketplaceIdTerm | null {
  const trimmed = term.trim();
  if (trimmed === '') return null;

  const comSite = RE_ID_COM_SITE.exec(trimmed);
  if (comSite) {
    return { candidates: [`${comSite[1]!.toUpperCase()}${comSite[2]!}`], variationId: null };
  }

  if (RE_SO_DIGITOS.test(trimmed) && trimmed.length >= MIN_DIGITOS_ID_NU) {
    const asNumber = Number(trimmed);
    return {
      candidates: SITES_PARA_NUMERO.map((site) => `${site}${trimmed}`),
      // ⚠️ Guard the precision boundary rather than trusting `Number`: past
      // 2^53 the parse rounds SILENTLY, and the rounded value would query a
      // variation id that exists but is not the one the operator typed.
      variationId: Number.isSafeInteger(asNumber) ? asNumber : null,
    };
  }

  return null;
}

/** Dedupe, cap, and report whether the cap threw anything away. */
function limitarIds(
  bruto: ReadonlyArray<string | null | undefined>,
  cap: number,
): { ids: string[]; truncated: boolean } {
  const unicos = new Set<string>();
  for (const id of bruto) if (id) unicos.add(id);
  const todos = [...unicos];
  // ⚠️ Dedupe BEFORE the cap. The same produto legitimately matches several of
  // the queries below (its SKU and its listing id), so capping the raw list
  // would both drop real matches and report a truncation that never happened.
  return { ids: todos.slice(0, cap), truncated: todos.length > cap };
}

/**
 * Resolve a search term to the produtos the catalog list should show.
 *
 * The `/produtos` list filters `paiId == null`, so every hit has to be mapped
 * to its family ANCHOR — resolving a variation child would hand the list an id
 * it then silently drops, which reads exactly like "not found".
 *
 * Two halves, and only one of them is conditional:
 *
 * - **The SKU half always runs.** An SKU is an arbitrary string; nothing about
 *   `CAM-PRETA-M` distinguishes it from the start of a produto name, so there
 *   is no term shape that could trigger it. Running it for every term is what
 *   makes the single box able to answer an SKU at all.
 * - **The id half runs only for a term shaped like an item id**, because those
 *   probes are pointless for anything else.
 *
 * Return contract (see `search.resolveIds` in `@delfrance/ui`):
 * `null` → not ours, fall through to the nome search. `{ ids: [] }` → it WAS an
 * id term and nothing matched, so show an empty list rather than the nome
 * search's separate miss for a term nobody meant as a name.
 */
export async function resolveProdutoIdsPorTermo(
  db: Firestore,
  term: string,
  cap: number = MAX_PRODUTOS_BUSCA,
): Promise<SearchIdResolution | null> {
  const trimmed = term.trim();
  if (trimmed === '') return null;

  const idTerm = parseMarketplaceIdTerm(trimmed);
  // One over the cap: enough to know the answer was cut, without paying for a
  // page of results nobody will see.
  const fetchLimit = cap + 1;

  // A variation link doc lives under the variation CHILD; its
  // `produtoMercadoLivreOuterRef` names the anchor's link doc, so the anchor
  // comes free. A row whose ref is missing or malformed (the legacy corpus
  // predates the field) falls back to a `paiId` read, collected here and done
  // in ONE batch rather than a read per row.
  const semOuterRef: string[] = [];
  const ancoraDeVariacao = (ref: unknown, childId: string | undefined): string | null => {
    const parsed = parseProdutoMercadoLivreOuterRef(ref);
    if (parsed) return parsed.produtoId;
    if (childId) semOuterRef.push(childId);
    return null;
  };

  const pmlGroup = groupQuery(
    db,
    'produtoMercadoLivre',
    produtoMercadoLivreLinkCollection.converter,
  );
  const variacaoGroup = groupQuery(
    db,
    'variacaoMercadoLivre',
    variacaoMercadoLivreLinkCollection.converter,
  );

  const tarefas: Array<Promise<Array<string | null | undefined>>> = [
    // 1. The produto's own SKU. Not filtered to `paiId == null`: a variation
    //    child carries its own SKU and is what an operator scans off a label,
    //    so match it and hand back its parent.
    getDocs(
      buildQuery(produtoCollection.ref(db, {}), [
        whereEqual('sku', trimmed),
        limitConstraint(fetchLimit),
      ]),
    ).then((snap) => snap.docs.map((d) => d.data().paiId ?? d.id)),

    // 2. The SKU registered on the listing itself, which routinely differs from
    //    the ERP's — it is whatever was sent to ML as `seller_custom_field`.
    getDocs(buildQuery(pmlGroup, [whereEqual('sku', trimmed), limitConstraint(fetchLimit)])).then(
      (snap) => snap.docs.map((d) => d.ref.parent.parent?.id),
    ),

    // 3. Same, per User-Products member.
    getDocs(
      buildQuery(variacaoGroup, [whereEqual('sku', trimmed), limitConstraint(fetchLimit)]),
    ).then((snap) =>
      snap.docs.map((d) =>
        ancoraDeVariacao(d.data().produtoMercadoLivreOuterRef, d.ref.parent.parent?.id),
      ),
    ),
  ];

  if (idTerm) {
    tarefas.push(
      // 4. The anchor link's `id`. ⚠️ Under User Products this field is
      //    `familyId ?? itemId`, so a member's own MLB will NOT be here — which
      //    is exactly why query 5 exists rather than being a nicety.
      getDocs(
        buildQuery(pmlGroup, [whereOp('id', 'in', idTerm.candidates), limitConstraint(fetchLimit)]),
      ).then((snap) => snap.docs.map((d) => d.ref.parent.parent?.id)),

      // 5. A User-Products member's own item id.
      getDocs(
        buildQuery(variacaoGroup, [
          whereOp('itemId', 'in', idTerm.candidates),
          limitConstraint(fetchLimit),
        ]),
      ).then((snap) =>
        snap.docs.map((d) =>
          ancoraDeVariacao(d.data().produtoMercadoLivreOuterRef, d.ref.parent.parent?.id),
        ),
      ),
    );

    // 6. The legacy numeric variation id, off an order line rather than a URL.
    if (idTerm.variationId !== null) {
      tarefas.push(
        getDocs(
          buildQuery(variacaoGroup, [
            whereEqual('id', idTerm.variationId),
            limitConstraint(fetchLimit),
          ]),
        ).then((snap) =>
          snap.docs.map((d) =>
            ancoraDeVariacao(d.data().produtoMercadoLivreOuterRef, d.ref.parent.parent?.id),
          ),
        ),
      );
    }
  }

  const encontrados = (await Promise.all(tarefas)).flat();

  if (semOuterRef.length > 0) {
    const filhos = await getDocsByIds(db, produtoCollection, semOuterRef.slice(0, fetchLimit));
    for (const [childId, filho] of filhos) encontrados.push(filho.paiId ?? childId);
  }

  const { ids, truncated } = limitarIds(encontrados, cap);
  // Nothing matched AND the term was never an id: hand it back so the nome
  // search gets its turn. An id term that missed stays ours — see the jsdoc.
  if (ids.length === 0 && !idTerm) return null;
  return { ids, truncated };
}
