import { z } from 'zod';
import type { CollectionMetadata } from './types';

// Stock is its own permission domain (`PERM.estoque`, byte 64 — same bits the
// `deposito` schema mirrors), distinct from the produto bits even though the
// docs live under `produtos/{id}/estoques`.
const PERM_ESTOQUE_READ = 1n << 64n;
const PERM_ESTOQUE_WRITE = 1n << 65n;
const PERM_ESTOQUE_DELETE = 1n << 66n;

/**
 * Estoque — per-warehouse stock for a produto, doc of
 * `produtos/{id}/estoques/{est-<produtoId>-<depositoId>}`. Mirrors the Flutter
 * `Estoque` model (`packages/produtos/lib/src/models.dart:4018` / generated
 * `_$EstoqueToJson`).
 *
 * Wire facts: `depositoOuterRef` is a `documents/depositos/<id>` path string
 * (`OuterRefField.toJson` → `pathWithDocuments`; readers tolerate the bare
 * `depositos/<id>` form); `quantidade` / `quantidadeReservada` are doubles;
 * `ultimaModificacao` / `dataCriacao` are ms-epoch ints (`dateTimeToJson` →
 * `millisecondsSinceEpoch`). `variacoes` is a legacy per-variation breakdown
 * the old app already plans to drop — pass-through, never authored here.
 *
 * `disponivel` (quantidade − reservada) is **derived**, never stored — use
 * `estoqueDisponivel`.
 */
export const estoqueProdutoSchema = z
  .object({
    parentId: z.string().nullable().default(null),
    depositoOuterRef: z.string().min(1),
    quantidade: z.number().default(0),
    quantidadeReservada: z.number().min(0).default(0),
    localizacao: z.string().max(50).nullable().default(null),
    variacoes: z.record(z.string(), z.unknown()).nullable().default(null),
    ultimaModificacao: z.number().int().nullable().default(null),
    dataCriacao: z.number().int().nullable().default(null),
  })
  .passthrough();

export type EstoqueProduto = z.infer<typeof estoqueProdutoSchema>;

/** Available quantity = total − reserved (Flutter `Estoque.disponivel`). */
export function estoqueDisponivel(
  e: Pick<EstoqueProduto, 'quantidade' | 'quantidadeReservada'>,
): number {
  return e.quantidade - e.quantidadeReservada;
}

/** Deterministic estoque doc id (Flutter `Estoque.makeEstoqueUid`). */
export function makeEstoqueUid(produtoId: string, depositoId: string): string {
  return `est-${produtoId}-${depositoId}`;
}

export const estoqueProdutoMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/estoques',
  permissions: {
    read: PERM_ESTOQUE_READ,
    write: PERM_ESTOQUE_WRITE,
    delete: PERM_ESTOQUE_DELETE,
  },
};

export const estoqueProduto = {
  schema: estoqueProdutoSchema,
  meta: estoqueProdutoMeta,
};
