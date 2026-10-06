/**
 * Map known Melhor Envio / context errors to HTTP responses. In a route's
 * catch, narrow with the `isMelhorEnvioError` type guard (it only tests the
 * error; it does not throw) and pass the matched error here. The route's
 * own catch rethrows anything the guard rejects, so non-ME failures surface
 * as 500s instead of being swallowed.
 */
import { NextResponse } from 'next/server';
import {
  MelhorEnvioError,
  MelhorEnvioHttpError,
  MelhorEnvioLabelTerminalError,
  MelhorEnvioReauthRequiredError,
  MelhorEnvioTimeoutError,
  MelhorEnvioValidationError,
} from '@delfrance/integrations-freight-br';
import {
  FREIGHT_CODIGO_COMPRA_EM_ANDAMENTO,
  FREIGHT_CODIGO_ME_TIMEOUT,
} from '@delfrance/integrations-freight-br/http-client';

import {
  type CompraEtiquetaAncoraMudouError,
  CompraEtiquetaJanelaEsgotadaError,
  CompraEtiquetaPossePerdidaError,
} from './compraEtiqueta';
import { MelhorEnvioConfigError, MelhorEnvioContaNotConfiguredError } from './melhorEnvio';

type KnownError = MelhorEnvioError | MelhorEnvioContaNotConfiguredError | MelhorEnvioConfigError;

export function isMelhorEnvioError(err: unknown): err is KnownError {
  return (
    err instanceof MelhorEnvioError ||
    err instanceof MelhorEnvioContaNotConfiguredError ||
    err instanceof MelhorEnvioConfigError
  );
}

export function melhorEnvioErrorResponse(err: KnownError): NextResponse {
  if (err instanceof MelhorEnvioConfigError) {
    // Server misconfig (missing app credentials) — not the caller's fault.
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  if (err instanceof MelhorEnvioContaNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof MelhorEnvioReauthRequiredError) {
    return NextResponse.json(
      { error: err.message, code: 'ME_REAUTH', reason: err.reason },
      { status: 409 },
    );
  }
  if (err instanceof MelhorEnvioLabelTerminalError) {
    // The label is canceled/suspended at ME — re-buying needs a fresh label.
    return NextResponse.json(
      { error: err.message, code: 'ME_LABEL_TERMINAL', reason: err.reason },
      { status: 409 },
    );
  }
  if (err instanceof MelhorEnvioValidationError) {
    return NextResponse.json({ error: err.message, errors: err.errors }, { status: 422 });
  }
  if (err instanceof MelhorEnvioHttpError) {
    // Upstream ME failure that isn't validation/reauth — surface as a bad
    // gateway so the client can distinguish it from its own 4xx.
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
  if (err instanceof MelhorEnvioTimeoutError) {
    // #1679: Melhor Envio stopped answering one call and we stopped waiting —
    // the outcome is UNKNOWN (a `checkout` may have paid). A 504 WITH our coded
    // envelope, the ML `AI_TIMEOUT` precedent: the browser client reads a coded
    // 504 as a route answer, never as the platform's gateway giving up
    // (`ehTempoEsgotadoNoGateway`), and maps this code to its timeout class.
    // Before the base arm below — it is a `MelhorEnvioError` too.
    //
    // Logged: on `checkout` the money outcome is unknown, and without this line
    // the 504 in the request log would be the only server-side trace of it.
    console.warn('[melhor-envio] Melhor Envio não respondeu a tempo', {
      operacao: err.operacao,
      timeoutMs: err.timeoutMs,
    });
    return NextResponse.json(
      {
        error: err.message,
        code: FREIGHT_CODIGO_ME_TIMEOUT,
        operacao: err.operacao,
        timeoutMs: err.timeoutMs,
      },
      { status: 504 },
    );
  }
  // Base MelhorEnvioError (e.g. a network failure reaching ME).
  return NextResponse.json({ error: err.message }, { status: 502 });
}

/** `503` — the comprar paid window closed before a paid step could start (#1677). */
export const ME_CODIGO_COMPRA_INTERROMPIDA = 'ME_COMPRA_INTERROMPIDA';
/** `412` — the pedido's resume anchor changed during the buy (#1677). */
export const ME_CODIGO_FRETE_ALTERADO = 'ME_FRETE_ALTERADO';

/**
 * `423 { code: 'ME_COMPRA_EM_ANDAMENTO', leaseExpiraEmMs }` — another request
 * holds the pedido's comprar claim (#1677).
 *
 * ⚠️ 423, not 409: the browser freight client maps ANY 409 without a code it
 * knows to `FreightReauthRequiredError`, so an older tab would tell the operator
 * to reconnect the Melhor Envio account. A 423 reaches an older tab as a plain
 * server error showing THIS message. The time is in the BODY because the CORS
 * proxy exposes no response headers, so a `Retry-After` would be unreadable.
 *
 * @param leaseExpiraEmMs when the other request's claim expires, or `null` when
 *   this run is the one that lost it (nothing useful to wait for).
 */
export function compraEmAndamentoResponse(leaseExpiraEmMs: number | null): NextResponse {
  const minutos =
    leaseExpiraEmMs === null
      ? null
      : Math.max(1, Math.ceil((leaseExpiraEmMs - Date.now()) / 60_000));
  const espera =
    minutos === null ? 'Aguarde alguns minutos' : `Aguarde cerca de ${String(minutos)} min`;
  // ⚠️ True for BOTH reasons a claim can be held: a purchase still running, and
  // one whose paid step failed in transit (the claim is then kept until it
  // expires and nothing is running — so never promise that "it will finish").
  return NextResponse.json(
    {
      error:
        'Outra compra de etiqueta para este pedido está em andamento, ou foi interrompida sem ' +
        `confirmação do Melhor Envio. ${espera} e abra o pedido de novo — comprar então retoma ` +
        'a mesma etiqueta, sem pagar outra vez se ela já estiver paga.',
      code: FREIGHT_CODIGO_COMPRA_EM_ANDAMENTO,
      leaseExpiraEmMs,
    },
    { status: 423 },
  );
}

/** `412` — the label was PAID but the pedido no longer points at it (#1677). */
export const ME_CODIGO_ETIQUETA_DESVINCULADA = 'ME_ETIQUETA_DESVINCULADA';

/**
 * The label was bought and PAID, but the pedido's frete was re-pointed, cleared
 * or deleted while the purchase ran, so the pedido does not reference it — and
 * the Melhor Envio webhook, which finds pedidos only by `printLabelId`, never
 * will. Answered as a coded refusal, NEVER a 200: a "success" here is how an
 * operator buys again and pays for a second label while the first one is linked
 * to nothing. The paid label's id and print URL ride along so it can be found.
 *
 * 412, not 409: the browser client maps any 409 it does not know to "reconecte
 * a conta". A 412 reaches every tab as a plain server error with THIS message.
 */
export function etiquetaDesvinculadaResponse(etiqueta: {
  readonly printLabelId: string;
  readonly printUrl: string;
  readonly tracking: string | null;
}): NextResponse {
  return NextResponse.json(
    {
      error:
        `A etiqueta ${etiqueta.printLabelId} foi comprada e PAGA no Melhor Envio, mas o frete do ` +
        'pedido mudou durante a compra e ela não ficou vinculada ao pedido. Não compre de novo ' +
        'antes de cancelá-la no painel do Melhor Envio (ou de conferir o frete do pedido).',
      code: ME_CODIGO_ETIQUETA_DESVINCULADA,
      printLabelId: etiqueta.printLabelId,
      printUrl: etiqueta.printUrl,
      tracking: etiqueta.tracking,
    },
    { status: 412 },
  );
}

/**
 * A paid step that failed IN TRANSIT without being a timeout of that step — a
 * dropped connection, a gateway-class status from Melhor Envio's edge — leaves
 * the money outcome exactly as unknown as a timeout does. It is answered with
 * the SAME coded `504 ME_TIMEOUT` envelope, deliberately: to the operator both
 * mean "Melhor Envio did not confirm", and the browser maps that one code to
 * its "outcome unknown" handling (yellow notice, the buy modal closes, no
 * re-click). A plain 502 here would show "Falha" with Comprar re-armed.
 */
export function desfechoPagoIncertoResponse(etapa: 'checkout' | 'generate'): NextResponse {
  const error =
    etapa === 'checkout'
      ? 'O Melhor Envio não confirmou o pagamento da etiqueta (a conexão falhou no meio), e ' +
        'o pagamento pode ter sido concluído. Aguarde alguns minutos e confira o pedido antes ' +
        'de comprar de novo.'
      : 'O Melhor Envio não confirmou a geração da etiqueta já paga (a conexão falhou no meio). ' +
        'Aguarde alguns minutos e tente de novo — a compra retoma sem pagar outra vez.';
  console.warn('[melhor-envio] etapa paga sem confirmação do Melhor Envio', { etapa });
  return NextResponse.json(
    { error, code: FREIGHT_CODIGO_ME_TIMEOUT, operacao: etapa, timeoutMs: null },
    { status: 504 },
  );
}

/**
 * The comprar claim's own refusals (#1677). The copy never says more than is
 * known: the paid window can close BEFORE `checkout` (nothing paid by this
 * run) or before `generate` (already paid — the retry resumes without paying),
 * and an anchor change is only ever detected before `checkout`.
 */
export function compraEtiquetaErrorResponse(
  err:
    | CompraEtiquetaPossePerdidaError
    | CompraEtiquetaJanelaEsgotadaError
    | CompraEtiquetaAncoraMudouError,
): NextResponse {
  if (err instanceof CompraEtiquetaPossePerdidaError) return compraEmAndamentoResponse(null);
  if (err instanceof CompraEtiquetaJanelaEsgotadaError) {
    const detalhe =
      err.etapa === 'checkout'
        ? 'antes do pagamento — nada foi pago nesta tentativa'
        : 'depois do pagamento — a etiqueta já está paga e a próxima tentativa retoma sem pagar de novo';
    return NextResponse.json(
      {
        error: `A compra da etiqueta demorou demais e foi interrompida ${detalhe}. Tente novamente.`,
        code: ME_CODIGO_COMPRA_INTERROMPIDA,
        etapa: err.etapa,
      },
      { status: 503 },
    );
  }
  return NextResponse.json(
    {
      error:
        'O frete do pedido mudou durante a compra (a etiqueta registrada não é mais esta). ' +
        'Nada foi pago nesta tentativa — reabra o pedido e confira o frete antes de comprar.',
      code: ME_CODIGO_FRETE_ALTERADO,
    },
    { status: 412 },
  );
}
