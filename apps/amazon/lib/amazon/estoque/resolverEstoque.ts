/**
 * The Firestore half of the Amazon stock sync's link verdict (step 12, PR
 * 12-e1): for ONE SKU of one conta, every document `avaliarVinculoEstoqueAmazon`
 * (`vinculoEstoque.ts`) reads, each read MASKED to the fields that are read off
 * it. This module only READS: what the documents mean is the verdict's.
 *
 * ## The binding is the order import's, read through its own pieces
 *
 * A SKU publishes the stock of the unit an order line of that SKU consumes, so
 * the resolution is the order import's own (`pedidos/vinculoProdutoAmazon.ts`):
 * THE link-doc query and its ambiguity detector (`lerVinculosDoSkuAmazon`), the
 * by-id dono read with its gone-dono rule (`lerDonosAmazon`), the hop
 * (`unidadeDoDonoAmazon`) and the dono count (`resolucaoPorUnidadesAmazon`).
 * Only the MASKS are this module's: the order import reads the same documents
 * whole.
 *
 * ## The reads, in order
 *
 *  1. THE link-doc query, projected (a classic `select`) to
 *     {@link CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON}: a link doc carries a whole
 *     product payload, and Enterprise bills the data a read returns. It rides
 *     the declared collection-group index `prodAmazon (contaAmazonOuterRef ASC,
 *     sku ASC)`. The limit reached ⇒ ambiguous, and nothing more is read.
 *  2. The distinct donos, by id in ONE `getAll` masked to
 *     {@link CAMPOS_LEITURA_DONOS_ESTOQUE_AMAZON} (the hop's fields and the
 *     verdict's opt-out map); a gone dono is dropped, then the live ones are
 *     counted. No live dono, or two, ⇒ nothing more is read.
 *  3. For the ONE live `dono` and the unit it hops to, in parallel:
 *     - the unit's produto by id, masked to
 *       `CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON` — UNLESS the unit is the `dono`
 *       itself (a kit, or any produto that is not a family-of-one wrapper),
 *       whose masked read in 2 already holds those fields: it is projected to
 *       them, and no second read is made;
 *     - the unit's children ({@link lerFilhosDaUnidadeEstoqueAmazon}): keys
 *       only, at most `LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON`, on the declared
 *       `produtos (paiId ASC, nome ASC)` composite;
 *     - the parent pointers of the `dono`'s link docs that PARSE, deduplicated
 *       by their bare path (both stored forms are one), in ONE `getAll` masked
 *       to `CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON`, through the link handle
 *       ({@link lerPaisDosLinksEstoqueAmazon}); none ⇒ no read. An unreadable
 *       pointer is not read at all: the verdict refuses it as given.
 *
 * Every field list is a constant the verdict's own lists derive, so a field the
 * verdict starts reading is a field these reads carry.
 *
 * ## What it answers
 *
 * Exactly the verdict's input, `EntradaVinculoEstoqueAmazon`. When the
 * resolution names no unit (the limit, no live dono, two), the `dono` is
 * `null` and the rest is empty: the verdict refuses at its first check.
 *
 * Reads only: no write, no clock, no network.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoAmazonLinkCollection, produtoCollection } from '@delfrance/data/admin/collections';
import { CAMPOS_INDICE_VINCULO_AMAZON, type produtoSchema } from '@delfrance/schemas';

import {
  type DonoLidoAmazon,
  RESOLUCAO_LIMITE_VINCULOS_AMAZON,
  donosDosVinculosAmazon,
  lerDonosAmazon,
  lerVinculosDoSkuAmazon,
  mascaraDosDonosAmazon,
  resolucaoPorUnidadesAmazon,
} from '../pedidos/vinculoProdutoAmazon';
import {
  type AlvoDoPaiEstoqueAmazon,
  CAMPOS_DONO_ESTOQUE_AMAZON,
  CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON,
  CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON,
  CAMPOS_VINCULO_ESTOQUE_AMAZON,
  type EntradaVinculoEstoqueAmazon,
  LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON,
  type LinkDoSkuEstoqueAmazon,
  type UnidadeDoVinculoEstoqueAmazon,
  ponteiroPaiDoVinculoEstoqueAmazon,
} from './vinculoEstoque';

/**
 * The fields the link-doc query projects (module header, read 1): the index's
 * two (the conta ref and the SKU) and everything the verdict reads off a link.
 */
export const CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON = [
  ...CAMPOS_INDICE_VINCULO_AMAZON,
  ...CAMPOS_VINCULO_ESTOQUE_AMAZON,
] as const;

/**
 * The mask of the donos' read (module header, read 2): the hop's own fields
 * (`ehKit`, `paiId`, `filhoUnicoId`), then everything the verdict reads off the
 * `dono`.
 */
export const CAMPOS_LEITURA_DONOS_ESTOQUE_AMAZON: readonly string[] = mascaraDosDonosAmazon(
  CAMPOS_DONO_ESTOQUE_AMAZON,
);

/**
 * The children seek's fields, in the declared composite's order: the equality
 * on the parent, then the order the index is sorted by.
 */
export const CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON = [
  'paiId',
  'nome',
] as const satisfies ReadonlyArray<keyof typeof produtoSchema.shape>;

/** A unit no read named: no fields, no children. */
const SEM_UNIDADE: UnidadeDoVinculoEstoqueAmazon = { raw: {}, filhosIds: [] };

/** `raw` holding only the fields of `campos` it has. */
function projetar(
  raw: Readonly<Record<string, unknown>>,
  campos: readonly string[],
): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const campo of campos) {
    if (Object.hasOwn(raw, campo)) saida[campo] = raw[campo];
  }
  return saida;
}

/**
 * The ids of the unit's children (module header, read 3): `produtos where
 * paiId == <unidadeId> orderBy nome limit LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON`,
 * the keys alone (`select()`), on the declared `produtos (paiId ASC, nome ASC)`
 * composite. Two tell none, one and more apart, which is all refusal 4 asks.
 *
 * ⚠️ The order the index serves also filters: a child stored WITHOUT `nome` is
 * not returned. The produto schema requires `nome` on every document, so such
 * a child exists only outside the schema; it would leave its parent apt.
 */
export async function lerFilhosDaUnidadeEstoqueAmazon(
  db: Firestore,
  unidadeId: string,
): Promise<string[]> {
  const [campoPai, campoOrdem] = CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON;
  const snap = await produtoCollection
    .ref(db, {})
    .where(campoPai, '==', unidadeId)
    .orderBy(campoOrdem)
    .limit(LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON)
    .select()
    .get();
  return snap.docs.map((d) => d.id);
}

/**
 * What each READABLE parent pointer of `links` names (module header, read 3),
 * keyed by its bare path: the target's `sku` and `asin`, or `'sumido'` when the
 * document does not exist. The pointers are deduplicated (two links, or both
 * stored forms of one pointer, are ONE read) and read in ONE `getAll` masked to
 * `CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON`; an absent or unreadable pointer is
 * not read. No readable pointer ⇒ no read.
 */
export async function lerPaisDosLinksEstoqueAmazon(
  db: Firestore,
  links: readonly LinkDoSkuEstoqueAmazon[],
): Promise<Map<string, AlvoDoPaiEstoqueAmazon>> {
  const porCaminho = new Map<string, { readonly produtoId: string; readonly linkId: string }>();
  for (const link of links) {
    const ponteiro = ponteiroPaiDoVinculoEstoqueAmazon(link.dados.produtoAmazonPaiOuterRef);
    if (ponteiro.tipo === 'caminho') porCaminho.set(ponteiro.caminho, ponteiro);
  }
  if (porCaminho.size === 0) return new Map();
  const alvos = [...porCaminho.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const snaps = await db.getAll(
    ...alvos.map(([, { produtoId, linkId }]) =>
      produtoAmazonLinkCollection.docRef(db, { produtoId }, linkId),
    ),
    { fieldMask: [...CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON] },
  );
  return new Map(
    alvos.map(([caminho], i): [string, AlvoDoPaiEstoqueAmazon] => {
      const snap = snaps[i];
      if (snap?.exists !== true) return [caminho, 'sumido'];
      const raw = (snap.data() ?? {}) as Record<string, unknown>;
      return [caminho, { sku: raw.sku, asin: raw.asin }];
    }),
  );
}

/**
 * The unit's document for refusal 4 (module header, read 3): the `dono`'s own
 * masked read projected when the unit IS the `dono`, else one masked read of
 * the unit (a missing unit reads as no fields).
 */
async function lerUnidade(
  db: Firestore,
  dono: DonoLidoAmazon,
): Promise<Readonly<Record<string, unknown>>> {
  if (dono.unidadeId === dono.id) {
    return projetar(dono.raw, CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON);
  }
  const [snap] = await db.getAll(produtoCollection.docRef(db, {}, dono.unidadeId), {
    fieldMask: [...CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON],
  });
  return snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : {};
}

/**
 * Every document the link verdict reads for `sku` of `contaId`, masked (module
 * header): exactly `avaliarVinculoEstoqueAmazon`'s input.
 */
export async function lerVinculoEstoqueAmazon(
  db: Firestore,
  contaId: string,
  sku: string,
): Promise<EntradaVinculoEstoqueAmazon> {
  const semDono = (
    resolucao: EntradaVinculoEstoqueAmazon['resolucao'],
    linksDoSku: readonly LinkDoSkuEstoqueAmazon[],
  ): EntradaVinculoEstoqueAmazon => ({
    contaId,
    sku,
    resolucao,
    dono: null,
    linksDoSku,
    paisDosLinks: new Map(),
    unidade: SEM_UNIDADE,
  });

  // 1. THE query, projected.
  const leitura = await lerVinculosDoSkuAmazon(db, contaId, sku, {
    campos: CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON,
  });
  if (leitura.tipo === 'limite') return semDono(RESOLUCAO_LIMITE_VINCULOS_AMAZON, []);

  // 2. The donos, masked; gone dropped, then counted.
  const vivos = (
    await lerDonosAmazon(db, donosDosVinculosAmazon(leitura.docs), {
      campos: CAMPOS_DONO_ESTOQUE_AMAZON,
    })
  ).filter((d): d is DonoLidoAmazon => d !== null);
  const resolucao = resolucaoPorUnidadesAmazon(vivos.map((d) => d.unidadeId));
  const [dono] = vivos;
  if (resolucao.produtoId === null || dono === undefined) {
    return semDono(resolucao, leitura.docs);
  }

  // 3. The unit, its children and the `dono`'s parent pointers, in parallel.
  const [raw, filhosIds, paisDosLinks] = await Promise.all([
    lerUnidade(db, dono),
    lerFilhosDaUnidadeEstoqueAmazon(db, dono.unidadeId),
    lerPaisDosLinksEstoqueAmazon(
      db,
      leitura.docs.filter((d) => d.donoId === dono.id),
    ),
  ]);
  return {
    contaId,
    sku,
    resolucao,
    dono: { id: dono.id, raw: dono.raw },
    linksDoSku: leitura.docs,
    paisDosLinks,
    unidade: { raw, filhosIds },
  };
}
