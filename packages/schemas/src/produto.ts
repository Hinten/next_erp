import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { fotoSchema } from './storage/foto';
import { videoSchema } from './storage/video';

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
 * for the fields this app reads/writes today. Complex nested structures
 * (componentesKit, marketplace integrations, fotos, videos, anexos) are
 * pass-through `unknown` for now — the Flutter app continues to author
 * those, and we surface them later when their respective verticals land.
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

    // Categoria reference (Flutter `OuterReference<Categoria>`). Stored as a
    // path-bearing object on disk; pass-through here.
    categoriaProdutoOuterRef: z.unknown().nullable().default(null),

    // Dimensions / weights — all optional doubles.
    pesoLiquidoKg: z.number().nullable().default(null),
    pesoBrutoKg: z.number().nullable().default(null),
    alturaCm: z.number().nullable().default(null),
    larguraCm: z.number().nullable().default(null),
    profundidadeCm: z.number().nullable().default(null),

    // Kit + visibility + freight flags. Defaults match the Flutter
    // constructor defaults (false / false / true / false / false).
    ehKit: z.boolean().default(false),
    ehKitVirtual: z.boolean().default(false),
    publicado: z.boolean().default(true),
    ofereceFreteGratis: z.boolean().default(false),
    permiteVendaSemEstoque: z.boolean().default(false),
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
    componentesKit: z.record(z.string(), z.unknown()).nullable().default(null),
    integracoesComProduto: z.array(z.string()).default([]),
    marketplaceIds: z.array(z.string()).nullable().default(null),
    marketplace: z.array(z.unknown()).default([]),
    statusProdutosMarketplace: z.record(z.string(), z.unknown()).nullable().default(null),
    fotos: z.array(fotoSchema).nullable().default(null),
    videos: z.array(videoSchema).nullable().default(null),
    anexos: z.array(z.unknown()).nullable().default(null),
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
};

export const produto = { schema: produtoSchema, meta: produtoMeta };
