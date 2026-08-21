import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

// Mirror `PERM.produto` from @delfrance/auth; duplicated locally to avoid a
// circular dep.
const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * FaixaTaxaFixaPeso — faixa de peso com taxa fixa, embutida em
 * `FormulaCalculoPreco.faixasTaxaFixaPeso`. Mirrors o model Flutter.
 */
export const faixaTaxaFixaPesoSchema = z.object({
  pesoMinKg: z.number(),
  pesoMaxKg: z.number(),
  taxaFixa: z.number(),
});
export type FaixaTaxaFixaPeso = z.infer<typeof faixaTaxaFixaPesoSchema>;

/**
 * FormulaCalculoPreco — fórmula de precificação. Variáveis:
 *  C = custo (entrada), c = custoFixo, T = taxaFixa, L = margem,
 *  M = comissão marketplace, I = imposto, F = frete, K = marketing.
 * Mirrors `FormulaCalculoPreco` em `.old/packages/produtos/lib/src/models.dart`.
 */
export const formulaCalculoPrecoSchema = z.object({
  limiar: z.number(),
  formula: z.string().min(1),
  taxaFixa: z.number().default(0),
  custoFixo: z.number().default(0),
  margemDeLucro: z.number().default(0),
  comissaoMarketplace: z.number().default(0),
  imposto: z.number().default(0),
  frete: z.number().default(0),
  marketing: z.number().default(0),
  faixasTaxaFixaPeso: z.array(faixaTaxaFixaPesoSchema).nullable().optional(),
});
export type FormulaCalculoPreco = z.infer<typeof formulaCalculoPrecoSchema>;

/**
 * FormulasPorCategoria — bucket de fórmulas associadas a uma categoria.
 * Mirrors `FormulasPorCategoria`.
 */
export const formulasPorCategoriaSchema = z.object({
  name: z.string(),
  formulasCalculoPreco: z.array(formulaCalculoPrecoSchema).nullable().optional(),
});
export type FormulasPorCategoria = z.infer<typeof formulasPorCategoriaSchema>;

/**
 * ListaDePrecos — coleção de fórmulas de precificação aplicadas a um
 * canal ou segmento. Mirrors `ListaDePrecos` em
 * `.old/packages/produtos/lib/src/models.dart`.
 */
export const listaDePrecosSchema = z.object({
  nome: z.string().min(1).max(255),
  padrao: z.boolean().default(false),
  ativo: z.boolean().default(true),
  formulasCalculoPreco: z.array(formulaCalculoPrecoSchema).nullable().optional(),
  formulasPorCategoria: z.record(z.string(), formulasPorCategoriaSchema).nullable().optional(),
  ultimaModificacao: millisSinceEpoch().nullable().optional(),
  timestamp: millisSinceEpoch().nullable().optional(),
});

export type ListaDePrecos = z.infer<typeof listaDePrecosSchema>;

export const listaDePrecosMeta: CollectionMetadata = {
  collectionPath: 'listaDePrecos',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
  // Declared in #159. Before that this meta carried no `defaultQuery` at all,
  // /listas-de-precos passed `orderBy` inline, and `firestore.indexes.json` had
  // NO listaDePrecos entry — a silent full scan on Enterprise that the
  // `delfrance/default-query-needs-index` rule cannot see, because it only ever
  // fires on a `defaultQuery` property literal.
  //
  // `nome asc` matches legacy (`.old/lib/produtos/pages/listaDePrecosTableView.dart:75`)
  // and the index it requires also serves `ListaDePrecosPicker` and the
  // /produtos Preço column's default-list lookup. No `ativo == true` filter:
  // legacy's management list deliberately showed inactive rows (deactivating is
  // done from that same screen); `ativo` is a PICKER-only filter.
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
    // Richer than legacy, which showed only Nome + Data de Criação: the Padrão
    // and Ativo badges are what an operator actually scans this list for.
    columns: ['nome', 'padrao', 'ativo'],
  },
};

export const listaDePrecos = {
  schema: listaDePrecosSchema,
  meta: listaDePrecosMeta,
};
