import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { integracaoTipoSchema } from './integracao';

// Mirror `PERM.produto` from @delfrance/auth; duplicated locally to avoid a
// circular dep.
const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * TipoVariacaoEnum — int-coded variation type, mirroring
 * `packages/produtos/lib/src/models.dart`. Stored as the integer.
 */
export const tipoVariacaoSchema = z.union([
  z.literal(0), // outros
  z.literal(1), // tamanho
  z.literal(2), // cor
]);
export type TipoVariacao = z.infer<typeof tipoVariacaoSchema>;

export const TIPO_VARIACAO = {
  outros: 0,
  tamanho: 1,
  cor: 2,
} as const satisfies Record<string, TipoVariacao>;

export const TIPO_VARIACAO_LABELS: Record<TipoVariacao, string> = {
  0: 'Outros',
  1: 'Tamanho',
  2: 'Cor',
};

/**
 * ExternalVariacaoLink — embedded inside `Variante.externalVariacaoLinks`.
 * Mirrors the Flutter `ExternalVariacaoLink` model.
 */
export const externalVariacaoLinkSchema = z.object({
  tipo: integracaoTipoSchema,
  integracaoId: z.string().min(1),
  externalId: z.string().min(1),
  externalName: z.string().nullable().optional(),
  timestamp: z.string().datetime().nullable().optional(),
});
export type ExternalVariacaoLink = z.infer<typeof externalVariacaoLinkSchema>;

/**
 * Variante — single variation entry embedded inside `GrupoDeVariacoes.variacoes`.
 * Mirrors the Flutter `Variante` model.
 */
export const varianteSchema = z.object({
  id: z.string().min(1),
  nome: z.string().min(1),
  codigo: z.string().nullable().optional(),
  variantesVinculadasIds: z.array(z.string()).nullable().optional(),
  externalVariacaoLinks: z.array(externalVariacaoLinkSchema).nullable().optional(),
  timestamp: z.string().datetime().nullable().optional(),
});
export type Variante = z.infer<typeof varianteSchema>;

/**
 * GrupoDeVariacoes — collection of variation groups (Tamanho, Cor, etc).
 * Mirrors `GrupoDeVariacoes` in `packages/produtos/lib/src/models.dart`.
 * Marketplace link arrays (Shopee / Loja Integrada / Amazon) stay
 * pass-through because the Flutter app continues to author them; the
 * Next-rewrite UI only needs to read/write the core fields for now.
 */
export const grupoDeVariacoesSchema = z.object({
  nome: z.string().min(1),
  codigo: z.string().nullable().optional(),
  ordem: z.number().int().default(1),
  tipo: tipoVariacaoSchema.nullable().optional(),
  permiteFotos: z.boolean().default(false),
  ultimaModificacao: z.string().datetime().nullable().optional(),
  timestamp: z.string().datetime().nullable().optional(),
  variacoesIds: z.array(z.string()).default([]),
  variacoes: z.array(varianteSchema).nullable().optional(),

  // Marketplace integration link arrays — pass-through. Flutter still
  // authors these; surfaced as opaque arrays here.
  linksVariacoesShopee: z.array(z.unknown()).nullable().optional(),
  linksVariacoesli: z.array(z.unknown()).nullable().optional(),
  linksVariacoesAmazon: z.array(z.unknown()).nullable().optional(),
});

export type GrupoDeVariacoes = z.infer<typeof grupoDeVariacoesSchema>;

export const grupoDeVariacoesMeta: CollectionMetadata = {
  collectionPath: 'grupoDeVariacoes',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
};

export const grupoDeVariacoes = {
  schema: grupoDeVariacoesSchema,
  meta: grupoDeVariacoesMeta,
};
