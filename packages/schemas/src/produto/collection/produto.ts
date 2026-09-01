import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { millisSinceEpoch } from '../../shared/datetime';
import { outerRefSchema } from '../../shared/outerRef';
import { fotoSchema } from '../../storage/foto';
import { videoSchema } from '../../storage/video';
import { componentesKitSchema } from './embedded/kit';
import { anexoSchema } from './embedded/anexo';

const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * One entry of the `produto.precos` map — Flutter `Preco` serializes as
 * `{ valor: double }` (`models.g.dart:136-138`); the map is keyed by the
 * ListaDePrecos doc id. A price is a real monetary value: `min(0.01)` rejects
 * 0/sub-cent entries at the form (clearing the input removes the entry instead
 * of storing 0).
 */
export const precoSchema = z
  .object({ valor: z.number().min(0.01, 'O preço mínimo é R$ 0,01') })
  .passthrough();

export type Preco = z.infer<typeof precoSchema>;

/**
 * Produto schema. Parity with `packages/produtos/lib/src/models.dart`
 * for the fields this app reads/writes today. `componentesKit`, `anexos`,
 * `fotos` and `videos` are typed against their own schemas; the marketplace
 * integrations (`marketplace`, `statusProdutosMarketplace`) stay loosely typed
 * `unknown` at the field level — the Flutter app continues to author those,
 * and we surface them when their vertical lands.
 *
 * No `.passthrough()` — this is a plain (strip-policy) `z.object`. On READ,
 * `parseSoftRead` (`@delfrance/data`) still tolerates an unmodeled key: it
 * strips it silently rather than throwing, which is what keeps a legacy
 * corpus doc carrying a since-retired field readable (root `CLAUDE.md` rule
 * 8). On WRITE, `parseForWrite`/`parseMergePatch` (same package) notice the
 * strip and re-parse with `.strict()`, so a genuinely unknown top-level key
 * throws a `ZodError` instead of being silently persisted — see
 * `packages/data/src/zodParse.ts`.
 */
export const produtoSchema = z.object({
  nome: z.string().min(1).max(100),
  sku: z.string().max(255).nullable().default(null),
  codPai: z.string().max(255).nullable().default(null),
  paiId: z.string().nullable().default(null),
  /**
   * The doc id of this produto's SOLE variation child, when it has exactly one
   * (#1398). Null on a child, on a childless produto, and on a family with more
   * than one member.
   *
   * ⚠️ It is the pointer AND the family-of-one flag, deliberately one field:
   * a surface holding a parent asks "where is the sellable unit" and "is this a
   * family of one" as the same question, and two fields could disagree.
   *
   * ⚠️ **Why this is stored and not derived.** `variacoesUid == null` looks like
   * it identifies a sole member, and does not: `reconstructFromSkuSuffix`
   * (`pureLogic/variacoes.ts:241`) exists precisely because legacy children
   * legally carry an EMPTY `variacoesUid`, and `findDuplicateSkus` records that
   * a child SKU equal to the parent's is also legacy-legal. Any derived rule
   * therefore mislabels legacy variation children, and the mislabel is silent —
   * it would attribute the parent's stock to a real variation.
   *
   * ⚠️ It is a DENORMALISATION and can drift: a family of three still naming
   * child #1 sends every reader to the wrong produto. Every writer that changes
   * a produto's child set must recompute it with `derivarFilhoUnico` in the SAME
   * batch (`pureLogic/familia.ts`). It is deliberately not trigger-maintained —
   * root `CLAUDE.md` rejects derived-state-kept-by-trigger, and #869 worked that
   * exact trade.
   *
   * Not queried, so it needs no index; the reverse direction is `paiId`, already
   * covered by `produtos(paiId ASC, nome ASC)`.
   */
  filhoUnicoId: z.string().nullable().default(null),
  ordem: z.number().int().nullable().default(null),
  gtin: z.string().max(255).nullable().default(null),
  codFornecedor: z.string().max(255).nullable().default(null),

  // Categoria reference — the Flutter `OuterReference<Categoria>` serializes
  // to a `documents/categorias/<id>` doc-path string (read `as String?`). The
  // Categoria picker emits that exact shape.
  categoriaProdutoOuterRef: outerRefSchema.nullable().default(null),

  // Tabela de medidas (moda) reference. The Flutter `Produto.tabelaDeMedidasModaUid`
  // is a plain `documents/tabMedi/<id>` doc-path String (not an OuterReference),
  // so we keep that exact wire name to stay byte-compatible with existing docs.
  // The "Tabela de Medidas (Moda)" picker emits that shape.
  tabelaDeMedidasModaUid: outerRefSchema.nullable().default(null),

  // Dimensions / weights — all optional doubles.
  pesoLiquidoKg: z.number().nullable().default(null),
  pesoBrutoKg: z.number().nullable().default(null),
  alturaCm: z.number().nullable().default(null),
  larguraCm: z.number().nullable().default(null),
  profundidadeCm: z.number().nullable().default(null),

  // Kit + visibility + freight flags. Defaults match the Flutter
  // constructor defaults (`models.dart:1320-1333`): all false — a new produto
  // starts as a DRAFT (`publicado=false`), published explicitly by the user.
  /**
   * This produto is assembled from `componentesKit` rather than stocked on
   * its own. Its availability is DERIVED at read time from the components
   * (`kitEstoqueDisponivel`) and a sale moves the components' stock, never
   * the kit's — see ADR 0014.
   */
  ehKit: z.boolean().default(false),
  /**
   * A kit whose composition the **marketplace** resolves instead of us.
   *
   * ⚠️ Virtual does NOT mean unpublished, internal, or exempt from stock
   * signals. A virtual kit is published and sold like any other kit; the only
   * difference is the **shape of the upload**. For an ordinary kit we publish
   * one listing and send the kit's own computed availability. For a virtual
   * kit we upload the **components** and the marketplace manages the stock,
   * deriving what can be assembled on its side.
   *
   * Consequence for anything reading this flag: its estoque doc still needs
   * the same treatment as an ordinary kit's — notably the `ultimaModificacao`
   * stamp a sale writes (ADR 0014) — because the channels that DO support
   * this upload shape consume that signal.
   *
   * Mercado Livre has no usable form of it. ML's own Virtual Kits do compute
   * stock from the components, but they are User-Products-only
   * (`POST /items/kits`, `bundle.components[]` of `user_product_id`s),
   * immutable once published, and — because a component is already
   * variation-level — cannot represent a produto that has variations, so this
   * port never creates one.
   *
   * ⚠️ So on the ML wire a virtual kit is just an ordinary kit, and **both** ML
   * paths treat it as one: publish sends the component-min
   * (`quantidadeParaPublicar` — `POST /items` requires `available_quantity`, so
   * omitting it makes the produto unpublishable rather than making ML derive
   * anything), and since **#1087** the stock **sweep** does too.
   *
   * ⚠️ The sweep used to REFUSE (`quantidadeParaEnvio` → null), which read as a
   * property of virtual kits and was not one: it was legacy parity
   * (`functions.dart:286-289`) whose premise — that ML keeps the quantity
   * current from the components — never held here, because there is no ML kit.
   * The anúncio simply advertised its publish-time quantity for ever, which
   * oversells. The refusal survives only behind
   * `MERCADO_LIVRE_STOCK_KIT_VIRTUAL_SKIP_ENABLED`, an escape hatch that ships
   * OFF.
   *
   * That was a per-channel limitation, **not** a property of virtual kits, and
   * it must not be generalized into one.
   */
  ehKitVirtual: z.boolean().default(false),
  /**
   * ⚠️ **DEMONSTRATIVE ONLY — an ERP catalogue-visibility flag.** It says
   * whether the operator wants this produto shown in the ERP's own catalogue,
   * and **nothing else**. It is not a marketplace state, not a lifecycle, and
   * not a permission.
   *
   * ⛔ **A channel integration must never gate on it.** Whether a listing is
   * live, sellable or updatable is decided by the MARKETPLACE's own internal
   * publication state, which this repo already models per conta:
   *
   * - `integracoesComProduto` — the produto-side denorm of "has a live anúncio
   *   on this conta", derived from `linkHasLiveListing` (an item id, and
   *   `estado !== 'c'`) and moved in real time by the channel's status sync;
   * - the per-conta link's `estado` / `status` / `sub_status` (`ESTADO_PUBLICACAO_ML`
   *   in `mercadoLivreLink.ts`) — the marketplace's own answer;
   * - the send-time whitelist each channel applies to that status
   *   (ML stock: `podeEnviarEstoque`).
   *
   * The two questions come apart constantly, and the direction that hurts is
   * `publicado: false` + a live, SELLING anúncio: gating on this flag then drops
   * the produto SERVER-SIDE, so the sync produces no skip row and no log line —
   * unobservable, not merely silent — and the marketplace goes on advertising a
   * stale quantity, which **oversells** (#804 class 1; fixed on the ML price
   * sweep by #1072 and on the ML stock sweep by #1087).
   *
   * Hiding a produto in the ERP is not a request to stop syncing a live
   * listing; close or pause the listing on the channel for that.
   */
  publicado: z.boolean().default(false),
  ofereceFreteGratis: z.boolean().default(false),
  /**
   * ⚠️ **Slated for removal** — do not build on it.
   *
   * The legacy ML publish used it as a backorder floor: a produto at zero
   * stock went out with `available_quantity: 1` instead of 0
   * (`.old/.../models.dart:1487-1497`). That floor is deliberately NOT ported
   * (#797 E5) precisely because the field is going away; ML publish reads the
   * real availability and nothing else.
   */
  permiteVendaSemEstoque: z.boolean().default(false),
  // "Produto usado" — Flutter reads `as bool?`, but we default to false like
  // the other flags so the ObjectView switch can't be left in an unclearable
  // null; an absent Flutter value reads back as false.
  ehUsado: z.boolean().default(false),
  crossdocking: z.number().int().min(0).nullable().default(null),

  // Pricing — `precos` keyed by ListaDePrecos doc id; `custo` feeds the
  // formula recalc (kits: Flutter sums component costs — Kit tab concern).
  precos: z.record(z.string(), precoSchema).nullable().default(null),
  custo: z.number().min(0).nullable().default(null),
  // Gates the server-side propagation of this PARENT's `precos` map onto its
  // variation children (the `onProdutoPrecoCustoChanged` Cloud Function,
  // apps/functions). Default true = every parent price edit cascades to the
  // children, matching the legacy Flutter behavior. false = the user
  // maintains each variation's prices manually — a future UI toggle exposes
  // this; the field has no editor yet.
  propagatePriceToChildren: z.boolean().default(true),

  // Variations.
  grupoDeVariacoesUid: z.array(z.string()).nullable().default(null),
  variacoesUid: z.array(z.string()).nullable().default(null),

  // Pass-through complex structures (kits, marketplace bindings, media).
  componentesKitKeys: z.array(z.string()).nullable().default(null),
  componentesKit: componentesKitSchema.nullable().default(null),
  integracoesComProduto: z.array(z.string()).default([]),

  /**
   * ⛔ DEAD WEIGHT — no query consumers, deleted at the Flutter decommission
   * (#992). Do not build on these three.
   *
   * "No query consumers" precisely: nothing in this repo filters, projects or
   * orders by them, and no code reads one to make a decision about anything
   * else. They ARE read in four places — `stampChildMarketplace`,
   * `removeMarketplaceEntry`, `applyMarketplaceDeletion` and the publish
   * read-clean-write — but only to compute the next value of the same field.
   * That is maintenance, not consumption, and it all dies with the field.
   *
   * They are Firestore **Standard**-edition workarounds. `marketplace` was a
   * map so the old app could find a produto AND learn which channel an id
   * belonged to **without a join**; `marketplaceIds` was its flat index. On
   * **Enterprise** both questions have direct answers: the link
   * subcollections are collection-group-indexed by `id`/`itemId` (12 call
   * sites, e.g. `orderProdutoResolve.ts`), and the channel is simply the
   * subcollection's NAME. CLAUDE.md's "re-derive it, don't transcribe it"
   * applies literally here.
   *
   * ⚠️ **Never add a reader.** Nothing in this repo queries them — and
   * nothing can afford to: `firestore.indexes.json` declares **no index on
   * either**, so on Enterprise a query would silently full-scan `produtos`
   * and bill the data. Resolve produto-by-item-id through the link
   * subcollection instead.
   *
   * The only real consumer was ever the deployed Flutter backend, which does
   * not survive the cutover — so as of the owner decision on 2026-08-10 these
   * have no consumer in any window. The writes are kept purely so the
   * decommission can delete the whole cluster in one piece — tracked in
   * **#992**, which carries the full removal list. (#431, which used to hold
   * that job, is closed.) The `statusProdutosMarketplace` write in
   * `importMigration.applyMarketplaceDeletion` is kept on the same grounds and
   * for the same window — decided explicitly in #825, not by omission.
   *
   * ⚠️ And they are already unreliable, which is why nobody should try to
   * repair them: an entry is **never removed when a link doc is deleted** (no
   * code does that, by design); legacy's own ML order probe omits
   * `relevantData` while several writers include it, so `array-contains` —
   * which compares the whole map — misses them; and `marketplaceIds` drifts
   * from `marketplace` by construction. Details and the audit: #961.
   */
  marketplaceIds: z.array(z.string()).nullable().default(null),
  marketplace: z.array(z.unknown()).default([]),
  statusProdutosMarketplace: z.record(z.string(), z.unknown()).nullable().default(null),
  fotos: z.array(fotoSchema).nullable().default(null),
  videos: z.array(videoSchema).nullable().default(null),
  anexos: z.array(anexoSchema).nullable().default(null),
  fotosArquivosIds: z.array(z.string()).nullable().default(null),

  // Server-managed.
  nome_embedding: z.unknown().nullable().default(null),

  // System stamps — create-only `timestamp` (nullish coalesce) and
  // `ultimaModificacao` on every write; both stamped by `saveRecord` /
  // ObjectView so the TableView update-monitor sees edits.
  //
  // ⚠️ BOTH are `.nullable().default(null)`, never `.nullable().optional()`.
  // `.optional()` with no default makes Zod DROP the key, so the document is
  // written with the field ABSENT — and Firestore `orderBy` silently SKIPS
  // documents missing the ordered field. `ultimaModificacao` is this list's
  // default sort (see `defaultQuery` below), so an absent key makes a produto
  // invisible in /produtos. That is exactly how ML-imported produtos vanished
  // before #861, and how seeded clientes vanished in #381/#384. Fixed in #159
  // together with a one-time backfill for rows written before it.
  timestamp: millisSinceEpoch('Criação').nullable().default(null),
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().default(null),
});

export type Produto = z.infer<typeof produtoSchema>;

export const produtoMeta: CollectionMetadata = {
  collectionPath: 'produtos',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
  // Catalog listing shows parents only — variation children carry
  // `paiId = <parentId>` and are reached through their parent's Variações tab.
  // Both Flutter and this app always write `paiId` (explicitly null on
  // parents), so the equality filter misses nothing.
  defaultQuery: {
    where: [{ field: 'paiId', value: null }],
    // Most-recently-EDITED first (#159). Legacy browsed newest-created first
    // (`orderBy__timestamp(false)`, `.old/lib/produtos/pages/produtoTableView.dart:302`);
    // `nome asc` was only ever its semantic-search branch (`:238`), never the
    // browse order. Requires `ultimaModificacao` to be present on every doc —
    // see the stamp note on the field.
    //
    // ⚠️ The /produtos search box range-filters `nome`, and Firestore requires
    // an inequality field to be the FIRST orderBy — so that page overrides the
    // sort back to `nome asc` while the box is non-empty. Do not delete the
    // `produtos(paiId, nome)` index: the search still rides it.
    orderBy: [{ field: 'ultimaModificacao', direction: 'desc' }],
    limit: 50,
    // Legacy showed Foto · SKU · Nome · Preço · Canais de Venda
    // (`produtoTableView.dart:1568-1587`). `foto`, `preco` and `integracoes`
    // are page-owned virtual columns; `ultimaModificacao` is here because it is
    // the sort key — without it the list is ordered by a column nobody can see
    // and no sort arrow renders. "Canais de venda" was deferred by #159 for
    // needing a join; it is now the `integracoes` column, which resolves the
    // `integracoesComProduto` ids through one cached read of `integracao`.
    //
    // ⚠️ This set is FIXED on screen: /produtos passes
    // `showColumnPicker={false}`, so the ⚙ is gone and nothing else can edit
    // it. That makes the list below the whole truth about both what renders AND
    // what is projected — there is no per-user override widening the read.
    // `gtin` was dropped when the set was fixed; restoring it is a one-line
    // change here, not a user preference.
    columns: ['foto', 'nomeLink', 'sku', 'preco', 'publicado', 'integracoes', 'ultimaModificacao'],
  },
};

export const produto = { schema: produtoSchema, meta: produtoMeta };
