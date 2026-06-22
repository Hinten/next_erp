import { z } from 'zod';
import type { CollectionMetadata } from '../../types';

// Stock history rides the same `PERM.estoque` domain (bits 64–66) as `estoque`
// and `deposito` — duplicated locally to avoid a circular dep on @delfrance/auth.
const PERM_ESTOQUE_READ = 1n << 64n;
const PERM_ESTOQUE_WRITE = 1n << 65n;
const PERM_ESTOQUE_DELETE = 1n << 66n;

/**
 * HistoricoEstoque — one stock-movement record under an estoque doc
 * (`produtos/{id}/estoques/{estId}/historicoEstoque/{x}`). Mirrors the Flutter
 * `HistoricoEstoque` model (`packages/produtos/lib/src/models.dart:4397`).
 *
 * It is the audit log behind the conflict-safe quantity editor: each entrada /
 * saída / balanço appends one record alongside the atomic `increment` (or the
 * balanço absolute set) on the parent estoque doc.
 *
 * Wire facts: `quantidade` / `quantidadeReservada` are the **signed delta** of
 * the movement (saída negates) — for a balanço they are the absolute counted
 * values; `ehBalanco` flags a balanço (`true`) vs a regular movement (null);
 * `motivo` is free text; `timestamp` is a ms-epoch int (`dateTimeToJson`).
 */
export const historicoEstoqueSchema = z
  .object({
    ehBalanco: z.boolean().nullable().default(null),
    quantidade: z.number().default(0),
    quantidadeReservada: z.number().default(0),
    motivo: z.string().nullable().default(null),
    timestamp: z.number().int().nullable().default(null),
  })
  .passthrough();

export type HistoricoEstoque = z.infer<typeof historicoEstoqueSchema>;

export const historicoEstoqueMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/estoques/{estoqueId}/historicoEstoque',
  permissions: {
    read: PERM_ESTOQUE_READ,
    write: PERM_ESTOQUE_WRITE,
    delete: PERM_ESTOQUE_DELETE,
  },
};

export const historicoEstoque = {
  schema: historicoEstoqueSchema,
  meta: historicoEstoqueMeta,
};
