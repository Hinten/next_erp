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
 * integrations stay pass-through `unknown` — the Flutter app continues to
 * author those, and we surface them when their vertical lands.
 */
export const produtoSchema = z
  .object({
    nome: z.string().min(1).max(100),
    sku: z.string().max(255).nullable().default(null),
    codPai: z.string().max(255).nullable().default(null),
    paiId: z.string().nullable().default(null),
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
     * Mercado Livre has no proper support for it, which is why the ML sweep
     * alone declines to send a quantity for a virtual kit
     * (`quantidadeParaEnvio` → null). That is a per-channel limitation, **not**
     * a property of virtual kits, and it must not be generalized into one.
     */
    ehKitVirtual: z.boolean().default(false),
    publicado: z.boolean().default(false),
    ofereceFreteGratis: z.boolean().default(false),
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
    timestamp: millisSinceEpoch('Criação').nullable().default(null),
    ultimaModificacao: millisSinceEpoch('Última modificação').nullable().optional(),
  })
  .passthrough();

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
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
  },
};

export const produto = { schema: produtoSchema, meta: produtoMeta };
