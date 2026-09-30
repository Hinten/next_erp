import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore as FirebaseAdminFirestore,
  Transaction,
} from 'firebase-admin/firestore';
import {
  coberturaDoPedido,
  ehMarketplace,
  idFromRef,
  integracaoTipoSchema,
  nowMicros,
  travarInclusaoProduto,
  type EstadoPedido,
  type Pagamento,
  type PagamentoCoberturaRow,
} from '@delfrance/schemas';

import { freteComDespachoAutorizado, nextPedidoEstado } from '../pedido/usecases';
import { integracaoCollection, pagamentoCollection, pedidoCollection } from './collections';

/**
 * Thrown when the reconcile targets a pedido that no longer exists. The webhook
 * caller parks the delivery as failed (and does NOT ack it as processed) so a
 * later redelivery — after the pedido is (re)created — can settle it.
 */
export class PedidoReconcileNotFoundError extends Error {
  constructor(readonly pedidoId: string) {
    super(`Pedido ${pedidoId} não encontrado — reconcile abortado.`);
    this.name = 'PedidoReconcileNotFoundError';
  }
}

/**
 * The ONLY pagamento fields a gateway redelivery is authoritative over — the
 * inverse of the client-edit preservation set. On an UPDATE the write is
 * inverted: the stored doc is the base and just these keys are overlaid from the
 * incoming (webhook-derived) `Pagamento`, so EVERYTHING NOT LISTED HERE survives
 * an operator's edits (`nFat`, `vencimento`, `juros`, `duplicata`,
 * `descricaoPagamento`, the out-of-band `cartao` / `cheque` /
 * `metodoPagamentoOuterRef` / `dataCadastro`, …). Without the inversion a
 * redelivery would rebuild the doc from the mapper output and wipe those edits.
 * `lastProviderUpdate` is the update-if-newer key. `ultimaModificacao` remains
 * local recency and is made monotonic on every winning write. The server-stamped
 * attribution keys are NOT here — they follow the opposite rule, see
 * {@link GATEWAY_FILL_ONCE}.
 */
const GATEWAY_OWNED = [
  'valor',
  'status_pagamento',
  'ultimaModificacao',
  'lastProviderUpdate',
  'dataAprovacao',
  'dataCancelamento',
  'tarifas',
  'parcelas',
  'aVista',
  'forma_de_pagamento',
] as const;

/**
 * The server-stamped ATTRIBUTION keys (#367): which payment link a Mercado Pago
 * payment came from and the payer's first name. Filled from the FIRST delivery
 * that carries a value and never overwritten or cleared afterwards — the
 * deliberate opposite of {@link GATEWAY_OWNED}, which overlays every defined
 * incoming value.
 *
 * Why they are NOT in `GATEWAY_OWNED`: that loop would let any later delivery
 * rewrite them, and a later delivery is exactly the one most likely to be
 * poorer — a redelivery whose mapper could not read `metadata.link_id` (or a
 * card-less state of the same payment) arrives with the key absent, and a
 * mapper that ever produced a DIFFERENT value would silently re-attribute money
 * already credited to another link. The attribution answers "who paid what",
 * which the first observation fixes for good. The two keys are also
 * `serverOwnedFields` on `pagamentoMeta`, so no operator edit can have put a
 * competing value in the stored doc.
 *
 * The fill condition is `stored == null && incoming != null`, i.e. an ABSENT
 * stored key and an explicit `null` behave the same (both are "not filled yet").
 * A stale delivery (`lastProviderUpdate` not newer) returns before this runs, so
 * an attribution can only be filled by a delivery that is also fresh enough to
 * win the update-if-newer guard — the next real event fills it.
 */
const GATEWAY_FILL_ONCE = ['linkPagamentoId', 'primeiroNomePagador'] as const;

/**
 * One pagamento doc as far as the coverage sum is concerned: `valor` (0 when not
 * a number), `status_pagamento`, and `forma_de_pagamento` (`null` when not a
 * number — the 'crédito loja' subtraction reads it). Shared by both callers so
 * the two cannot map a stored row differently.
 */
function coberturaRowOf(d: DocumentSnapshot): PagamentoCoberturaRow {
  const forma: unknown = d.get('forma_de_pagamento');
  return {
    valor: typeof d.get('valor') === 'number' ? (d.get('valor') as number) : 0,
    status_pagamento: d.get('status_pagamento') as number | null | undefined,
    forma_de_pagamento: typeof forma === 'number' ? forma : null,
  };
}

/**
 * Shared tail of both admin reconciles: given the pedido's already-read
 * snapshot and the pedido's pagamento rows, computes the VALOR QUITADO — the
 * paying pagamentos PLUS the troca's devolução credit minus any paying 'crédito
 * loja' pagamento (`coberturaDoPedido`, legacy `tasks.dart:64-68`) — and the
 * money paid beyond the returned value (only that makes a pedido PARTIALLY paid;
 * the return alone never does, #367 OD4), applies {@link nextPedidoEstado} and —
 * only on a transition — writes the new `estado` and flips `freteInicial.estado`
 * to `despachoAutorizado` through {@link freteComDespachoAutorizado} (only from
 * a pre-authorization estado, or from a
 * malformed block carrying no estado at all, which the flip repairs — and never
 * on a marketplace-owned frete block, #702). Returns the new estado, or `null`
 * when no transition applies.
 *
 * ⚠️ The credit is derived from `pedidoSnap` — the caller's `tx.get` of the
 * pedido — so `itensDevolvidos` / `ehSaida` are re-read on every transaction
 * attempt like `estado` and `valorCobrado` (root `CLAUDE.md` rule 7), and it adds
 * NO read: {@link reconcilePedidoFromPagamento} has already written the pagamento
 * by the time this runs and Firestore forbids a read after a write. The rows
 * arrive already read (or, for the incoming payment, already known), each
 * carrying `forma_de_pagamento`.
 *
 * The `historicoEstadoPedido` audit row is NOT written here: the
 * `onPedidoChanged` trigger observes the pedido write below and records
 * the transition. Both callers run on the Admin SDK, so that row carries a null
 * usuário — but for DIFFERENT reasons, and only one of them is "there is no
 * operator": {@link reconcilePedidoFromPagamento} serves the Mercado Pago
 * webhook and genuinely has no end user, while {@link reconcilePedidoEstado} is
 * called from an onCall that REJECTS unauthenticated requests and therefore
 * knows exactly who the operator is. It deliberately does not carry them
 * through — see the note on that function.
 */
function applyEstadoTransition(
  tx: Transaction,
  pedidoRef: DocumentReference,
  pedidoSnap: DocumentSnapshot,
  pagamentos: ReadonlyArray<PagamentoCoberturaRow>,
): EstadoPedido | null {
  const estado = pedidoSnap.get('estado') as EstadoPedido;
  const total =
    typeof pedidoSnap.get('valorCobrado') === 'number'
      ? (pedidoSnap.get('valorCobrado') as number)
      : 0;
  const { valorQuitado, valorPagoAlemDaDevolucao } = coberturaDoPedido(
    {
      valorCobrado: total,
      ehSaida: pedidoSnap.get('ehSaida') as boolean | null | undefined,
      itensDevolvidos: pedidoSnap.get('itensDevolvidos'),
    },
    pagamentos,
  );
  const next = nextPedidoEstado(estado, total, valorQuitado, valorPagoAlemDaDevolucao);
  if (next === null) return null;

  const pedidoPatch: Record<string, unknown> = {
    estado: next.estado,
    ultimaModificacao: nowMicros(),
  };
  if (next.autorizarDespacho) {
    // The frete rule (#702) — including why it needs no extra transaction read —
    // lives with `freteComDespachoAutorizado`; `null` means "leave the block alone".
    const frete = freteComDespachoAutorizado(pedidoSnap.get('freteInicial'));
    if (frete !== null) pedidoPatch.freteInicial = frete;
  }
  tx.update(pedidoRef, pedidoPatch);

  return next.estado;
}

/**
 * Server-side (Admin SDK) reconcile of a pedido's `estado` from ONE inbound
 * payment. It replaced a client-side reconcile that used to live in
 * `../pedido/usecases` and carried a documented atomicity caveat (#308): the
 * Firebase JS SDK can't read a query inside `runTransaction`, so `valorPago`
 * was summed BEFORE the tx and two reconciles could settle on a stale estado.
 * The Admin SDK CAN query in-transaction, so this path reads the whole payment
 * set atomically with the pedido — no race. **Webhook writers (Mercado Pago)
 * are the primary caller.** See {@link reconcilePedidoEstado} for the
 * callable-facing counterpart that reconciles from the CURRENT payment set
 * instead of upserting one — that one now serves the web client.
 *
 * In one transaction it:
 *  1. reads the pedido (missing → {@link PedidoReconcileNotFoundError});
 *  2. reads ALL pagamentos of the pedido in-tx;
 *  3. **update-if-newer guard** — if the stored pagamento at `pagamentoId` is at
 *     least as fresh as the incoming one (`lastProviderUpdate` µs), returns
 *     `{ transition: null, skippedStale: true }` WITHOUT writing (drops stale /
 *     duplicate redeliveries idempotently);
 *  4. upserts the incoming pagamento at the FIXED id `pagamentoId`: on an UPDATE
 *     the merge is INVERTED — the stored doc is the base and only the
 *     {@link GATEWAY_OWNED} fields are overlaid from the incoming pagamento, so
 *     operator-edited fields (nFat, vencimento, juros, …) survive a redelivery,
 *     and the {@link GATEWAY_FILL_ONCE} attribution keys (`linkPagamentoId`,
 *     `primeiroNomePagador`) are filled only while still empty;
 *     a CREATE writes the full mapped doc and mints `dataCadastro`;
 *  5. recomputes the valor quitado from the in-tx set (with the upserted
 *     payment's incoming values) via the shared `coberturaDoPedido` rule: the
 *     paying pagamentos (`sumPagamentosPagos`) PLUS the troca's devolução credit,
 *     read off the pedido snapshot of step 1, minus paying 'crédito loja'
 *     pagamentos (legacy `tasks.dart:64-68`);
 *  6. applies {@link nextPedidoEstado} (which gates on the payment-driven
 *     estados) and, ONLY on a transition, writes the new `estado`, flips
 *     `freteInicial.estado` to `despachoAutorizado` — only from a
 *     pre-authorization estado and never on a marketplace-owned frete block
 *     (#702, {@link freteComDespachoAutorizado}) — and stamps the pedido
 *     `ultimaModificacao` (µs).
 *
 * The `historicoEstadoPedido` audit row for a transition is written by the
 * `onPedidoChanged` trigger observing the pedido write, with a null
 * usuário — this path runs on the Admin SDK and has no end user behind it.
 *
 * Returns the new estado (or `null` when the pagamento was written but no estado
 * transition applies), plus whether the delivery was skipped as stale.
 *
 * Datetime units: `lastProviderUpdate` / `ultimaModificacao` / `dataCadastro`
 * are MICROSECONDS since epoch (`nowMicros()`), the pagamento/pedido standard.
 */
export async function reconcilePedidoFromPagamento(
  db: FirebaseAdminFirestore,
  input: {
    pedidoId: string;
    pagamentoId: string;
    pagamento: Pagamento;
  },
): Promise<{ transition: EstadoPedido | null; skippedStale: boolean }> {
  const { pedidoId, pagamentoId, pagamento } = input;

  return db.runTransaction(async (tx) => {
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) throw new PedidoReconcileNotFoundError(pedidoId);

    // The atomic read the client SDK can't do (#308): the whole payment set,
    // in the same snapshot as the pedido.
    const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));
    const existing = pagamentosSnap.docs.find((d) => d.id === pagamentoId) ?? null;

    // Update-if-newer guard: a stored pagamento at least as fresh as the incoming
    // one (same or newer `lastProviderUpdate`) means this is a stale/duplicate
    // delivery — skip without writing (idempotent redelivery).
    //
    // Missing/null deliberately means "no trusted provider event has won yet":
    // accept the first delivery and seed the watermark. Never fall back to
    // `ultimaModificacao`; legacy values may come from a human edit, which would
    // recreate #361 by blocking a legitimate provider delivery indefinitely.
    if (existing) {
      const existingMod = existing.get('lastProviderUpdate');
      const incomingMod = pagamento.lastProviderUpdate;
      if (
        typeof existingMod === 'number' &&
        typeof incomingMod === 'number' &&
        existingMod >= incomingMod
      ) {
        return { transition: null, skippedStale: true };
      }
    }

    // Upsert the pagamento at its fixed (gateway-stable) id.
    let toWrite: Record<string, unknown>;
    if (existing) {
      // UPDATE — INVERTED merge: the stored doc is the base (operator edits and
      // out-of-band first-write fields survive) and only the {@link GATEWAY_OWNED}
      // fields are overlaid from the incoming (webhook-derived) pagamento.
      // The stored side goes through the soft (read) parse first: `pagamentoSchema`
      // no longer carries `.passthrough()` (#463), so a legacy corpus doc with an
      // unmodeled key would otherwise survive the spread below into the strict
      // write parse and throw. `parseSoftRead` silently strips it instead — the
      // read-tolerance root `CLAUDE.md` rule 8 requires — so only a genuinely
      // INCOMING unknown key can still throw on write.
      const existingData = pagamentoCollection.parseRead(
        existing.data() ?? {},
        pagamentoCollection.docPath({ pedidoId }, pagamentoId),
      ) as unknown as Record<string, unknown>;
      const incoming = pagamento as unknown as Record<string, unknown>;
      toWrite = { ...existingData };
      for (const key of GATEWAY_OWNED) {
        if (incoming[key] !== undefined) toWrite[key] = incoming[key];
      }
      // The attribution keys are decided from the stored side, which is the
      // in-tx `existing` snapshot above (root CLAUDE.md rule 7): a value already
      // stored wins over whatever this delivery carries.
      for (const key of GATEWAY_FILL_ONCE) {
        if (toWrite[key] == null && incoming[key] != null) toWrite[key] = incoming[key];
      }
    } else {
      // CREATE — the full mapped doc, plus the first-seen `dataCadastro` stamp
      // (the field the list sorts by; buildPagamentoOp mints it on create).
      toWrite = { ...pagamento };
      if (toWrite.dataCadastro == null) toWrite.dataCadastro = nowMicros();
    }
    const writeNow = nowMicros();
    const storedModification = existing?.get('ultimaModificacao');
    toWrite.ultimaModificacao = Math.max(
      typeof storedModification === 'number' ? storedModification : writeNow,
      typeof pagamento.ultimaModificacao === 'number' ? pagamento.ultimaModificacao : writeNow,
      writeNow,
    );
    if (typeof toWrite.lastProviderUpdate !== 'number') {
      toWrite.lastProviderUpdate = writeNow;
    }
    const pagamentoRef = pagamentoCollection.docRef(db, { pedidoId }, pagamentoId);
    tx.set(pagamentoRef, pagamentoCollection.parse(toWrite) as DocumentData);

    // The payment set the coverage is summed over: the in-tx docs, replacing the
    // upserted one with the incoming values, using the SAME status filter the
    // client path uses. `forma_de_pagamento` rides along for the 'crédito loja'
    // subtraction (`coberturaDoPedido`); the devolução credit itself comes from
    // `pedidoSnap`, so this adds no read after the `tx.set` above.
    const paymentsForSum: PagamentoCoberturaRow[] = pagamentosSnap.docs
      .filter((d) => d.id !== pagamentoId)
      .map(coberturaRowOf);
    paymentsForSum.push({
      valor: pagamento.valor,
      status_pagamento: pagamento.status_pagamento,
      forma_de_pagamento: pagamento.forma_de_pagamento,
    });

    const transition = applyEstadoTransition(tx, pedidoRef, pedidoSnap, paymentsForSum);
    return { transition, skippedStale: false };
  });
}

/**
 * Server-side (Admin SDK) reconcile of a pedido's `estado` from its CURRENT
 * pagamentos — the callable-facing counterpart to {@link
 * reconcilePedidoFromPagamento}. Where that one upserts ONE inbound (webhook)
 * payment, this one assumes every pagamento was already written by its own
 * path (client CRUD via `savePagamento`/`deletePagamento`) and just settles
 * `estado` from the current payment set — the fully-consistent replacement for
 * the client-side reconcile deleted from `../pedido/usecases` in #308, which
 * summed `valorPago` with a `getDocs` BEFORE `runTransaction` (the Firebase JS
 * SDK can't query inside a transaction), so two concurrent reconciles could
 * settle on a stale estado. This one reads the pedido AND every pagamento in
 * the SAME transaction — no race.
 *
 * Exposed via the `reconciliarPagamentoPedido` Cloud Function callable
 * (`apps/functions`), and this IS the web client's reconcile path:
 * `PagamentosSection`'s `reconcileEstado()` calls that callable, which
 * delegates here. The cutover was hard — the old client-side
 * `reconcilePedidoEstadoFromPagamentos` was deleted, there is no fallback — so
 * the callable must be DEPLOYED for the Pagamentos tab's estado transition to
 * happen at all (deploy is a manual, coordinated step; the e2e that exercises
 * this exact flow, `apps/web/e2e/pedidos-pagamento.vendas.e2e.spec.ts`, hits
 * real staging Cloud Functions).
 *
 * Takes NO `usuarioRef`: the `historicoEstadoPedido` row is written by the
 * `onPedidoChanged` trigger from the pedido write's auth context, and this
 * runs on the Admin SDK — so the transition is recorded with a null usuário even
 * though the calling operator is known to the callable. That is deliberate: an
 * automatic, payment-driven transition is system-caused, not user-caused.
 *
 * ⚠️ Be precise about what that costs. This is the ONE path where the actor
 * regressed: the Pagamentos tab named the operator before the #308 cutover and
 * still did during it. The web editor's estado change (client SDK) keeps its
 * actor and a pedido create now GAINS one; the webhook and the Mercado Livre
 * import were null before and after. Until that is revisited (issue #711), the
 * only surviving attribution for this path is the `logger.info` line in
 * `reconciliarPagamentoPedido.ts`, which ages out with log retention.
 *
 * The estado it settles is measured against the pedido's VALOR QUITADO, not the
 * bare payment sum: a troca's devolução credit counts as paid beside the
 * pagamentos (`coberturaDoPedido`, see {@link applyEstadoTransition}), so a
 * pedido paid "the difference" reaches `pago` and an even swap needs no
 * pagamento at all.
 *
 * `aposAlterarTotal` serves the OTHER caller: a pedido save that moved
 * `valorCobrado` or the devolução credit (#703, `deveReconciliarAposSalvar`).
 * It returns
 * `{ transition: null }` without writing unless, per THIS transaction's reads:
 *
 *  1. the estado still lets the editor change the total
 *     (`!travarInclusaoProduto`). A Mercado Livre pedido promoted from
 *     `carrinho` to `emProcessamento` between the operator's save and this call
 *     must stay there: ML's advance guards only move a pedido FROM
 *     `emProcessamento`, so reconciling it off that estado strands it (#703
 *     blocker 1);
 *  2. the pedido's channel is NOT a marketplace ({@link canalDecideOEstado}).
 *     Gate 1 alone leaves the other half of the same hazard open: the ML
 *     payments topic stores an `aprovado` pagamento on a pedido still in
 *     `carrinho`/`escolhendoFormaDePagamento` and advances nothing until
 *     `podeAvancarParaPago` holds (#791). An item edit in that window would
 *     jump the pedido straight to `pago` past those prerequisites — and `pago`
 *     authorizes dispatch and NF-e, and leaves the ML pre-payment ladder for
 *     good. A marketplace pedido's estado is the channel's ladder, not the
 *     payment sum (#703's verdict), so this path leaves it alone entirely.
 *
 * The pagamento path never sets the flag, so its behaviour is unchanged — it
 * still carries both exposures, and that is a separate decision.
 */
export async function reconcilePedidoEstado(
  db: FirebaseAdminFirestore,
  input: { pedidoId: string; aposAlterarTotal?: boolean },
): Promise<{ transition: EstadoPedido | null }> {
  const { pedidoId, aposAlterarTotal = false } = input;

  return db.runTransaction(async (tx) => {
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) throw new PedidoReconcileNotFoundError(pedidoId);
    // Both gates are re-derived from this transaction's reads on every attempt
    // (root CLAUDE.md rule 7): the caller's own read is what the race makes stale.
    if (aposAlterarTotal) {
      if (travarInclusaoProduto(pedidoSnap.get('estado') as EstadoPedido)) {
        return { transition: null };
      }
      if (await canalDecideOEstado(tx, db, pedidoSnap)) return { transition: null };
    }

    const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));

    const transition = applyEstadoTransition(
      tx,
      pedidoRef,
      pedidoSnap,
      pagamentosSnap.docs.map(coberturaRowOf),
    );
    return { transition };
  });
}

/**
 * Whether the pedido's sales channel owns its `estado` — i.e. it is NOT one of
 * the three known non-marketplace integração tipos (`nenhuma`, `whatsapp`,
 * `balcao`). Reads the integração inside the caller's transaction.
 *
 * The discriminator is the referenced integração's `tipo`, never the ref's
 * presence: the pedido form REQUIRES `integracaoPedidoOuterRef` on a manual
 * sale too (`apps/mercado-livre/CLAUDE.md`), and `lastMarketplaceUpdate` is
 * blind to every ML pedido the legacy importer wrote (#703's verdict comment).
 * `tipo` is the same numeric wire enum in the legacy corpus.
 *
 * Fails CLOSED — answers "the channel decides" — whenever it cannot tell: an
 * integração that no longer exists, or a `tipo` outside the enum. The cost of
 * that answer is only the pre-#703 behaviour (estado stale until the next
 * pagamento change, fixable by hand); the cost of the opposite is a stranded or
 * prematurely-`pago` marketplace order. A pedido with no integração at all was
 * never written by a marketplace importer, so it proceeds.
 *
 * Exported for the Mercado Pago payment-link route (#367, `apps/mercado-pago`),
 * which needs the SAME answer before it mints a link: {@link
 * reconcilePedidoFromPagamento} carries no such gate, so a link payment landing
 * on a marketplace pedido would settle it straight to `pago` and authorize
 * dispatch past the channel's own ladder (the #703 / #791 hazard). The route
 * MUST call this with the `tx` and `pedidoSnap` of ITS OWN transaction — the
 * answer is a decision, and a value read before the transaction is exactly what
 * rule 7 says a race makes stale.
 */
export async function canalDecideOEstado(
  tx: Transaction,
  db: FirebaseAdminFirestore,
  pedidoSnap: DocumentSnapshot,
): Promise<boolean> {
  const ref: unknown = pedidoSnap.get('integracaoPedidoOuterRef');
  const integracaoId = typeof ref === 'string' ? idFromRef(ref) : '';
  if (integracaoId === '') return false;
  const integracaoSnap = await tx.get(integracaoCollection.docRef(db, {}, integracaoId));
  if (!integracaoSnap.exists) return true;
  const tipo = integracaoTipoSchema.safeParse(integracaoSnap.get('tipo'));
  return !tipo.success || ehMarketplace(tipo.data);
}
