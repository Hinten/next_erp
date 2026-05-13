import { z } from 'zod';
import type { CollectionMetadata } from './types';

const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * Produto schema. Parity with `packages/produtos/lib/src/models.dart`
 * for the fields this app reads/writes today. Complex nested structures
 * (componentesKit, marketplace integrations, fotos, videos, anexos) are
 * pass-through `unknown` for now — the Flutter app continues to author
 * those, and we surface them later when their respective verticals land.
 */
export const produtoSchema = z.object({
  nome: z.string().min(1).max(100),
  sku: z.string().max(255).nullable().optional(),
  codPai: z.string().max(255).nullable().optional(),
  paiId: z.string().nullable().optional(),
  ordem: z.number().int().nullable().optional(),
  gtin: z.string().max(255).nullable().optional(),
  codFornecedor: z.string().max(255).nullable().optional(),

  // Categoria reference (Flutter `OuterReference<Categoria>`). Stored as a
  // path-bearing object on disk; pass-through here.
  categoriaProdutoOuterRef: z.unknown().nullable().optional(),

  // Dimensions / weights — all optional doubles.
  pesoLiquidoKg: z.number().nullable().optional(),
  pesoBrutoKg: z.number().nullable().optional(),
  alturaCm: z.number().nullable().optional(),
  larguraCm: z.number().nullable().optional(),
  profundidadeCm: z.number().nullable().optional(),

  // Kit + visibility + freight flags. Defaults match the Flutter
  // constructor defaults (false / false / true / false / false).
  ehKit: z.boolean().default(false),
  ehKitVirtual: z.boolean().default(false),
  publicado: z.boolean().default(true),
  ofereceFreteGratis: z.boolean().default(false),
  permiteVendaSemEstoque: z.boolean().default(false),
  crossdocking: z.number().int().min(0).nullable().optional(),

  // Variations.
  grupoDeVariacoesUid: z.array(z.string()).nullable().optional(),
  variacoesUid: z.array(z.string()).nullable().optional(),

  // Pass-through complex structures (kits, marketplace bindings, media).
  componentesKitKeys: z.array(z.string()).nullable().optional(),
  componentesKit: z.record(z.string(), z.unknown()).nullable().optional(),
  integracoesComProduto: z.array(z.string()).default([]),
  marketplaceIds: z.array(z.string()).nullable().optional(),
  marketplace: z.array(z.unknown()).default([]),
  statusProdutosMarketplace: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional(),
  fotos: z.array(z.unknown()).nullable().optional(),
  videos: z.array(z.unknown()).nullable().optional(),
  anexos: z.array(z.unknown()).nullable().optional(),
  fotosArquivosIds: z.array(z.string()).nullable().optional(),

  // Server-managed.
  nome_embedding: z.unknown().nullable().optional(),
}).passthrough();

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
