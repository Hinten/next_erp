import { getDoc, getDocs, type Firestore } from 'firebase/firestore';
import {
  buildQuery,
  groupQuery,
  limit as limitConstraint,
  whereEqual,
  whereOp,
} from '@delfrance/data';
import { docIdSchema, parseProdutoMercadoLivreOuterRef } from '@delfrance/schemas';
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
 * Fewest digits any term needs before it is read as a marketplace item id.
 *
 * ML item ids run 10–13 digits, so a short number is far more likely an SKU —
 * and it still resolves, because the SKU lookups below run for every term
 * regardless. The threshold only decides whether we ALSO spend three queries
 * probing the id fields for it.
 *
 * ⚠️ It guards the PREFIXED branch too, not just bare numbers. Without it
 * `MAX-3` was read as an item id on a single digit, and the cost of a wrong
 * claim is not a wasted query — see {@link resolveProdutoIdsPorTermo}.
 */
const MIN_DIGITOS_ID = 5;

/**
 * Every Mercado Livre site code. The regex below is BUILT from this list rather
 * than approximating it as `M` + two letters.
 *
 * ⚠️ The approximation is what let `MOD-12`, `MAX-3`, `MIN-4` and `MED-10`
 * through — ordinary catalog terms, claimed as listings. Deriving the pattern
 * from the list is also what stops the two drifting: the old rule enumerated
 * these codes in its own prose while matching something wider.
 */
const ML_SITE_IDS = [
  'MLB',
  'MLA',
  'MLM',
  'MLU',
  'MLC',
  'MCO',
  'MPE',
  'MEC',
  'MRD',
  'MPT',
  'MLV',
] as const;

/**
 * A marketplace item id, in either form an operator can paste.
 *
 * ⚠️ `MLB-123` and `MLB123` are the same listing. ML's own surfaces are not
 * consistent about the hyphen, so the stored value (always unhyphenated) is not
 * what a copy-paste necessarily produces — legacy normalised the same two forms
 * (`.old/lib/produtos/pages/produtoTableView.dart:98-102`).
 *
 * The prefix must be a REAL {@link ML_SITE_IDS} code, and the digits must
 * clear {@link MIN_DIGITOS_ID}. Both bounds exist because a wrong claim is not
 * free: it used to make the term's miss final, hiding a produto whose NAME the
 * operator was typing.
 *
 * ⚠️ Case-insensitive across the whole prefix. An id gets pasted as often as it
 * gets typed, and a term that differs from a working one only in case is the
 * kind of miss nobody reports as a bug.
 */
// ⚠️ `[0-9]`, not `\d`: this pattern is assembled as a STRING, and a
// template literal swallows a lone `\d` into a bare `d` — a regex that
// silently matches the LETTER. The character class has no escape to lose.
const RE_ID_COM_SITE = new RegExp(`^(${ML_SITE_IDS.join('|')})-?([0-9]+)$`, 'i');
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
  /**
   * Did the term arrive as a NAKED number, with no site prefix?
   *
   * ⚠️ Load-bearing, not descriptive. Typing `MLB1234567890` says "listing", so
   * its miss is an answer. Typing `12345` says nothing of the kind — this file
   * itself calls that "far more likely an SKU" — so its miss must not be
   * allowed to suppress the nome search. See {@link resolveProdutoIdsPorTermo}.
   */
  bareNumber: boolean;
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
  if (comSite && comSite[2]!.length >= MIN_DIGITOS_ID) {
    return {
      candidates: [`${comSite[1]!.toUpperCase()}${comSite[2]!}`],
      variationId: null,
      bareNumber: false,
    };
  }

  if (RE_SO_DIGITOS.test(trimmed) && trimmed.length >= MIN_DIGITOS_ID) {
    const asNumber = Number(trimmed);
    return {
      bareNumber: true,
      candidates: SITES_PARA_NUMERO.map((site) => `${site}${trimmed}`),
      // ⚠️ Guard the precision boundary rather than trusting `Number`: past
      // 2^53 the parse rounds SILENTLY, and the rounded value would query a
      // variation id that exists but is not the one the operator typed.
      variationId: Number.isSafeInteger(asNumber) ? asNumber : null,
    };
  }

  return null;
}

/** A produto addressed by its own Firestore document id. */
export interface DocumentIdTerm {
  /** The candidate document id, already checked as addressable. */
  id: string;
  /**
   * Did the term arrive as a PATH, rather than as a bare id?
   *
   * ⚠️ Load-bearing, exactly like {@link MarketplaceIdTerm.bareNumber}, and for
   * the same reason. Pasting `/produtos/<id>/editar` is an operator naming ONE
   * produto, so a miss is an answer. Typing a bare `dev-camiseta-pai` is not —
   * that string is a legal document id AND a perfectly plausible SKU, so its
   * miss has to fall through to the other lookups.
   */
  fromPath: boolean;
}

/** The collection segment a produto path is addressed through. */
const SEGMENTO_PRODUTOS = 'produtos';

/**
 * Firestore's document-id ceiling. Same constant, same spelling as `asDocId`
 * in `apps/mercado-livre/lib/marketplace/notificacoes/notificacao.ts` — the
 * limit is 1500 BYTES and this counts CHARS, which is conservative for the
 * only direction that matters here.
 */
const MAX_DOC_ID_CHARS = 1500;

/**
 * Is this string addressable as a `produtos` document id?
 *
 * ⚠️ Deliberately NOT a shape check. Measured on staging, produto ids come in
 * at least four shapes: 20-char Firestore auto-ids (34 of 49), 64-char hex,
 * 70-char Mercado Livre-derived (`XMLB0000…vMLBMLB5125183715`) and kebab-case
 * fixtures (`dev-camiseta-pai`). A tidy "20 alphanumerics" rule would silently
 * refuse the IMPORTED produtos — the ones most likely to be chased by id in the
 * first place.
 *
 * So this refuses only what cannot BE a produto id: a `/`, `.`/`..`, the
 * `__…__` range Firestore reserves for itself, and anything past the backend's
 * 1500-byte ceiling.
 *
 * ⚠️ The separator is refused outright rather than by asking whether `doc()`
 * throws, because it throws for only HALF the bad cases. Measured against a
 * real Firestore and written up at `naoDocId`
 * (`apps/mercado-livre/lib/marketplace/core/linkRefs.ts`): `'a/b'` throws
 * (odd segment count), but `'a/b/c'` does NOT — it silently resolves to
 * `produtos/a/b/c`, a document two levels below the collection we meant, which
 * comes back as a puzzling miss instead of an error.
 *
 * ⚠️ The other three never throw at all: verified against the installed client
 * SDK, `.`, `..`, `__x__` and a 1600-character string all build a reference
 * without complaint, and only the BACKEND rejects them. They are refused here
 * because no produto can carry such an id — not because they would blow up.
 */
function idEnderecavel(id: string | undefined): id is string {
  if (!id) return false;
  if (id === '.' || id === '..') return false;
  if (/^__.*__$/.test(id)) return false;
  if (id.length > MAX_DOC_ID_CHARS) return false;
  return docIdSchema.safeParse(id).success;
}

/**
 * Read a search term as a produto document id, or decide it is not one.
 *
 * Accepts the bare id plus every path form an operator can plausibly copy: the
 * `/produtos/<id>` view URL, the `/produtos/<id>/editar` URL every row links
 * to, a fully qualified one carrying `?query` and `#hash`, and this repo's own
 * `documents/produtos/<id>` outer-ref string.
 *
 * ⚠️ The id is the segment AFTER `produtos`, never the LAST segment. Rows link
 * to `/produtos/<id>/editar`, so `idFromRef`/`parseRef` (`@delfrance/schemas`)
 * hand back `editar` — a term that parses cleanly, matches nothing, and reads
 * exactly like "that produto does not exist".
 *
 * ⚠️ A term containing WHITESPACE is refused outright. None of the 49 produto
 * ids on staging carries any, so the rule costs nothing — and it keeps
 * multi-word name searches, the common case, from paying for a document read
 * they could never satisfy.
 */
export function parseDocumentIdTerm(term: string): DocumentIdTerm | null {
  const trimmed = term.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return null;

  // No slash: the term IS the candidate. Left unstripped on purpose — `?` and
  // `#` are legal inside a document id, and only a PATH can carry a query or a
  // fragment, so trimming them off a bare term would corrupt a real id.
  if (!trimmed.includes('/')) {
    return idEnderecavel(trimmed) ? { id: trimmed, fromPath: false } : null;
  }

  const caminho = trimmed.split('#')[0]!.split('?')[0]!;
  const segmentos = caminho.split('/').filter(Boolean);
  const posicao = segmentos.indexOf(SEGMENTO_PRODUTOS);
  if (posicao < 0) return null;

  const id = segmentos[posicao + 1];
  return idEnderecavel(id) ? { id, fromPath: true } : null;
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
 * ⚠️ The anchor hop is not TOTAL, and the gap is accepted rather than missed. A
 * variation child whose parent has been deleted resolves to a `paiId` that no
 * longer exists, and the list renders empty with no explanation. Verifying the
 * anchor would double the cost of every hit to produce a DIFFERENT empty table:
 * nothing here can tell "parent deleted" from "parent not readable".
 *
 * Three groups, and only one of them always runs:
 *
 * - **The SKU group always runs.** An SKU is an arbitrary string; nothing about
 *   `CAM-PRETA-M` distinguishes it from the start of a produto name, so there
 *   is no term shape that could trigger it. Running it for every term is what
 *   makes the single box able to answer an SKU at all.
 * - **The marketplace-id group runs only for a term shaped like an item id**,
 *   because those probes are pointless for anything else.
 * - **The document-id probe runs for any term that could BE a document id** —
 *   which is nearly any term without whitespace, since produto ids have no one
 *   shape (20-char auto-ids here, 64-char hashes in the legacy corpus, and raw
 *   alphanumeric seller SKUs among the produtos the Flutter app imported).
 *   It is a single point read, so breadth is cheap.
 *
 * Return contract (see `search.resolveIds` in `@delfrance/ui`):
 * `null` → not ours, fall through to the nome search. `{ ids: [] }` → the term
 * NAMED one produto and nothing matched, so show an empty list rather than the
 * nome search's separate miss for a term nobody meant as a name.
 *
 * ⚠️ Two shapes earn that `{ ids: [] }`: a SITE-PREFIXED marketplace id, and a
 * produto PATH (`/produtos/<id>/editar`, `documents/produtos/<id>`). Both are
 * an operator pointing at one produto.
 *
 * ⚠️ A BARE-NUMBER miss returns `null`, not `{ ids: [] }`, and the asymmetry is
 * deliberate. `MLB1234567890` is the operator saying "listing", so its miss is
 * an answer. `12345` says nothing of the kind — this file calls it "far more
 * likely an SKU" — and a produto named `10000 Lumens …` must stay reachable by
 * typing its name. Costs nothing when the term really was an id: the nome
 * prefix search then matches nothing either.
 *
 * ⚠️ A BARE DOCUMENT-ID miss falls through for the same reason, and the legacy
 * corpus is why it must. The Flutter ML import wrote the seller's
 * `seller_custom_field` straight in as the produto's document id, constrained
 * only to `^[a-zA-Z0-9]+$` — so in production a produto id can BE an SKU, of
 * any length, digits included. A bare term is therefore never unambiguous.
 */
export async function resolveProdutoIdsPorTermo(
  db: Firestore,
  term: string,
  cap: number = MAX_PRODUTOS_BUSCA,
): Promise<SearchIdResolution | null> {
  const trimmed = term.trim();
  if (trimmed === '') return null;

  const idTerm = parseMarketplaceIdTerm(trimmed);
  const docIdTerm = parseDocumentIdTerm(trimmed);
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
    // 0. The produto's OWN document id — the identifier an operator always has,
    //    because it sits in the address bar of every produto page they open.
    //    One point read, no index, the cheapest probe in this file.
    //
    //    ⚠️ FIRST in the array, and that is not cosmetic: `limitarIds` dedupes
    //    and slices in INSERTION order, so whichever task runs first is the one
    //    the cap cannot drop. An exact id is the most precise answer this box
    //    can give; it must not be the hit that falls off the end.
    //
    //    ⚠️ The only task here that CATCHES, because `getDoc` is the only one
    //    that rejects where the others degrade. Verified in the installed SDK
    //    (`@firebase/firestore` 4.14.1, `common-*.node.mjs`): a point read of a
    //    MISSING document while offline hits `if (!exists && snap.fromCache)`
    //    and rejects `UNAVAILABLE`, where `getDocs` resolves from cache. Without
    //    this catch one offline probe fails the WHOLE box — including the plain
    //    name searches the three SKU queries would still have answered.
    //    It hides nothing real: task 1 reads the same `produtos` collection
    //    uncaught, so a genuine permission failure still surfaces there.
    ...(docIdTerm
      ? [
          getDoc(produtoCollection.docRef(db, {}, docIdTerm.id))
            .then((snap) =>
              // The anchor hop, exactly as in lookup 1: the list filters
              // `paiId == null`, so a pasted VARIATION CHILD id has to come back
              // as its parent or the row is dropped without a word.
              snap.exists() ? [snap.data().paiId ?? snap.id] : [],
            )
            .catch(() => []),
        ]
      : []),

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
  // Did the term name ONE produto unambiguously? Then its miss is an answer,
  // and the list should show nothing rather than fall through to a nome search
  // for a string nobody meant as a name. Two shapes qualify: a site-prefixed
  // marketplace id, and a produto PATH. Everything else — a naked number, a
  // bare id that is equally plausible as an SKU — hands the term back.
  const termoInequivoco = (idTerm !== null && !idTerm.bareNumber) || (docIdTerm?.fromPath ?? false);
  if (ids.length === 0 && !termoInequivoco) return null;
  return { ids, truncated };
}
