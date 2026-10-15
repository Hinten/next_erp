/**
 * **The tabela de medidas one publish needs** — the produto's `tabMedi`
 * document, read ONCE and reduced to what `size_chart_info` can be built from:
 * THIS conta's stored entries and the tabela's FIRST photo (step 18, #1526).
 *
 * `tabelaMedidasPublicacao.ts` decides and touches nothing; this module is the
 * half that reads — the `lerImpostoDoProduto.ts` / `taxInfoPublicacao.ts` split,
 * for the same reason: the decision is a pure function a test can drive over
 * every arm, and the read is the one place a Firestore double has to exist.
 *
 * ## What it reads, and what it never does
 *
 * - **At most ONE document read**, and only when the produto names a tabela.
 *   A `tabelaDeMedidasModaUid` that is absent, blank or not a string costs
 *   nothing; a ref that does not point into `tabMedi` (or whose id is not a
 *   usable document id) costs nothing either — a bad path would throw inside
 *   `docRef`, and that is not a property of the listing.
 * - **Through the collection handle** (`tabelaDeMedidasCollection.docRef`, a
 *   RAW ref — the ML `publish.ts` precedent), never an inline collection
 *   path (this app's rule 3). The document is read RAW and never through
 *   `parseRead`: the Shopee map is handed as `unknown` to the ONE tolerant read
 *   slice in `@delfrance/schemas` (`lerEntradasShopeeDaConta`), so a legacy
 *   oddity in an unrelated field — the ML map, a photo, a date — can never cost
 *   this conta its entries.
 * - **Writes nothing.** It takes a `Firestore` only for `.get()`. This app
 *   never writes `tabMedi`: the pick is the browser's, staged in the tabela's
 *   own save (`/medidas/[id]`, `ObjectView`'s guarded transaction).
 *
 * ## The FIRST photo, and only the first
 *
 * The legacy publish sent the tabela's `fotos.first` as the image chart when no
 * template matched (Lucas, 2026-10-05: template first, else the photo). The
 * reader therefore hands DOWN the first STORED element, parsed with the
 * schemas' `fotoSchema`, or `null`. ⚠️ An unreadable first element is `null`
 * and is NEVER replaced by the second photo: the operator ordered the tabela's
 * photos, and the ones after the first may be pictures of the garment rather
 * than a size chart — sending one would publish the wrong image as the chart.
 * A photo staged for deletion is never stored (the web strips the mark before
 * the save), so there is nothing to skip either.
 *
 * Pure apart from the one read: no clock, no Shopee call, no Next import (the
 * functions bundle reaches `anuncios/`).
 */
import type { Firestore } from 'firebase-admin/firestore';

import { tabelaDeMedidasCollection } from '@delfrance/data/admin/collections';
import {
  type Foto,
  type LeituraEntradasShopee,
  fotoSchema,
  lerEntradasShopeeDaConta,
  parseRef,
  tabelaDeMedidasMeta,
} from '@delfrance/schemas';

import { naoDocId } from './corpoPublicacao';

/**
 * What the produto's tabela offers this conta's publish.
 *
 * - `produto-sem-tabela` — the produto names no tabela. Zero reads.
 * - `tabela-inexistente` — it names one that cannot be read: a ref outside
 *   `tabMedi` or with an unusable id (`tabMediId: null`, zero reads), or a
 *   document that does not exist (`tabMediId` = the id that was read).
 * - `lida` — the document exists: THIS conta's entries through the schemas'
 *   read slice (every other conta's list, and the ML map, are never looked
 *   at), plus the tabela's first photo or `null`.
 */
export type LeituraTabelaDeMedidasShopee =
  | { readonly tipo: 'produto-sem-tabela' }
  | { readonly tipo: 'tabela-inexistente'; readonly tabMediId: string | null }
  | {
      readonly tipo: 'lida';
      readonly tabMediId: string;
      readonly leitura: LeituraEntradasShopee;
      /** `fotos[0]` parsed by `fotoSchema`, or `null` (none stored, or the first is unreadable). */
      readonly primeiraFoto: Foto | null;
    };

/** The first STORED photo, or `null` — never the second (module docblock). */
function primeiraFotoDe(fotos: unknown): Foto | null {
  if (!Array.isArray(fotos) || fotos.length === 0) return null;
  const lida = fotoSchema.safeParse(fotos[0]);
  return lida.success ? lida.data : null;
}

/**
 * Read the produto's tabela for ONE conta.
 *
 * @param ref the produto's RAW `tabelaDeMedidasModaUid` — `unknown`, because a
 *   legacy produto may carry anything there; the canonical
 *   `documents/tabMedi/<id>` and the bare `tabMedi/<id>` both resolve.
 * @param integracaoId the conta whose entries are wanted — the map key.
 */
export async function lerTabelaMedidasDoProduto(
  db: Firestore,
  ref: unknown,
  integracaoId: string,
): Promise<LeituraTabelaDeMedidasShopee> {
  if (typeof ref !== 'string' || ref.trim() === '') return { tipo: 'produto-sem-tabela' };

  // ⚠️ The COLLECTION is checked, unlike the operação ref in
  // `lerImpostoDoProduto.ts`: the corpus spells this ref as a path (the
  // Flutter `documents/tabMedi/<id>`), so a ref naming another collection is a
  // stray value — reading `tabMedi/<its id>` would attach some OTHER tabela's
  // chart to this listing.
  const { collection, id } = parseRef(ref);
  if (collection !== tabelaDeMedidasMeta.collectionPath || naoDocId(id)) {
    return { tipo: 'tabela-inexistente', tabMediId: null };
  }

  const snap = await tabelaDeMedidasCollection.docRef(db, {}, id).get();
  if (!snap.exists) return { tipo: 'tabela-inexistente', tabMediId: id };

  const bruto: unknown = snap.data();
  const doc =
    typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto)
      ? (bruto as Record<string, unknown>)
      : {};
  return {
    tipo: 'lida',
    tabMediId: id,
    leitura: lerEntradasShopeeDaConta(doc.tabelasMedidasShopee, integracaoId),
    primeiraFoto: primeiraFotoDe(doc.fotos),
  };
}
