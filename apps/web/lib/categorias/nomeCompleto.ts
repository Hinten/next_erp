import {
  makeNomeCompleto,
  parentBreadcrumbFromDoc,
  toOuterRef,
  type OuterRef,
} from '@delfrance/schemas';

/**
 * `makeNomeCompleto` and `parentBreadcrumbFromDoc` moved to `@delfrance/schemas` (`categoria.ts`):
 * the Loja Integrada product import builds the same breadcrumb on the server, and a rule two
 * surfaces need is shared, never written twice. Re-exported here so every web caller (and this
 * folder's tests) keeps importing from one place.
 */
export { makeNomeCompleto, parentBreadcrumbFromDoc };

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
