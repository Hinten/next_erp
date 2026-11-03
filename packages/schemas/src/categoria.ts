import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { outerRefSchema } from './shared/outerRef';
import type { CollectionMetadata } from './types';

const PERM_CATEGORIA_READ = 1n << 11n;
const PERM_CATEGORIA_WRITE = 1n << 12n;
const PERM_CATEGORIA_DELETE = 1n << 13n;

/**
 * Categoria de produto. Mirrors `packages/produtos/lib/src/models.dart`.
 * `categoriaPaiOuterRef` is a `documents/categorias/<id>` doc-path string
 * (Flutter `OuterRefField.toJson`).
 *
 * `.describe()` labels feed the schema-driven UI primitives (TableView /
 * ObjectView) in `@delfrance/ui`.
 */
export const categoriaSchema = z.object({
  nome: z.string().min(1).max(255).describe('Nome'),
  nomeCompleto: z.string().max(2000).nullable().default(null).describe('Nome completo'),
  permiteCadastro: z.boolean().default(true).describe('Permite cadastro'),
  categoriaGoogleId: z.string().nullable().default(null).describe('Google Product Category ID'),
  categoriaPaiOuterRef: outerRefSchema.nullable().default(null).describe('Categoria pai'),
  // Milliseconds since epoch (numeric-epoch standard); reads tolerantly.
  timestamp: millisSinceEpoch().nullable().default(null),
  // System field — creation stays in `timestamp`; this is stamped by
  // `saveRecord` on every write so the TableView update-monitor sees edits.
  // `.default(null)`, never a bare `.optional()`: the TableView update-
  // monitor runs a CLASSIC `orderBy(ultimaModificacao, 'desc').limit(1)`,
  // which EXCLUDES documents missing the key — so a dropped key hides the
  // row from the staleness check, silently. Pinned by
  // `defaultQuery.sortKeyPresence.test.ts`.
  ultimaModificacao: millisSinceEpoch().nullable().default(null),
});

export type Categoria = z.infer<typeof categoriaSchema>;

export const categoriaMeta: CollectionMetadata = {
  collectionPath: 'categorias',
  permissions: {
    read: PERM_CATEGORIA_READ,
    write: PERM_CATEGORIA_WRITE,
    delete: PERM_CATEGORIA_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
    columns: ['nome', 'nomeCompleto', 'permiteCadastro'],
  },
};

export const categoria = { schema: categoriaSchema, meta: categoriaMeta };

/* -------------------------------------------------------------------------- */
/*                          The breadcrumb (`nomeCompleto`)                    */
/* -------------------------------------------------------------------------- */

/*
 * Two surfaces build a categoria's breadcrumb: the web's categoria screens and the Loja
 * Integrada product import (master plan step 9), which creates a categoria under its ERP parent.
 * `apps/web` has no dependency edge to any app, so the rule lives here once (root `CLAUDE.md`).
 */

/**
 * Materialized breadcrumb for a categoria — same format as the ML import
 * (`apps/mercado-livre/lib/marketplace/importacao/importCategoria.ts`): names joined with
 * ` > ` (spaces around `>`). Root categories are just `nome`.
 *
 * Issue #554: derived on every save; never hand-edited in the UI.
 */
export function makeNomeCompleto(
  nome: string,
  parentNomeCompleto: string | null | undefined,
): string {
  const parent = parentNomeCompleto?.trim();
  return parent ? `${parent} > ${nome}` : nome;
}

/**
 * Resolve the breadcrumb string to prefix children with, from a parent doc.
 * Prefer the parent's materialized `nomeCompleto`; fall back to `nome` when
 * legacy/import docs still have a null breadcrumb.
 */
export function parentBreadcrumbFromDoc(
  parent:
    | {
        nome?: string | null;
        nomeCompleto?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (parent == null) return null;
  const full = parent.nomeCompleto?.trim();
  if (full) return full;
  const nome = parent.nome?.trim();
  return nome || null;
}
