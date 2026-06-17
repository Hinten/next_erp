import { z } from 'zod';
import { produtoSchema } from './produto';
import { produtoExtraDataSchema } from './extraData';
import { estoqueProdutoSchema } from './estoque';
import { impostoProdutoSchema } from '../impostoProduto';

/**
 * # Produto page model
 *
 * The **aggregate** Zod model for the whole Produto object view — the produto
 * document plus the related documents the screen edits as one unit (extraData
 * singleton, per-depósito estoques, imposto subcollection; `componentesKit` and
 * `anexos` already live on the produto doc). It exists so the screen's
 * cross-document validation lives in ONE place (`produtoPageIssues`) instead of
 * being scattered across per-tab managers, and so a future agent (MCP) can
 * validate/save a produto without the React front-end.
 *
 * It is **not** the `ObjectView` resolver schema: `ObjectView` keeps validating
 * the produto document with `produtoSchema` (it only writes the produto doc).
 * The page assembles this aggregate from the form values + the subcollection
 * managers and runs `produtoPageIssues` through `ObjectView`'s `validate` hook,
 * so cross-document errors surface in the existing per-tab error UI. The domain
 * use-case layer (`@delfrance/data`) consumes the refined `produtoPageSchema`.
 *
 * Page models get their own `pageModel/` folder; per-collection schemas stay at
 * the package root.
 */
export const produtoPageBaseSchema = produtoSchema
  .extend({
    // The produto doc id — transient validation context (never written to the
    // doc; it IS the doc id). Lets the cross-document rules check self/cyclic
    // kit references. Null on create (no id yet).
    id: z.string().nullable().default(null),

    // Related documents the page edits alongside the produto doc.
    extraData: produtoExtraDataSchema.nullable().default(null),
    estoques: z.array(estoqueProdutoSchema).nullable().default(null),
    impostos: z.array(impostoProdutoSchema).nullable().default(null),
  })
  .passthrough();

/** Loose view of the aggregate the cross-document rules read. */
export interface ProdutoPageValidationInput {
  id?: string | null;
  ehKit?: boolean | null;
  componentesKit?: Record<string, { quantidade: number }> | null;
  estoques?: Array<{ quantidade?: number | null; quantidadeReservada?: number | null }> | null;
}

/** One cross-document validation problem, keyed by a dotted field path. */
export interface ProdutoPageIssue {
  path: string;
  message: string;
}

/**
 * The single source of the produto screen's **cross-document / cross-field**
 * rules (the per-field shape lives in each collection schema). Returns the
 * problems as `{ path, message }` so both the `ObjectView` `validate` hook and
 * the refined schema below share exactly one rule set. Replaces the old Flutter
 * provider's scattered `validou*` flags.
 */
export function produtoPageIssues(data: ProdutoPageValidationInput): ProdutoPageIssue[] {
  const issues: ProdutoPageIssue[] = [];

  const componentes = data.componentesKit ?? {};
  const componentKeys = Object.keys(componentes);

  // A kit must have components; a non-kit's components are cleared on save
  // (handled by the save use-case), so they are not validated here.
  if (data.ehKit && componentKeys.length === 0) {
    issues.push({
      path: 'componentesKit',
      message: 'Um kit precisa de ao menos um componente.',
    });
  }

  // A produto cannot be a component of itself (would loop the kit cost).
  if (data.id && componentKeys.includes(data.id)) {
    issues.push({
      path: 'componentesKit',
      message: 'Um produto não pode ser componente de si mesmo.',
    });
  }

  // Reserved stock can never exceed the quantity on hand.
  (data.estoques ?? []).forEach((estoque, i) => {
    const { quantidade, quantidadeReservada } = estoque ?? {};
    if (
      typeof quantidade === 'number' &&
      typeof quantidadeReservada === 'number' &&
      quantidadeReservada > quantidade
    ) {
      issues.push({
        path: `estoques.${i}.quantidadeReservada`,
        message: 'A quantidade reservada não pode ser maior que a quantidade em estoque.',
      });
    }
  });

  return issues;
}

/** `superRefine` body wiring {@link produtoPageIssues} into Zod. */
export function refineProdutoPage(data: ProdutoPageValidationInput, ctx: z.RefinementCtx): void {
  for (const issue of produtoPageIssues(data)) {
    ctx.addIssue({
      code: 'custom',
      message: issue.message,
      path: issue.path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
    });
  }
}

/**
 * The full aggregate (a `ZodEffects`) — base shape + cross-document rules. The
 * domain use-case layer parses with this before persisting. Do NOT call
 * `.pick()/.omit()` on it: Zod 4 throws on refined objects at runtime
 * (see the `zod4-pick-refine-runtime-crash` note) — derive from
 * `produtoPageBaseSchema` instead.
 */
export const produtoPageSchema = produtoPageBaseSchema.superRefine(refineProdutoPage);

export type ProdutoPageBase = z.infer<typeof produtoPageBaseSchema>;
export type ProdutoPage = z.infer<typeof produtoPageSchema>;
