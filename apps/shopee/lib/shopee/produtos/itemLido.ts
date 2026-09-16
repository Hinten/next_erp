/**
 * **The seam of step 9** (#1517): the record one listing arrives in, the
 * importer's signature and result, and the dependency shapes the job and the
 * importer meet on. Pure and Next-free — the Cloud Functions bundle reaches this
 * module, so `next/server` (and therefore `core/respond.ts`) must stay out of
 * its import graph.
 *
 * ## Why the record exists at all
 *
 * The mass-import job pays for the wire reads ONCE per item — `get_item_list`
 * (the scan row), `get_item_base_info` (batched, up to 50 ids in one call),
 * `get_model_list` (one per variation-bearing item) and, for a kit,
 * `get_kit_item_info` — and hands them down. **The importer issues no item read
 * of its own** (`o importador não emite nenhuma chamada de item_base_info`), so
 * a catalogue walk costs one batch per dispatch instead of one call per listing,
 * and the single-item route, the CLI and the job all drive the same code path
 * with the same record.
 *
 * ## ⚠️ The five fields Shopee contradicts itself about
 *
 * `get_item_base_info`'s parameter table renders `tax_info`, `description_type`,
 * `description_info`, `stock_info_v2` and `complaint_policy` as SIBLINGS of
 * `item_list` under `response`, while its own response SAMPLE nests them INSIDE
 * each item ({@link SHOPEE_NESTING_AMBIGUOUS_KEYS}). Reading one position only is
 * the silent failure: under the wrong reading every item's fiscal block arrives
 * `null`, with no error anywhere. So {@link montarItemLido} resolves all five
 * through {@link campoAninhadoDe} — the ITEM position wins, both absent stays
 * `null`, never `{}` — and writes them back onto the row it keeps. Everything
 * downstream reads `item.base.<campo>` and cannot pick the wrong position,
 * because by then there is only one.
 *
 * ## ⚠️ Units, clocks and the microsecond reflex
 *
 * Shopee's `create_time` / `update_time` are wire SECONDS; the produto stamps
 * (`timestamp`, `ultimaModificacao`) are MILLISECONDS. Step 9 stores no Shopee
 * timestamp at all, so nothing here converts one — and **no module under
 * `produtos/` holds a microsecond helper**: the two ms→µs helpers belong to the
 * pedido/pagamento paths of this app and reaching for one here is the drift
 * that `apps/shopee/CLAUDE.md`'s µs list exists to prevent (described, not
 * named — the repo's raw-text guards grep for the names). The clock itself is a
 * PARAMETER ({@link ImportarAnuncioDeps.nowMs}) — one read per dispatch, handed
 * down; the single clock read under `produtos/` is the documented default in
 * `importacaoMassa.ts`, which is what fills it.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type {
  ShopeeClient,
  ShopeeDescriptionInfo,
  ShopeeItemBaseInfo,
  ShopeeItemBaseInfoRow,
  ShopeeItemListRow,
  ShopeeKitItem,
  ShopeeModelList,
  ShopeeNestingAmbiguousKey,
  ShopeeStandardiseTierVariation,
  ShopeeTaxInfo,
  ShopeeTierVariation,
} from '@delfrance/integrations-shopee';
import { SHOPEE_NESTING_AMBIGUOUS_KEYS } from '@delfrance/integrations-shopee';
import type { ImportacaoShopeeOptions } from '@delfrance/schemas';
import type { Bucket } from '@delfrance/storage/admin';

import type { ShopeeCategoriaIndice } from '../taxonomia/categorias';

// ⚠️ TYPE-ONLY, and it has to stay that way: `planoImportacao.ts` imports real
// VALUES from this module, so a value import here would close a runtime cycle.
// `import type` is erased entirely, so there is none.
import type { PlanoImportacaoShopee } from './planoImportacao';

/* -------------------------------------------------------------------------- */
/*  The record                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One listing, already READ.
 *
 * ⚠️ `base` is the row RECONCILED BY `item_id` out of the batch payload, never
 * the row at the caller's position: `get_item_base_info` may answer with FEWER
 * rows than were asked for, and by-position reconciliation would then import one
 * listing's data onto another listing's produto — silently, and only for the
 * items after the gap.
 *
 * ⚠️ `base` also carries the five nesting-ambiguous fields NORMALISED to the
 * item position (see the module header). It is the parsed row plus that
 * resolution, and nothing else is rewritten.
 */
export interface ItemLido {
  /** The `get_item_base_info` row for {@link ItemLido.itemId}, ambiguous fields resolved. */
  readonly base: ShopeeItemBaseInfoRow;
  /** `get_model_list`'s payload. `null` when the item has no models (or none was read). */
  readonly models: ShopeeModelList | null;
  /** `tax_info`, resolved through {@link taxInfoDe}. Absent in both positions ⇒ `null`. */
  readonly taxInfo: ShopeeTaxInfo | null;
  /** `get_kit_item_info.response.product_info`. `null` for a non-kit. */
  readonly kit: ShopeeKitItem | null;
  /** The id ASKED for — the reconciliation key. */
  readonly itemId: number;
}

/* -------------------------------------------------------------------------- */
/*  The two readers for the ambiguous nesting                                  */
/* -------------------------------------------------------------------------- */

/** The resolved value of one ambiguous key: its declared type, or `null`. */
type CampoAninhado<K extends ShopeeNestingAmbiguousKey> = NonNullable<
  ShopeeItemBaseInfoRow[K]
> | null;

/**
 * `row[key] ?? payload[key] ?? null` — the ITEM position wins.
 *
 * ⚠️ `null` and not `{}` when both are absent: an empty object is a statement
 * ("Shopee answered, and the block is empty") and a `null` is another one
 * ("nothing arrived"), and the fiscal leg of the import branches on the
 * difference. Step 10's `lerLimitesDeItem` reads `gtin_limit` the same way, for
 * the same page's same contradiction.
 */
export function campoAninhadoDe<K extends ShopeeNestingAmbiguousKey>(
  payload: ShopeeItemBaseInfo,
  row: ShopeeItemBaseInfoRow,
  key: K,
): CampoAninhado<K> {
  const doItem = row[key] as CampoAninhado<K> | undefined;
  if (doItem != null) return doItem;
  const daRaiz = payload[key] as CampoAninhado<K> | undefined;
  return daRaiz ?? null;
}

/**
 * The fiscal block, from whichever position Shopee sent it in.
 *
 * ⚠️ Every value inside is a STRING on the wire (`"00"` means absent for several
 * of them) and stays one all the way to the link document. Numeric coercion
 * anywhere near `tax_info` is a defect — `csosn: "00"` is not the number 0.
 */
export function taxInfoDe(
  payload: ShopeeItemBaseInfo,
  row: ShopeeItemBaseInfoRow,
): ShopeeTaxInfo | null {
  return campoAninhadoDe(payload, row, 'tax_info');
}

/* -------------------------------------------------------------------------- */
/*  The builder                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What {@link montarItemLido} needs.
 *
 * ⚠️ The ROW is not a parameter: it is reconciled out of `payload` by `itemId`.
 * Taking it from the caller would be exactly the by-position bug this record
 * exists to prevent — the caller holds an ARRAY and an index, and the safe
 * lookup is the one nobody has to remember to do.
 */
export interface ArgsMontarItemLido {
  /** The id asked for. */
  readonly itemId: number;
  /** The whole `get_item_base_info` payload of the batch this item was read in. */
  readonly payload: ShopeeItemBaseInfo;
  /** The `get_item_list` row, when the item came from a scan. Absent on the single-item route. */
  readonly linha?: ShopeeItemListRow | null;
  /** `get_model_list`'s payload, for a `has_model` item. */
  readonly modelos?: ShopeeModelList | null;
  /** `get_kit_item_info.response.product_info`, for a `tag.kit` item. */
  readonly kit?: ShopeeKitItem | null;
}

/**
 * Assemble one {@link ItemLido}.
 *
 * ⚠️ A payload carrying no row for `itemId` is a **caller bug**, not a provider
 * outage: the caller asked for this id in this very batch. It throws a plain
 * `Error` naming the id rather than a `ShopeeError`, because the contained
 * per-item vocabulary (`item-nao-retornado`) belongs to the JOB, which compares
 * the ids it asked for against the ids it got back BEFORE building anything.
 * A `ShopeeError` here would let that bug be filed as a listing's failure row.
 */
export function montarItemLido(args: ArgsMontarItemLido): ItemLido {
  // ⚠️ `item_list` is tolerant PER ELEMENT: a row that did not parse arrives as
  // the payload schema's `null` sentinel, so the lookup skips holes. A hole is
  // the caller's problem exactly like an absent row — both are
  // `item-nao-retornado`, decided by the job before anything is built.
  const legiveis = args.payload.item_list.filter(
    (row): row is ShopeeItemBaseInfoRow => row !== null,
  );
  const bruta = legiveis.find((row) => row.item_id === args.itemId);
  if (!bruta) {
    throw new Error(
      `montarItemLido: o payload de get_item_base_info não traz o item ${String(args.itemId)} ` +
        `(pedidos: ${String(legiveis.length)} linha(s) legível(is) de ` +
        `${String(args.payload.item_list.length)}). ` +
        'Reconcilie por item_id antes de montar — uma linha ausente é item-nao-retornado, do job.',
    );
  }

  // The five ambiguous fields, resolved ONCE onto the row every later module
  // reads. Built by NAME from the exported key list, so a sixth ambiguous field
  // is one entry there and nothing here.
  const resolvidos: Partial<Record<ShopeeNestingAmbiguousKey, unknown>> = {};
  for (const chave of SHOPEE_NESTING_AMBIGUOUS_KEYS) {
    resolvidos[chave] = campoAninhadoDe(args.payload, bruta, chave);
  }
  const base = { ...bruta, ...resolvidos } as ShopeeItemBaseInfoRow;

  return {
    base,
    models: args.modelos ?? null,
    taxInfo: taxInfoDe(args.payload, bruta),
    kit: args.kit ?? null,
    itemId: args.itemId,
  };
}

/* -------------------------------------------------------------------------- */
/*  Pure accessors — READINGS of the record, never extra fields on it          */
/* -------------------------------------------------------------------------- */

/**
 * The listing's `item_status`, as READ — a loose string, never the request
 * enum.
 *
 * ⚠️ An `item_status` Shopee invents tomorrow costs ONE field on the link
 * document (it folds to `null` there), never an item: a strict enum on a
 * RESPONSE would fail the whole page and with it a catalogue scan.
 */
export function itemStatusDe(item: ItemLido): string | null {
  return item.base.item_status ?? null;
}

/**
 * Is this listing a kit?
 *
 * `base.tag?.kit ?? linha?.tag?.kit ?? false` — the scan row is the fallback
 * because `tag` was added on 2024-10-18 and a read that predates it simply has
 * none, while `tag.kit` is the ONLY kit-discovery channel that exists (there is
 * no kit listing endpoint). A `false` is DATA, never an absence.
 *
 * ⚠️ The scan row is a SECOND parameter rather than a field of {@link ItemLido}:
 * the record is the frozen seam and carries no scan row, and the single-item
 * route has none to carry. The job passes it; the importer, which already knows
 * a kit by {@link ItemLido.kit}, does not.
 */
export function ehKitDe(
  base: Pick<ShopeeItemBaseInfoRow, 'tag'>,
  linha?: Pick<ShopeeItemListRow, 'tag'> | null,
): boolean {
  return base.tag?.kit ?? linha?.tag?.kit ?? false;
}

/**
 * Does the listing have models (variations)?
 *
 * ⚠️ `has_model === true` EXACTLY, never truthiness: Shopee zero-fills, the
 * field is deliberately not strict in the schema, and a string `'false'` is
 * truthy in JavaScript — the `ehFolha` (`has_children === false`) precedent of
 * this app. A wrong `true` here would leave a parent produto owning children it
 * has no models for.
 */
export function temModelosDe(item: ItemLido): boolean {
  return item.base.has_model === true;
}

/** `tier_variation[]` — the CUSTOM tree's tier NAMES. `[]` when absent. */
export function tiersDe(item: ItemLido): readonly ShopeeTierVariation[] {
  return item.models?.tier_variation ?? [];
}

/**
 * `standardise_tier_variation[]` — the STANDARDISED tree's ids. `[]` when absent.
 *
 * ⚠️ Both trees may be absent, in any combination, and a BR shop outside Fashion
 * gets every id back as `0` (the documented CUSTOM sentinel). The legacy
 * dereferenced `tier_variation` unconditionally; tolerating every combination is
 * why these two readers exist at all.
 */
export function tiersPadronizadosDe(item: ItemLido): readonly ShopeeStandardiseTierVariation[] {
  return item.models?.standardise_tier_variation ?? [];
}

/** Every non-blank `text` block of an extended description, joined by a blank line. */
function textoEstendido(info: ShopeeDescriptionInfo | null): string | null {
  const blocos = info?.extended_description?.field_list ?? [];
  const textos = blocos
    .map((b) => (typeof b.text === 'string' ? b.text.trim() : ''))
    .filter((t) => t.length > 0);
  return textos.length > 0 ? textos.join('\n\n') : null;
}

function textoOuNulo(valor: string | null): string | null {
  const t = valor?.trim() ?? '';
  return t.length > 0 ? t : null;
}

/**
 * The listing's description, from whichever of the two mutually exclusive
 * sources carries it.
 *
 * `description` and `description_info` are documented as exclusive: when
 * `description_type` is `extended`, `description` comes back EMPTY, and vice
 * versa. So the DECLARED source is preferred and the other is the fallback —
 * which costs nothing when the declaration is honest and saves the description
 * when it is not (an unknown `description_type` with real extended blocks would
 * otherwise import as an empty description, silently, for every item of a
 * whitelisted seller).
 *
 * ⚠️ Blank is `null`, never `''`. And an extended description made only of IMAGE
 * blocks is blank: per-block images are a recorded gap (ML parity), so there is
 * no text to keep.
 *
 * ⚠️ No length cap here. The 3000-character cap belongs to the mapper, beside
 * the produto field it writes.
 */
export function descricaoDe(item: ItemLido): string | null {
  const simples = textoOuNulo(item.base.description);
  const estendido = textoEstendido(item.base.description_info);
  return item.base.description_type === 'extended'
    ? (estendido ?? simples)
    : (simples ?? estendido);
}

/* -------------------------------------------------------------------------- */
/*  The importer's signature and result                                        */
/* -------------------------------------------------------------------------- */

/** What one listing's import did, as the route, the CLI and the job all report it. */
export interface ResultadoImportacaoShopee {
  readonly produtoId: string;
  readonly criado: boolean;
  readonly nome: string;
  readonly variacoes: {
    readonly total: number;
    readonly criadas: number;
    /**
     * Children created with NO `variashopee` link — the `model_id: 0` case,
     * which is Shopee's "this item has no variation" and is never written as a
     * link. Counted rather than hidden: a child nothing can resolve is a fact
     * the operator has to be able to see.
     */
    readonly semLink: number;
  };
  readonly fotos: {
    readonly importadas: number;
    readonly ignoradas: number;
    readonly falhas: number;
  };
  /** Present only when the item was a kit AND the kit arm ran. */
  readonly kit?: { readonly componentes: number; readonly criado: boolean };
}

/** One stored document, unparsed — the shape every memo below carries. */
export interface DocumentoDeGrupo {
  readonly id: string;
  readonly raw: Record<string, unknown>;
  /**
   * The snapshot's write stamp, carried so the guarded grupo write can assert
   * the read its patch was DERIVED from.
   *
   * ⚠️ It has to ride the memo rather than come from a second read in the
   * writer. A patch planned against the memo's copy and guarded by a fresher
   * read's stamp is an UNGUARDED write wearing a precondition: the window it
   * claims to cover is exactly the window between the two reads. `unknown`
   * because the concrete type is the Admin SDK's `Timestamp` and nothing here
   * reads it — it is handed straight back to `update()`.
   */
  readonly updateTime?: unknown;
}

/**
 * The LOADED `grupoDeVariacoes` candidate set — what the PURE taxonomy core
 * plans against.
 *
 * `raw` is the stored document, unparsed, because the scan reads a field the
 * grupo schema types as `z.array(z.unknown())`: Firestore cannot query inside an
 * array of objects (`array-contains` needs exact element equality), so the
 * operator-authored `linksVariacoesShopee` mapping — the very thing step 11's
 * export reads — is only findable by scanning in memory.
 */
export interface GrupoMemo {
  readonly docs: readonly DocumentoDeGrupo[];
  /**
   * Take in a document THIS dispatch has just written, so the next item of the
   * same dispatch plans against it instead of against the collection as it was
   * before the first item ran.
   *
   * ⚠️ Without it the memo AGES: item 1 creates `Cor`, item 2 still cannot see
   * it, plans the same create, and loses — spending its one bounded re-plan on
   * ITSELF, so a genuine second writer arriving right afterwards would refuse
   * the item for a conflict that never happened. It also turns "one collection
   * read per dispatch" into one read per item that debuts a tier, on a database
   * that bills DATA SCANNED.
   *
   * ⚠️ Optional so that a fixed candidate set (`{ docs: [...] }`) stays a legal
   * `GrupoMemo` — a caller that cannot absorb simply keeps today's behaviour.
   * The writer calls it only after a write it WON; a lost race is re-planned
   * against a fresh read, never against a guess about who won.
   */
  absorver?(doc: DocumentoDeGrupo): void;
}

/**
 * The per-DISPATCH memo: one full read of `grupoDeVariacoes`, performed lazily
 * on the first item that has models and reused by every later item and every
 * rung.
 *
 * ⚠️ LAZY, and that is the whole point of the shape. An eager field would make
 * the collection read happen once per ITEM (or once per dispatch even for a
 * catalogue of no-model listings), and Firestore Enterprise bills DATA SCANNED —
 * so "loaded when first needed, never again" is a cost property, not a style
 * choice. `taxonomiaShopee.ts` builds one with `criarMemoDeGrupos(db)`; the job
 * builds it ONCE per dispatch beside the rest of the importer's deps, and a
 * per-item route or the CLI passes nothing and lets the module build its own.
 */
export interface MemoDeGrupos {
  carregar(): Promise<GrupoMemo>;
}

/**
 * The per-DISPATCH memo of the Shopee category tree, in the same lazy shape and
 * for the same reason.
 *
 * ⚠️ It exists because the importer's deps carry no Shopee `client`: every wire
 * read was already paid for by the caller, and the category tree is the one
 * remaining read the importer itself needs. It is NOT a per-item API call — the
 * loader goes through step 10's TTL-cached index — but it still has to be handed
 * in by whoever owns a client. ABSENT ⇒ the categoria leg is skipped entirely
 * (no chain, no document created, no leaf ref on the produto) with one log line,
 * exactly like an unknown category id: never a throw, never a failed item.
 */
export interface MemoDeCategorias {
  carregar(): Promise<ShopeeCategoriaIndice>;
}

/**
 * What the per-item importer needs. ONE clock, handed down; no scheduler, no
 * client — every wire read was already paid for by the caller.
 */
export interface ImportarAnuncioDeps {
  readonly db: Firestore;
  /** The `integracao` document id. It scopes the produto ids, both links and the photo cache. */
  readonly integracaoId: string;
  /** `integracao.tabelaNormalOuterRef` — absent ⇒ the price leg SKIPS, never throws. */
  readonly tabelaNormalOuterRef: string | null;
  /**
   * `integracao.tabelaPromocionalOuterRef`.
   *
   * ⚠️ Carried and DELIBERATELY never written. The Shopee legacy sent
   * `current_price` here whenever it was lower than `original_price`; Mercado
   * Livre refused exactly that (#803, owner decision) because the promotional
   * tabela belongs to promotions the operator authors in the ERP, and step 9
   * takes the same stance: `original_price ?? current_price` goes to the NORMAL
   * table and this field stays a documented no-op.
   */
  readonly tabelaPromocionalOuterRef: string | null;
  /** `integracao.depositoOuterRef` — absent ⇒ the estoque leg SKIPS with one log line. */
  readonly depositoOuterRef: string | null;
  /** Absent ⇒ photos are skipped for the whole run (an unresolvable bucket NAME). */
  readonly bucket?: Bucket;
  readonly options: ImportacaoShopeeOptions;
  /**
   * Milliseconds. ONE clock read per dispatch (the documented default in
   * `importacaoMassa.ts`), handed down — every module here takes it as a parameter.
   */
  readonly nowMs: number;
  /** The per-dispatch grupo memo. Absent ⇒ the taxonomy module builds its own. */
  readonly grupos?: MemoDeGrupos;
  /**
   * The per-dispatch category-tree memo. Absent ⇒ the categoria leg is SKIPPED
   * with one log line (see {@link MemoDeCategorias}).
   */
  readonly categorias?: MemoDeCategorias;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * The deps of the WRITE-FREE half.
 *
 * Structurally write-free: no bucket (an upload is a write) and no fetch (the
 * photo unit is the only thing that fetches, and it writes). A test drives it
 * with a FakeDb that throws on every write verb, the `prepararImportacaoPedidoShopee`
 * discipline — the property is proved by the call graph, not by a comment.
 */
export type PrepararImportacaoShopeeDeps = Omit<ImportarAnuncioDeps, 'bucket' | 'fetchImpl'>;

/**
 * The plan the write-free half produces — the ORDERED write plan, as data.
 *
 * ⚠️ RE-EXPORTED, not declared: `planoImportacao.ts` owns the shape. It replaced
 * a brand-only placeholder the moment that module landed, rather than being
 * shadowed by it — two declarations of one seam type is exactly how the two
 * halves of a seam drift while both compile.
 */
export type { PlanoImportacaoShopee };

export type ImportarAnuncioShopeeFn = (
  deps: ImportarAnuncioDeps,
  entrada: ItemLido,
) => Promise<ResultadoImportacaoShopee>;

export type PrepararImportacaoShopeeFn = (
  deps: PrepararImportacaoShopeeDeps,
  entrada: ItemLido,
) => Promise<PlanoImportacaoShopee>;

/** The kit arm's importer (K1). Same deps; the result carries the `kit` block. */
export type ImportarKitShopeeFn = (
  deps: ImportarAnuncioDeps,
  entrada: ItemLido,
) => Promise<ResultadoImportacaoShopee>;

/* -------------------------------------------------------------------------- */
/*  The job ↔ importer seam                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything one dispatch resolves ONCE, before the drain.
 *
 * ⚠️ `client` holds a token FUNCTION, not a token: a shop token lapsing
 * mid-walk is then renewed rather than replayed dead.
 */
export interface ContextoImportacaoShopee {
  readonly client: ShopeeClient;
  readonly integracaoId: string;
  readonly tabelaNormalOuterRef: string | null;
  readonly tabelaPromocionalOuterRef: string | null;
  readonly depositoOuterRef: string | null;
  readonly bucket?: Bucket;
}

/** The Cloud Tasks body of one mass-import dispatch. */
export interface ImportacaoShopeeTaskPayload {
  readonly jobId: string;
  readonly integracaoId: string;
}

/**
 * The scheduler, as the JOB sees it — one method, so the job's own suite never
 * loads the Cloud Tasks client. Wave 4's `shopeeMassImportTasks.ts` implements
 * it.
 */
export interface AgendadorImportacaoShopee {
  enqueue(
    payload: ImportacaoShopeeTaskPayload,
    opts?: { readonly scheduleDelaySeconds?: number },
  ): Promise<void>;
}

/**
 * The mass-import job's dependencies.
 *
 * ⚠️ `importarAnuncio` / `importarKit` are INJECTED so the job's suite never
 * loads the importer's graph and the two build waves run in parallel. There is
 * **no default**: this module never dynamic-imports the importer and never
 * top-level-imports it, so each one is REQUIRED whenever there is matching work
 * in its queue. A missing one is a programming error and THROWS a plain `Error`
 * naming it — exactly like a missing scheduler, and never contained as a
 * listing's failure row. Optional in the TYPE only because a dispatch with an
 * empty `fila` needs neither.
 */
export interface ImportacaoShopeeDeps {
  readonly db: Firestore;
  readonly resolverContexto?: (
    db: Firestore,
    integracaoId: string,
  ) => Promise<ContextoImportacaoShopee>;
  readonly importarAnuncio?: ImportarAnuncioShopeeFn;
  readonly importarKit?: ImportarKitShopeeFn;
  readonly scheduler?: AgendadorImportacaoShopee;
  /** Milliseconds. The job reads it ONCE per dispatch and hands the value down. */
  readonly now?: () => number;
}

/** What one dispatch decided. */
export type DespachoImportacaoShopee = 'done' | 'continued' | 'noop' | 'failed';
