import { z } from 'zod';
import { pedidoSchema, type EstadoPedido } from '../collection/pedido';
import { pagamentoSchema, STATUS_PAGAMENTO } from '../collection/pagamento';
import { incidenteSchema } from '../collection/incidente';
import { historicoEstadoPedidoSchema } from '../collection/historicoEstadoPedido';
import { round2 } from '../pureLogic/totals';

/**
 * # Pedido page model
 *
 * The **aggregate** Zod model for the whole Pedido editor — the pedido document
 * plus the related documents the screen edits as one unit (the `pagamentos`,
 * `incidentes` and `historicoEstadoPedido` subcollections; `itens`,
 * `itensDevolvidos` and `freteInicial` already live on the pedido doc). It
 * exists so the screen's cross-document validation lives in ONE place
 * (`pedidoPageIssues`) instead of being scattered across the form resolver and
 * per-tab managers, and so a future agent (MCP) can validate/save a pedido
 * without the React front-end. Mirrors `produto/pageModel/pageModel.ts`.
 *
 * It is **not** the collection schema: the registry, rules generator and the
 * `pedidoResolver` keep validating the pedido document with the plain
 * `pedidoSchema`. The page assembles this aggregate from the form values + the
 * subcollection managers and runs `pedidoPageIssues` so cross-document errors
 * surface in the per-tab error UI.
 */
export const pedidoPageBaseSchema = pedidoSchema
  .extend({
    // Transient validation context — never written to the pedido doc.
    /** The pedido doc id (null on create). */
    id: z.string().nullable().default(null),
    /** `ehSaida` as loaded — the direction flag cannot flip on an existing order. */
    ehSaidaOriginal: z.boolean().nullable().default(null),

    // Related documents the page edits alongside the pedido doc.
    pagamentos: z.array(pagamentoSchema).nullable().default(null),
    incidentes: z.array(incidenteSchema).nullable().default(null),
    historicoEstado: z.array(historicoEstadoPedidoSchema).nullable().default(null),
  })
  .passthrough();

/** Loose view of the aggregate the cross-document rules read. */
export interface PedidoPageValidationInput {
  id?: string | null;
  ehSaida?: boolean | null;
  ehSaidaOriginal?: boolean | null;
  estado?: EstadoPedido | null;
  integracaoPedidoOuterRef?: unknown;
  itens?: Record<string, ReadonlyArray<{ quantidade?: number | null }>> | null;
  valorCobrado?: number | null;
  pagamentos?: ReadonlyArray<{ status_pagamento?: number | null; valor?: number | null }> | null;
}

/** One cross-document validation problem, keyed by a dotted field path. */
export interface PedidoPageIssue {
  path: string;
  message: string;
}

/**
 * The single source of the pedido screen's **cross-document / cross-field**
 * rules (the per-field shape lives in each collection schema). Returns the
 * problems as `{ path, message }` so both the resolver and the refined schema
 * below share exactly one rule set. Replaces the old Flutter provider's
 * scattered validations + the form resolver's inline extra-errors.
 */
export function pedidoPageIssues(data: PedidoPageValidationInput): PedidoPageIssue[] {
  const issues: PedidoPageIssue[] = [];

  // A pedido must have at least one item (legacy
  // `cadastroPedidoProvider.dart:959`).
  const itemCount = Object.values(data.itens ?? {}).reduce((n, list) => n + (list?.length ?? 0), 0);
  if (itemCount === 0) {
    issues.push({ path: 'itens', message: 'Adicione ao menos um item.' });
  }

  // The integração is required (legacy `cadastroPedidoProvider.dart:721`).
  if (data.integracaoPedidoOuterRef == null) {
    issues.push({ path: 'integracaoPedidoOuterRef', message: 'Selecione a integração.' });
  }

  // `ehSaida` is immutable on an existing order (legacy
  // `cadastroPedidoProvider.dart:728`).
  if (
    data.id &&
    data.ehSaidaOriginal != null &&
    data.ehSaida != null &&
    data.ehSaida !== data.ehSaidaOriginal
  ) {
    issues.push({
      path: 'ehSaida',
      message: 'Um pedido não pode mudar de Saída para Entrada (ou vice-versa).',
    });
  }

  // Devolução qty is NOT cross-checked against this pedido's `itens`: returns are
  // recorded against OTHER origin orders (or avulso items), so a returned produto
  // need not appear in this order. The per-row cap (origin sold qty) is enforced
  // in the Devolução tab UI. (See issue #235 for the return-order side effects.)

  // When the aggregate carries the payments AND the order is marked paid, the
  // approved payments must cover the charged total (legacy
  // `cadastroPedidoProvider.dart:1169`). Only enforced when `pagamentos` is
  // supplied (an MCP agent / integrated save) — the per-tab web flows save the
  // pedido doc and the payments separately, so this stays out of their way.
  if (data.pagamentos != null && data.estado === 'pago') {
    const aprovado = data.pagamentos
      .filter((p) => p.status_pagamento === STATUS_PAGAMENTO.aprovado)
      .reduce((sum, p) => sum + (p.valor ?? 0), 0);
    if (round2(aprovado) < round2(data.valorCobrado ?? 0)) {
      issues.push({
        path: 'pagamentos',
        message: 'O valor pago aprovado é menor que o total do pedido.',
      });
    }
  }

  return issues;
}

/** `superRefine` body wiring {@link pedidoPageIssues} into Zod. */
export function refinePedidoPage(data: PedidoPageValidationInput, ctx: z.RefinementCtx): void {
  for (const issue of pedidoPageIssues(data)) {
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
 * `pedidoPageBaseSchema` instead.
 */
export const pedidoPageSchema = pedidoPageBaseSchema.superRefine(refinePedidoPage);

export type PedidoPageBase = z.infer<typeof pedidoPageBaseSchema>;
export type PedidoPage = z.infer<typeof pedidoPageSchema>;
