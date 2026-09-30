import { z } from 'zod';
import { roundReais } from '@delfrance/core/money';
import { chaveAcessoValida, decomporChaveAcesso } from '../../chaveAcesso';
import { CHAVE_NFE_REGEX } from '../../nfe';
import { COMPETENCIA_AAAA_MM } from '../../imposto/notaCreditoDebito';
import { ESTADO_PEDIDO, pedidoSchema, type EstadoPedido } from '../collection/pedido';
import { pagamentoSchema, STATUS_PAGAMENTO } from '../collection/pagamento';
import { incidenteSchema } from '../collection/incidente';
import { historicoEstadoPedidoSchema } from '../collection/historicoEstadoPedido';
import { coberturaDoPedido, type PagamentoCoberturaRow } from '../pureLogic/cobertura';

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
  itens?: Record<
    string,
    ReadonlyArray<{
      quantidade?: number | null;
      dfeReferenciado?: { chaveAcesso?: string | null; nItem?: number | null } | null;
      ajusteRtc?: { vIBS?: number | null; vCBS?: number | null; competApur?: string | null } | null;
    }>
  > | null;
  chNFeReferenciadas?: ReadonlyArray<string | null> | null;
  chNFePagamentoAntecipado?: ReadonlyArray<string | null> | null;
  valorCobrado?: number | null;
  /** The returned items (troca) — their value counts as paid; see `coberturaDoPedido`. */
  itensDevolvidos?: unknown;
  pagamentos?: ReadonlyArray<PagamentoCoberturaRow> | null;
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

  // Every referenced NF-e access key (`chNFeReferenciadas`) must match
  // `CHAVE_NFE_REGEX` — an invalid one is accepted by the form today and only
  // fails at NF-e emission. Block the save here (the Fiscal tab also shows a
  // per-input hint). ⚠️ 44 CHARACTERS, not digits: positions 6-17 are the
  // emitente CNPJ body and may hold A-Z (NT 2026.004). The regex has been right
  // since #1619; the message below had not caught up, so an operator with a
  // valid alfa chave was told to count digits. The message names the WINDOW
  // too: A-Z is legal only at positions 7-18 (1-indexed), so "números e A-Z"
  // alone would describe a looser shape than the regex enforces.
  if (
    (data.chNFeReferenciadas ?? []).some((c) => c != null && c !== '' && !CHAVE_NFE_REGEX.test(c))
  ) {
    issues.push({
      path: 'chNFeReferenciadas',
      message:
        'Chave de acesso referenciada inválida: 44 caracteres — letras A-Z apenas nas posições 7 a 18 (CNPJ do emitente).',
    });
  }

  // The NF-e de pagamento antecipado (`chNFePagamentoAntecipado`, #331): each an
  // NF-e modelo 55 with a valid check digit (BC02), none twice, at most 99
  // (BC01). Whether the nota may carry them at all (the RTC switch) is judged at
  // emission, like every NT 2025.002 group.
  const antecipado = (data.chNFePagamentoAntecipado ?? []).filter(
    (c): c is string => c != null && c !== '',
  );
  if (antecipado.some((c) => decomporChaveAcesso(c)?.mod !== '55')) {
    issues.push({
      path: 'chNFePagamentoAntecipado',
      message:
        'NF-e de pagamento antecipado: cada chave deve ser de uma NF-e modelo 55, com dígito verificador correto.',
    });
  }
  if (new Set(antecipado).size !== antecipado.length) {
    issues.push({
      path: 'chNFePagamentoAntecipado',
      message: 'NF-e de pagamento antecipado: a mesma chave aparece mais de uma vez.',
    });
  }
  if (antecipado.length > 99) {
    issues.push({
      path: 'chNFePagamentoAntecipado',
      message: 'NF-e de pagamento antecipado: no máximo 99 chaves.',
    });
  }

  // An item-level NF-e reference (`dfeReferenciado`, #330) must be a real chave —
  // shape AND check digit — and its `nItem`, when given, the XSD's 1–990. Only
  // the SHAPE blocks the save: whether `nItem` is required, and how the
  // references combine, depends on the operação (finNFe / tipo de débito) and is
  // judged by `violacoesDoDocumento` at emission and in the Fiscal tab panel.
  const refs = Object.values(data.itens ?? {})
    .flat()
    .map((it) => it?.dfeReferenciado)
    .filter((r): r is NonNullable<typeof r> => r != null);
  if (refs.some((r) => !chaveAcessoValida(r.chaveAcesso ?? ''))) {
    issues.push({
      path: 'dfeReferenciado',
      message:
        'Referência por item: chave de acesso inválida — 44 caracteres com dígito verificador correto (letras A-Z só nas posições 7 a 18).',
    });
  }
  if (
    refs.some(
      (r) => r.nItem != null && (!Number.isInteger(r.nItem) || r.nItem < 1 || r.nItem > 990),
    )
  ) {
    issues.push({
      path: 'dfeReferenciado',
      message: 'Referência por item: o item da nota referenciada deve ser um número de 1 a 990.',
    });
  }

  // The adjustment amounts of a nota de débito (`ajusteRtc`, #330): money, so
  // finite and never negative, and `competApur` a real AAAA-MM. Whether the
  // operação's tipo needs them — and which group they ride in — is judged by
  // `violacoesDoDocumento`, like the item references above.
  const ajustes = Object.values(data.itens ?? {})
    .flat()
    .map((it) => it?.ajusteRtc)
    .filter((a): a is NonNullable<typeof a> => a != null);
  const valorInvalido = (v: number | null | undefined) =>
    typeof v !== 'number' || !Number.isFinite(v) || v < 0;
  if (ajustes.some((a) => valorInvalido(a.vIBS) || valorInvalido(a.vCBS))) {
    issues.push({
      path: 'ajusteRtc',
      message: 'Ajuste de IBS/CBS: informe valores de IBS e CBS iguais ou maiores que zero.',
    });
  }
  if (ajustes.some((a) => a.competApur != null && !COMPETENCIA_AAAA_MM.test(a.competApur))) {
    issues.push({
      path: 'ajusteRtc',
      message: 'Ajuste de IBS/CBS: a competência deve estar no formato AAAA-MM (ex.: 2026-09).',
    });
  }

  // Devolução qty is NOT cross-checked against this pedido's `itens`: returns are
  // recorded against OTHER origin orders (or avulso items), so a returned produto
  // need not appear in this order. The per-row cap (origin sold qty) is enforced
  // in the Devolução tab UI. (See issue #235 for the return-order side effects.)

  // When the aggregate carries the payments AND the order is marked paid, the
  // approved payments PLUS the value of the returned items (a troca: legacy
  // counted the devolução as paid) must cover the charged total (legacy
  // `cadastroPedidoProvider.dart:1169`). Only enforced when `pagamentos` is
  // supplied (an MCP agent / integrated save) — the per-tab web flows save the
  // pedido doc and the payments separately, so this stays out of their way.
  // Keeps legacy's aprovado-only payment filter (the estado reconcile, not this
  // save-time check, is what counts `em_disputa`).
  if (data.pagamentos != null && data.estado === ESTADO_PEDIDO.pago) {
    const aprovados = data.pagamentos.filter(
      (p) => p.status_pagamento === STATUS_PAGAMENTO.aprovado,
    );
    const { valorQuitado } = coberturaDoPedido(
      {
        valorCobrado: data.valorCobrado,
        ehSaida: data.ehSaida,
        itensDevolvidos: data.itensDevolvidos,
      },
      aprovados,
    );
    if (valorQuitado < roundReais(data.valorCobrado ?? 0)) {
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
