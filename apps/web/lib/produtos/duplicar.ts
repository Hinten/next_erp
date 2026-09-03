import { type Firestore, getDocFromServer, getDocsFromServer } from 'firebase/firestore';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import {
  buildDuplicarProdutoWriteOps,
  ehFamiliaDeUmParaDuplicar,
  type FilhoParaDuplicar,
} from '@delfrance/data/produto';
import {
  PRODUTO_EXTRA_DATA_DOC_ID,
  type ImpostoProduto,
  type ProdutoExtraData,
} from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import { impostoProdutoCollection } from '@/lib/data/impostoProdutoCollection';
import { BATCH_LIMIT, createClientProdutoPort } from './clientPort';
import { newDocId } from './docId';
import { gerarSkuUnico } from './skuUnico';

/** The selected row no longer exists — the read raced a delete. */
export class ProdutoNaoEncontradoError extends Error {}

/**
 * The selected produto is a variation CHILD (`paiId != null`).
 *
 * Cloning one would silently PROMOTE it: the clone is built as a parent
 * (`paiId: null`), so a child duplicated this way becomes a root produto in the
 * catalogue with no family and no sibling. `/produtos` lists parents only
 * (`produtoMeta.defaultQuery` filters `paiId == null`), so nothing in the UI can
 * reach this — which is exactly why it must fail loudly rather than write.
 */
export class ProdutoFilhoNaoDuplicavelError extends Error {}

/**
 * The clone would need more writes than one Firestore batch can carry
 * atomically (`BATCH_LIMIT`).
 *
 * ⚠️ This is a REFUSAL, not a limit we could raise. `clientProdutoPort.commit`
 * chunks at `BATCH_LIMIT` and awaits one batch per chunk, so an oversized write
 * set is not one failed operation — it is a family half-written: chunk 1 lands,
 * chunk 2 throws, and the partially-built produto sits in the catalogue with
 * nothing cleaning it up and nothing navigating to it.
 *
 * The op count is `(1 + filhos) × (1 + extraData + impostos)`, so it grows with
 * BOTH the family size and each member's imposto rows — a 6-colour × 6-size
 * family with a dozen operações is already in range. Refusing before the first
 * write keeps this flow's fail-closed posture, the same reason every SKU probe
 * runs before the batch opens.
 */
export class ProdutoFamiliaGrandeDemaisError extends Error {}

/** Same cap the Imposto tab reads with (`ImpostoManager`). */
const IMPOSTO_LIMIT = 200;

/** The produto-owned subdocuments a clone carries over — catalog content, not identity. */
interface SubdocsDeProduto {
  extraData: ProdutoExtraData | null;
  impostos: ImpostoProduto[];
}

/**
 * Read one produto's `extraData` singleton and its per-operação `imposto` docs.
 *
 * Server reads, like the produto/children reads below: a stale cache silently
 * missing a tax row would drop it from the clone rather than reporting anything.
 */
async function lerSubdocs(db: Firestore, produtoId: string): Promise<SubdocsDeProduto> {
  const [extraSnap, impostoSnap] = await Promise.all([
    getDocFromServer(
      produtoExtraDataCollection.docRef(db, { produtoId }, PRODUTO_EXTRA_DATA_DOC_ID),
    ),
    getDocsFromServer(
      buildQuery(impostoProdutoCollection.ref(db, { produtoId }), [limit(IMPOSTO_LIMIT)]),
    ),
  ]);
  return {
    extraData: extraSnap.exists() ? extraSnap.data() : null,
    impostos: impostoSnap.docs.map((d) => d.data()),
  };
}

/**
 * "Duplicar" produto (#556) — clone a PARENT produto's own fields into a
 * brand-new document, re-creating each of its variation children under the
 * clone. Never a `copyHref` pre-fill: a produto owns children, kit composition
 * and marketplace links a plain create-form seed can't touch (see the issue's
 * own opening line). All the field-level decisions — what gets renamed, cleared
 * or mirrored — live in `buildDuplicarProdutoWriteOps`
 * (`@delfrance/data/produto`); this supplies it fresh reads, fresh ids and
 * fresh SKUs, and commits the result.
 *
 * Reads are forced to the server: a stale cache silently missing a variation
 * child would drop it from the clone rather than reporting anything.
 *
 * ⚠️ **A fresh unique SKU per document is minted HERE, before any write.** The
 * builder is pure and a unique SKU needs a corpus probe (`gerarSkuUnico`). Every
 * probe therefore runs first, and a `FirebaseError` from one propagates before
 * the batch opens — so a failed mint can never leave a half-cloned family. One
 * `jaMintados` set spans the whole family: the minted values are not in
 * Firestore yet, so without it two siblings could be handed the same SKU and
 * both probes would still pass.
 *
 * ⚠️ A source produto with no SKU stays without one — we mint a REPLACEMENT for
 * an exclusive value, never invent an identifier the operator never had. Same
 * when the generator gives up: the clone lands with an empty SKU field on the
 * editor this action opens, which is visible, rather than a copy of the
 * source's.
 *
 * Returns the new PARENT's id, for the caller to navigate to its editor.
 */
export async function duplicarProduto(db: Firestore, produtoId: string): Promise<string> {
  const parentSnap = await getDocFromServer(produtoCollection.docRef(db, {}, produtoId));
  if (!parentSnap.exists()) {
    throw new ProdutoNaoEncontradoError(`produto ${produtoId} não encontrado`);
  }
  const parentOrigem = parentSnap.data();
  if (parentOrigem.paiId != null) {
    throw new ProdutoFilhoNaoDuplicavelError(
      `produto ${produtoId} é uma variação (paiId=${parentOrigem.paiId}) e não pode ser duplicado`,
    );
  }

  const childrenSnap = await getDocsFromServer(
    buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', produtoId)]),
  );
  const origens = childrenSnap.docs.map((d) => ({ id: d.id, dados: d.data() }));

  // ⚠️ The genuine family-of-one member is MIRRORED from the parent clone and
  // takes the parent's SKU (`espelhoDoMembroUnico`), so minting one for it would
  // spend a server probe on a value the builder then drops.
  const mirrorDoMembroUnico = ehFamiliaDeUmParaDuplicar(parentOrigem, origens);

  const jaMintados = new Set<string>();
  const mintarSku = async (skuOrigem: string | null): Promise<string | null> => {
    if (skuOrigem == null) return null;
    const novo = await gerarSkuUnico(db, jaMintados);
    if (novo) jaMintados.add(novo);
    return novo;
  };

  const novoParentSku = await mintarSku(parentOrigem.sku);
  const novosSkus: (string | null)[] = [];
  for (const origem of origens) {
    novosSkus.push(mirrorDoMembroUnico ? null : await mintarSku(origem.dados.sku));
  }

  const [subdocsDoPai, ...subdocsDosFilhos] = await Promise.all([
    lerSubdocs(db, produtoId),
    ...origens.map((o) => lerSubdocs(db, o.id)),
  ]);

  // Parent id first, then one per child — the order `newDocId` is called in is
  // what the orchestration test pins.
  const novoParentId = newDocId();
  const filhos: FilhoParaDuplicar[] = origens.map((origem, i) => ({
    id: origem.id,
    dados: origem.dados,
    novoId: newDocId(),
    novoSku: novosSkus[i] ?? null,
    extraData: subdocsDosFilhos[i]?.extraData ?? null,
    impostos: subdocsDosFilhos[i]?.impostos ?? [],
  }));

  const ops = buildDuplicarProdutoWriteOps({
    novoParentId,
    parentOrigem,
    novoParentSku,
    parentExtraData: subdocsDoPai!.extraData,
    parentImpostos: subdocsDoPai!.impostos,
    filhos,
    now: Date.now(),
  });
  // ⚠️ Before the first write, never after: `commit` is atomic only WITHIN a
  // chunk, so committing an oversized set half-clones the family.
  if (ops.length > BATCH_LIMIT) {
    throw new ProdutoFamiliaGrandeDemaisError(
      `duplicar produto ${produtoId} exige ${ops.length} escritas, acima do limite atômico de ${BATCH_LIMIT}`,
    );
  }

  await createClientProdutoPort(db).commit(ops);

  return novoParentId;
}
