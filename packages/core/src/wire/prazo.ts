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
  /**
   * Whether a rejection means **the outcome is unknown** — and why — or `null`
   * when it reads as an ordinary network failure:
   *
   *  - `'prazo'` — this deadline fired;
   *  - `'gateway'` — something else rejected the request after it had been in
   *    flight for at least {@link LIMIAR_FALHA_TARDIA_MS}. In a cross-origin
   *    browser that is how the platform's gateway 504 arrives (see there).
   *
   * A linked caller abort is never a timeout: `null`.
   */
  motivoDeTempoEsgotado(): 'prazo' | 'gateway' | null;
  /** Clear the timer and detach from the caller signal. Idempotent. */
  liberar(): void;
}

/**
 * How long a request must have been in flight before a NETWORK failure stops
 * reading as "never sent" and starts reading as "the outcome is unknown" (#1094).
 *
 * The case it exists for is the platform's own gateway 504. App Hosting / Cloud
 * Run answer a request that outlives the service's request timeout from their
 * FRONTEND, which never runs the app's Next proxy — so that 504 carries no
 * `Access-Control-Allow-Origin`, and a cross-origin browser `fetch` sees it as
 * `TypeError: Failed to fetch`, never as a status. Every browser caller of our
 * backends is cross-origin, so reading the 504 as a status
 * (`ehTempoEsgotadoNoGateway`) never happens there; the elapsed time is the
 * only signal left. Without this rule the most common way a stalled request
 * ends — the platform giving up — would arrive as a plain, RETRYABLE network
 * error, and `withNFeRetry` would re-POST an emission over the live run.
 *
 * Why 30 s: a genuinely pre-send failure — DNS, connection refused, a TLS or
 * CORS-preflight refusal, being offline — rejects within seconds, and 30 s sits
 * below any request ceiling a backend of ours could have (App Hosting's former
 * 60 s limit, the 180 s ML/Shopee pin, the 300 s default). What the rule can
 * misread is a connection that dropped mid-flight or a black-holed connect; for
 * both, "the outcome is unknown — check before repeating" is the SAFE reading,
 * which is the direction it errs in.
 */
export const LIMIAR_FALHA_TARDIA_MS = 30_000;

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
  const inicio = Date.now();
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
    motivoDeTempoEsgotado(): 'prazo' | 'gateway' | null {
      if (esgotou) return 'prazo';
      // Aborted but not by us: the linked caller cancelled, whatever the clock says.
      if (controller.signal.aborted) return null;
      return Date.now() - inicio >= LIMIAR_FALHA_TARDIA_MS ? 'gateway' : null;
    },
    liberar(): void {
      if (liberado) return;
      liberado = true;
      clearTimeout(timer);
      chamador?.removeEventListener('abort', aoCancelar);
    },
  };
}
