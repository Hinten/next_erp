/**
 * A deadline raced against a promise that cannot be cancelled (step-3 plan §3
 * decision 32): the receiver's Cloud Tasks enqueue and its failure persist, and
 * from step 4 the poll's enqueues.
 *
 * Why a race and not a timeout option: firebase-admin's HTTP client retries a
 * 503 up to four times with 1/2/4/8-s backoff and honours `Retry-After`, and the
 * Cloud Tasks client sets no request timeout, so an enqueue can outlive the AWS
 * API destination's 5-second timeout by a wide margin. Nothing can abort it: the
 * loser KEEPS RUNNING after the deadline answered for it.
 *
 * ## The one consume-all handler of this app
 *
 * A losing operation that later REJECTS must still be handled, or Node raises
 * an unhandled rejection, which kills the instance. So once the deadline has
 * decided, a late rejection reaches `aoRejeitarTarde` and is CONSUMED: the
 * caller logs the error's CLASS and nothing else, and nothing rethrows it.
 *
 * ⚠️ This is a deliberate exception to root `CLAUDE.md` rule 6, and the only
 * one in `apps/amazon`: by the time it runs, the request was answered and the
 * failure already has its durable record (a persisted `failed` document, or the
 * 500 the relay retries). There is no caller left to rethrow to — a rethrow here
 * is not "loud", it is a process crash. Do not "fix" it into a narrowing
 * rethrow. A rejection that arrives BEFORE the deadline is returned to the
 * caller as a value, and the caller narrows it by class and rethrows the rest.
 */

/** Arms a deadline; returns the function that disarms it. */
export type AgendadorDePrazoAmazon = (ms: number, aoVencer: () => void) => () => void;

/**
 * The production timer: an UNREF'd `setTimeout`, so a pending deadline never
 * holds a draining instance open by itself.
 */
export const agendarPrazoPadraoAmazon: AgendadorDePrazoAmazon = (ms, aoVencer) => {
  const temporizador = setTimeout(aoVencer, ms);
  temporizador.unref();
  return () => {
    clearTimeout(temporizador);
  };
};

/** How the race ended. Never a rejection: an early failure is a VALUE the caller narrows. */
export type DesfechoComPrazoAmazon<T> =
  | { readonly tipo: 'concluida'; readonly valor: T }
  | { readonly tipo: 'rejeitada'; readonly erro: unknown }
  | { readonly tipo: 'prazo' };

export interface OpcoesDoPrazoAmazon {
  readonly agendarPrazo: AgendadorDePrazoAmazon;
  /**
   * Called once with the rejection of an operation that LOST the race (module
   * header). It must not throw: it runs after the answer, with nobody to catch.
   */
  readonly aoRejeitarTarde: (erro: unknown) => void;
}

/**
 * Start `operacao` and race it against `prazoMs`. The returned promise never
 * rejects. A synchronous throw from `operacao` counts as an early rejection. A
 * late SUCCESS is ignored (the caller's record already exists; a duplicate is
 * the importer's to absorb).
 */
export function correrComPrazoAmazon<T>(
  operacao: () => Promise<T>,
  prazoMs: number,
  opcoes: OpcoesDoPrazoAmazon,
): Promise<DesfechoComPrazoAmazon<T>> {
  return new Promise((resolver) => {
    let decidido = false;
    const desarmar = opcoes.agendarPrazo(prazoMs, () => {
      if (decidido) return;
      decidido = true;
      resolver({ tipo: 'prazo' });
    });
    // `void`: both arms are handled right here, so the derived promise can never
    // reject (the late arm consumes; it must not throw).
    void new Promise<T>((resolverOperacao) => {
      resolverOperacao(operacao());
    }).then(
      (valor) => {
        if (decidido) return;
        decidido = true;
        desarmar();
        resolver({ tipo: 'concluida', valor });
      },
      (erro: unknown) => {
        if (decidido) {
          // THE consume-all (module header): the deadline already answered.
          opcoes.aoRejeitarTarde(erro);
          return;
        }
        decidido = true;
        desarmar();
        resolver({ tipo: 'rejeitada', erro });
      },
    );
  });
}
