import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { outerRefSchema } from './shared/outerRef';
import type { CollectionMetadata } from './types';

// Mirror `PERM.estoque` from @delfrance/auth; duplicated locally to avoid a
// circular dep. Same bits as `deposito` — etiqueta is an estoque-scoped
// collection (see `packages/schemas/src/deposito.ts`).
const PERM_ESTOQUE_READ = 1n << 64n;
const PERM_ESTOQUE_WRITE = 1n << 65n;
const PERM_ESTOQUE_DELETE = 1n << 66n;

/**
 * FormatoEtiqueta — output format for the label print job. Mirrors legacy
 * `FormatoEtiqueta` (`.old/packages/etiquetas/lib/src/models.dart`).
 */
export const formatoEtiquetaSchema = z.enum(['pdf', 'zpl2']);
export type FormatoEtiqueta = z.infer<typeof formatoEtiquetaSchema>;

/**
 * TamanhoEtiqueta — physical label size. Only `tam34x23x3` is wired in
 * legacy (the `EtiquetaRetrato` A4 layout exists but is never selected by the
 * UI); kept as an enum so the wire shape has room for it later.
 */
export const tamanhoEtiquetaSchema = z.enum(['tam34x23x3']);
export type TamanhoEtiqueta = z.infer<typeof tamanhoEtiquetaSchema>;

/**
 * ResolucaoEtiqueta — printer resolution, dots per mm. Mirrors legacy
 * `Resolucao` (`dpi203` → 8, `dpi300` → 12, `dpi600` → 24 dots/mm), used by
 * the ZPL generator as `convertToDots(cm) = ceil(cm * 10 * value)`. Named
 * `*Etiqueta` (not the legacy bare `Resolucao`) to avoid colliding with the
 * unrelated `Resolucao` (incidente/frete resolution) already exported from
 * this barrel.
 */
export const resolucaoEtiquetaSchema = z.enum(['dpi203', 'dpi300', 'dpi600']);
export type ResolucaoEtiqueta = z.infer<typeof resolucaoEtiquetaSchema>;

/**
 * ItemTelaEtiqueta — one (produto, quantidade) row embedded in a `TelaEtiqueta`
 * print job. `produtoEtiquetaOuterRef` is nullable — legacy allows a row to be
 * added before a produto is picked.
 */
export const itemTelaEtiquetaSchema = z.object({
  produtoEtiquetaOuterRef: outerRefSchema.nullable().default(null).describe('Produto'),
  quantidade: z.number().int().min(1).default(1).describe('Quantidade'),
});
export type ItemTelaEtiqueta = z.infer<typeof itemTelaEtiquetaSchema>;

/**
 * TelaEtiqueta — a saved label **print job** (not a physical label): a named
 * list of (produto, quantidade) rows plus three print toggles. Mirrors legacy
 * `TelaEtiqueta` (`.old/packages/etiquetas/lib/src/models.dart`). `itens` is
 * an embedded array, not a subcollection.
 *
 * `.describe()` labels feed the schema-driven UI primitives (TableView /
 * ObjectView) in `@delfrance/ui`.
 */
export const etiquetaSchema = z.object({
  nome: z.string().min(1).max(255).describe('Nome'),
  itens: z.array(itemTelaEtiquetaSchema).default([]).describe('Itens'),
  preco: z.boolean().default(false).describe('Imprimir preço'),
  localizacao: z.boolean().default(false).describe('Imprimir localização'),
  data: z.boolean().default(false).describe('Imprimir data'),
  dataCriacao: millisSinceEpoch().nullable().default(null),
  dataAtualizacao: millisSinceEpoch().nullable().default(null),
});

export type Etiqueta = z.infer<typeof etiquetaSchema>;

export const etiquetaMeta: CollectionMetadata = {
  collectionPath: 'etiquetas',
  permissions: {
    read: PERM_ESTOQUE_READ,
    write: PERM_ESTOQUE_WRITE,
    delete: PERM_ESTOQUE_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
  },
};

export const etiqueta = { schema: etiquetaSchema, meta: etiquetaMeta };
