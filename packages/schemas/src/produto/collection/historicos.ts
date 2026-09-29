import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { outerRefSchema } from '../../shared/outerRef';

// Price/cost history is produto-scoped: it reuses the produto permission bits
// (byte 8 — see `produto.ts`). The collections are retained only so imported
// legacy rows remain readable; `serverOwned` makes every client write bit below
// inert while preserving the produto read grant.
const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * Legacy price/cost history records imported with the Flutter corpus. Nothing
 * in this repo reads or writes these subcollections as application state; new
 * edits are recorded in `historicoDeModificacoes`. The schemas stay registered
 * so imported rows retain their existing produto-scoped read grant while all
 * client writes are denied. Wire facts (generated `models.g.dart:153-171` +
 * the old firestore rules):
 *  - `listaDePrecoHistoricoOuterRef` = string `documents/listaDePrecos/<id>`
 *    (`OuterRefField.toJson()` → `pathWithDocuments`); readers must tolerate
 *    the bare form (Flutter parses via `fromPathPrependDocuments`).
 *  - `valorOriginal`/`valorFinal` are written EXPLICITLY null when absent
 *    (added price → only valorFinal; removed price → only valorOriginal).
 *  - `timestamp` is an ms-epoch int (rules: `d.timestamp is int`).
 */

/** `produtos/{id}/historicoDePrecos` doc. */
export const historicoPrecoSchema = z
  .object({
    listaDePrecoHistoricoOuterRef: outerRefSchema,
    valorOriginal: z.number().nullable().default(null),
    valorFinal: z.number().nullable().default(null),
    timestamp: z.number().int().nullable().default(null),
  })
  .passthrough();

export type HistoricoPreco = z.infer<typeof historicoPrecoSchema>;

export const historicoPrecoMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/historicoDePrecos',
  serverOwned: true,
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
};

export const historicoPreco = {
  schema: historicoPrecoSchema,
  meta: historicoPrecoMeta,
};

/**
 * `produtos/{id}/historicoDeCusto` doc ("data da compra"). The old Flutter app
 * defined the model + rules. Any rows carried by the import remain parseable
 * and readable here, but current edits are represented by
 * `historicoDeModificacoes` and no client may mutate this legacy collection.
 */
export const historicoCustoSchema = z
  .object({
    valor: z.number().min(0),
    timestamp: z.number().int().nullable().default(null),
  })
  .passthrough();

export type HistoricoCusto = z.infer<typeof historicoCustoSchema>;

export const historicoCustoMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/historicoDeCusto',
  serverOwned: true,
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
};

export const historicoCusto = {
  schema: historicoCustoSchema,
  meta: historicoCustoMeta,
};
