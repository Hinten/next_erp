'use client';

import { useCallback, useReducer, useRef } from 'react';
import {
  checkoutReducer,
  initialCheckoutState,
  type CheckoutAction,
  type CheckoutState,
} from './checkoutReducer';

export interface CheckoutReducerHandle {
  state: CheckoutState;
  dispatch: React.Dispatch<CheckoutAction>;
  /**
   * Advance the epoch and return the new value. The SYNCHRONOUS source of truth
   * for "which pedido is current" — call it right before dispatching a
   * `load/start` / `clear` / `reset` (pass the returned epoch into that action),
   * and read {@link currentEpoch} when kicking off any other async op so its
   * completion action carries the epoch it started under. See the reducer's
   * epoch-guard doc.
   */
  bumpEpoch: () => number;
  /** The live epoch (mirrors `state.epoch`, but readable synchronously mid-handler). */
  currentEpoch: () => number;
}

/**
 * `useReducer` over {@link checkoutReducer} plus the epoch ref that makes the
 * guard synchronous. Kept as its own hook so the screen orchestrator stays
 * focused on wiring the async flows, and so both the reducer and the epoch
 * discipline are unit-testable in isolation.
 */
export function useCheckoutReducer(): CheckoutReducerHandle {
  const [state, dispatch] = useReducer(checkoutReducer, initialCheckoutState);
  const epochRef = useRef(0);

  const bumpEpoch = useCallback(() => {
    epochRef.current += 1;
    return epochRef.current;
  }, []);
  const currentEpoch = useCallback(() => epochRef.current, []);

  return { state, dispatch, bumpEpoch, currentEpoch };
}
