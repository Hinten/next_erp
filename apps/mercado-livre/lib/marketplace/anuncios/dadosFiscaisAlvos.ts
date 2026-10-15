/**
 * **The fiscal SKUs of an anúncio, rebuilt from the STORED links** — what the
 * "Enviar dados fiscais" route (#745) sends without republishing. Publish
 * builds the same `AlvoFiscal`s from what it has just written; this is the
 * read-only twin for a listing that already exists, and both hand them to the
 * one `enviarDadosFiscais`.
 *
 * The member links come from ONE indexed group query on
 * `produtoMercadoLivreOuterRef` (`familyMemberQuery`, the declared
 * COLLECTION_GROUP index), and the listing shape is read off each member:
 *
 *  - a member with an `itemId` is a User-Products member — its own item, no
 *    variation id;
 *  - a member with only a numeric `id` is a legacy `variations[]` row — the
 *    PARENT link's item, with that variation id;
 *  - no member link at all is a simple item — the parent link's own `id`.
 *
 * ⚠️ A parent `id` that is a numeric FAMILY key is never addressed as an item
 * (`isFamilyId`): under User Products it names the family, and ML answers 404
 * for it. Such a listing with no member links on disk yields NO target — the
 * caller says so rather than guessing.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { type Produto, toOuterRef } from '@delfrance/schemas';

import { isFamilyId } from '../core/linkRefs';
import { type AlvoFiscal, registradoFiscal } from './dadosFiscais';
import { familyMemberQuery } from './upMemberLink';
import { SUB_STATUS_VARIACAO_REMOVIDA } from './variacoesFantasma';

export async function alvosFiscaisArmazenados(
  db: Firestore,
  args: {
    readonly produtoId: string;
    readonly linkDocId: string;
    /** The parent `produtoMercadoLivre` link, RAW — ownership already proven. */
    readonly link: Readonly<Record<string, unknown>>;
  },
): Promise<AlvoFiscal[]> {
  const { produtoId, linkDocId, link } = args;
  const produto = await lerProduto(db, produtoId);
  if (produto == null) return [];

  const titulo = typeof link.title === 'string' ? link.title : null;
  const idDoPai = typeof link.id === 'string' && link.id !== '' ? link.id : null;
  const itemDoPai = idDoPai != null && !isFamilyId(idDoPai) ? idDoPai : null;

  const pmlOuterRef = toOuterRef(`produtos/${produtoId}/produtoMercadoLivre/${linkDocId}`);
  const membros = await familyMemberQuery(db, pmlOuterRef).get();

  if (membros.empty) {
    if (itemDoPai == null) return [];
    return [
      {
        produtoId,
        produto,
        pai: null,
        titulo,
        itemId: itemDoPai,
        variationId: null,
        link: { colecao: 'produtoMercadoLivre', produtoId, docId: linkDocId },
        registrado: registradoFiscal(link),
      },
    ];
  }

  const alvos: AlvoFiscal[] = [];
  for (const d of membros.docs) {
    const raw = d.data() as Record<string, unknown>;
    const childId = d.ref.parent?.parent?.id;
    if (childId == null) continue;

    // #707's phantom prune marks a legacy variation ML deleted — and KEEPS the
    // doc, numeric `id` included. Publish never meets one (it builds from the
    // `variations[]` ML echoes), so neither may this: linking a SKU to a deleted
    // variation is an `erro` on every re-send and a wasted PUT + link.
    if (Array.isArray(raw.sub_status) && raw.sub_status.includes(SUB_STATUS_VARIACAO_REMOVIDA)) {
      continue;
    }
    const itemDoMembro = typeof raw.itemId === 'string' && raw.itemId !== '' ? raw.itemId : null;
    const variacaoLegada = typeof raw.id === 'number' ? raw.id : null;
    let itemId: string;
    let variationId: number | null;
    if (itemDoMembro != null) {
      itemId = itemDoMembro;
      variationId = null;
    } else if (variacaoLegada != null && itemDoPai != null) {
      itemId = itemDoPai;
      variationId = variacaoLegada;
    } else {
      // Never published as either shape — nothing at ML to link a SKU to.
      continue;
    }

    const filho = await lerProduto(db, childId);
    if (filho == null) continue;
    alvos.push({
      produtoId: childId,
      produto: filho,
      pai: produto,
      titulo,
      itemId,
      variationId,
      link: { colecao: 'variacaoMercadoLivre', produtoId: childId, docId: d.id },
      registrado: registradoFiscal(raw),
    });
  }
  return alvos;
}

async function lerProduto(db: Firestore, id: string): Promise<Produto | null> {
  const snap = await produtoCollection.docRef(db, {}, id).get();
  if (!snap.exists) return null;
  return produtoCollection.parseRead(snap.data(), produtoCollection.docPath({}, id));
}
