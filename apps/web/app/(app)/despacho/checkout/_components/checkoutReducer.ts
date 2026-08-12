'use client';

import {
  applyDelete,
  applyScan,
  buildEngineState,
  type CheckoutEngineState,
  type EngineProduto,
  type Incidente,
  type ItemDoPedido,
  type Pedido,
  type ScanLogEntry,
} from '@delfrance/schemas';
import type { CheckoutData, PedidoCandidate } from '@/lib/checkout/loadPedidoCheckout';
import type { CheckoutDanfeFormat } from '@/lib/checkout/nfeFlow';
import { buildScanIndex, type ScanIndex } from './resolveScan';

/**
 * The checkout screen's single reducer — one `useReducer` owns EVERYTHING that
 * drives a render, so a scan is one dispatch and React re-renders 1–2 memoized
 * rows (the engine structurally shares every untouched `ExpectedItem`; see
 * `@delfrance/schemas` `applyScan`). The engine calls (`applyScan`/`applyDelete`)
 * run INSIDE the reducer, keeping them pure and colocated with the state they
 * mutate.
 *
 * ## Epoch guard (the cancellation mechanism, checkout port plan §5.3)
 *
 * Loading a pedido is async, and so is a scan that misses the prefetched maps.
 * Every such async op captures the `epoch` live when it STARTED and tags its
 * completion action with it; the reducer drops any action whose `epoch` no
 * longer matches `state.epoch`. Bumping the epoch (a new load, a clear, a
 * post-save reset) therefore atomically cancels every in-flight async result
 * for the old pedido — no result can ever land on the wrong pedido's engine.
 * The epoch's synchronous source of truth is a `useRef` in `useCheckoutReducer`;
 * this reducer only mirrors it into state (set by the epoch-bumping actions).
 */

export type CheckoutStatus = 'empty' | 'loading' | 'loaded' | 'error';

export interface CheckoutState {
  /** Monotonic load counter — the epoch guard. Bumped by load/clear/reset. */
  epoch: number;
  status: CheckoutStatus;
  /** null until a pedido is loaded. */
  pedidoId: string | null;
  pedido: Pedido | null;
  /** the pedido's flattened, ordem-sorted items as LOADED (the save-gate baseline). */
  itens: readonly ItemDoPedido[];
  produtos: ReadonlyMap<string, EngineProduto>;
  /** prefetched scan lookups derived from `produtos` (read by the scan pipeline). */
  scanIndex: ScanIndex;
  engine: CheckoutEngineState | null;
  existingCheckout: CheckoutData['existingCheckout'];
  incidentes: readonly Incidente[];
  /** a human message when `status === 'error'` (finder miss / load failure). */
  message: string | null;
  /** the `many` finder result awaiting the operator's pick, else null. */
  manyCandidates: readonly PedidoCandidate[] | null;
  finderBusy: boolean;
  saving: boolean;
  formatoDanfe: CheckoutDanfeFormat;
  formatoEtiqueta: 'pdf' | 'zpl2';
}

const EMPTY_INDEX: ScanIndex = { byId: new Map(), bySku: new Map() };

export const initialCheckoutState: CheckoutState = {
  epoch: 0,
  status: 'empty',
  pedidoId: null,
  pedido: null,
  itens: [],
  produtos: new Map(),
  scanIndex: EMPTY_INDEX,
  engine: null,
  existingCheckout: null,
  incidentes: [],
  message: null,
  manyCandidates: null,
  finderBusy: false,
  saving: false,
  formatoDanfe: 'simplificadoPdf',
  formatoEtiqueta: 'pdf',
};

/** Metadata the engine needs for a scan/error log row (generated outside the reducer, so it stays pure). */
export interface ScanMeta {
  /** the log entry's own uuid (React key + wire order) — NOT the auth uid. */
  uid: string;
  timestampMs: number;
}

export type CheckoutAction =
  // ── epoch-bumping (the component bumps the ref, then dispatches the new epoch) ──
  | { type: 'load/start'; epoch: number; pedidoId: string }
  | { type: 'clear'; epoch: number }
  | { type: 'reset'; epoch: number }
  // ── async completions (dropped when `epoch !== state.epoch`) ──
  | { type: 'load/success'; epoch: number; data: CheckoutData }
  | { type: 'load/error'; epoch: number; message: string }
  | { type: 'scan/apply'; epoch: number; produto: EngineProduto; meta: ScanMeta }
  | { type: 'scan/not-found'; epoch: number; code: string; meta: ScanMeta }
  // ── synchronous UI actions (no epoch) ──
  | { type: 'scan/delete'; entryUid: string; nowMs: number }
  | { type: 'finder/busy'; busy: boolean }
  | { type: 'finder/many'; candidates: readonly PedidoCandidate[] }
  | { type: 'finder/error'; message: string }
  | { type: 'finder/dismiss' }
  | { type: 'save/start' }
  | { type: 'save/done' }
  | { type: 'format/danfe'; value: CheckoutDanfeFormat }
  | { type: 'format/etiqueta'; value: 'pdf' | 'zpl2' };

/** A soft error log row for a code that resolved to no produto at all (blocks save until deleted). */
function notFoundEntry(code: string, meta: ScanMeta): ScanLogEntry {
  return {
    uid: meta.uid,
    produtoId: null,
    produtoNome: code || '(código vazio)',
    produtoSku: null,
    quantidade: 1,
    kind: 'error',
    targetKey: null,
    componentProdutoId: null,
    error: 'Produto não encontrado',
    timestampMs: meta.timestampMs,
    excluidoMs: null,
  };
}

/** A cleared-but-loaded state: same pedido, fresh engine + scan index, no scans. */
function reloadedEngine(state: CheckoutState, epoch: number): CheckoutState {
  return {
    ...state,
    epoch,
    engine: state.pedido
      ? buildEngineState({ itens: state.itens, produtos: state.produtos })
      : null,
    saving: false,
  };
}

export function checkoutReducer(state: CheckoutState, action: CheckoutAction): CheckoutState {
  switch (action.type) {
    case 'load/start':
      return {
        ...initialCheckoutState,
        epoch: action.epoch,
        status: 'loading',
        pedidoId: action.pedidoId,
        // preserve the operator's format choices across loads
        formatoDanfe: state.formatoDanfe,
        formatoEtiqueta: state.formatoEtiqueta,
      };

    case 'load/success': {
      if (action.epoch !== state.epoch) return state; // stale — a newer load superseded it
      const { data } = action;
      return {
        ...state,
        status: 'loaded',
        pedido: data.pedido,
        pedidoId: data.pedidoId,
        itens: data.itens,
        produtos: data.produtos,
        scanIndex: buildScanIndex(data.produtos),
        engine: buildEngineState({ itens: data.itens, produtos: data.produtos }),
        existingCheckout: data.existingCheckout,
        incidentes: data.incidentes,
        message: null,
        manyCandidates: null,
      };
    }

    case 'load/error':
      if (action.epoch !== state.epoch) return state;
      return { ...state, status: 'error', message: action.message };

    case 'scan/apply': {
      if (action.epoch !== state.epoch || state.engine === null) return state;
      const { state: engine } = applyScan(state.engine, action.produto, {
        uid: action.meta.uid,
        timestampMs: action.meta.timestampMs,
      });
      return { ...state, engine };
    }

    case 'scan/not-found': {
      if (action.epoch !== state.epoch || state.engine === null) return state;
      const entry = notFoundEntry(action.code, action.meta);
      return { ...state, engine: { ...state.engine, log: [...state.engine.log, entry] } };
    }

    case 'scan/delete': {
      if (state.engine === null) return state;
      return { ...state, engine: applyDelete(state.engine, action.entryUid, action.nowMs) };
    }

    case 'clear':
      // Same pedido, wiped scans (also bumps epoch so in-flight scans self-drop).
      return reloadedEngine(state, action.epoch);

    case 'reset':
      return {
        ...initialCheckoutState,
        epoch: action.epoch,
        formatoDanfe: state.formatoDanfe,
        formatoEtiqueta: state.formatoEtiqueta,
      };

    case 'finder/busy':
      return { ...state, finderBusy: action.busy };

    case 'finder/many':
      return { ...state, finderBusy: false, manyCandidates: action.candidates };

    case 'finder/error':
      return { ...state, finderBusy: false, status: 'error', message: action.message };

    case 'finder/dismiss':
      return { ...state, manyCandidates: null };

    case 'save/start':
      return { ...state, saving: true };

    case 'save/done':
      return { ...state, saving: false };

    case 'format/danfe':
      return { ...state, formatoDanfe: action.value };

    case 'format/etiqueta':
      return { ...state, formatoEtiqueta: action.value };

    default: {
      const _exhaustive: never = action;
      return state ?? _exhaustive;
    }
  }
}
