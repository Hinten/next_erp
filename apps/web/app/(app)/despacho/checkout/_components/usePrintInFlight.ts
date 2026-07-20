'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * A single-slot print mutex for the reprint surfaces (the Outros-Checkouts
 * modal). Printing goes to a LOCAL print agent over HTTP; a double-click or a
 * second reprint fired while the first is mid-flight would POST twice and can
 * spit a duplicate (or, worse near a list re-order, the wrong) label. `run`
 * serializes by DROPPING any call made while one is already in flight — never
 * queued, never overlapped — which is the correct semantics for a physical
 * printer (the operator re-clicks if they truly want a second copy).
 *
 * The `ref` is the SYNCHRONOUS source of truth (a second click in the same tick
 * sees it before React re-renders); `inFlight` state only drives the disabled
 * button. `finally` always releases, so a throwing/rejecting print can't wedge
 * the mutex shut.
 */
export interface PrintInFlight {
  /** True while an exclusive print action runs — disable the print buttons. */
  readonly inFlight: boolean;
  /**
   * Run `fn` exclusively. Resolves with its result, or `undefined` when the
   * call was dropped because a print was already in flight.
   */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
}

export function usePrintInFlight(): PrintInFlight {
  const runningRef = useRef(false);
  const [inFlight, setInFlight] = useState(false);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (runningRef.current) return undefined; // already printing — drop the re-entrant call
    runningRef.current = true;
    setInFlight(true);
    try {
      return await fn();
    } finally {
      runningRef.current = false;
      setInFlight(false);
    }
  }, []);

  return { inFlight, run };
}
