import { toOuterRef, type OuterRef } from '@delfrance/schemas';

/**
 * Materialized breadcrumb for a categoria — same format as the ML import
 * (`apps/mercado-livre/lib/marketplace/importCategoria.ts`): names joined with
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

/** Canonical `documents/categorias/<id>` outer-ref for a categoria doc id. */
export function outerRefForCategoriaId(id: string): OuterRef {
  return toOuterRef(`categorias/${id}`);
}

const BREADCRUMB_SEP = ' > ';

/**
 * Build `nomeCompleto` for save.
 *
 * Prefer `parentBreadcrumb` from the parent picker (authoritative after a
 * selection or after the edit-page parent load). When a parent is set but the
 * handle is still null (async load race on a fast rename), recover the parent
 * prefix by stripping the last segment of the existing breadcrumb.
 */
export function deriveNomeCompletoOnSave(args: {
  nome: string;
  hasParent: boolean;
  parentBreadcrumb: string | null;
  existingNomeCompleto: string | null | undefined;
}): string {
  if (!args.hasParent) {
    return makeNomeCompleto(args.nome, null);
  }
  if (args.parentBreadcrumb != null) {
    return makeNomeCompleto(args.nome, args.parentBreadcrumb);
  }
  const existing = args.existingNomeCompleto?.trim() ?? '';
  const lastSep = existing.lastIndexOf(BREADCRUMB_SEP);
  if (lastSep >= 0) {
    return makeNomeCompleto(args.nome, existing.slice(0, lastSep));
  }
  // Parent set, no breadcrumb yet, no recoverable prefix — save as root label;
  // a subsequent parent-load + re-save (or cascade from parent) can correct it.
  return makeNomeCompleto(args.nome, null);
}
