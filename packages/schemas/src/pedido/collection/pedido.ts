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
  /**
   * The order has **consolidated**: the return window has passed and the money
   * is certain to be received.
   *
   * ⚠️ NOT a synonym for "delivered", and the distinction is load-bearing —
   * delivery OPENS the return window, consolidation is what closes it, so the
   * two events are separated by the whole devolução period. No channel reports
   * the later one, which is why no marketplace import advances a pedido here:
   * `pago` is the last rung an ML/marketplace path may write (see
   * `apps/mercado-livre/CLAUDE.md` — from `emProcessamento` on, `estado`
   * belongs to the business).
   *
   * It is also a stock-removal trigger in its own right (`efeitoEstoquePedido`
   * tests `estado === finalizado` in `entradaRemocao`, independently of the
   * frete), which makes it the backstop that eventually removes the goods for an
   * order whose freight state never reported.
   */
  finalizado: 'finalizado',
  error: 'error',
} as const satisfies Record<string, EstadoPedido>;

/**
 * ItemDoPedido — embedded item structure inside `Pedido.itens`. Mirrors
 * `packages/pedido/lib/src/models.dart` ItemDoPedido — all 13 legacy fields
 * (`.old` `models.dart:57–195`) are enumerated below (confirmed 100% by the
 * #462 parity audit). `imposto` stays `z.unknown()`: it round-trips a
 * point-in-time `Imposto` (produto subcollection) snapshot, not a reference,
 * and full modeling is tracked separately (the sibling "nested strictness
 * gap" issue — that issue also covers making this schema itself reject an
 * unknown key on write, see the note below).
 *
 * No `.passthrough()` — this is a plain (strip-policy) `z.object`. On READ,
 * `parseSoftRead` (`@delfrance/data`) tolerates an unmodeled key here: it
 * strips it silently rather than throwing, which is what keeps a legacy
 * corpus doc carrying a since-retired field readable (root `CLAUDE.md` rule
 * 8). ⚠️ On WRITE, `parseForWrite`/`parseMergePatch`'s strict re-check (same
 * package, `zodParse.ts`) is **top-level only** — it diffs `Object.keys` of
 * the caller's `pedidoSchema` input against the parsed output, and Zod's
 * `.strict()` does not recurse into a nested schema. A pedido write with an
 * unmodeled key on an ITEM inside `itens`/`itensDevolvidos` does not throw:
 * `itens` itself is present on both sides, so nothing looks dropped at the
 * top level, and the item-level key is silently stripped the same way a
 * lenient read strips one. This schema's own `.strict()` (exercised directly
 * in `pedido.test.ts`) is therefore not a shape any production write path
 * actually applies.
 */
export const itemDoPedidoSchema = z.object({
  produtoUid: z.string().nullable().default(null),
  ordem: z.number().int().default(1),
  ensureUniqueId: z.string().nullable().default(null),
  mktplaceId: z.string().nullable().default(null),
  sku: z.string().nullable().default(null),
  gtin: z.string().nullable().default(null),
  nomeDeVenda: z.string().nullable().default(null),
  // The STORAGE floor is 0, not 0.01: a marketplace line can legitimately
  // price at zero (100% coupon/cashback, a bonus line, or a `206 Partial
  // Content` order response whose `unit_price` the mapper fills with `?? 0`)
  // and must import rather than park the whole delivery (#794). Negative is
  // still rejected — no channel produces one. The 0.01 DATA-ENTRY floor lives
  // in the pedido form (`min={0.01}` on the item price input), not here.
  precoDeVenda: z.number().min(0, 'O preço não pode ser negativo'),
  descontoUnitario: z.number().min(0).nullable().default(0),
  quantidade: z.number().min(0),
  custo: z.number().nullable().default(null),
  timestamp: microsSinceEpoch().nullable().default(null),
  imposto: z.unknown().nullable().default(null),
});

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
 * guessing. The ONE exception is a Mercado Livre pack sibling appended to such a
 * pedido (#795): the trigger's `before` revision holds exactly the items Flutter
 * stock-moved, so the snapshot is REBUILT from that anchor rather than guessed —
 * without it the appended units sell with no movement at all (overselling). See
 * `detectarCrescimentoLegado` in `apps/functions`.
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
 * Flutter writes is enumerated below with the same nullability + default
 * semantics — the #462 parity audit confirmed all 39 persisted legacy
 * fields are modeled (five of them, `valorCusto`/`valorFreteInicial`/
 * `custoFreteInicial`/`valorDevolucao`/`valorCustoDevolvidos`, were later
 * REMOVED as pure derived caches with no reader, see `valorCobrado` below
 * and #796); `estoqueAplicado` is a new, server-owned field with no legacy
 * counterpart.
 *
 * No `.passthrough()` — this is a plain (strip-policy) `z.object`. On READ,
 * `parseSoftRead` (`@delfrance/data`) still tolerates an unmodeled key: it
 * strips it silently rather than throwing, which is what keeps a legacy
 * corpus doc carrying a since-retired field readable (root `CLAUDE.md` rule
 * 8). On WRITE, `parseForWrite`/`parseMergePatch` (same package) notice the
 * strip and re-parse with `.strict()`, so a genuinely unknown key throws a
 * `ZodError` instead of being silently persisted — see
 * `packages/data/src/zodParse.ts`.
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
export const pedidoSchema = z.object({
  // Direction flag ----------------------------------------------------------
  ehSaida: z.boolean().default(true).describe('Saída'),
  hasUserInteraction: z.boolean().nullable().default(null).describe('Interação do usuário'),

  // Core state + numbering ----------------------------------------------------
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

  // Related orders ------------------------------------------------------------
  entradasRelacionadas: z
    .array(z.string())
    .nullable()
    .default(null)
    .describe('Entradas relacionadas'),
  saidasRelacionadas: z.array(z.string()).nullable().default(null).describe('Saídas relacionadas'),
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
  /** Returned items, nested by produto / volta. Heavy nested payload. */
  itensDevolvidos: z
    .record(z.string(), z.record(z.string(), z.array(itemDoPedidoSchema)))
    .nullable()
    .default(null)
    .describe('Itens devolvidos'),

  // Shipping --------------------------------------------------------------
  freteInicial: freteDoPedidoSchema.nullable().default(null).describe('Frete inicial'),

  // Stock sync (server-owned — see estoqueAplicadoSchema) ------------------
  estoqueAplicado: estoqueAplicadoSchema.nullable().default(null).describe('Estoque aplicado'),

  // Totals. `valorCobrado` is the ONE derived money cache still persisted:
  // it backs a server-side `orderBy` + currency filter on `/pedidos`
  // (`PedidosListView.tsx`) and the two indexes serving them, so it cannot be
  // computed at read time. The other five Flutter wrote here
  // (`valorCusto`, `valorFreteInicial`, `custoFreteInicial`, `valorDevolucao`,
  // `valorCustoDevolvidos`) were REMOVED: each was a pure function of `itens`
  // or `freteInicial` on this same document, with no reader, no query and no
  // index, so a cache could only ever drift from the value it cached (#796).
  // `derivePedidoTotals` still computes all six — they are display values now.
  // ⚠️ Do not re-add one to "make a report easier": reports sum item
  // subtotals, NF-e reads `frete.valorCobrado`, the footer derives live.
  valorCobrado: z.number().nullable().default(null).describe('Valor cobrado'),
  descontoTotal: z.number().default(0).describe('Desconto total'),
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
});

export type Pedido = z.infer<typeof pedidoSchema>;

export const pedidoMeta: CollectionMetadata = {
  collectionPath: 'pedidos',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
  // ⚠️ DECLARED BUT DELIBERATELY NOT ENFORCED — there is no `onPedidoDeleted`
  // cascade trigger, and adding one is a decision that has already been made and
  // rejected (owner call, 2026-08). `nfev4` holds emitted fiscal documents:
  // sweeping them on a pedido delete destroys records the business is required
  // to retain, and no convenience is worth that. Deleting a pedido therefore
  // ORPHANS these subcollections on purpose. If you are here to "finish" the
  // cascade with `defineCascadeCaroGenerico`, don't — read
  // `apps/functions/src/cascades/caroGenericoTriggers.ts` first.
  cascade: [
    { path: 'pedidos/{pedidoId}/itens', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/pagamentos', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/historicoEstadoPedido', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/incidentes', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/frete', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/nfev4', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/orderML', onDelete: 'cascade' },
    // Freight-history / checkout / checkin subcollections, all three reusing
    // the legacy leaf names, which is where the migrated corpus sits. The new app
    // writes two of them: `checkout` (saveCheckout, schema
    // `checkoutFretePedidoMeta`) and `historicoFtIni`, whose sole writer is the
    // `onPedidoChanged` trigger (schema `historicoFreteInicialMeta`).
    // `checkin` still has no schema and no writer here — only Flutter fills it
    // — but the cascade must clean it too so a deleted pedido never leaves
    // orphans (#372). `histestq` is intentionally omitted: it is a dead legacy
    // constant with no model, rules block, or writer in either app.
    { path: 'pedidos/{pedidoId}/historicoFtIni', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/checkout', onDelete: 'cascade' },
    { path: 'pedidos/{pedidoId}/checkin', onDelete: 'cascade' },
  ],
  defaultQuery: {
    // Direction slice: one collection serves both /pedidos (saídas) and
    // /pedidos/entradas — each list binds `ehSaida` via TableView queryParams.
    where: [{ field: 'ehSaida', param: true }],
    // Most-recent-first, matching legacy, which closed EVERY pedido query with
    // `orderBy__timestamp(false)` (`.old/lib/pedido/pages/pedidoTableView.dart:237`).
    //
    // ⚠️ NOT `numero desc`, which this list used until #159. `numero` is a
    // string whose OPERAÇÃO PREFIX leads it (`VEN-000042` — see
    // `formatPedidoNumero`), so a lexicographic sort groups the list by
    // operação and only then orders by sequence *within* each prefix. Worse,
    // the Mercado Livre importer writes a bare numeric id
    // (`String(packId ?? order.id)`), and digits sort below letters — so every
    // marketplace order sat under every UI-created pedido, permanently,
    // regardless of date. (The often-repeated "'99' sorts above '100'" story is
    // NOT the defect: both apps zero-pad to a fixed width.)
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    // 100, matching legacy, which deliberately overrode this one screen to
    // `itensPerPage: 100` (`cacheExtent: 700`,
    // `.old/lib/pedido/pages/pedidoTableView.dart:2187`).
    //
    // ⚠️ This sat at 50 between #159 and #1216, and the reason is worth keeping:
    // `PedidoCells.NFCell` opens a REALTIME `onSnapshot` on that pedido's
    // `nfev4` subcollection, so the page size WAS also the concurrent-listener
    // count on first paint of the heaviest screen — 100 rows meant 100 live
    // listeners. The vendas e2e lane measured it across four runs: at 100 it
    // never produced a clean run (3 failed/2 flaky, then 1/1, then 1/1 — a
    // different /pedidos LIST spec each time, while every pedido EDITOR spec
    // passed); at 50 it was 166 passed, 0 failed, 0 flaky.
    //
    // ⚠️ Raising this is gated on FIRST-PAINT cost, not on the sustained count,
    // and the history is worth reading before touching it again.
    //
    // #1216 first made the NF listener RELEASABLE (`useLatestNfe`: subscribe at
    // mount, tear down once the IntersectionObserver reports the row off
    // screen). That cuts the SUSTAINED count but not the peak, and two attempts
    // at bounding the peak through the observer were both rejected by the
    // vendas lane, for opposite reasons:
    //
    //  1. Waiting for the observer before subscribing put intersection delivery
    //     on the critical path of the first badge — those callbacks are
    //     throttled and can lag by seconds while 100 rows render — and
    //     `pedidos-nfe-snapshot` went fail/fail/pass, pass, fail/fail/fail.
    //  2. Rationing the optimistic subscriptions (a 30-slot budget) was worse:
    //     rows past the ration never subscribe AT ALL when delivery is
    //     unreliable, so their badges never resolve. FOUR /pedidos LIST specs
    //     failed 3/3 — pedidos-anexos, pedidos-devolucao, pedidos-etiqueta-ml,
    //     pedidos-nfe-snapshot.
    //
    // ⭐ The lesson those two produced: never WITHHOLD a per-row read to bound
    // cost — BATCH it. `rowReadPrefetch` issues one chunked `getDocsByIds` for
    // the page's clientes, replacing up to N one-shot `getDoc`s from
    // `ClienteCell`, and seeds them into the cache key that cell already reads.
    // It cannot make data unreachable: a cell the batch missed, or whose batch
    // failed or never ran, falls back to its own read after
    // PREFETCH_MAX_WAIT_MS. That is a real improvement and it ships.
    //
    // ⛔ Attempts at 100 so far: observer-gated NF listener (#1283) →
    // fail/fail/pass, pass, fail/fail/fail; rationed subscriptions → four LIST
    // specs 3/3; cliente batching (#1303) → 1 failed / 3 flaky / 167, against
    // main's 171 / 0 / 0 at 50. Always the rotating /pedidos LIST spec
    // signature #159 recorded (pedidos-anexos, pedidos-devolucao,
    // pedidos-etiqueta-ml, pedidos-nfe-snapshot) while editor specs pass.
    //
    // ⚠️ The batching run is NOT valid evidence about batching, and the reason
    // is worth knowing before trusting any of these numbers: `TableView` fires
    // `onRowsChange([])` once at mount, and the gate treated that as "nothing
    // to batch" and released every cell BEFORE a row existed. So each cell
    // still issued its own `getDoc` AND the batch ran on top — the page paid
    // roughly double, which is very likely why that run was worse than the one
    // before it. Fixed in `rowReadPrefetch` (an empty row set is "not loaded
    // yet", never "nothing to do"); the measurement was never repeated.
    //
    // ⭐ So before raising this again: re-measure with the gate actually
    // gating, and MEASURE WHERE FIRST-PAINT TIME GOES rather than removing
    // another read on a hunch. Three of the four attempts targeted reads that
    // were not the bottleneck, and the fourth measured a mechanism that was
    // silently inert.
    // `limit` is the FIRST page only; "Carregar mais" grows it by the same
    // amount per click.
    limit: 50,
    // Same nine columns legacy showed (`pedidoTableView.dart:2221-2256`).
    // Every virtual column declares `dependsOn`, so the Pipelines projection
    // stays on for this heavy collection — see `CollectionDefaultQuery.columns`.
    columns: ['numero', 'estado', 'nf', 'cliente', 'expedicao', 'vlr', 'frete', 'criacao', 'imp'],
  },
  // All three estoque-sync fields are written ONLY by the
  // `sincronizarEstoquePedido` Cloud Function, and this list must stay in step
  // with `CAMPOS_ESTOQUE_SYNC` (`packages/data/src/pedido/estoquePlan.ts`),
  // which is the source of truth for "the sync owns it end to end — it is their
  // only writer, and no interactive editor in `apps/web` can author any of
  // them".
  //
  // Forging `estoqueAplicado` could make the admin-privileged sync mint or leak
  // stock. Forging either legacy marker is milder — `ehMarcadorLegado` makes the
  // sync SKIP the pedido, so the exposure is a denial of sync, not a stock
  // move — but "milder" was never the reason they were left open.
  //
  // ⚠️ That reason was: "the Flutter app writes them back on every full-doc
  // save". It is VOID — there is no dual run (root `CLAUDE.md` rule 8), so no
  // Flutter write ever lands on a document this app writes, and the two files
  // above contradicted each other for as long as it stood. Nothing subject to
  // these rules writes the markers: `PedidoForm` seeds both null (which the
  // create guard allows), `buildPedidoPatch` emits only dirty form keys and no
  // control authors them, `EstoqueSyncTab` only displays them, and `duplicar`
  // strips them. The update guard keys on `diff().affectedKeys()`, so an update
  // that leaves them untouched is unaffected.
  serverOwnedFields: ['estoqueAplicado', 'dataIndisponivelEstoque', 'dataRemocaoEstoque'],
};

export const pedido = { schema: pedidoSchema, meta: pedidoMeta };
