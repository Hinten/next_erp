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
    parentId: z.string().nullable().default(null),
    depositoOuterRef: outerRefSchema,
    quantidade: z.number().default(0),
    /**
     * ⚠️ NOT guaranteed non-negative at rest, and deliberately NOT constrained
     * here. Nothing may assume the stored value is ≥ 0: the ML sweep reads raw
     * pipeline rows, the ML import reads the doc with a bare `.data()`, and the
     * Flutter app + every Admin SDK writer bypass this schema entirely (root
     * `CLAUDE.md` rule 7).
     *
     * This carried a `.min(0)` until #931. It looked like a cheap write guard and
     * was in fact a **read** defect: `parseSoftRead` `safeParse`s the WHOLE object,
     * so one out-of-range field failed the document and returned the raw data —
     * silently discarding every `.default()` below. A stored doc with no
     * `quantidade` (ADR 0014 §2 writes exactly that shape and relies on this
     * schema to default it) then read as `undefined`, and `estoqueDisponivel`
     * returned **NaN** — which `publish.ts` would have sent to Mercado Livre.
     *
     * The three concerns are separated instead:
     *  - reject a bad WRITE → `movimentacaoInputSchema` (`@delfrance/data`), the
     *    untrusted callable input, which keeps `.min(0).finite()`;
     *  - floor for ONE CALCULATION → {@link reservaEfetiva};
     *  - make a bad row VISIBLE → `produtoPageIssues` + the #931 audit.
     *
     * See ADR 0014 §7.
     */
    quantidadeReservada: z.number().default(0),
    localizacao: z.string().max(50).nullable().default(null),
    variacoes: z.record(z.string(), z.unknown()).nullable().default(null),
    ultimaModificacao: z.number().int().nullable().default(null),
    dataCriacao: z.number().int().nullable().default(null),
  })
  .passthrough();

export type EstoqueProduto = z.infer<typeof estoqueProdutoSchema>;

/**
 * The reservation as every calculation must treat it: **never negative**.
 *
 * This is the single floor. A negative reservation that reaches arithmetic
 * *invents* stock — `8 − (−2) = 10` — which is the one failure direction that
 * makes Mercado Livre sell units the store does not have. Failing toward "less
 * available" is the only safe direction here.
 *
 * Non-finite reads as `0` too. Every caller that already pre-coerced with
 * `finiteNumber(x) ?? 0` keeps its exact behaviour; the callers that did not
 * (`publish.ts`, the web estoque tab) stop propagating a `NaN` into a published
 * send quantity.
 *
 * ⚠️ This floors the value **for one calculation** and must never be written
 * back over the stored one. A stored negative is a real data defect, and the
 * evidence of it is what the #931 audit reads — laundering it at rest would
 * destroy the only trace of the writer that produced it.
 *
 * See ADR 0014 §7.
 */
export function reservaEfetiva(quantidadeReservada: number | null | undefined): number {
  return typeof quantidadeReservada === 'number' && Number.isFinite(quantidadeReservada)
    ? Math.max(0, quantidadeReservada)
    : 0;
}

/**
 * Available quantity = total − reserved (Flutter `Estoque.disponivel`).
 *
 * The reservation goes through {@link reservaEfetiva}, so a negative one can
 * never increase availability. This helper is the single derivation of
 * `disponivel` in the repo — kits included, since `kitEstoqueDisponivel`
 * consumes its output rather than re-deriving — which is why the floor belongs
 * here and not at the consumers.
 *
 * A negative `disponivel` is still returned when the reservation legitimately
 * exceeds the quantity (2 in stock, 5 reserved ⇒ −3); that is real information
 * and callers that publish externally clamp it themselves.
 */
export function estoqueDisponivel(
  e: Pick<EstoqueProduto, 'quantidade' | 'quantidadeReservada'>,
): number {
  return e.quantidade - reservaEfetiva(e.quantidadeReservada);
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
