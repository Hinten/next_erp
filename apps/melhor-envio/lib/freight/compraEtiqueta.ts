/**
 * The in-flight claim on a Melhor Envio label purchase (#1677).
 *
 * `POST …/comprar` resumes safely from a SEQUENTIAL re-click — the pedido's
 * `freteInicial.printLabelId` is the resume anchor — but nothing used to protect
 * a CONCURRENT one. A second request arriving while the first was still before
 * the anchor (inside `ensureCartAgency`, or a stalled `POST /me/cart`) read
 * `printLabelId = null`, created its own cart item and PAID FOR A SECOND LABEL;
 * the anchor then ended last-writer-wins and the other paid label was orphaned
 * (the ME webhook finds pedidos only by `printLabelId`). No route observes a
 * client abort, so the first run kept going after the browser gave up.
 *
 * ## The mechanism — a lease, plus a fence on the anchor
 *
 * An expiring claim at `pedidos/{pedidoId}/compraEtiqueta/current` serialises
 * runs; the anchor compare-and-set and a fence before every paid step make a run
 * that lost its claim harmless. Five guarantees, each pinned by a test:
 *
 *  1. **One holder at a time** — {@link adquirirCompraEtiqueta} answers
 *     `ocupado` (the route's 423) while another request holds a live claim.
 *  2. **At most one anchored label per fresh buy** — {@link ancorarEtiqueta}
 *     writes `printLabelId` only while the claim is still OURS and the stored
 *     anchor is still null (or already ours). A loser stops there, before any
 *     money moves; its only residue is an UNPAID cart item.
 *  3. **No paid step from a stale run** — {@link garantirPosseCompraEtiqueta}
 *     runs before `checkout` and `generate`: the claim must still be ours, the
 *     request must still be inside {@link COMPRA_ETIQUETA_JANELA_PAGA_MS}, and
 *     (before `checkout`) the anchor must still be the label about to be paid.
 *  4. **No takeover while a paid call can still be in flight** — the lease
 *     ({@link COMPRA_ETIQUETA_LEASE_MS}) outlasts the paid window plus what can
 *     run between the fence and the end of the paid call (a token refresh, the
 *     longest paid deadline, Firestore), so a run that passed the fence has
 *     finished waiting on Melhor Envio before anyone can take the claim — as
 *     long as its CPU is not frozen (see the residual below).
 *  5. **No false "success"** — when the label was paid but the pedido no longer
 *     points at it, {@link finalizarCompraEtiqueta} says so and the route answers
 *     a coded refusal naming the paid label, never a 200.
 *
 * ## Why a lease is allowed here (ADR 0011 rejects them in general)
 *
 * ADR 0011 rejects pessimistic locking for ordinary edits, and rightly: a stale
 * lease blocks a legitimate edit. Its 2026-10 addendum allows one ONLY around a
 * non-idempotent EXTERNAL act between two writes — here, paying for a label —
 * and only with the Shopee refresh-lease conditions: it EXPIRES, it is NEVER
 * renewed (a lock that renews itself cannot expire), a corrupt or far-future
 * claim reads as NO claim (nothing can block for ever), and it is fenced.
 *
 * ## Residual, deliberately accepted
 *
 * The SAME order checked out twice: a paid call that passed the fence and then
 * stalled past the lease (Cloud Run throttles CPU once the platform has answered
 * its 504, so a zombie's timers fire late), while a takeover run resumes on the
 * same anchor and checks it out again. Melhor Envio documents a 422 for an order
 * that is already paid, which covers the sequential case; a truly simultaneous
 * double checkout of one order is undocumented. It cannot produce a SECOND label.
 *
 * ⚠️ Every transaction here re-derives its decision from its own `tx.get`s
 * (root rule 7) — this file is in the transaction inventory as class C, because
 * the label id it anchors comes from a network call made before the
 * transaction. All clocks are server `Date.now()` milliseconds.
 */
import { randomUUID } from 'node:crypto';

import type { DocumentReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { ESTADO_FRETE, type EstadoFrete } from '@delfrance/schemas';
import {
  COMPRA_ETIQUETA_DOC_ID,
  compraEtiquetaCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  MelhorEnvioHttpError,
  MelhorEnvioNetworkError,
  MelhorEnvioTimeoutError,
} from '@delfrance/integrations-freight-br';

import { resolverEstadoFinalCompraEtiqueta } from './estadoEtiqueta';

/**
 * How long a claim lives: the 300 s App Hosting request ceiling plus 60 s — so a
 * claim never expires while its own request can still be running, and a
 * request that died (crash, CPU-frozen after the platform's 504) frees the
 * pedido on its own. Never renewed. Pinned against the ceiling by
 * `packages/config-eslint/rules/http-client-timeout-ceiling.test.js`.
 */
export const COMPRA_ETIQUETA_LEASE_MS = 360_000;

/**
 * A paid step (`checkout`, `generate`) may only START within this long of the
 * request's arrival — well inside the 300 s ceiling, so it never starts in a
 * request the platform is about to abandon.
 *
 * ⚠️ "Start" is the fence, and the bytes leave LATER: between the fence and the
 * paid call's own deadline window sit `getAccessToken()` (a Firestore load and,
 * at most once per run, a token refresh bounded by `PRAZO_ME_TOKEN_MS`) and a
 * few Firestore round trips. So the inequality the takeover safety rests on is
 * `JANELA + PRAZO_ME_TOKEN_MS + max(checkout, generate) + margin ≤ LEASE`
 * (240 + 20 + 60 + 30 = 350 ≤ 360), pinned in `compraEtiqueta.test.ts` against
 * the REAL deadlines — not `JANELA + checkout ≤ LEASE`, which a review showed
 * left only Firestore latency as slack.
 */
export const COMPRA_ETIQUETA_JANELA_PAGA_MS = 240_000;

/**
 * Clock slack for the far-future guard: two instances (or one instance across a
 * backward NTP step) do not share a clock to the millisecond, and a live claim
 * written by a writer a few ms AHEAD must still read as live — a zero-tolerance
 * guard let a racing acquire read it as "corrupt" and overwrite it.
 */
const FOLGA_RELOGIO_MS = 60_000;

/** The paid steps the fence guards. */
export type EtapaPagaCompraEtiqueta = 'checkout' | 'generate';

/**
 * Another request took the claim — this run is stale (its lease expired, or it
 * is a zombie the platform already abandoned). Answered as "em andamento".
 */
export class CompraEtiquetaPossePerdidaError extends Error {
  constructor(readonly pedidoId: string) {
    super('Outra compra de etiqueta assumiu este pedido.');
    this.name = 'CompraEtiquetaPossePerdidaError';
  }
}

/** The request is too old to START a paid step safely (see {@link COMPRA_ETIQUETA_JANELA_PAGA_MS}). */
export class CompraEtiquetaJanelaEsgotadaError extends Error {
  constructor(
    readonly pedidoId: string,
    readonly etapa: EtapaPagaCompraEtiqueta,
  ) {
    super(`A compra demorou demais para iniciar a etapa ${etapa} com segurança.`);
    this.name = 'CompraEtiquetaJanelaEsgotadaError';
  }
}

/**
 * The pedido's anchor is no longer the label this run is buying — the frete was
 * changed or cleared mid-buy, or the pedido is gone. Only ever raised BEFORE
 * `checkout`, so nothing was paid by this run.
 */
export class CompraEtiquetaAncoraMudouError extends Error {
  constructor(
    readonly pedidoId: string,
    readonly esperado: string,
    readonly encontrado: string | null,
  ) {
    super('A etiqueta registrada no pedido mudou durante a compra.');
    this.name = 'CompraEtiquetaAncoraMudouError';
  }
}

/** What a request that acquired the claim carries through the buy. */
export interface PosseCompraEtiqueta {
  readonly pedidoId: string;
  readonly dono: string;
  /** Request arrival + {@link COMPRA_ETIQUETA_JANELA_PAGA_MS}: no paid step starts at or after it. */
  readonly janelaFechaEmMs: number;
}

export type ResultadoAdquirirCompraEtiqueta =
  | { readonly kind: 'pedido-ausente' }
  | { readonly kind: 'ocupado'; readonly leaseExpiraEmMs: number }
  | {
      readonly kind: 'adquirido';
      readonly posse: PosseCompraEtiqueta;
      /** The resume anchor, read from the SAME snapshot that granted the claim. */
      readonly printLabelIdAncorado: string | null;
    };

interface LeaseLido {
  readonly dono: string;
  readonly leaseExpiraEmMs: number;
}

/**
 * The stored claim, or `null` when there is none that can block anyone.
 *
 * ⚠️ A corrupt claim reads as NO claim — a non-string or empty `dono`, a
 * missing or non-finite expiry — and so does one expiring more than a whole
 * lease (plus {@link FOLGA_RELOGIO_MS} of clock slack) into the future: a
 * hand-edit, a badly skewed writer. The Shopee refresh lease this copies did not
 * have that guard; without it a claim dated 2099 would block re-buys of the
 * pedido until 2099. ADR 0011's wrong-way default: the failure mode of a bad
 * lock must be "no lock".
 */
export function leaseDe(raw: unknown, nowMs: number, pedidoId: string): LeaseLido | null {
  if (raw === undefined) return null;
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const { dono, leaseExpiraEmMs } = obj;
  if (
    typeof dono !== 'string' ||
    dono.length === 0 ||
    typeof leaseExpiraEmMs !== 'number' ||
    !Number.isFinite(leaseExpiraEmMs)
  ) {
    console.warn('[melhor-envio/compraEtiqueta] claim corrompido lido como livre', { pedidoId });
    return null;
  }
  if (leaseExpiraEmMs > nowMs + COMPRA_ETIQUETA_LEASE_MS + FOLGA_RELOGIO_MS) {
    console.warn('[melhor-envio/compraEtiqueta] claim com validade no futuro lido como livre', {
      pedidoId,
    });
    return null;
  }
  return { dono, leaseExpiraEmMs };
}

/** `freteInicial.printLabelId` of a pedido snapshot's data, or `null`. */
function ancoraDe(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const frete = (data as { freteInicial?: unknown }).freteInicial;
  if (frete === null || typeof frete !== 'object') return null;
  const id = (frete as { printLabelId?: unknown }).printLabelId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Raw nested state, without full-parsing a possibly legacy pedido. */
function estadoDe(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return undefined;
  const frete = (data as { freteInicial?: unknown }).freteInicial;
  if (frete === null || typeof frete !== 'object') return undefined;
  return (frete as { estado?: unknown }).estado;
}

function refs(
  db: Firestore,
  pedidoId: string,
): { claim: DocumentReference; pedido: DocumentReference } {
  return {
    claim: compraEtiquetaCollection.docRef(db, { pedidoId }, COMPRA_ETIQUETA_DOC_ID),
    pedido: pedidoCollection.docRef(db, {}, pedidoId),
  };
}

function dadosDe(snap: DocumentSnapshot): unknown {
  return snap.exists ? snap.data() : undefined;
}

/**
 * ACQUIRE — class A: every input to the write is an argument or comes from this
 * callback's own reads.
 *
 * ⚠️ The pedido is read INSIDE this transaction, and that is load-bearing: it
 * serialises this acquire against a previous holder's anchor commit. If that
 * commit lands first, this attempt aborts, retries and resumes on its label; if
 * this one lands first, the previous holder's anchor transaction re-reads the
 * claim and finds it is no longer the owner.
 *
 * `now === leaseExpiraEmMs` counts as EXPIRED and takeable; a claim carrying our
 * own owner id is an OCC retry of this very call, never a competitor.
 */
export async function adquirirCompraEtiqueta(
  db: Firestore,
  args: {
    readonly pedidoId: string;
    /** `Date.now()` when the request arrived — the paid window counts from it. */
    readonly inicioMs: number;
    readonly uid: string | null;
    readonly intFreteId: string | null;
  },
): Promise<ResultadoAdquirirCompraEtiqueta> {
  const { pedidoId } = args;
  const dono = randomUUID();
  const { claim, pedido } = refs(db, pedidoId);

  return db.runTransaction(async (tx) => {
    const [claimSnap, pedidoSnap] = await tx.getAll(claim, pedido);
    // The clock is read AFTER the reads: taken before them, a claim another
    // request committed while this read was in flight could look like it expires
    // further ahead than "now" allows.
    const nowMs = Date.now();
    if (!pedidoSnap?.exists) return { kind: 'pedido-ausente' } as const;

    const lease = claimSnap ? leaseDe(dadosDe(claimSnap), nowMs, pedidoId) : null;
    if (lease !== null && lease.dono !== dono && nowMs < lease.leaseExpiraEmMs) {
      return { kind: 'ocupado', leaseExpiraEmMs: lease.leaseExpiraEmMs } as const;
    }

    tx.set(
      claim,
      compraEtiquetaCollection.parse({
        dono,
        leaseExpiraEmMs: nowMs + COMPRA_ETIQUETA_LEASE_MS,
        criadoEmMs: nowMs,
        uid: args.uid,
        intFreteId: args.intFreteId,
      }),
    );
    return {
      kind: 'adquirido',
      posse: {
        pedidoId,
        dono,
        janelaFechaEmMs: args.inicioMs + COMPRA_ETIQUETA_JANELA_PAGA_MS,
      },
      printLabelIdAncorado: ancoraDe(pedidoSnap.data()),
    } as const;
  });
}

/**
 * ANCHOR — the `persistPrintLabelId` hook of `comprarEtiqueta`, replacing the
 * plain `update` that used to be last-writer-wins.
 *
 * Class C: `printLabelId` comes from the `POST /me/cart` made BEFORE this
 * transaction. Guarded by an identity compare-and-set re-derived from this
 * callback's reads — the claim must still be ours, and the stored anchor must
 * still be null (or already this id: an OCC retry, or a resume) — so a run that
 * lost its claim stops here, before `checkout` spends anything.
 *
 * A new anchor also normalizes an inherited `postado` to `aguardandoPostagem`:
 * the old state had no label, so any later `postado` belongs to this new one.
 * The reset survives a checkout failure; rolling it back could lose a webhook.
 * Dotted updates preserve all other siblings under `freteInicial`.
 */
export async function ancorarEtiqueta(
  db: Firestore,
  posse: PosseCompraEtiqueta,
  printLabelId: string,
): Promise<void> {
  const { claim, pedido } = refs(db, posse.pedidoId);
  await db.runTransaction(async (tx) => {
    const [claimSnap, pedidoSnap] = await tx.getAll(claim, pedido);
    const lease = claimSnap ? leaseDe(dadosDe(claimSnap), Date.now(), posse.pedidoId) : null;
    if (lease === null || lease.dono !== posse.dono) {
      throw new CompraEtiquetaPossePerdidaError(posse.pedidoId);
    }
    if (!pedidoSnap?.exists) {
      throw new CompraEtiquetaAncoraMudouError(posse.pedidoId, printLabelId, null);
    }
    const atual = ancoraDe(pedidoSnap.data());
    if (atual === printLabelId) return;
    if (atual !== null) {
      throw new CompraEtiquetaAncoraMudouError(posse.pedidoId, printLabelId, atual);
    }
    tx.update(pedido, {
      'freteInicial.printLabelId': printLabelId,
      ...(estadoDe(pedidoSnap.data()) === ESTADO_FRETE.postado
        ? { 'freteInicial.estado': ESTADO_FRETE.aguardandoPostagem }
        : {}),
    });
  });
}

/**
 * The FENCE before a paid step. Not a transaction — it guards an EXTERNAL act,
 * which no transaction can enclose — so it can only refuse to START the step.
 * The window is checked first, from memory (a run past it never even reads), and
 * AGAIN after the read: a slow read must not carry a run past the window it was
 * checked against.
 *
 * Before `checkout` it also requires the anchor to still be the label about to
 * be paid (a frete changed mid-buy must not be paid for). Before `generate` the
 * label is already paid, so only the claim and the window are checked.
 */
export async function garantirPosseCompraEtiqueta(
  db: Firestore,
  posse: PosseCompraEtiqueta,
  etapa: EtapaPagaCompraEtiqueta,
  orderIds: readonly string[],
): Promise<void> {
  if (Date.now() >= posse.janelaFechaEmMs) {
    throw new CompraEtiquetaJanelaEsgotadaError(posse.pedidoId, etapa);
  }
  const { claim, pedido } = refs(db, posse.pedidoId);
  const [claimSnap, pedidoSnap] = await db.getAll(claim, pedido);
  const nowMs = Date.now();
  if (nowMs >= posse.janelaFechaEmMs) {
    throw new CompraEtiquetaJanelaEsgotadaError(posse.pedidoId, etapa);
  }
  const lease = claimSnap ? leaseDe(dadosDe(claimSnap), nowMs, posse.pedidoId) : null;
  if (lease === null || lease.dono !== posse.dono) {
    throw new CompraEtiquetaPossePerdidaError(posse.pedidoId);
  }
  if (etapa === 'checkout') {
    const atual = pedidoSnap?.exists ? ancoraDe(pedidoSnap.data()) : null;
    const rotulo = orderIds.length === 1 ? orderIds[0] : undefined;
    if (rotulo === undefined || atual !== rotulo) {
      throw new CompraEtiquetaAncoraMudouError(posse.pedidoId, rotulo ?? '', atual);
    }
  }
}

export type ResultadoFinalizarCompraEtiqueta =
  | { readonly kind: 'vinculada'; readonly estado: EstadoFrete }
  | { readonly kind: 'desvinculada' };

/**
 * FINALIZE — class C (provider status and tracking come from Melhor Envio).
 * Re-derives the state from the transaction's pedido while it is STILL anchored
 * on this label, preserving terminal states and posted progress. Deletes the
 * claim in the same commit when it is still ours.
 *
 * A `desvinculada` result means a bought label the pedido no longer points at.
 * The route must report it loudly rather than invite another purchase.
 */
export async function finalizarCompraEtiqueta(
  db: Firestore,
  posse: PosseCompraEtiqueta,
  resultado: {
    readonly printLabelId: string;
    readonly tracking: string | null;
    readonly agency: number | null;
    readonly providerStatus: string | null;
  },
): Promise<ResultadoFinalizarCompraEtiqueta> {
  const { claim, pedido } = refs(db, posse.pedidoId);
  return db.runTransaction(async (tx) => {
    const [claimSnap, pedidoSnap] = await tx.getAll(claim, pedido);
    let finalizacao: ResultadoFinalizarCompraEtiqueta = { kind: 'desvinculada' };
    // No logging here: each OCC retry must recompute and return its own state.
    if (pedidoSnap?.exists && ancoraDe(pedidoSnap.data()) === resultado.printLabelId) {
      const estadoAtual = estadoDe(pedidoSnap.data());
      const estado = resolverEstadoFinalCompraEtiqueta(estadoAtual, resultado.providerStatus);
      tx.update(pedido, {
        ...(estadoAtual !== estado ? { 'freteInicial.estado': estado } : {}),
        'freteInicial.codRastreio': resultado.tracking,
        ...(resultado.agency !== null
          ? { 'freteInicial.externalOptionData.agency': resultado.agency }
          : {}),
      });
      finalizacao = { kind: 'vinculada', estado };
    }
    if (claimSnap && donoDe(dadosDe(claimSnap)) === posse.dono) tx.delete(claim);
    return finalizacao;
  });
}

/**
 * RELEASE — class A. Deletes the claim only when it is still ours: a run that
 * lost it must never free the winner's. A throw propagates (root rule 6); the
 * claim then simply expires.
 */
export async function liberarCompraEtiqueta(
  db: Firestore,
  posse: PosseCompraEtiqueta,
): Promise<void> {
  const { claim } = refs(db, posse.pedidoId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(claim);
    if (donoDe(dadosDe(snap)) === posse.dono) tx.delete(claim);
  });
}

/**
 * Did a PAID step fail in a way that leaves the money outcome UNKNOWN? Then the
 * route keeps the claim until it expires (nobody re-buys over a payment Melhor
 * Envio may still be settling) and tells the operator to check, not to retry.
 *
 *  - a timeout OF THAT STEP;
 *  - any other transport failure of it — the request may have left before the
 *    connection dropped;
 *  - a GATEWAY-class status from Melhor Envio's edge (502/503/504, Cloudflare's
 *    52x) — the edge answered, the origin may still be processing. A plain 500
 *    or a 4xx is the origin answering, so it is not.
 *
 * ⚠️ NOT when the failure came from the TOKEN refresh inside the step
 * (`operacao: 'token'`): `request()` asks `getAccessToken()` before the paid
 * call's own request, and a refresh that timed out, dropped or got a gateway
 * status sent nothing to `checkout`/`generate`. Holding the claim and telling
 * the operator "o pagamento pode ter sido concluído" there would be false (PR
 * review of #1677). An error that does not say where it came from
 * (`operacao: null`) is treated as the step's own — the conservative reading,
 * which can only over-hold.
 */
export function ehDesfechoPagoIncerto(err: unknown, etapa: EtapaPagaCompraEtiqueta): boolean {
  if (err instanceof MelhorEnvioTimeoutError) return err.operacao === etapa;
  if (err instanceof MelhorEnvioNetworkError) return err.operacao !== 'token';
  if (err instanceof MelhorEnvioHttpError) {
    if (err.operacao === 'token') return false;
    return err.status === 502 || err.status === 503 || err.status === 504 || err.status >= 520;
  }
  return false;
}

/** The stored owner id, without any of `leaseDe`'s validity rules — for "is it mine?". */
function donoDe(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const dono = (raw as { dono?: unknown }).dono;
  return typeof dono === 'string' ? dono : null;
}
