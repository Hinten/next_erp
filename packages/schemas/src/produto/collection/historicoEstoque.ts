import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { outerRefSchema } from '../../shared/outerRef';

// Stock history rides the same `PERM.estoque` domain (bits 64–66) as `estoque`
// and `deposito` — duplicated locally to avoid a circular dep on @delfrance/auth.
const PERM_ESTOQUE_READ = 1n << 64n;
const PERM_ESTOQUE_WRITE = 1n << 65n;
const PERM_ESTOQUE_DELETE = 1n << 66n;

/**
 * Movement types — the business event behind a `historicoEstoque` record.
 * Pedido-driven types are written by the `sincronizarEstoquePedido` sync;
 * `manual`/`balanco` by the `aplicarEstoque` callable. Legacy (Flutter-era)
 * records carry `null` and are distinguishable only by their `motivo` text.
 */
export const TIPO_MOVIMENTO_ESTOQUE = [
  'reserva', // reservation applied (checkout/payment phase)
  'ajusteReserva', // held reservation adjusted after an item edit
  'liberacaoReserva', // reservation released without a physical movement
  'saida', // physical stock out (shipped / finalizado) — may release the reserva too
  'devolucao', // saída reverted (cancellation after removal)
  'entrada', // physical stock in (entrada pedido: purchase / return)
  'estorno', // entrada reverted
  'exclusaoPedido', // pedido deleted while holding stock — snapshot reverted
  'manual', // aplicarEstoque callable, entrada/saída
  'balanco', // aplicarEstoque callable, absolute recount
] as const;

export const tipoMovimentoEstoqueSchema = z.enum(TIPO_MOVIMENTO_ESTOQUE);
export type TipoMovimentoEstoque = z.infer<typeof tipoMovimentoEstoqueSchema>;

export const TIPO_MOVIMENTO_ESTOQUE_LABELS: Record<TipoMovimentoEstoque, string> = {
  reserva: 'Reserva',
  ajusteReserva: 'Ajuste de reserva',
  liberacaoReserva: 'Liberação de reserva',
  saida: 'Saída',
  devolucao: 'Devolução',
  entrada: 'Entrada',
  estorno: 'Estorno',
  exclusaoPedido: 'Exclusão do pedido',
  manual: 'Manual',
  balanco: 'Balanço',
};

/**
 * HistoricoEstoque — one stock-movement record under an estoque doc
 * (`produtos/{id}/estoques/{estId}/historicoEstoque/{x}`). Mirrors the Flutter
 * `HistoricoEstoque` model (`packages/produtos/lib/src/models.dart:4397`).
 *
 * It is the audit log behind the conflict-safe quantity editor: each entrada /
 * saída / balanço appends one record alongside the atomic `increment` (or the
 * balanço absolute set) on the parent estoque doc.
 *
 * Wire facts: `quantidade` / `quantidadeReservada` are the **signed delta** of
 * the movement (saída negates) — for a balanço they are the absolute counted
 * values; `ehBalanco` flags a balanço (`true`) vs a regular movement (null);
 * `motivo` is free text; `timestamp` is a ms-epoch int (`dateTimeToJson`).
 *
 * The structured audit block (all nullable — legacy docs parse unchanged) fixes
 * the legacy trail's unqueryability (movements were findable only by
 * string-matching `motivo`): `tipo` names the business event, `pedidoOuterRef` /
 * `pedidoNumero` link the pedido, `*Antes`/`*Depois` snapshot the counters
 * around the movement (exact — written inside the sync transaction; null on the
 * read-free manual path), `usuarioOuterRef` records who moved (manual only),
 * and `eventId` traces the triggering Firestore event for dedup forensics.
 */
export const historicoEstoqueSchema = z
  .object({
    ehBalanco: z.boolean().nullable().default(null),
    quantidade: z.number().default(0),
    quantidadeReservada: z.number().default(0),
    motivo: z.string().nullable().default(null),
    timestamp: z.number().int().nullable().default(null),

    // Structured audit (all nullable — absent on legacy/Flutter records) ------
    tipo: tipoMovimentoEstoqueSchema.nullable().default(null),
    pedidoOuterRef: outerRefSchema.nullable().default(null),
    pedidoNumero: z.string().nullable().default(null),
    quantidadeAntes: z.number().nullable().default(null),
    quantidadeDepois: z.number().nullable().default(null),
    quantidadeReservadaAntes: z.number().nullable().default(null),
    quantidadeReservadaDepois: z.number().nullable().default(null),
    usuarioOuterRef: outerRefSchema.nullable().default(null),
    eventId: z.string().nullable().default(null),
  })
  .passthrough();

export type HistoricoEstoque = z.infer<typeof historicoEstoqueSchema>;

export const historicoEstoqueMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/estoques/{estoqueId}/historicoEstoque',
  permissions: {
    read: PERM_ESTOQUE_READ,
    write: PERM_ESTOQUE_WRITE,
    delete: PERM_ESTOQUE_DELETE,
  },
  // The movement-history read (EstoqueMovimentacaoModal): newest-first, one
  // page. Declared here so the defaultQuery.indexes meta-test REQUIRES the
  // matching `historicoEstoque(timestamp desc)` entry in firestore.indexes.json
  // — on this Enterprise edition an undeclared index means a per-estoque scan +
  // in-memory sort on every modal open (#407).
  defaultQuery: {
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    limit: 50,
  },
};

export const historicoEstoque = {
  schema: historicoEstoqueSchema,
  meta: historicoEstoqueMeta,
};
