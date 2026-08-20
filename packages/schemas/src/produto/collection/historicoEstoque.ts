import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { millisSinceEpoch } from '../../shared/datetime';
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
export const TIPO_MOVIMENTO_ESTOQUE_VALUES = [
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

export const tipoMovimentoEstoqueSchema = z.enum(TIPO_MOVIMENTO_ESTOQUE_VALUES);
export type TipoMovimentoEstoque = z.infer<typeof tipoMovimentoEstoqueSchema>;

/**
 * Named members of {@link tipoMovimentoEstoqueSchema}. Each name is its own wire
 * value; the value of the constant is that these ten are easy to confuse with
 * one another — `reserva` / `ajusteReserva` / `liberacaoReserva` are three
 * different events, and picking the wrong one writes a wrong stock history.
 */
export const TIPO_MOVIMENTO_ESTOQUE = {
  reserva: 'reserva',
  ajusteReserva: 'ajusteReserva',
  liberacaoReserva: 'liberacaoReserva',
  saida: 'saida',
  devolucao: 'devolucao',
  entrada: 'entrada',
  estorno: 'estorno',
  exclusaoPedido: 'exclusaoPedido',
  manual: 'manual',
  balanco: 'balanco',
} as const satisfies Record<string, TipoMovimentoEstoque>;

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
 * ## v2 — the ledger is SUMMABLE (ADR 0014)
 *
 * `movimento` / `movimentoReservada` are the **signed delta** of the movement
 * (saída negates) on **every** row, a balanço included. That is the whole point:
 * the Mercado Livre sweep reconstructs "stock at time T" as
 * `atual − sum(movimento since T)` in ONE grouped aggregate, and a row that
 * stores an absolute value in the delta field poisons that sum silently. The
 * balanço write path therefore takes a transaction to compute `contado − atual`
 * rather than recording the counted value — see `aplicarMovimento`.
 *
 * ⚠️ **Never reintroduce a field whose meaning depends on a discriminator.**
 * v1 had exactly that (`quantidade` was a delta, or an absolute when
 * `ehBalanco`), which is why the sweep could not sum the trail and had to reach
 * for a sales pre-pass over `pedidos` instead.
 *
 * `parentId` (produto id) and `depositoOuterRef` are the aggregate's **group
 * keys** — the join keys this collection lacked, being three levels deep with no
 * denorm of its own.
 *
 * `saldo` / `saldoReservada` are the resulting counters, **best effort**: filled
 * by writers that already read inside a transaction (the pedido sync), `null` on
 * the deliberately read-free manual entrada/saída path (#387). Nothing computes
 * from them — they are for the audit UI. `*Antes` is `saldo − movimento`.
 *
 * ⚠️ **Legacy rows**: the corpus is full of v1-shape rows, so a legacy-written
 * row arrives with `movimento: null`. That is deliberate and
 * safe — every consumer treats an absent `movimento` as *unknown* and **fails
 * open** (the sweep sends rather than skips). Keeping v1's field name would
 * instead have let a Flutter balanço's absolute value be summed as if it were a
 * delta: silent corruption, which is strictly worse than a visible gap. The
 * one-time `tools/migrations` pass normalizes rows at rest in the cutover
 * window (ADR 0013), and Flutter stops writing at the same cutover (#431).
 *
 * `motivo` is free text; `timestamp` is ms since epoch. The rest of the audit
 * block is unqueryable-trail repair (v1 movements were findable only by
 * string-matching `motivo`): `tipo` **names** the business event and is a
 * display label only — nothing computes from it — while `pedidoOuterRef` /
 * `pedidoNumero` link the pedido, `usuarioOuterRef` records who moved (manual
 * only), and `eventId` traces the triggering Firestore event for dedup
 * forensics.
 */
export const historicoEstoqueSchema = z
  .object({
    // The summable core — signed deltas, always (ADR 0014) -------------------
    movimento: z.number().nullable().default(null),
    movimentoReservada: z.number().nullable().default(null),
    // Aggregate group keys ---------------------------------------------------
    parentId: z.string().nullable().default(null),
    depositoOuterRef: outerRefSchema.nullable().default(null),

    motivo: z.string().nullable().default(null),
    timestamp: millisSinceEpoch().nullable().default(null),

    // Structured audit (all nullable — absent on legacy/Flutter records) ------
    tipo: tipoMovimentoEstoqueSchema.nullable().default(null),
    pedidoOuterRef: outerRefSchema.nullable().default(null),
    pedidoNumero: z.string().nullable().default(null),
    saldo: z.number().nullable().default(null),
    saldoReservada: z.number().nullable().default(null),
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
