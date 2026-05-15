import { z } from 'zod';
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
  formulasCalculoPreco: z
    .array(formulaCalculoPrecoSchema)
    .nullable()
    .optional(),
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
  formulasCalculoPreco: z
    .array(formulaCalculoPrecoSchema)
    .nullable()
    .optional(),
  formulasPorCategoria: z
    .record(z.string(), formulasPorCategoriaSchema)
    .nullable()
    .optional(),
  ultimaModificacao: z.string().datetime().nullable().optional(),
  timestamp: z.string().datetime().nullable().optional(),
});

export type ListaDePrecos = z.infer<typeof listaDePrecosSchema>;

export const listaDePrecosMeta: CollectionMetadata = {
  collectionPath: 'listaDePrecos',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
};

export const listaDePrecos = {
  schema: listaDePrecosSchema,
  meta: listaDePrecosMeta,
};
