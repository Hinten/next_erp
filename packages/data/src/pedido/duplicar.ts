import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  isFreteMarketplaceOwned,
  pedidoSchema,
} from '@delfrance/schemas';
import { CAMPOS_ESTOQUE_SYNC } from './estoquePlan';
import type { PedidoDevolucaoDataPort } from './port';
import { PedidoConflictError } from './usecases';

/**
 * Duplicar pedido (#370) — port of Flutter `CopiarPedidoAction`
 * (`.old/lib/pedido/pages/pedidoTableView.dart`): clone an existing pedido into
 * a fresh, independent create-form draft. Cliente, operação, itens and the
 * "how do we ship this" half of the frete carry through unchanged; every field
 * below is state/print/marketplace/money metadata that belongs to the ORIGIN
 * pedido, not the new one, and is stripped back to its schema default before
 * the re-parse.
 *
 * ⚠️ The strip list has to be COMPLETE, because almost nothing downstream
 * re-derives it. `pedidoResolver` (`apps/web/.../PedidoForm.tsx`) recomputes
 * exactly the six `derivePedidoTotals` caches; everything else in
 * `defaultValues` flows verbatim through `{ ...rest }` → `pedidoSchema.parse`
 * (which is `.passthrough()`) → `createPedidoWithNumero`'s
 * `tx.set({ ...values, numero })`. Whatever the seed leaves in, gets written.
 *
 * Beyond the legacy Flutter list, this strips:
 *
 *  - `chNFeReferenciadas`, `itensDevolvidos` — the #370 legacy-context audit
 *    flagged their absence from the Flutter strip list as a bug (a duplicate
 *    could carry stale NFe-key / devolução data). Deliberately not reproduced.
 *  - `entradasRelacionadas` / `saidasRelacionadas` / `CAMPOS_ESTOQUE_SYNC` /
 *    `numero` — a duplicate is a brand new, unrelated pedido; carrying the
 *    origin's relational links or its server-owned stock-application snapshot
 *    would forge state that never happened. Same reason
 *    {@link import('./devolucao').buildDevolucaoIntegralSeed} nulls its
 *    siblings. `CAMPOS_ESTOQUE_SYNC` is spread rather than hand-listed so the
 *    pedido→estoque sync's write set and this list cannot drift apart.
 *  - `valorComissoes`, `valorDespesasIncidentes`, `valorFretesIncidentes`,
 *    `impostos` — the four legacy money pass-throughs. `derivePedidoTotals`
 *    explicitly leaves them to the caller and NO caller exists, so unlike the
 *    six derived caches they are never recomputed: the origin's marketplace
 *    commission and tax total would land verbatim, and the two incidente
 *    totals would describe an `incidentes` subcollection this seed never
 *    clones — the exact situation that justifies stripping `itensDevolvidos`.
 *  - `dataFinalExpedicao` — deprecated, but still a µs stamp of the origin and
 *    the last top-level date the legacy list missed.
 *  - `bloquearEmissaoNFe` — operator intent scoped to the ORIGIN ("do not emit
 *    NF-e for THIS order"). Carried over it silently blocks the duplicate's
 *    emission, surfacing only as a 409 `NFeBlockedError` at emit time.
 *  - `foiImpresso` — pairs with `dtImpressao`: carrying `true` over without a
 *    real print date would mark a never-printed draft as printed.
 *
 * `observacoesInternas` deliberately SURVIVES, unlike in
 * `DEVOLUCAO_INTEGRAL_STRIP_KEYS`: a devolução is a *different* order, so the
 * saída's notes do not describe it, whereas a duplicate is the *same* order
 * placed again and its notes still apply. Pinned by a test so it is not
 * "fixed" into alignment later.
 */
export const DUPLICAR_PEDIDO_STRIP_KEYS = [
  'estado',
  'foiImpresso',
  'dtImpressao',
  'lastMarketplaceUpdate',
  'ultimaModificacao',
  'timestamp',
  'dataFinalExpedicao',
  'error',
  'chNFeReferenciadas',
  'itensDevolvidos',
  'entradasRelacionadas',
  'saidasRelacionadas',
  'bloquearEmissaoNFe',
  'valorComissoes',
  'valorDespesasIncidentes',
  'valorFretesIncidentes',
  'impostos',
  ...CAMPOS_ESTOQUE_SYNC,
] as const;

/**
 * The `freteInicial` sub-fields describing the origin's QUOTE, LABEL and
 * CARRIER PROGRESS rather than "how do we ship this" — stripped so schema
 * defaults refill them to `null` (`estado` has no default and is reset to
 * `iniciado` explicitly).
 *
 * ⚠️ Keep in step with the `onIntegracaoChange` reset in `FreteTab.tsx`, which
 * clears the same surface when the operator swaps the freight integração and
 * tells them the previous etiqueta and cotação were unlinked — cote e compre
 * novamente. That list is this codebase's own definition of "this block is no
 * longer a live quote", and a duplicate is at least as far from one as an
 * integração swap: none of these values describes the new pedido.
 *
 *  - `codRastreio` / `externalId` / `printLabelId` — the origin's shipment and
 *    label. `/pedidos` renders the tracking code with a copy button.
 *  - `valorCobrado` / `custoCalculado` / `custoFinal` — the origin's freight
 *    money, and NOT inert: `derivePedidoTotals` reads
 *    `custoCalculado ?? custoFinal` and `valorCobrado`, so a stale quote would
 *    silently become the duplicate's `valorCobrado` — the field backing the
 *    `/pedidos` server-side `orderBy`, its currency-range filter, and the
 *    payment-coverage rule in `pedidoPageIssues`.
 *  - `prazoDespacho` / `dataEntrega` / `dataPrevisaoEntrega` — the origin's
 *    carrier dates. `/pedidos` has a sortable "Expedição" column on
 *    `freteInicial.prazoDespacho` and the printed order sheet renders an
 *    overdue marker, so a fresh draft would enter the dispatch queue already
 *    late.
 *  - `externalOption*` — the origin's selected shipping option, its selection
 *    moment, and (for a Melhor Envio buy) the resolved `.agency` blob.
 *  - `ultimaModificacao` / `timestamp` — the block's own stamps, including the
 *    freshness watermark the ML shipment merge gates on.
 *
 * Everything NOT listed here carries through: modalidade, transportadora,
 * veículo, reboques, vagão, balsa, volumes, `valor_assegurado`, `maoPropria`,
 * `avisoRecebimento`, `ehReverso`, `prazoExtra`, endereço de entrega and
 * recebedor — the operator's shipping intent, which a duplicate keeps.
 */
export const FRETE_QUOTE_RESET_KEYS = [
  'externalId',
  'printLabelId',
  'externalOptionId',
  'externalOptionData',
  'externalOptionIntegracao',
  'externalOptionSelectionDate',
  'codRastreio',
  'valorCobrado',
  'custoCalculado',
  'custoFinal',
  'prazoDespacho',
  'dataEntrega',
  'dataPrevisaoEntrega',
  'ultimaModificacao',
  'timestamp',
] as const;

/**
 * Per-line keys the clone must not inherit. `ensureUniqueId` is the Mercado
 * Livre line identity (`sha256(orderId-mktplaceId-index)`, `orderIds.ts`) and
 * `timestamp` is the origin line's creation stamp — neither describes a line on
 * a manually created pedido.
 */
const ITEM_STRIP_KEYS = ['ensureUniqueId', 'timestamp'] as const;

/** Clone `itens`, dropping {@link ITEM_STRIP_KEYS} from every line. */
function cloneItens(itens: unknown): unknown {
  if (itens == null || typeof itens !== 'object' || Array.isArray(itens)) return itens;
  const out: Record<string, unknown> = {};
  for (const [produtoUid, lista] of Object.entries(itens as Record<string, unknown>)) {
    out[produtoUid] = Array.isArray(lista)
      ? lista.map((item) => {
          if (item == null || typeof item !== 'object') return item;
          const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
          for (const key of ITEM_STRIP_KEYS) delete copy[key];
          return copy;
        })
      : lista;
  }
  return out;
}

/**
 * Reset the origin's `freteInicial` to a fresh, unquoted block: strip
 * {@link FRETE_QUOTE_RESET_KEYS} and restart `estado`.
 *
 * When the origin's freight was MARKETPLACE-OWNED the two integração refs go
 * too. Without that the duplicate's Frete tab is a dead end: `FreteTab`
 * resolves `int_frete.tipo` from `integracaoFreteOuterRef` and, for a
 * marketplace tipo, `isFreteMarketplaceOwned` locks the modalidade, endereço,
 * recebedor, status AND the `IntegracaoFreteSelect` itself while rendering the
 * body read-only — so the operator could never point the duplicate at Melhor
 * Envio. Dropping the refs falls the tab through to `GenericFreteFields` with
 * an enabled picker, keeping the endereço / volumes / dimensões the operator
 * still wants.
 *
 * Ownership is read off `externalOptionIntegracao`, the same no-extra-read seam
 * `admin/pedidoReconcile.ts` uses. ⚠️ `FreteTab` locks on the RESOLVED
 * `int_frete.tipo` instead, so the two can disagree (its own comment flags
 * this) — but the case that matters is covered: `orderShipmentImport` always
 * writes `externalOptionIntegracao: 'mercadoLivre'` on an ML-imported pedido.
 */
function resetFreteInicial(freteInicial: unknown): unknown {
  if (freteInicial == null || typeof freteInicial !== 'object') return freteInicial;
  const frete: Record<string, unknown> = { ...(freteInicial as Record<string, unknown>) };
  const marketplaceOwned = isFreteMarketplaceOwned(
    frete.externalOptionIntegracao as string | null | undefined,
  );
  for (const key of FRETE_QUOTE_RESET_KEYS) delete frete[key];
  if (marketplaceOwned) {
    delete frete.integracaoFreteOuterRef;
    delete frete.integracaoTargetOuterRef;
  }
  frete.estado = ESTADO_FRETE.iniciado;
  return frete;
}

/**
 * Build the pre-seeded create-form values for a "Duplicar pedido" (#370): the
 * origin pedido cloned with the {@link DUPLICAR_PEDIDO_STRIP_KEYS} removed and
 * re-parsed so schema defaults refill them (`estado` has no schema default, so
 * it is reset to `'iniciado'` explicitly — the duplicate restarts the flow,
 * same as the devolução integral seed), its `freteInicial` reset by
 * {@link resetFreteInicial} and its item lines cleaned of the origin's per-line
 * ids. Pagamentos and incidentes are subcollections, never read here, so they
 * are never cloned — legacy carried them over by omission (a bug, not intended
 * UX); the new app leaves them out per the #370 audit comment.
 *
 * `vendedorPedidoOuterRef` becomes the CURRENT logged-in user, not the
 * original seller — mirrors legacy. `numero` stays null; the create flow
 * (`createPedidoWithNumero`) mints a fresh one on save, same as any other new
 * pedido — the legacy `'COPIA <numero>'` convention doesn't fit here.
 *
 * Throws `PedidoConflictError(null)` when the origin no longer exists.
 */
export async function buildDuplicarPedidoSeed(
  port: PedidoDevolucaoDataPort,
  args: { originId: string; usuarioRef: string | null },
): Promise<{ values: Record<string, unknown>; originNumero: string | null }> {
  const origin = await port.getPedido(args.originId);
  if (origin === null) throw new PedidoConflictError(null);
  const originNumero = typeof origin.numero === 'string' ? origin.numero : null;

  const clone: Record<string, unknown> = { ...origin };
  for (const key of DUPLICAR_PEDIDO_STRIP_KEYS) delete clone[key];

  const values = pedidoSchema.parse({
    ...clone,
    itens: cloneItens(clone.itens),
    freteInicial: resetFreteInicial(clone.freteInicial),
    estado: ESTADO_PEDIDO.iniciado,
    numero: null,
    vendedorPedidoOuterRef: args.usuarioRef,
  }) as Record<string, unknown>;

  return { values, originNumero };
}
