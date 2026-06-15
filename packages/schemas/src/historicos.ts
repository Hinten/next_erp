import { z } from 'zod';

/**
 * Price/cost history records — subcollections of a produto doc, written by
 * the Flutter `Produto.save()` (`packages/produtos/lib/src/models.dart:2078-2130`)
 * and now also by the Next produto editor (price changes only — see
 * `diffPrecos`). Wire facts (generated `models.g.dart:153-171` + the old
 * firestore rules):
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
    listaDePrecoHistoricoOuterRef: z.string().min(1),
    valorOriginal: z.number().nullable().default(null),
    valorFinal: z.number().nullable().default(null),
    timestamp: z.number().int().nullable().default(null),
  })
  .passthrough();

export type HistoricoPreco = z.infer<typeof historicoPrecoSchema>;

/**
 * `produtos/{id}/historicoDeCusto` doc ("data da compra"). The old app
 * defines the model + rules but has NO write site — the Next app renders
 * these READ-ONLY and never writes them (decision 2026-06-12).
 */
export const historicoCustoSchema = z
  .object({
    valor: z.number().min(0),
    timestamp: z.number().int().nullable().default(null),
  })
  .passthrough();

export type HistoricoCusto = z.infer<typeof historicoCustoSchema>;
