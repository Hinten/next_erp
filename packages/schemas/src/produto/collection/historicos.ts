import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { outerRefSchema } from '../../shared/outerRef';

// Price/cost history is produto-scoped: it reuses the produto permission bits
// (byte 8 — see `produto.ts`), so reading/writing a produto's history requires
// the same read/write/delete claims as the produto itself.
const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * Price/cost history records — subcollections of a produto doc, written by
 * the Flutter `Produto.save()` (`packages/produtos/lib/src/models.dart:2078-2130`)
 * and now also by the Next produto editor (price changes via `diffPrecos`,
 * cost changes via `appendCustoHistory`). Wire facts (generated
 * `models.g.dart:153-171` + the old firestore rules):
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
 * defined the model + rules but never wrote records; the Next editor now
 * records every `custo` change (`appendCustoHistory`) using the same wire
 * shape, so the two apps coexist.
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
