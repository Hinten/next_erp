import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { outerRefSchema } from '../../shared/outerRef';

// Stock is its own permission domain (`PERM.estoque`, bits 64–66 — same bits
// the `deposito` schema mirrors), distinct from the produto bits even though
// the docs live under `produtos/{id}/estoques`.
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
    /**
     * The owning produto's id, denormalized so a **collection-group** query can
     * key on it — that is its only purpose, and its only consumer is the kit
     * component join (`compEstoques` in the ML sweep's `estoquePlan.ts`, which
     * matches `parentId equalAny <a kit's componentesKitKeys>`).
     *
     * ⚠️ Anything reading a doc it already located by path must take the owner
     * from the path, never from here: a subcollection probe's projection carries
     * no `parentId`, and treating its absence as data is #932. On a KIT's own
     * estoque doc the field has no reader at all — a kit can never be a
     * component of another kit (#239) — and is written purely for uniformity
     * (ADR 0014 §2).
     */
    parentId: z.string().nullable().default(null),
    depositoOuterRef: outerRefSchema,
    quantidade: z.number().default(0),
    /**
     * ⚠️ `.min(0)` validates a WRITE through a Zod converter — it is NOT a read
     * guarantee, and nothing may assume the stored value is non-negative. The ML
     * sweep reads raw pipeline rows, the Flutter app and the Admin SDK write
     * these docs without this schema, and a negative here would *increase*
     * computed availability. `estoqueDisponivel` floors it; see ADR 0014 §7.
     */
    quantidadeReservada: z.number().min(0).default(0),
    localizacao: z.string().max(50).nullable().default(null),
    variacoes: z.record(z.string(), z.unknown()).nullable().default(null),
    ultimaModificacao: z.number().int().nullable().default(null),
    dataCriacao: z.number().int().nullable().default(null),
  })
  .passthrough();

export type EstoqueProduto = z.infer<typeof estoqueProdutoSchema>;

/**
 * Available quantity = total − reserved (Flutter `Estoque.disponivel`).
 *
 * ⚠️ The reservation is **floored at 0 before subtracting**, and that floor is
 * load-bearing rather than defensive. A negative reservation would otherwise
 * *increase* availability — `8 − (−2) = 10` — so a single bad value invents
 * stock that does not exist, and every consumer of this helper inherits the
 * invention: the ML sweep publishes a quantity Mercado Livre will happily sell,
 * the pedido form green-lights a line it cannot fulfil, and the print assembler
 * reports it. Failing toward "less available" is the only safe direction here.
 *
 * The schema declares `quantidadeReservada` as `.min(0)`, but that guards the
 * WRITE through a Zod converter — it is not a read guarantee. Three paths reach
 * this function around it: the ML sweep consumes **raw** pipeline rows that are
 * never Zod-parsed, the sweep's window-start reconstruction synthesizes
 * `reservada − ΣmovimentoReservada` (arithmetic that can land below zero on its
 * own), and the live Flutter app + Admin SDK write these docs without this
 * schema (root `CLAUDE.md` rule 7 — there is always a second writer).
 *
 * A negative `disponivel` is still returned when the reservation legitimately
 * exceeds the quantity (2 in stock, 5 reserved ⇒ −3); that is real information
 * and callers that publish externally clamp it themselves.
 */
export function estoqueDisponivel(
  e: Pick<EstoqueProduto, 'quantidade' | 'quantidadeReservada'>,
): number {
  return e.quantidade - Math.max(0, e.quantidadeReservada);
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
