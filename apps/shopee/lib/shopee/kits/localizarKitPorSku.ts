/**
 * **The duplicate-SKU scan** (step 19, #1527, L6 / R-14) — and, since #1911
 * P5b, the ONE walk of the shop that every listing look-up of the publish
 * rides: does a listing of the kind asked for already carry this SKU here?
 *
 * - **A native KIT** ({@link localizarKitsPorSku}): every kit CREATE arm
 *   (criar, recriar, converter) runs it before `add_kit_item`; NO other arm
 *   does — a republish never scans (L10(4)), so a double-create twin surfaces
 *   on the next create-arm run, never on `kit-atualizar`.
 * - **An ORDINARY listing** ({@link localizarItensPorSku} with `kit: false`,
 *   #1911 P5b — Lucas, 2026-10-26): a DRAFT's FIRST `add_item`, under its
 *   lock, runs it through `anuncios/criacaoIncerta.ts`'s
 *   `verificarAnuncioExistenteShopee`, so a listing the conta already holds
 *   with the produto's SKU is IMPORTED, never created twice. The kit arm
 *   mirrored: the same walk, the same page ceiling, the same fold, the same
 *   incomplete verdict.
 * - **ENSURE** (`anuncios/criacaoIncerta.ts`, `localizarAnuncioIncerto`) rides
 *   {@link varrerListaDeItensShopee} alone — narrowed to its attempt window,
 *   with its own ceiling and its own fail-closed classification.
 *
 * It answers the hits; it decides nothing. `decidirKitNovo` (`planoKit.ts`)
 * reads the kit hits against the link docs (OURS is decided there, by the links
 * — S2C-02) and turns a foreign hit into the `kit-ja-existe-na-shopee` refusal
 * ("importe-o"), so a kit an uncertain or crashed create left unlinked is
 * IMPORTED by step 9 instead of created twice (L9); `criacaoIncerta.ts` reads
 * the ordinary hits the same way.
 *
 * ## The walk ({@link varrerListaDeItensShopee} — ONE copy, three callers)
 *
 * 1. **`get_item_list`, 100 per page** — UN-narrowed for both same-SKU scans
 *    (no `update_time_from`: a listing created a year ago in Seller Centre is
 *    as much a duplicate as one created a minute ago); ENSURE alone narrows it
 *    to its window. Statuses {@link STATUS_BUSCA_KIT}
 *    (`NORMAL, UNLIST, REVIEWING, BANNED`): a DELETED listing is never a
 *    duplicate. The cursor is Shopee's own `next_offset`, echoed, never
 *    `offset + 100`; FIRST sighting wins — an offset walk can show a row twice.
 * 2. **Candidates — fail closed on the tag.** `tag` was added on 2024-10-18 and
 *    a row that predates it has none, so a `null` `tag` / `tag.kit` is a
 *    CANDIDATE decided by its base info: a kit scan drops only an explicit
 *    `tag.kit: false` (DATA: this item is not a kit), an ordinary scan only an
 *    explicit `true`. `excluirItemIds` drops the recriar's own target (the old
 *    kit carries the same SKU); every other caller excludes nothing.
 * 3. **ONE base-info batch (≤ 50 per call)** over the candidates, through the
 *    shared reader (`lerBaseInfoDosItens`). EVERY candidate must come back with
 *    a row — one that does not makes the walk INCOMPLETE (below), never "not a
 *    hit". A hit is a row of the KIND asked
 *    for — `ehKitDe(base, listRow)`, the import's own reading, so the base `tag`
 *    wins and the list row's is only the fallback — AND whose SKU folds equal:
 *    `skuDoItemShopee(base) === sku`. That fold is step 9's PARENT-SKU rung,
 *    exported from `produtos/resolveProduto.ts` and shared, never copied: the
 *    scan must ask exactly what the import asks, or "importe-o" would land the
 *    listing on another produto. Equal: leading/trailing whitespace on
 *    Shopee's side (`'KIT-1 '` is a hit for `'KIT-1'`). Distinct: case
 *    (`'kit-1'` is not), inner whitespace, and an absent `item_sku` (folds to
 *    `''`, which no caller ever asks for).
 * 4. **ONE `resolverLinkPorItemId` per hit** — the declared `(item_id, conta)`
 *    composite — fills {@link AchadoPorSku.vinculo}, so the refusal can say
 *    "já vinculado ao produto {id}" and the classifier can tell ours from not.
 *
 * ## Incomplete is a verdict, not an error
 *
 * After {@link MAX_PAGINAS_BUSCA_KIT} pages (both same-SKU scans) still
 * reporting `has_next_page`, the answer is `completo: false` and the create
 * refuses (`busca-de-kit-incompleta`; the ordinary arm's
 * `busca-de-anuncio-existente-incompleta`) — nothing is created on a scan that
 * did not finish. ⚠️ So is a cursor Shopee did not hand back
 * (`has_next_page: true` with no `next_offset`) or one that does not ADVANCE:
 * the mass import may read those as the end of a catalogue it is merely
 * importing, but here an early end would be a duplicate check that silently
 * checked half the shop — the one direction this guard cannot afford. An
 * incomplete walk reads no base info: nothing it found could change the
 * refusal.
 *
 * ⚠️ **And so is a listed candidate the base-info batch returned NO row for**
 * (#1911 batch-A review, both kinds, in the ONE loop — step 19's kit scan
 * skipped such a row since it was written, undocumented): the list says the
 * listing exists, and without its base row nothing says it is not a same-SKU
 * listing of the kind asked for, so skipping it would be "absent" on no
 * evidence — the fail-open direction ENSURE already refuses (an unreported SKU
 * is a doubt there). Whether Shopee left the id out of a batch, answered a
 * chunk with the batch verdict "none of these ids exists"
 * (`error_item_not_found`, which the shared reader turns into no rows), or the
 * listing vanished between the two reads, the answer is the same: `completo:
 * false`, NO achados, NO link read, the ids in {@link BuscaPorSku.incompleta}
 * and ONE `console.warn` (the count and ≤ 10 ids — never a SKU, a name or a
 * body). Both callers word it ({@link fraseDaBaseInfoNaoDevolvida}): "try
 * again; if it persists, check those listings in Seller Centre". Each
 * `incompleta.causa` names which of the two stopped it: `'lista'` (the
 * ceiling or the cursor) or `'base-info'`.
 *
 * Every Shopee FAILURE propagates untouched (rule 6) — the caller's
 * classifier owns those.
 *
 * Reads only. `chamadas` (the pages plus the base-info calls actually made — an
 * incomplete-by-`base-info` answer counts its batch too) and `paginas` are
 * reported by the dry run and counted
 * into `chamadasShopee`; the route has a 180 s ceiling and the CLI none, so a
 * very large shop is the CLI's. ⚠️ The ORDINARY scan's base-info batch covers
 * the whole catalogue (every non-kit row is a candidate) where the kit's covers
 * the shop's few kits: ⌈rows/100⌉ pages plus ⌈rows/50⌉ base-info calls.
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

/* -------------------------------------------------------------------------- */
/*                        the walk — ONE copy, three callers                   */
/* -------------------------------------------------------------------------- */

/** What one {@link varrerListaDeItensShopee} walk saw. */
export interface VarreduraDaLojaShopee {
  /** `false` ⇒ the walk did not reach the end of the shop (the ceiling, or a cursor). */
  readonly completo: boolean;
  /** Every candidate row, FIRST sighting wins, in sighting order. */
  readonly candidatos: ReadonlyMap<number, ShopeeItemListRow>;
  /** `get_item_list` pages read. */
  readonly paginas: number;
}

/**
 * Walk `get_item_list` — see the module header, steps 1–2. Reads only; every
 * Shopee failure propagates untouched (rule 6).
 */
export async function varrerListaDeItensShopee(
  client: ShopeeClient,
  a: {
    /** Pages read before the walk gives up and answers INCOMPLETE. */
    readonly maxPaginas: number;
    /** SECONDS — `update_time_from`; absent ⇒ un-narrowed (the key is never sent). */
    readonly updateTimeFromS?: number;
    /** Whether a list row is a candidate; `false` drops it before any base info. */
    readonly candidato: (linha: ShopeeItemListRow) => boolean;
    /** The stalled-cursor log line: its prefix and its ids (ids only, never content). */
    readonly registro: {
      readonly origem: string;
      readonly ids: Readonly<Record<string, string>>;
    };
  },
): Promise<VarreduraDaLojaShopee> {
  const candidatos = new Map<number, ShopeeItemListRow>();
  let paginas = 0;
  let completo = false;
  let offset = 0;

  while (paginas < a.maxPaginas) {
    const pagina = await client.getItemList({
      offset,
      pageSize: SHOPEE_MAX_PAGE_SIZE,
      statuses: STATUS_BUSCA_KIT,
      ...(a.updateTimeFromS === undefined ? {} : { updateTimeFromS: a.updateTimeFromS }),
    });
    paginas += 1;

    for (const linha of pagina.item) {
      if (!a.candidato(linha)) continue;
      if (!candidatos.has(linha.item_id)) candidatos.set(linha.item_id, linha);
    }

    if (!pagina.has_next_page) {
      completo = true;
      break;
    }
    const proximo = pagina.next_offset;
    if (proximo === null || proximo <= offset) {
      console.warn(
        `${a.registro.origem} get_item_list sem um next_offset que avance; busca incompleta`,
        { ...a.registro.ids, offset, nextOffset: proximo, paginas },
      );
      break;
    }
    offset = proximo;
  }

  return { completo, candidatos, paginas };
}

/* -------------------------------------------------------------------------- */
/*                          the same-SKU scan, two kinds                       */
/* -------------------------------------------------------------------------- */

/** One same-SKU listing the scan found. */
export interface AchadoPorSku {
  readonly itemId: number;
  /** The listing link that already names it in this conta (`resolverLinkPorItemId`), or `null`. */
  readonly vinculo: { readonly produtoId: string; readonly linkDocId: string } | null;
}

/** Why a same-SKU scan answered INCOMPLETE ({@link BuscaPorSku.incompleta}). */
export type IncompletudeDaBuscaPorSku =
  /** THE walk stopped short: the page ceiling, or a cursor Shopee did not hand back / advance. */
  | { readonly causa: 'lista' }
  /**
   * The walk finished, but `get_item_base_info` returned no row for these
   * LISTED candidates — every one of them, sorted by `item_id`.
   */
  | { readonly causa: 'base-info'; readonly itemIds: readonly number[] };

/** What {@link localizarItensPorSku} answers. */
export interface BuscaPorSku {
  /**
   * `false` ⇒ the scan cannot prove absence — the walk did not reach the end
   * of the shop, or a listed candidate came back with no base row; `achados`
   * is then EMPTY.
   */
  readonly completo: boolean;
  /** Every same-SKU listing of the kind asked for, sorted by `item_id`. */
  readonly achados: readonly AchadoPorSku[];
  /** Why `completo` is `false`; `null` ⇔ `completo`. */
  readonly incompleta: IncompletudeDaBuscaPorSku | null;
  /** `get_item_list` pages read. */
  readonly paginas: number;
  /** Shopee calls spent: the pages plus the base-info calls actually made. */
  readonly chamadas: number;
}

/** At most this many ids in a sentence or the log line — the count says the rest. */
const IDS_NO_TEXTO = 10;

/**
 * The sentence BOTH callers give a scan that stopped on `'base-info'` — after
 * their own "a busca … não terminou: " — so the kit and the ordinary refusal
 * cannot word it apart. Ids last-but-one and capped at {@link IDS_NO_TEXTO}
 * ("e mais N"); item ids are not secrets.
 */
export function fraseDaBaseInfoNaoDevolvida(itemIds: readonly number[]): string {
  const mostrados = itemIds.slice(0, IDS_NO_TEXTO).map(String).join(', ');
  const mais =
    itemIds.length > IDS_NO_TEXTO ? ` e mais ${String(itemIds.length - IDS_NO_TEXTO)}` : '';
  return (
    `a Shopee não devolveu os dados de ${String(itemIds.length)} anúncio(s) listado(s) ` +
    `(ids ${mostrados}${mais}) — nada foi criado; tente de novo; se persistir, confira esses ` +
    'anúncios no Seller Centre'
  );
}

/** One same-SKU KIT (step 19's name for {@link AchadoPorSku}). */
export type AchadoKitPorSku = AchadoPorSku;

/** What {@link localizarKitsPorSku} answers (step 19's name for {@link BuscaPorSku}). */
export type BuscaDeKitPorSku = BuscaPorSku;

/**
 * Walk the shop for a listing of ONE kind carrying `sku` — see the module
 * header. `kit: true` looks for native kits (step 19), `kit: false` for
 * ordinary listings (#1911 P5b); everything else — the walk, the ceiling
 * ({@link MAX_PAGINAS_BUSCA_KIT}), the fold, the link read — is one code path.
 *
 * ⚠️ `sku` must be non-empty and trim-clean — the FOLD of the produto's SKU:
 * anything else here is a caller bug and throws a `RangeError` with ZERO Shopee
 * calls (an empty SKU would match every SKU-less listing; a padded one would
 * match none). Kit phase A refuses `kit-sem-sku` / `kit-sku-com-espacos` before
 * any scan; the ordinary arm folds first and never scans a blank fold.
 */
export async function localizarItensPorSku(
  client: ShopeeClient,
  db: Firestore,
  a: {
    readonly integracaoId: string;
    readonly sku: string;
    readonly excluirItemIds: ReadonlySet<number>;
    /** `true` ⇒ native kits; `false` ⇒ ordinary listings. */
    readonly kit: boolean;
  },
): Promise<BuscaPorSku> {
  if (a.sku === '' || a.sku.trim() !== a.sku) {
    throw new RangeError(
      `localizarItensPorSku: o SKU ${a.kit ? 'do kit' : 'do anúncio'} deve ser não vazio e ` +
        'sem espaços nas pontas',
    );
  }

  const origem = a.kit ? '[shopee/kits]' : '[shopee/anuncios]';
  const varredura = await varrerListaDeItensShopee(client, {
    maxPaginas: MAX_PAGINAS_BUSCA_KIT,
    candidato: (linha) => {
      // ⚠️ Only an EXPLICIT tag of the OTHER kind drops a row (fail closed):
      // a `null` tag is decided by the base info below.
      if (linha.tag?.kit === !a.kit) return false;
      return !a.excluirItemIds.has(linha.item_id);
    },
    registro: { origem, ids: { integracaoId: a.integracaoId } },
  });
  const { paginas } = varredura;
  if (!varredura.completo) {
    return {
      completo: false,
      achados: [],
      incompleta: { causa: 'lista' },
      paginas,
      chamadas: paginas,
    };
  }

  const leitura = await lerBaseInfoDosItens(client, [...varredura.candidatos.keys()]);
  const chamadas = paginas + leitura.chamadas;

  const hits: number[] = [];
  const naoLidos: number[] = [];
  for (const [itemId, linhaDaLista] of varredura.candidatos) {
    const base = leitura.linhas.get(itemId);
    // ⚠️ Listed, but no base row came back: a DOUBT, never "not a hit" — the
    // scan cannot prove absence (module header). Both kinds, one path.
    if (base === undefined) {
      naoLidos.push(itemId);
      continue;
    }
    if (ehKitDe(base, linhaDaLista) !== a.kit) continue;
    if (skuDoItemShopee(base) !== a.sku) continue;
    hits.push(itemId);
  }
  if (naoLidos.length > 0) {
    naoLidos.sort((x, y) => x - y);
    console.warn(
      `${origem} get_item_base_info não devolveu ${String(naoLidos.length)} anúncio(s) ` +
        'listado(s); busca incompleta',
      {
        integracaoId: a.integracaoId,
        naoLidos: naoLidos.length,
        itemIds: naoLidos.slice(0, IDS_NO_TEXTO),
      },
    );
    return {
      completo: false,
      achados: [],
      incompleta: { causa: 'base-info', itemIds: naoLidos },
      paginas,
      chamadas,
    };
  }
  hits.sort((x, y) => x - y);

  const achados: AchadoPorSku[] = [];
  for (const itemId of hits) {
    const link = await resolverLinkPorItemId(db, a.integracaoId, itemId);
    achados.push({
      itemId,
      vinculo: link === null ? null : { produtoId: link.produtoId, linkDocId: link.linkDocId },
    });
  }

  return { completo: true, achados, incompleta: null, paginas, chamadas };
}

/**
 * Walk the shop for a native KIT carrying `sku` — step 19's L6 scan,
 * {@link localizarItensPorSku} with `kit: true`.
 *
 * ⚠️ `sku` must be the kit produto's own SKU, non-empty and trim-clean: phase A
 * refuses `kit-sem-sku` / `kit-sku-com-espacos` before any scan, so anything
 * else here is a caller bug and throws a `RangeError` with ZERO Shopee calls.
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
  return localizarItensPorSku(client, db, { ...a, kit: true });
}
