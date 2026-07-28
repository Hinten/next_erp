import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { microsSinceEpoch } from '../../shared/datetime';
import { freteDoPedidoSchema } from '../../shared/frete';
import { outerRefSchema } from '../../shared/outerRef';

const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * ESTADOS_PEDIDO enum, mirroring `packages/pedido/lib/src/models.dart`.
 * Stored on disk as the enum's `name` (e.g. `'pago'`, `'emAnalise'`).
 */
export const ESTADO_PEDIDO_LABELS = {
  iniciado: 'Iniciado',
  carrinho: 'Carrinho',
  carrinhoAbandonado: 'Carrinho abandonado',
  escolhendoFormaDePagamento: 'Escolhendo forma de pagamento',
  aguardandoConfirmacaoDePagamento: 'Aguardando confirmação',
  pagamentoNaoRealizado: 'Pagamento não realizado',
  emAnalise: 'Em análise',
  emProcessamento: 'Em processamento',
  pago: 'Pago',
  estornadoParcialmente: 'Estornado parcialmente',
  estornadoIntegralmente: 'Estornado integralmente',
  processandoCancelamento: 'Processando cancelamento',
  cancelado: 'Cancelado',
  fraude: 'Fraude',
  finalizado: 'Finalizado',
  error: 'Erro',
} as const;

export const estadoPedidoSchema = z
  .enum([
    'iniciado',
    'carrinho',
    'carrinhoAbandonado',
    'escolhendoFormaDePagamento',
    'aguardandoConfirmacaoDePagamento',
    'pagamentoNaoRealizado',
    'emAnalise',
    'emProcessamento',
    'pago',
    'estornadoParcialmente',
    'estornadoIntegralmente',
    'processandoCancelamento',
    'cancelado',
    'fraude',
    'finalizado',
    'error',
  ])
  .meta({ labels: ESTADO_PEDIDO_LABELS });
export type EstadoPedido = z.infer<typeof estadoPedidoSchema>;

/**
 * Named members of {@link estadoPedidoSchema} — the ONLY way to write an
 * `EstadoPedido` in code. Values are identical to the keys here (unlike
 * `ESTADO_NFE`, whose wire values are single chars), so this buys rename-safety
 * and discoverability rather than translation: a typo'd `'cancelaado'` becomes a
 * compile error instead of a value Firestore happily stores.
 *
 * Enforced by the `delfrance/prefer-schema-enum` lint rule, which fires for any
 * Zod enum that has a companion constant like this one.
 */
export const ESTADO_PEDIDO = {
  iniciado: 'iniciado',
  carrinho: 'carrinho',
  carrinhoAbandonado: 'carrinhoAbandonado',
  escolhendoFormaDePagamento: 'escolhendoFormaDePagamento',
  aguardandoConfirmacaoDePagamento: 'aguardandoConfirmacaoDePagamento',
  pagamentoNaoRealizado: 'pagamentoNaoRealizado',
  emAnalise: 'emAnalise',
  emProcessamento: 'emProcessamento',
  pago: 'pago',
  estornadoParcialmente: 'estornadoParcialmente',
  estornadoIntegralmente: 'estornadoIntegralmente',
  processandoCancelamento: 'processandoCancelamento',
  cancelado: 'cancelado',
  fraude: 'fraude',
  finalizado: 'finalizado',
  error: 'error',
} as const satisfies Record<string, EstadoPedido>;

/**
 * ItemDoPedido — embedded item structure inside `Pedido.itens`. Mirrors
 * `packages/pedido/lib/src/models.dart` ItemDoPedido. Nested complex
 * fields (`imposto`) are pass-through.
 */
export const itemDoPedidoSchema = z
  .object({
    produtoUid: z.string().nullable().default(null),
    ordem: z.number().int().default(1),
    ensureUniqueId: z.string().nullable().default(null),
    mktplaceId: z.string().nullable().default(null),
    sku: z.string().nullable().default(null),
    gtin: z.string().nullable().default(null),
    nomeDeVenda: z.string().nullable().default(null),
    precoDeVenda: z.number().min(0.01),
    descontoUnitario: z.number().min(0).nullable().default(0),
    quantidade: z.number().min(0),
    custo: z.number().nullable().default(null),
    timestamp: microsSinceEpoch().nullable().default(null),
    imposto: z.unknown().nullable().default(null),
  })
  .passthrough();

export type ItemDoPedido = z.infer<typeof itemDoPedidoSchema>;

/**
 * `pedido.estoqueAplicado` — the stock-sync applied-state snapshot, written ONLY
 * by the `sincronizarEstoquePedido` Cloud Function (apps/functions). Records
 * exactly what the sync holds per produto (post kit-expansion), so releases /
 * returns / adjustments reverse what was REALLY applied — never a recomputation
 * from the current items (the legacy drift bug the `recalcularIndisponivel.dart`
 * repair script existed for). `null` on a pedido with no stock effect applied.
 *
 * A legacy-era pedido with `dataIndisponivelEstoque`/`dataRemocaoEstoque` set but
 * NO snapshot is Flutter-owned: the sync skips it (quantities unknown) instead of
 * guessing.
 */
export const estoqueAplicadoSchema = z.object({
  /** Depósito that received the applied movements (id, not a path). */
  depositoId: z.string(),
  /** Operação that authorized them (audit — reversal uses the maps, not config). */
  operacaoId: z.string().nullable().default(null),
  /** Direction the movements were applied under. */
  ehSaida: z.boolean(),
  /** produtoId → reserved qty currently held (`quantidadeReservada`). */
  reservado: z.record(z.string(), z.number()).nullable().default(null),
  /** produtoId → qty currently removed from physical stock (saída). */
  removido: z.record(z.string(), z.number()).nullable().default(null),
  /** produtoId → qty currently added to physical stock (entrada). */
  adicionado: z.record(z.string(), z.number()).nullable().default(null),
  /** µs since epoch of the last sync that changed this snapshot. */
  atualizadoEm: microsSinceEpoch('Atualização do estoque aplicado').nullable().default(null),
});

export type EstoqueAplicado = z.infer<typeof estoqueAplicadoSchema>;

/**
 * Pedido schema — aligned with the legacy Flutter `Pedido` class
 * (`.old/packages/pedido/lib/src/models.dart:2537–3498`). Every field
 * Flutter writes is enumerated below with the same nullability +
 * default semantics. `.passthrough()` is preserved on the outer
 * object so any not-yet-ported Flutter field still flows through.
 *
 * Timestamp convention: datetime fields are **microseconds since epoch**
 * (`microsSinceEpoch()`), the project's higher-precision standard — NOT the
 * legacy Flutter `int` milliseconds. The builder reads tolerantly (ms / µs /
 * ISO / `Date` all normalize to µs), so docs written before the backfill still
 * render correctly. The legacy ms↔µs mapping is documented in
 * `tools/migrations/pedido-pagamento-micros.README.md` for the future Flutter
 * import. UI rendering/editing is driven by the `kind: 'datetime'` metadata the
 * builder carries.
 *
 * Keep this schema **plain** (no top-level `.refine`/`.superRefine`): the
 * registry + rules generator + any `.pick()` call run against it. Cross-document
 * and cross-field rules live in `../pageModel/pageModel.ts` instead (Zod 4 throws
 * on `.pick()` over a refined object — see the `zod4-pick-refine-runtime-crash`
 * note).
 */
export const pedidoSchema = z
  .object({
    // Direction flag --------------------------------------------------------
    ehSaida: z.boolean().default(true).describe('Saída'),
    hasUserInteraction: z.boolean().nullable().default(null).describe('Interação do usuário'),

    // Core state + numbering ------------------------------------------------
    estado: estadoPedidoSchema.describe('Pagamento'),
    numero: z.string().nullable().default(null).describe('Número'),

    // Outer references — `documents/<col>/<id>` doc-path strings (Flutter ODM);
    // the UI dereferences them through Firestore .get() when needed. The issuing
    // Filial is NOT a pedido field: the NFe orchestrator resolves it from the
    // pedido's integração (`integracao.filialIntegracaoPedidoOuterRef`).
    vendedorPedidoOuterRef: outerRefSchema.nullable().default(null).describe('Vendedor'),
    integracaoPedidoOuterRef: outerRefSchema.nullable().default(null).describe('Integração'),
    operacaoPedidoOuterRef: outerRefSchema.nullable().default(null).describe('Operação'),
    clientePedidoOuterRef: outerRefSchema.nullable().default(null).describe('Cliente'),
    enderecoFiscalOuterRef: outerRefSchema.nullable().default(null).describe('Endereço fiscal'),
    listaDePrecosOuterRef: outerRefSchema.nullable().default(null).describe('Lista de preços'),

    // Related orders --------------------------------------------------------
    entradasRelacionadas: z
      .array(z.string())
      .nullable()
      .default(null)
      .describe('Entradas relacionadas'),
    saidasRelacionadas: z
      .array(z.string())
      .nullable()
      .default(null)
      .describe('Saídas relacionadas'),
    chNFeReferenciadas: z
      .array(z.string())
      .nullable()
      .default(null)
      .describe('Chaves de NF-e referenciadas'),

    // Items (record keyed by produtoUid; 'NONE' / '' when no produto bound).
    itens: z.record(z.string(), z.array(itemDoPedidoSchema)).default({}).describe('Itens'),
    // Queryable produto-id projection of `itens`. No code queries it today —
    // if a screen adds `array-contains` on it, declare the
    // `pedidos(itensIds CONTAINS)` index first (Enterprise scans otherwise; #407).
    itensIds: z.array(z.string()).default([]).describe('IDs dos itens'),
    /** Returned items, nested by produto / volta. Heavy passthrough payload. */
    itensDevolvidos: z
      .record(z.string(), z.record(z.string(), z.array(itemDoPedidoSchema)))
      .nullable()
      .default(null)
      .describe('Itens devolvidos'),

    // Shipping --------------------------------------------------------------
    freteInicial: freteDoPedidoSchema.nullable().default(null).describe('Frete inicial'),

    // Stock sync (server-owned — see estoqueAplicadoSchema) ------------------
    estoqueAplicado: estoqueAplicadoSchema.nullable().default(null).describe('Estoque aplicado'),

    // Totals (Flutter caches derived totals on the doc; the orchestrator
    // recomputes via itens but the table UI prefers the cached field).
    valorCobrado: z.number().nullable().default(null).describe('Valor cobrado'),
    descontoTotal: z.number().default(0).describe('Desconto total'),
    valorCusto: z.number().nullable().default(null).describe('Valor de custo'),
    valorFreteInicial: z.number().nullable().default(null).describe('Valor do frete inicial'),
    custoFreteInicial: z.number().nullable().default(null).describe('Custo do frete inicial'),
    valorDevolucao: z.number().nullable().default(null).describe('Valor de devolução'),
    valorCustoDevolvidos: z.number().nullable().default(null).describe('Valor de custo devolvido'),
    valorDespesasIncidentes: z.number().nullable().default(null).describe('Despesas incidentes'),
    valorFretesIncidentes: z.number().nullable().default(null).describe('Fretes incidentes'),
    valorComissoes: z.number().nullable().default(null).describe('Comissões'),
    impostos: z.number().nullable().default(null).describe('Impostos'),

    // Timestamps — all stored as µs since epoch ----------------------------
    timestamp: microsSinceEpoch('Criação').nullable().default(null),
    ultimaModificacao: microsSinceEpoch('Última modificação').nullable().default(null),
    /** Deprecated in Flutter (kept for parse compatibility). */
    dataFinalExpedicao: microsSinceEpoch('Data final de expedição').nullable().default(null),
    dataIndisponivelEstoque: microsSinceEpoch('Indisponibilidade de estoque')
      .nullable()
      .default(null),
    dataRemocaoEstoque: microsSinceEpoch('Remoção de estoque').nullable().default(null),
    lastMarketplaceUpdate: microsSinceEpoch('Última atualização do marketplace')
      .nullable()
      .default(null),

    // Print metadata --------------------------------------------------------
    foiImpresso: z.boolean().default(false).describe('Impresso'),
    /** Print date (µs since epoch). The table view renders an icon if set. */
    dtImpressao: microsSinceEpoch('Data de impressão').nullable().default(null),

    // NF-e + observability --------------------------------------------------
    /** When true the orchestrator refuses to emit NF-e for this pedido. */
    bloquearEmissaoNFe: z.boolean().nullable().default(null).describe('Bloquear emissão de NF-e'),
    observacoesInternas: z.string().nullable().default(null).describe('Observações internas'),
    /** infCpl: NF-e complementary text (DANFE-only field). */
    infCpl: z.string().nullable().default(null).describe('Informações complementares'),
    /** Persisted error message from the last failed write / emission. */
    error: z.string().nullable().default(null).describe('Erro'),
  })
  .passthrough();

export type Pedido = z.infer<typeof pedidoSchema>;

export const pedidoMeta: CollectionMetadata = {
  collectionPath: 'pedidos',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
  cascade: [
    { path: 'pedidos/{pedidoId}/itens', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/pagamentos', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/historicoEstadoPedido', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/incidentes', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/frete', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/nfev4', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/orderML', onDelete: 'cascade' },
    // Freight-history / checkout / checkin subcollections. No writer emits
    // these in the new app yet, but the cascade must clean them once their
    // feature lands so a deleted pedido never leaves orphans (#372). `checkout`
    // already has a schema (`checkoutFretePedidoMeta`); `checkin` and
    // `historicoFtIni` reuse the legacy leaf names, matching the `checkout`
    // convention. `histestq` is intentionally omitted: it is a dead legacy
    // constant with no model, rules block, or writer in either app.
    { path: 'pedidos/{pedidoId}/historicoFtIni', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/checkout', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/checkin', onDelete: 'cascade' },
  ],
  defaultQuery: {
    // Direction slice: one collection serves both /pedidos (saídas) and
    // /pedidos/entradas — each list binds `ehSaida` via TableView queryParams.
    where: [{ field: 'ehSaida', param: true }],
    orderBy: [{ field: 'numero', direction: 'desc' }],
    limit: 50,
  },
  // `estoqueAplicado` is written ONLY by the sincronizarEstoquePedido Cloud
  // Function: a client forging (or clearing) the snapshot could make the
  // admin-privileged sync mint or leak stock. The legacy markers
  // (`dataIndisponivelEstoque`/`dataRemocaoEstoque`) stay client-writable on
  // purpose — the Flutter app writes them back on every full-doc save, and
  // forging them only makes the sync SKIP a pedido, never move stock.
  serverOwnedFields: ['estoqueAplicado'],
};

export const pedido = { schema: pedidoSchema, meta: pedidoMeta };
