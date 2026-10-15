/**
 * Per-operation deadlines for the SERVER-side Melhor Envio transport (#1679,
 * the F4-c item of the #1094 program).
 *
 * `api.ts` and `oauth.ts` used to fetch with no signal, so a Melhor Envio that
 * accepted the connection and never answered held the route until undici's own
 * 300 s header/body limits — PER CALL, and `comprar` chains up to seven of them.
 * Every server-side ME call now opens one of these deadlines (`abrirPrazo`) and
 * a timed-out call throws `MelhorEnvioTimeoutError`, which the routes answer as
 * `504 { code: 'ME_TIMEOUT' }`.
 *
 * Why each budget is what it is — the question is always "what does a cut HERE
 * leave behind?":
 *
 *  - **Reads (10–20 s)** — `getMe`, `getBalance`, `listServices`,
 *    `listAgencies`, `getOrder`, `tracking`, `calculate`, `print`. Nothing to
 *    leave behind; a repeat is harmless. `print`'s side effect (opening the URL)
 *    happens in the browser AFTER the response.
 *  - **`addToCart` (30 s)** — runs BEFORE the resume anchor
 *    (`freteInicial.printLabelId`). A cut may leave an UNPAID cart item whose id
 *    we never learn; the anchor is not written, so the next buy starts fresh, and
 *    our `checkout` always names explicit ids, so we never pay the orphan.
 *  - **`checkout` (60 s)** — deliberately generous: this one spends wallet
 *    balance, and a cut here leaves the MONEY outcome unknown. The anchor is
 *    already persisted, so a sequential re-buy resumes (`getOrder` → `paid_at`).
 *  - **`generate` (45 s)** — after payment; resumes the same way via
 *    `generated_at`.
 *  - **Token (20 s)** — Melhor Envio rotates the refresh token. A success we
 *    aborted is lost, so the next refresh is rejected and the account asks to be
 *    reconnected (`ME_REAUTH`): it fails CLOSED, with no money at stake.
 *
 * ⚠️ The deadline bounds how long WE wait, never what Melhor Envio does: an
 * aborted request may still be processed on their side. That is the whole
 * reason the cart / checkout / generate copy says "confira antes de repetir".
 */
import type { MelhorEnvioApi } from './api';

/**
 * One budget per `MelhorEnvioApi` method. `satisfies Record<keyof
 * MelhorEnvioApi, …>` makes a new method a compile error until someone decides
 * what a cut on it leaves behind.
 */
export const PRAZO_ME_MS = {
  getMe: 10_000,
  getBalance: 10_000,
  listServices: 10_000,
  listAgencies: 10_000,
  getOrder: 10_000,
  tracking: 10_000,
  calculate: 20_000,
  print: 15_000,
  addToCart: 30_000,
  checkout: 60_000,
  generate: 45_000,
} as const satisfies Record<keyof MelhorEnvioApi, number>;

export type OperacaoMelhorEnvio = keyof typeof PRAZO_ME_MS;

/** `POST /oauth/token` — the code exchange and the refresh grant. */
export const PRAZO_ME_TOKEN_MS = 20_000;

/**
 * The longest a `comprar` run can spend waiting on Melhor Envio: the FRESH-buy
 * path (`addToCart` resolves the drop-off agency with `listServices` +
 * `listAgencies` before the cart POST, then checkout → generate → print → the
 * final `getOrder`) plus one token refresh — `getOrRefreshAccessToken` refreshes
 * at most once per run. The resume path swaps the three cart calls for one
 * `getOrder`, so it is strictly shorter.
 *
 * Exported so the bound can be held against the backend's request ceiling
 * (`apps/melhor-envio/lib/freight/prazos.test.ts`) — a run that could outlive
 * the platform would be cut by its 504 with the outcome unknown.
 */
export const DURACAO_MAXIMA_COMPRAR_MS =
  PRAZO_ME_TOKEN_MS +
  PRAZO_ME_MS.listServices +
  PRAZO_ME_MS.listAgencies +
  PRAZO_ME_MS.addToCart +
  PRAZO_ME_MS.checkout +
  PRAZO_ME_MS.generate +
  PRAZO_ME_MS.print +
  PRAZO_ME_MS.getOrder;

/**
 * The pt-BR copy for a timed-out call. It must never claim more than we know:
 * only the cart insert can honestly say nothing was paid.
 */
export function mensagemDeTempoEsgotadoMe(
  operacao: OperacaoMelhorEnvio | 'token',
  timeoutMs: number,
): string {
  const segundos = String(Math.round(timeoutMs / 1000));
  switch (operacao) {
    case 'addToCart':
      return (
        `O Melhor Envio não respondeu em ${segundos} s ao incluir a etiqueta no carrinho. ` +
        'Nada foi pago nesta tentativa — tente novamente.'
      );
    case 'checkout':
      return (
        `O Melhor Envio não respondeu em ${segundos} s ao pagar a etiqueta, e o pagamento pode ter ` +
        'sido concluído. Aguarde alguns minutos e confira o pedido antes de comprar de novo.'
      );
    case 'generate':
      return (
        `O Melhor Envio não respondeu em ${segundos} s ao gerar a etiqueta já paga. Aguarde alguns ` +
        'minutos e tente de novo — a compra retoma de onde parou, sem pagar outra vez.'
      );
    case 'token':
      return (
        `O Melhor Envio não respondeu em ${segundos} s ao renovar o acesso à conta. Tente ` +
        'novamente; se o erro mudar para "reconecte a conta", refaça a conexão em Logística.'
      );
    // Every read, listed rather than defaulted: a NEW operation is a compile
    // error here until someone decides what its timeout may honestly say.
    case 'getMe':
    case 'getBalance':
    case 'listServices':
    case 'listAgencies':
    case 'getOrder':
    case 'tracking':
    case 'calculate':
    case 'print':
      return `O Melhor Envio não respondeu em ${segundos} s. Tente novamente.`;
  }
}
