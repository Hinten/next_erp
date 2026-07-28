import { getDoc, runTransaction, type Firestore } from 'firebase/firestore';
import {
  ESTADO_PEDIDO,
  ESTADO_FRETE,
  checkCompleteness,
  checkoutFretePedidoSchema,
  toItemCheckoutPedido,
  type CheckoutFretePedido,
  type EngineProduto,
  type EstadoFrete,
  type EstadoPedido,
  type ExpectedItem,
  type FreteDoPedido,
  type ItemDoPedido,
  type ScanLogEntry,
} from '@delfrance/schemas';
import { pedidoCollection } from '../data/pedidoCollection';
import { checkoutCollection } from '../data/checkoutCollection';
import { dereferenceOuterRef } from '../data/dereferenceOuterRef';
import { newDocId } from '../data/newDocId';

/**
 * The checkout save flow. Two pure, exhaustively-tested pieces — `evaluatePreSave`
 * (the 12 validation gates) and `buildCheckoutDoc` (the wire mapping) — plus the
 * Firestore transaction `salvarCheckoutTransacao`. Port of `checkout.dart`
 * `salvarCheckout` (930-1314) + `_save` (744-928), FIXING the two legacy bugs
 * (§2.3): the retirada phase-2 transaction ran even when phase-1 failed, and the
 * transaction re-checked `ehSaida` against the STALE outer pedido instead of the
 * transaction snapshot.
 */

/** Frete estados a pedido may be in for a normal (non-confirmed) checkout (legacy 766-769). */
const ALLOWED_FRETE_ESTADOS: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.aguardandoNFe,
  ESTADO_FRETE.aguardandoValidacaoTransporadora, // legacy spelling (missing 't') — must match the stored value
  ESTADO_FRETE.despachoAutorizado,
  ESTADO_FRETE.emSeparacao,
]);

/** Writing this estado triggers the server `sincronizarEstoquePedido` (removes stock). */
const ESTADO_CHECK_FINALIZADO: EstadoFrete = ESTADO_FRETE.checkFinalizado;
const ESTADO_AGUARDANDO_RETIRADA: EstadoFrete = ESTADO_FRETE.aguardandoRetirada;
const ESTADO_PEDIDO_PAGO: EstadoPedido = ESTADO_PEDIDO.pago;

export type ConfirmKind = 'frete-changed' | 'frete-estado';

export interface PreSaveBlock {
  ok: false;
  decision: 'block';
  kind: string;
  title: string;
  message: string;
  /** epoch ms of a pre-existing checkout (kind === 'checkout-existente'); UI formats it. */
  atMs?: number;
}
export interface PreSaveConfirm {
  ok: false;
  decision: 'confirm';
  kind: ConfirmKind;
  title: string;
  message: string;
}
export interface PreSaveOk {
  ok: true;
  /** the out-of-allowed-set frete estado the operator confirmed (re-checked in the tx), else null. */
  estadoContinuar: EstadoFrete | null;
}
export type PreSaveResult = PreSaveBlock | PreSaveConfirm | PreSaveOk;

/** The subset of the fresh (server re-fetched) pedido the gates read. */
export interface PreSaveFresh {
  estado: EstadoPedido;
  numero: string | null;
  freteInicial: FreteDoPedido | null;
}

export interface EvaluatePreSaveInput {
  /** the pedido as originally loaded into the screen. */
  loaded: {
    estado: EstadoPedido;
    itens: readonly ItemDoPedido[];
    freteInicial: FreteDoPedido | null;
  };
  /** the server re-fetch; null means the pedido was deleted. */
  fresh: PreSaveFresh | null;
  /** flattened, ordem-sorted items of the fresh pedido. */
  freshItens: readonly ItemDoPedido[];
  expected: readonly ExpectedItem[];
  log: readonly ScanLogEntry[];
  produtos: ReadonlyMap<string, EngineProduto>;
  existingCheckout: { timestampMs: number | null } | null;
  /** confirm gates the operator has already acknowledged (grows across the confirm loop). */
  confirmed: ReadonlySet<ConfirmKind>;
}

const makeBlock = (kind: string, title: string, message: string, atMs?: number): PreSaveBlock =>
  atMs === undefined
    ? { ok: false, decision: 'block', kind, title, message }
    : { ok: false, decision: 'block', kind, title, message, atMs };
const makeConfirm = (kind: ConfirmKind, title: string, message: string): PreSaveConfirm => ({
  ok: false,
  decision: 'confirm',
  kind,
  title,
  message,
});

/** Order-independent structural signature of the item list (matches legacy `unordered` compare). */
function itensSignature(itens: readonly ItemDoPedido[]): string {
  return itens
    .map((i) => JSON.stringify(i))
    .sort()
    .join('|');
}
function freteSignature(f: FreteDoPedido | null): string {
  return f === null ? '' : JSON.stringify(f);
}

/**
 * Run the 12 pre-save gates in legacy runtime order (salvarCheckout 1-8, then
 * _save 10 → 11 → 9 → 12). Returns the FIRST unresolved gate — a `block` the UI
 * shows as an error, or a `confirm` the UI dialogs (and, on "yes", re-calls with
 * the kind added to `confirmed`). `ok` carries `estadoContinuar` for the tx.
 *
 * Legacy gate 12 (Loja Integrada `conferirSePedidoEstaPago`) is NOT ported — the
 * new app has no LI integration; the general `estado === 'pago'` check here (and
 * the in-transaction re-check) covers the case. Follow-up issue tracks LI.
 */
export function evaluatePreSave(input: EvaluatePreSaveInput): PreSaveResult {
  const { loaded, fresh, freshItens, expected, log, produtos, existingCheckout, confirmed } = input;

  // 1. Re-fetch: pedido deleted.
  if (fresh === null) {
    return makeBlock('pedido-deleted', 'Erro', 'Não foi possível salvar: o pedido foi excluído.');
  }
  // 2. Estado changed since load.
  if (fresh.estado !== loaded.estado) {
    return makeBlock('estado-changed', 'Erro', 'Não foi possível salvar: o pedido foi alterado.');
  }
  // 3. Itens changed since load.
  if (itensSignature(freshItens) !== itensSignature(loaded.itens)) {
    return makeBlock(
      'itens-changed',
      'Erro',
      'Não foi possível salvar: os itens do pedido foram alterados.',
    );
  }
  // 4. Frete changed since load → CONFIRM.
  if (
    freteSignature(fresh.freteInicial) !== freteSignature(loaded.freteInicial) &&
    !confirmed.has('frete-changed')
  ) {
    return makeConfirm(
      'frete-changed',
      'Atenção',
      'O frete do pedido foi alterado, deseja continuar?',
    );
  }
  // 5. An expected item has an error (produto não encontrado).
  if (expected.some((e) => e.error !== null)) {
    return makeBlock(
      'expected-error',
      'Erro',
      'Não foi possível salvar: o pedido contém produtos com erro.',
    );
  }
  // 6. Frete deleted.
  if (fresh.freteInicial === null) {
    return makeBlock('frete-null', 'Erro', 'Não foi possível salvar: o frete foi excluído.');
  }
  // 7. A launched row with an unresolved error (operator must soft-delete it first).
  if (log.some((e) => e.error !== null && e.excluidoMs === null)) {
    return makeBlock(
      'log-error',
      'Itens com erro',
      'Existem produtos lançados com erro. Exclua-os antes de continuar.',
    );
  }
  // 8. Completeness (over/under scan). BLOCK — legacy dialog is OK-only, not a confirm.
  if (!checkCompleteness({ itens: freshItens, produtos, log }).complete) {
    return makeBlock(
      'incompleto',
      'Quantidade inesperada',
      'Existem itens que não foram lançados ou que foram lançados a mais.',
    );
  }
  // 10. Frete reverso.
  if (fresh.freteInicial.ehReverso === true) {
    return makeBlock(
      'reverso',
      'Erro',
      `Não foi possível salvar: o frete do pedido ${fresh.numero ?? ''} é reverso.`,
    );
  }
  // 11. A checkout already exists for this pedido.
  if (existingCheckout !== null) {
    return makeBlock(
      'checkout-existente',
      'Erro',
      'Este pedido já possui um checkout.',
      existingCheckout.timestampMs ?? undefined,
    );
  }
  // 9. Frete estado out of the allowed set → CONFIRM (captures estadoContinuar on ok).
  const freteEstado = fresh.freteInicial.estado;
  if (!ALLOWED_FRETE_ESTADOS.has(freteEstado) && !confirmed.has('frete-estado')) {
    return makeConfirm(
      'frete-estado',
      'Atenção',
      'Este pedido não está no estado "Despacho autorizado" ou "Em separação". Deseja continuar?',
    );
  }
  // 12. Pedido must be Pago (general case; LI payment check not ported).
  if (fresh.estado !== ESTADO_PEDIDO_PAGO) {
    return makeBlock(
      'nao-pago',
      'Erro',
      `O pedido está no estado "${fresh.estado}". Para salvar o checkout ele precisa estar Pago.`,
    );
  }

  return {
    ok: true,
    estadoContinuar: ALLOWED_FRETE_ESTADOS.has(freteEstado) ? null : freteEstado,
  };
}

/**
 * Build the `CheckoutFretePedido` doc to persist. `freteNoMomentoDoCheckout` is
 * the RE-FETCHED frete (a snapshot of the frete at save time); `itensCheckout`
 * is EVERY log row (active + soft-deleted + error) in insertion order. Pure.
 */
export function buildCheckoutDoc(input: {
  numero: string | null;
  frete: FreteDoPedido;
  uid: string;
  log: readonly ScanLogEntry[];
  nowMs: number;
}): CheckoutFretePedido {
  return checkoutFretePedidoSchema.parse({
    title: input.numero,
    obs: null,
    freteNoMomentoDoCheckout: input.frete,
    ehDoFreteInicial: true,
    usuarioCheckoutFretePedidoOuterRef: `documents/usuarios/${input.uid}`,
    itensCheckout: input.log.map(toItemCheckoutPedido),
    timestamp: input.nowMs,
  });
}

/** Thrown inside the transaction to abort it with a typed reason. */
export class CheckoutSaveError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutSaveError';
  }
}

/**
 * Persist the checkout in a transaction, then (retiradaNaLoja only) advance the
 * frete estado to `aguardandoRetirada` in a SECOND transaction — but ONLY on
 * phase-1 success (fixes the legacy bug where phase 2 ran even after phase 1
 * failed). Reads precede writes; every gate re-checks the TX snapshot (fixes the
 * stale-`ehSaida` bug). The checkout write ITSELF flips `freteInicial.estado` to
 * `checkFinalizado`, which the server stock-sync reacts to — stock is NEVER
 * written client-side. Legacy did not bump `ultimaModificacao`; kept for parity.
 */
export async function salvarCheckoutTransacao(
  db: Firestore,
  input: {
    pedidoId: string;
    uid: string;
    log: readonly ScanLogEntry[];
    estadoContinuar: EstadoFrete | null;
    nowMs: number;
  },
): Promise<{ checkoutId: string; retirada: boolean }> {
  const { pedidoId, uid, log, estadoContinuar, nowMs } = input;
  const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
  const checkoutId = newDocId();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pedidoRef);
    if (!snap.exists()) throw new CheckoutSaveError('pedido-deleted', 'O pedido foi excluído.');
    const fresh = snap.data();

    // Re-validate on the TX snapshot (the stale-read bug fix).
    if (!fresh.ehSaida) throw new CheckoutSaveError('nao-saida', 'O pedido não é de saída.');
    const frete = fresh.freteInicial;
    if (frete === null) throw new CheckoutSaveError('frete-null', 'O frete foi excluído.');
    if (frete.ehReverso === true) {
      throw new CheckoutSaveError('reverso', `O frete do pedido ${fresh.numero ?? ''} é reverso.`);
    }
    if (fresh.estado !== ESTADO_PEDIDO_PAGO) {
      throw new CheckoutSaveError('nao-pago', `O pedido está em "${fresh.estado}", não Pago.`);
    }
    const freteAllowed =
      ALLOWED_FRETE_ESTADOS.has(frete.estado) ||
      (estadoContinuar !== null && frete.estado === estadoContinuar);
    if (!freteAllowed) {
      throw new CheckoutSaveError('frete-estado', `O frete está no estado "${frete.estado}".`);
    }

    tx.set(
      checkoutCollection.docRef(db, { pedidoId }, checkoutId),
      buildCheckoutDoc({ numero: fresh.numero, frete, uid, log, nowMs }),
    );
    // Dotted-path update → affectedKeys = {freteInicial}; never touches the
    // serverOwnedFields-blocked `estoqueAplicado` (precedent: pedido-print/batch.ts).
    tx.update(pedidoRef, { 'freteInicial.estado': ESTADO_CHECK_FINALIZADO });
  });

  // Phase 2 — retiradaNaLoja only, and ONLY because phase 1 committed.
  const retirada = await isRetiradaNaLoja(db, pedidoId);
  if (retirada) {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(pedidoRef);
      if (!snap.exists()) return; // vanished between phases — nothing to advance
      tx.update(pedidoRef, { 'freteInicial.estado': ESTADO_AGUARDANDO_RETIRADA });
    });
  }

  return { checkoutId, retirada };
}

/** Whether the pedido's freight integration is retiradaNaLoja (drives the phase-2 estado). */
async function isRetiradaNaLoja(db: Firestore, pedidoId: string): Promise<boolean> {
  const snap = await getDoc(pedidoCollection.docRef(db, {}, pedidoId));
  if (!snap.exists()) return false;
  const ref = dereferenceOuterRef(db, snap.data().freteInicial?.integracaoFreteOuterRef);
  if (ref === null) return false;
  const intSnap = await getDoc(ref);
  if (!intSnap.exists()) return false;
  return (intSnap.data() as { tipo?: unknown }).tipo === 'retiradaNaLoja';
}
