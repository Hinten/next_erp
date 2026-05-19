import { z } from 'zod';
import type { CollectionMetadata } from './types';

const PERM_CATEGORIA_READ = 1n << 11n;
const PERM_CATEGORIA_WRITE = 1n << 12n;
const PERM_CATEGORIA_DELETE = 1n << 13n;

/**
 * Categoria de produto. Mirrors `packages/produtos/lib/src/models.dart`.
 * `categoriaPaiOuterRef` is the Flutter outer-reference object — kept as
 * pass-through `unknown` until we render category trees here.
 *
 * `.describe()` labels feed the schema-driven UI primitives (TableView /
 * ObjectView) in `@delfrance/ui`.
 */
export const categoriaSchema = z.object({
  nome: z.string().min(1).max(255).describe('Nome'),
  nomeCompleto: z
    .string()
    .max(2000)
    .nullable().default(null)
    .describe('Nome completo'),
  permiteCadastro: z.boolean().default(true).describe('Permite cadastro'),
  categoriaGoogleId: z
    .string()
    .nullable().default(null)
    .describe('Google Product Category ID'),
  categoriaPaiOuterRef: z.unknown().nullable().default(null),
  timestamp: z.string().datetime().nullable().default(null),
  // System field — creation stays in `timestamp`; this is stamped by
  // `saveRecord` on every write so the TableView update-monitor sees edits.
  ultimaModificacao: z.string().datetime().nullable().optional(),
});

export type Categoria = z.infer<typeof categoriaSchema>;

export const categoriaMeta: CollectionMetadata = {
  collectionPath: 'categorias',
  permissions: {
    read: PERM_CATEGORIA_READ,
    write: PERM_CATEGORIA_WRITE,
    delete: PERM_CATEGORIA_DELETE,
  },
};

export const categoria = { schema: categoriaSchema, meta: categoriaMeta };
