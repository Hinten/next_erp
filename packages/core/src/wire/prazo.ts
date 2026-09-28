/**
 * A per-request deadline for an HTTP transport (#1094).
 *
 * `fetch()` has no default timeout: a dropped connection, or a server that
 * accepts and never answers, leaves the promise pending for ever, and every
 * caller inherits the spinner. This is the one primitive the repo's HTTP
 * clients use to bound a request — open it right before the transport call,
 * pass `signal` to `fetch`, read the body INSIDE the window, and `liberar()` in
 * a `finally` as soon as the body is in hand.
 *
 * ## Why not `AbortSignal.timeout()` / `AbortSignal.any()`
 *
 * Not browser support — `timeout()` is inside Next 16's default targets (only
 * `any()` is not). Two properties this manual form has and they lack:
 *
 *  1. **`esgotado()` proves it was OUR timer.** `fetch` rejects with the
 *     signal's `reason` AS-IS (a `DOMException`, or whatever object or string
 *     was passed to `abort()`), and under Vitest's jsdom the `DOMException` is
 *     jsdom's realm, not Node's. So `err instanceof DOMException` is not a way
 *     to classify a rejection; asking the deadline itself is.
 *  2. **`liberar()` clears the timer the moment the body is read**, instead of
 *     leaving one pending for the full window on every fast request — which,
 *     under jsdom, fires after teardown (apps/web `CLAUDE.md` rule 9).
 *
 * ## The abort reason is a `TimeoutError`, never an `AbortError`
 *
 * Callers read "the cause is an `AbortError`" as *the operator cancelled*
 * (`apps/web/lib/mercado-livre/errors.ts`, and the marketplace push providers
 * that treat a raw `AbortError` as a clean cancel). A deadline that aborted with
 * the default reason would be misread as a cancel and swallowed. A linked
 * caller signal keeps ITS reason, so the two stay distinguishable.
 */
export interface PrazoDeTransporte {
  /**
   * Pass to `fetch` as `signal`. Aborts when the deadline passes, or when the
   * linked caller signal aborts — with that caller's own reason.
   */
  readonly signal: AbortSignal;
  /**
   * `true` only when THIS deadline fired first. A linked caller abort never
   * counts, and neither does a timer that fired after something else had
   * already aborted the request.
   */
  esgotado(): boolean;
  /** Clear the timer and detach from the caller signal. Idempotent. */
  liberar(): void;
}

export interface OpcoesPrazo {
  /**
   * An optional caller signal — an operator's Cancel, an effect cleanup. Its
   * abort aborts the transport with the CALLER's reason and is never reported
   * as `esgotado()`. Linked by hand rather than `AbortSignal.any()` (see above).
   */
  readonly vincular?: AbortSignal;
}

/** `setTimeout` clamps a larger delay to ~1 ms in Node and in browsers. */
const MAIOR_ATRASO_MS = 2_147_483_647;

/**
 * Open a deadline of `ms` milliseconds.
 *
 * ⚠️ `ms` must be a positive finite number no larger than a 32-bit timer. A
 * `NaN`, `0`, `Infinity` or an overflow would make `setTimeout` fire at once,
 * so every request would "time out" immediately; that is a programming error
 * and it throws here rather than degrading into one.
 */
export function abrirPrazo(ms: number, opcoes: OpcoesPrazo = {}): PrazoDeTransporte {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAIOR_ATRASO_MS) {
    throw new RangeError(`abrirPrazo: prazo inválido (${String(ms)} ms).`);
  }

  const controller = new AbortController();
  let esgotou = false;

  const timer = setTimeout(() => {
    // Something else (the caller) aborted first: that is its outcome, not ours.
    if (controller.signal.aborted) return;
    esgotou = true;
    controller.abort(new DOMException(`Tempo esgotado após ${String(ms)} ms.`, 'TimeoutError'));
  }, ms);

  const chamador = opcoes.vincular;
  const aoCancelar = (): void => {
    controller.abort(chamador?.reason);
  };
  if (chamador !== undefined) {
    if (chamador.aborted) aoCancelar();
    else chamador.addEventListener('abort', aoCancelar, { once: true });
  }

  let liberado = false;
  return {
    signal: controller.signal,
    esgotado: () => esgotou,
    liberar(): void {
      if (liberado) return;
      liberado = true;
      clearTimeout(timer);
      chamador?.removeEventListener('abort', aoCancelar);
    },
  };
}
