import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
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

    // Dimensions / weights — all optional doubles.
    pesoLiquidoKg: z.number().nullable().default(null),
    pesoBrutoKg: z.number().nullable().default(null),
    alturaCm: z.number().nullable().default(null),
    larguraCm: z.number().nullable().default(null),
    profundidadeCm: z.number().nullable().default(null),

    // Kit + visibility + freight flags. Defaults match the Flutter
    // constructor defaults (`models.dart:1320-1333`): all false — a new produto
    // starts as a DRAFT (`publicado=false`), published explicitly by the user.
    ehKit: z.boolean().default(false),
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
