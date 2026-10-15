/**
 * The two DETERMINISTIC link-document ids of a Shopee native kit (step 19,
 * #1527) — pure digests, `node:crypto` only.
 *
 * ## Why a kit link's id is derived when no other Shopee link's is
 *
 * Every other `prodshopee` / `variashopee` document is a Firestore AUTO id, and
 * the import's RESOLVE is its idempotence (`produtos/links.ts`). A native kit
 * has TWO writers that must land on ONE document: the kit create writes its
 * link right after `add_kit_item` answers an `item_id` (L9 — there is no intent
 * document before it), and step 9's import writes a NEW kit link when its
 * parent cascade finds none. A crash between `add_kit_item` and the create's
 * link write, or an import that runs in that window, would otherwise leave two
 * `prodshopee` documents for one `item_id`. With both writers computing the id
 * from (conta, `item_id`), the second write is a merge onto the first — rule 7
 * tier 0: the race is made impossible, not survived.
 *
 * A kit MODEL's row is keyed the same way, by (link document, `model_id`), so
 * the kit arms' `create()` and step 9's upserting merge produce exactly ONE row
 * per (link, model) whichever runs first.
 *
 * ## Why here and not in `packages/schemas`
 *
 * `packages/schemas` is bundled into the browser and holds no crypto. These ids
 * are only ever COMPUTED by server writers, so they live in the app, beside the
 * kit code that consumes them; `produtos/` imports them for the import's half.
 *
 * ## The preimages, and why each piece is there
 *
 * - `shopee-kit|<integracaoId>|<item_id>` — CONTA-scoped like every other
 *   Shopee identity here (`produtos/produtoIds.ts` explains why not shop-
 *   scoped). The `shopee-kit` prefix keeps it from ever equalling the parent
 *   PRODUTO id of the same listing (`shopee|<integracaoId>|<item_id>`), which
 *   lives in a different collection but is easy to confuse in a log line.
 * - `<linkDocId>|<model_id>` — the link document is the scope, so a model id
 *   can never collide across two listings, and a pre-step-19 kit link that kept
 *   its AUTO id still gets deterministic rows under it.
 *
 * ⚠️ The pipes are load-bearing: without them `('int-1', 2500139870)` and
 * `('int-12', 500139870)` would share a preimage. ⚠️ Inputs are checked rather
 * than coerced — an empty conta, or an id that is not a positive safe integer
 * (`0` is Shopee's "no model" sentinel and is never written as a row), throws
 * `RangeError` instead of hashing `undefined`/`NaN` into a plausible id.
 */
import { createHash } from 'node:crypto';

function sha256Hex(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

function exigirTexto(valor: string, nome: string): void {
  if (typeof valor !== 'string' || valor === '') {
    throw new RangeError(`idsKit: ${nome} vazio`);
  }
}

function exigirIdShopee(valor: number, nome: string): void {
  if (!Number.isSafeInteger(valor) || valor <= 0) {
    throw new RangeError(`idsKit: ${nome} não é um inteiro positivo (${String(valor)})`);
  }
}

/**
 * The `prodshopee` doc id of a native kit's listing link:
 * hex `sha256(utf8("shopee-kit|<integracaoId>|<item_id>"))`.
 */
export function idDoVinculoDeKit(integracaoId: string, itemId: number): string {
  exigirTexto(integracaoId, 'integracaoId');
  exigirIdShopee(itemId, 'item_id');
  return sha256Hex(`shopee-kit|${integracaoId}|${String(itemId)}`);
}

/**
 * The `variashopee` doc id of one kit MODEL's row under a kit link:
 * hex `sha256(utf8("<linkDocId>|<model_id>"))`.
 */
export function idDaVariacaoDeKit(linkDocId: string, modelId: number): string {
  exigirTexto(linkDocId, 'linkDocId');
  exigirIdShopee(modelId, 'model_id');
  return sha256Hex(`${linkDocId}|${String(modelId)}`);
}
