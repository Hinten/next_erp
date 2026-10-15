/**
 * **ERP component → this conta's Shopee address** (step 19, #1527, R-d) — the
 * ONE IO adapter the kit arms resolve a recipe through. The create direction
 * of step 9's component cascade: step 9 asks "which produto is this Shopee
 * component?", this asks "which Shopee listing (and model) is this produto?".
 *
 * ## The rungs, per component produto C (D2 §2.2), first hit wins
 *
 *  1. **`produtos/C/variashopee`**, read UNFILTERED with the conta compared in
 *     memory: a row names its listing link through `produtoShopeeOuterRef`,
 *     whose document lives under C's PARENT (a variation row sits under the
 *     child, its listing under the parent). That link must belong to this conta
 *     and carry a positive `item_id`. Address = `(link.item_id, row.model_id)`,
 *     with `0`/absent read as "no model". ⚠️ A row the model-list sync MARKED
 *     (`modeloAusenteEm` set — the model vanished from the listing) is not an
 *     address: its id would go to `add_kit_item` naming a model that no longer
 *     exists. Such a C falls to the rungs below, which is where the honest
 *     `componente-sem-modelo` ("re-import it") comes from.
 *  2. **`produtos/C/prodshopee`** — C is itself a listing. Address =
 *     `(item_id, no model)`.
 *  3. **The SOLE-MEMBER hop.** C has a parent W: when W is a família de um whose
 *     member IS C (`unidadeVendavel(W) === C`, the schemas' one rule), W's
 *     listing is C's — a plain listing's link lives on the WRAPPER while every
 *     kit map names the MEMBER (#1450). Address = `(W.item_id, no model)`.
 *     Any other parent with a listing in this conta is a família de MUITOS (or
 *     a drifted one): C is one of its variations and the ERP holds no row
 *     saying which ⇒ `componente-sem-modelo`. A parent with no listing ⇒
 *     `componente-nao-publicado`.
 *  4. Nothing ⇒ `componente-nao-publicado`.
 *
 * Every listing a rung lands on whose link says `kitNativo === true` refuses
 * `componente-e-kit-nativo` (a kit of kits is not supported). Duplicates within
 * a rung follow step 9's ONE policy, `escolherLink` (lexically first, one log
 * line, never a delete). Never a group query: every read here is one document
 * or one produto's own subcollection, so the adapter needs no index (rule 1) —
 * at most ~6 reads per component.
 *
 * ## Then ONE base-info batch, through the ONE shared reader
 *
 * The resolved `item_id`s go through `lerTemModelosDosComponentes` (step 9's
 * reader of the `has_model` authority, ≤ 50 ids per call) — never a second
 * copy of its batching or of its "none of these ids exists" verdict. The same
 * calls also hand back each row's `item_status` and `tag`
 * ({@link lerBaseInfoDosItens} observes the reader's own batches rather than
 * paying a second read). Per component:
 *  - no readable row (absent, unreadable, or a `has_model` that is not a
 *    boolean — the reader's "unknown") ⇒ `componente-anuncio-inativo`: the
 *    create never sends a component it could not see;
 *  - the live row says `tag.kit` ⇒ `componente-e-kit-nativo` — a kit imported
 *    before step 9 stamped `kitNativo` still carries the tag;
 *  - `item_status` neither `NORMAL` nor `UNLIST` ⇒ `componente-anuncio-inativo`;
 *  - the schemas' default-model rule `modeloDoComponenteKit` turns
 *    `(model, has_model)` into the model SENT: a plain item sends none (even
 *    over a stale variation row — Shopee's hidden default id is meaningless on
 *    a request), an item with variations sends the row's model, and an item
 *    with variations but no usable model ⇒ `componente-sem-modelo`.
 *
 * ## What it answers
 *
 * A TOTAL map: every requested id gets a `ResolucaoComponenteKit` — never an
 * absent key, so `componentesShopeeDoKit` never has to guess. Plus the
 * `has_model` map the recipe fold needs (the reader's own answer, ABSENT ⇒
 * unknown), the category of each resolved component's STORED link (the kit
 * limits are read on the principal's category, R-i) and the Shopee calls it
 * spent. Reads only; no write, no clock.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_ITEM_STATUS_WIRE,
  type ShopeeClient,
  type ShopeeItemBaseInfoRow,
} from '@delfrance/integrations-shopee';
import {
  modeloDoComponenteKit,
  unidadeVendavel,
  type EnderecoShopeeDoComponente,
  type MotivoFalhaComponenteKit,
  type ResolucaoComponenteKit,
} from '@delfrance/schemas';
import {
  produtoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { idDoRef } from '../core/vinculosShopee';
import { ehKitDe } from '../produtos/itemLido';
import { escolherLink } from '../produtos/resolveProduto';
import { lerTemModelosDosComponentes } from '../produtos/temModelosDosComponentes';

/* -------------------------------------------------------------------------- */
/*                        The base-info batch, observed                       */
/* -------------------------------------------------------------------------- */

/** What one {@link lerBaseInfoDosItens} learned. */
export interface LeituraDeBaseInfo {
  /** `item_id → has_model` — the shared reader's OWN answer. ABSENT ⇒ unknown, never `false`. */
  readonly temModelos: ReadonlyMap<number, boolean>;
  /** `item_id → its FIRST row`, for every requested id Shopee answered with a readable row. */
  readonly linhas: ReadonlyMap<number, ShopeeItemBaseInfoRow>;
  /** `get_item_base_info` calls made — one per chunk of ≤ 50, a call that failed included. */
  readonly chamadas: number;
}

/**
 * `get_item_base_info` for `itemIds`, read THROUGH `lerTemModelosDosComponentes`
 * so the batching (distinct ids, ≤ 50 per call, positive ids only), the
 * reconciliation by `item_id` and the batch "none of these ids exists" verdict
 * are the shared reader's — one implementation, not a second loop that would
 * drift from it. The reader is handed a client whose `getItemBaseInfo`
 * delegates to the real one and keeps each answered row (first one wins, ids
 * that were not asked for are ignored — the reader's own rules), so the same
 * calls answer `has_model`, `item_status`, `tag` and `item_sku` at once.
 * Zero ids ⇒ zero calls. Every failure the reader does not narrow propagates.
 */
export async function lerBaseInfoDosItens(
  client: ShopeeClient,
  itemIds: readonly number[],
): Promise<LeituraDeBaseInfo> {
  const linhas = new Map<number, ShopeeItemBaseInfoRow>();
  let chamadas = 0;
  const observado: ShopeeClient = {
    ...client,
    getItemBaseInfo: async (p) => {
      chamadas += 1;
      const payload = await client.getItemBaseInfo(p);
      const pedidos = new Set(p.itemIds);
      for (const linha of payload.item_list) {
        if (linha === null || !pedidos.has(linha.item_id) || linhas.has(linha.item_id)) continue;
        linhas.set(linha.item_id, linha);
      }
      return payload;
    },
  };
  const temModelos = await lerTemModelosDosComponentes(observado, itemIds);
  return { temModelos, linhas, chamadas };
}

/* -------------------------------------------------------------------------- */
/*                                The adapter                                 */
/* -------------------------------------------------------------------------- */

/** What {@link resolverComponentesDoKitErp} answers. */
export interface ComponentesDoKitResolvidos {
  /** EVERY requested component id → its address or its refusal. Never an absent key. */
  readonly resolucao: ReadonlyMap<string, ResolucaoComponenteKit>;
  /** `item_id → has_model` over the resolved items (the shared reader's map; ABSENT ⇒ unknown). */
  readonly temModelos: ReadonlyMap<number, boolean>;
  /**
   * EVERY requested component id → the `category_id` stored on the listing link
   * it resolved through, or `null` (refused, or no usable category stored).
   */
  readonly categoriaPorProduto: ReadonlyMap<string, number | null>;
  /** Shopee calls spent — the base-info batch; the rungs are Firestore-only. */
  readonly chamadas: number;
}

/** Live listing statuses a component may have: selling or paused. */
const STATUS_COMPONENTE_UTILIZAVEL: ReadonlySet<string> = new Set([
  SHOPEE_ITEM_STATUS_WIRE.normal,
  SHOPEE_ITEM_STATUS_WIRE.unlist,
]);

/** One stored link or row as `escolherLink` compares them. */
interface LinhaLida {
  readonly id: string;
  readonly raw: Record<string, unknown>;
  readonly produtoId: string | null;
}

/** A component that reached a listing — before the base-info checks. */
interface Candidato {
  readonly itemId: number;
  /** The STORED model (`null` = none); the default-model rule runs after the read. */
  readonly modelId: number | null;
  readonly categoria: number | null;
}

type DesfechoDoDegrau =
  | { readonly tipo: 'candidato'; readonly candidato: Candidato }
  | { readonly tipo: 'recusa'; readonly motivo: MotivoFalhaComponenteKit };

function inteiroPositivo(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
}

/** The conta fold — the stored ref's last segment, BOTH encodings (`core/vinculosShopee.ts` fold 1). */
function daConta(raw: Record<string, unknown>, campo: string, integracaoId: string): boolean {
  return idDoRef(raw[campo]) === integracaoId;
}

function textoOuNull(bruto: unknown): string | null {
  return typeof bruto === 'string' && bruto !== '' ? bruto : null;
}

function recusa(motivo: MotivoFalhaComponenteKit): DesfechoDoDegrau {
  return { tipo: 'recusa', motivo };
}

/** A listing link is an ADDRESS for this conta: its conta, and a positive `item_id`. */
function ehVinculoUtilizavel(raw: Record<string, unknown>, integracaoId: string): boolean {
  return (
    daConta(raw, 'contaProdutoShopeeOuterRef', integracaoId) &&
    inteiroPositivo(raw.item_id) !== null
  );
}

/** The verdict a listing link gives, with the model the rung found (`null` = none). */
function desfechoDoVinculo(
  link: Record<string, unknown>,
  modelId: number | null,
): DesfechoDoDegrau {
  if (link.kitNativo === true) return recusa('componente-e-kit-nativo');
  return {
    tipo: 'candidato',
    candidato: {
      itemId: inteiroPositivo(link.item_id)!,
      modelId,
      categoria: inteiroPositivo(link.category_id),
    },
  };
}

/** The usable listing links of ONE produto for this conta, unfiltered read + memory filter. */
async function vinculosDaConta(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): Promise<LinhaLida[]> {
  const snap = await produtoShopeeLinkCollection.ref(db, { produtoId }).get();
  return snap.docs
    .map((d) => ({ id: d.id, raw: (d.data() ?? {}) as Record<string, unknown>, produtoId }))
    .filter((l) => ehVinculoUtilizavel(l.raw, integracaoId));
}

/** Rung 1 — C's own variation rows, each through the link it names under C's parent. */
async function degrauVariacao(
  db: Firestore,
  integracaoId: string,
  componenteId: string,
  paiId: string,
): Promise<DesfechoDoDegrau | null> {
  const snap = await variacaoShopeeLinkCollection.ref(db, { produtoId: componenteId }).get();
  const vinculos = new Map<string, Record<string, unknown> | null>();
  const candidatas: (LinhaLida & { readonly link: Record<string, unknown> })[] = [];
  for (const d of snap.docs) {
    const raw = (d.data() ?? {}) as Record<string, unknown>;
    if (!daConta(raw, 'contaVariacaoShopeeOuterRef', integracaoId)) continue;
    // A model the sync marked as gone from its listing is not an address.
    if (typeof raw.modeloAusenteEm === 'number' && Number.isFinite(raw.modeloAusenteEm)) continue;
    const linkId = idDoRef(raw.produtoShopeeOuterRef);
    if (linkId === null) continue;
    if (!vinculos.has(linkId)) {
      const linkSnap = await produtoShopeeLinkCollection
        .docRef(db, { produtoId: paiId }, linkId)
        .get();
      const link = linkSnap.exists ? ((linkSnap.data() ?? {}) as Record<string, unknown>) : null;
      vinculos.set(linkId, link !== null && ehVinculoUtilizavel(link, integracaoId) ? link : null);
    }
    const link = vinculos.get(linkId) ?? null;
    if (link === null) continue;
    candidatas.push({ id: d.id, raw, produtoId: componenteId, link });
  }

  const escolhida = escolherLink(candidatas, {
    integracaoId,
    produtoId: componenteId,
    subcolecao: 'variashopee',
    origem: 'kit-componente',
  });
  if (escolhida === null) return null;
  const par = candidatas.find((c) => c.id === escolhida.id)!;
  return desfechoDoVinculo(par.link, inteiroPositivo(par.raw.model_id));
}

/** Rung 2 / the família-de-um hop — one produto's own listing link, with no model. */
async function degrauListagem(
  db: Firestore,
  integracaoId: string,
  produtoId: string,
): Promise<DesfechoDoDegrau | null> {
  const escolhido = escolherLink(await vinculosDaConta(db, produtoId, integracaoId), {
    integracaoId,
    produtoId,
    subcolecao: 'prodshopee',
    origem: 'kit-componente',
  });
  return escolhido === null ? null : desfechoDoVinculo(escolhido.raw, null);
}

/** Rungs 1 → 3 for ONE component. Firestore only. */
async function resolverNoErp(
  db: Firestore,
  integracaoId: string,
  componenteId: string,
): Promise<DesfechoDoDegrau> {
  // An id no document path can hold is never published — and never a read.
  if (componenteId === '' || componenteId.includes('/')) return recusa('componente-nao-publicado');

  const snap = await produtoCollection.docRef(db, {}, componenteId).get();
  if (!snap.exists) return recusa('componente-nao-publicado');
  const paiId = textoOuNull(((snap.data() ?? {}) as Record<string, unknown>).paiId);

  if (paiId !== null) {
    const porVariacao = await degrauVariacao(db, integracaoId, componenteId, paiId);
    if (porVariacao !== null) return porVariacao;
  }

  const propria = await degrauListagem(db, integracaoId, componenteId);
  if (propria !== null) return propria;

  if (paiId === null) return recusa('componente-nao-publicado');

  const paiSnap = await produtoCollection.docRef(db, {}, paiId).get();
  if (!paiSnap.exists) return recusa('componente-nao-publicado');
  const pai = (paiSnap.data() ?? {}) as Record<string, unknown>;
  const unidade = unidadeVendavel({
    id: paiId,
    paiId: textoOuNull(pai.paiId),
    filhoUnicoId: textoOuNull(pai.filhoUnicoId),
  });

  const doPai = await degrauListagem(db, integracaoId, paiId);
  if (doPai === null) return recusa('componente-nao-publicado');
  // The sole-member hop: the wrapper's plain listing IS the member's.
  if (unidade === componenteId) return doPai;
  // A variation of a listing with many: which model is C? The ERP has no row.
  if (doPai.tipo === 'recusa') return doPai;
  return recusa('componente-sem-modelo');
}

/** The base-info checks + the default-model rule, for one candidate. */
function resolucaoFinal(candidato: Candidato, leitura: LeituraDeBaseInfo): ResolucaoComponenteKit {
  const temModelos = leitura.temModelos.get(candidato.itemId);
  const linha = leitura.linhas.get(candidato.itemId);
  if (temModelos === undefined || linha === undefined) {
    return { ok: false, motivo: 'componente-anuncio-inativo' };
  }
  if (ehKitDe(linha)) return { ok: false, motivo: 'componente-e-kit-nativo' };
  if (linha.item_status === null || !STATUS_COMPONENTE_UTILIZAVEL.has(linha.item_status)) {
    return { ok: false, motivo: 'componente-anuncio-inativo' };
  }
  const modelId = modeloDoComponenteKit({
    modelId: candidato.modelId,
    itemTemModelos: temModelos,
  });
  if (temModelos && modelId === null) return { ok: false, motivo: 'componente-sem-modelo' };
  const endereco: EnderecoShopeeDoComponente = { itemId: candidato.itemId, modelId };
  return { ok: true, endereco };
}

/**
 * Resolve every ERP component of a kit to this conta's Shopee address — see the
 * module header for the rungs and the base-info checks. Reads only; never a
 * group query; ONE base-info batch for all of them.
 *
 * @param componenteIds the component produto ids (the KEYS of the children's
 *   `componentesKit`), any order, duplicates allowed.
 */
export async function resolverComponentesDoKitErp(
  db: Firestore,
  client: ShopeeClient,
  integracaoId: string,
  componenteIds: readonly string[],
): Promise<ComponentesDoKitResolvidos> {
  const distintos = [...new Set(componenteIds)];

  const desfechos = new Map<string, DesfechoDoDegrau>();
  for (const componenteId of distintos) {
    desfechos.set(componenteId, await resolverNoErp(db, integracaoId, componenteId));
  }

  const itemIds: number[] = [];
  for (const desfecho of desfechos.values()) {
    if (desfecho.tipo === 'candidato') itemIds.push(desfecho.candidato.itemId);
  }
  const leitura = await lerBaseInfoDosItens(client, itemIds);

  const resolucao = new Map<string, ResolucaoComponenteKit>();
  const categoriaPorProduto = new Map<string, number | null>();
  for (const [componenteId, desfecho] of desfechos) {
    if (desfecho.tipo === 'recusa') {
      resolucao.set(componenteId, { ok: false, motivo: desfecho.motivo });
      categoriaPorProduto.set(componenteId, null);
      continue;
    }
    const final = resolucaoFinal(desfecho.candidato, leitura);
    resolucao.set(componenteId, final);
    categoriaPorProduto.set(componenteId, final.ok ? desfecho.candidato.categoria : null);
  }

  return {
    resolucao,
    temModelos: leitura.temModelos,
    categoriaPorProduto,
    chamadas: leitura.chamadas,
  };
}
