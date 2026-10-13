/**
 * **The duplicate-SKU scan** (step 19, #1527, L6 / R-14): does a Shopee KIT
 * already carry this SKU in this shop? Every CREATE arm (criar, recriar,
 * converter) runs it before `add_kit_item`; NO other arm does — a republish
 * never scans (L10(4)), so a double-create twin surfaces on the next create-arm
 * run, never on `kit-atualizar`.
 *
 * It answers the hits; it decides nothing. `decidirKitNovo` (`planoKit.ts`)
 * reads them against the link docs (OURS is decided there, by the links — S2C-02)
 * and turns a foreign hit into the `kit-ja-existe-na-shopee` refusal ("importe-o"),
 * so a kit an uncertain or crashed create left unlinked is IMPORTED by step 9
 * instead of created twice (L9).
 *
 * ## The walk
 *
 * 1. **`get_item_list`, 100 per page, UN-narrowed** — no `update_time_from`:
 *    a kit created a year ago in Seller Centre is as much a duplicate as one
 *    created a minute ago. Statuses {@link STATUS_BUSCA_KIT}
 *    (`NORMAL, UNLIST, REVIEWING, BANNED`): a DELETED kit is never a duplicate.
 *    The cursor is Shopee's own `next_offset`, echoed, never `offset + 100`.
 * 2. **Candidates = every row whose `tag.kit` is not `false`.** ⚠️ Fail closed
 *    on the tag: `tag` was added on 2024-10-18 and a row that predates it has
 *    none, so a `null` `tag` / `tag.kit` is a CANDIDATE decided by its base
 *    info — only an explicit `false` (DATA: this item is not a kit) is dropped.
 *    `excluirItemIds` drops the recriar's own target (the old kit carries the
 *    same SKU); criar and converter exclude nothing — an ordinary listing is
 *    not a kit row.
 * 3. **ONE base-info batch (≤ 50 per call)** over the candidates, through the
 *    shared reader (`lerBaseInfoDosItens`). A hit is a row that IS a kit —
 *    `ehKitDe(base, listRow)`, the import's own reading, so the base `tag`
 *    wins and the list row's is only the fallback — AND whose SKU folds equal:
 *    `skuDoItemShopee(base) === sku`. That fold is step 9's PARENT-SKU rung,
 *    exported from `produtos/resolveProduto.ts` and shared, never copied: the
 *    scan must ask exactly what the import asks, or "importe-o" would land the
 *    kit on another produto. Equal: leading/trailing whitespace on Shopee's
 *    side (`'KIT-1 '` is a hit for `'KIT-1'`). Distinct: case (`'kit-1'` is
 *    not), inner whitespace, and an absent `item_sku` (folds to `''`, which no
 *    caller ever asks for).
 * 4. **ONE `resolverLinkPorItemId` per hit** — the declared `(item_id, conta)`
 *    composite — fills {@link AchadoKitPorSku.vinculo}, so the refusal can say
 *    "já vinculado ao produto {id}" and the classifier can tell ours from not.
 *
 * ## Incomplete is a verdict, not an error
 *
 * After {@link MAX_PAGINAS_BUSCA_KIT} pages still reporting `has_next_page`,
 * the answer is `completo: false` and the create refuses
 * `busca-de-kit-incompleta` — nothing is created on a scan that did not finish.
 * ⚠️ So is a cursor Shopee did not hand back (`has_next_page: true` with no
 * `next_offset`) or one that does not ADVANCE: the mass import may read those
 * as the end of a catalogue it is merely importing, but here an early end
 * would be a duplicate check that silently checked half the shop — the one
 * direction this guard cannot afford. An incomplete scan reads no base info:
 * nothing it found could change the refusal. Every Shopee FAILURE propagates
 * untouched (rule 6) — the caller's classifier owns those.
 *
 * Reads only. `chamadas` and `paginas` are reported by the dry run and counted
 * into `chamadasShopee`; the route has a 180 s ceiling and the CLI none, so a
 * very large shop is the CLI's.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_MAX_PAGE_SIZE,
  type ShopeeClient,
  type ShopeeItemListRow,
} from '@delfrance/integrations-shopee';

import { resolverLinkPorItemId } from '../anuncios/linkAnuncio';
import { ehKitDe } from '../produtos/itemLido';
import { skuDoItemShopee } from '../produtos/resolveProduto';
import { lerBaseInfoDosItens } from './componentesKit';
import { MAX_PAGINAS_BUSCA_KIT, STATUS_BUSCA_KIT } from './constantesKit';

/** One same-SKU kit the scan found. */
export interface AchadoKitPorSku {
  readonly itemId: number;
  /** The listing link that already names it in this conta (`resolverLinkPorItemId`), or `null`. */
  readonly vinculo: { readonly produtoId: string; readonly linkDocId: string } | null;
}

/** What {@link localizarKitsPorSku} answers. */
export interface BuscaDeKitPorSku {
  /** `false` ⇒ the walk did not reach the end of the shop; `achados` is then EMPTY. */
  readonly completo: boolean;
  /** Every same-SKU kit, sorted by `item_id`. */
  readonly achados: readonly AchadoKitPorSku[];
  /** `get_item_list` pages read. */
  readonly paginas: number;
  /** Shopee calls spent: the pages plus the base-info batch. */
  readonly chamadas: number;
}

/**
 * Walk the shop for a kit carrying `sku` — see the module header.
 *
 * ⚠️ `sku` must be the kit produto's own SKU, non-empty and trim-clean: phase A
 * refuses `kit-sem-sku` / `kit-sku-com-espacos` before any scan, so anything
 * else here is a caller bug and throws a `RangeError` with ZERO Shopee calls
 * (an empty SKU would match every SKU-less kit; a padded one would match none).
 */
export async function localizarKitsPorSku(
  client: ShopeeClient,
  db: Firestore,
  a: {
    readonly integracaoId: string;
    readonly sku: string;
    readonly excluirItemIds: ReadonlySet<number>;
  },
): Promise<BuscaDeKitPorSku> {
  if (a.sku === '' || a.sku.trim() !== a.sku) {
    throw new RangeError(
      'localizarKitsPorSku: o SKU do kit deve ser não vazio e sem espaços nas pontas',
    );
  }

  /** Candidates, FIRST sighting wins — an offset walk can show a row twice. */
  const candidatos = new Map<number, ShopeeItemListRow>();
  let paginas = 0;
  let completo = false;
  let offset = 0;

  while (paginas < MAX_PAGINAS_BUSCA_KIT) {
    const pagina = await client.getItemList({
      offset,
      pageSize: SHOPEE_MAX_PAGE_SIZE,
      statuses: STATUS_BUSCA_KIT,
    });
    paginas += 1;

    for (const linha of pagina.item) {
      if (linha.tag?.kit === false) continue;
      if (a.excluirItemIds.has(linha.item_id)) continue;
      if (!candidatos.has(linha.item_id)) candidatos.set(linha.item_id, linha);
    }

    if (!pagina.has_next_page) {
      completo = true;
      break;
    }
    const proximo = pagina.next_offset;
    if (proximo === null || proximo <= offset) {
      console.warn('[shopee/kits] get_item_list sem um next_offset que avance; busca incompleta', {
        integracaoId: a.integracaoId,
        offset,
        nextOffset: proximo,
        paginas,
      });
      break;
    }
    offset = proximo;
  }

  if (!completo) return { completo: false, achados: [], paginas, chamadas: paginas };

  const leitura = await lerBaseInfoDosItens(client, [...candidatos.keys()]);

  const hits: number[] = [];
  for (const [itemId, linhaDaLista] of candidatos) {
    const base = leitura.linhas.get(itemId);
    if (base === undefined) continue;
    if (!ehKitDe(base, linhaDaLista)) continue;
    if (skuDoItemShopee(base) !== a.sku) continue;
    hits.push(itemId);
  }
  hits.sort((x, y) => x - y);

  const achados: AchadoKitPorSku[] = [];
  for (const itemId of hits) {
    const link = await resolverLinkPorItemId(db, a.integracaoId, itemId);
    achados.push({
      itemId,
      vinculo: link === null ? null : { produtoId: link.produtoId, linkDocId: link.linkDocId },
    });
  }

  return { completo: true, achados, paginas, chamadas: paginas + leitura.chamadas };
}
