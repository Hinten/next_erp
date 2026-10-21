/**
 * Every HTTP answer the Amazon routes build.
 *
 * ⚠️ The ONE module under `lib/amazon/` that imports `next/server`, and
 * therefore the one module step 3's functions bundle must never reach
 * (`estrutura.test.ts`).
 *
 * Two headers ride EVERY answer built here (step-2 plan §3 decision 7):
 *
 *  - `Cache-Control: no-store` — a conta's connection state is never served
 *    from a cache between two operators, and a redirect carrying a connect
 *    outcome is never replayed from one;
 *  - `Referrer-Policy: no-referrer` — the OAuth callback's URL carries a
 *    single-use `state` and a live authorization code; the browser must not
 *    hand that URL onward. `next.config.ts` sets it site-wide too; this is the
 *    copy a unit test can observe.
 *
 * JSON errors use the repo's `{ error, code, issues? }` envelope
 * (`erroContaAmazonSchema` in `@delfrance/schemas`), with a `code` from
 * `CODIGO_ERRO_AMAZON`. No envelope built here ever carries a token, a code, a
 * state, a seller id, a ref or a provider body: every sentence is a literal
 * here or comes from `erros.ts`, which builds them from ids, paths and names.
 */
import { NextResponse } from 'next/server';
import { CHAVE_RETORNO_OAUTH_AMAZON, CODIGO_ERRO_AMAZON } from '@delfrance/schemas';

import type { RetornoOAuthAmazon } from '../conta/conectar';
import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonNaoEncontradaError,
  ErroAppAmazon,
} from './erros';

/** The two headers every answer carries. */
export const CABECALHOS_DE_RESPOSTA_AMAZON: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Set both headers on an answer built elsewhere — `verifyCaller`'s 401/403/500,
 * which the routes return as-is otherwise.
 */
export function comCabecalhosAmazon<R extends Response>(res: R): R {
  for (const [nome, valor] of Object.entries(CABECALHOS_DE_RESPOSTA_AMAZON)) {
    res.headers.set(nome, valor);
  }
  return res;
}

/** A JSON answer with both headers. */
export function respostaJson(status: number, corpo: unknown): NextResponse {
  return comCabecalhosAmazon(NextResponse.json(corpo, { status }));
}

/** One error envelope. Every refusal below goes through here. */
export function respostaErro(
  status: number,
  codigo: string,
  mensagem: string,
  extras: { readonly issues?: readonly string[] } = {},
): NextResponse {
  return respostaJson(status, {
    error: mensagem,
    code: codigo,
    ...(extras.issues === undefined ? {} : { issues: [...extras.issues] }),
  });
}

/** 400 — the `[id]` segment cannot be a conta id (`idDeContaValido`). Nothing was read. */
export function respostaIdInvalido(): NextResponse {
  return respostaErro(400, CODIGO_ERRO_AMAZON.ID_INVALIDO, 'Id de conta inválido.');
}

/** Whether `err` is one of this app's own errors (it only tests the class). */
export function ehErroAppAmazon(err: unknown): err is ErroAppAmazon {
  return err instanceof ErroAppAmazon;
}

/**
 * The HTTP answer to an app error a step-2 route can meet:
 *
 * | class | HTTP | code |
 * | --- | --- | --- |
 * | `ContaAmazonNaoEncontradaError` | 404 | `AMAZON_CONTA_NAO_ENCONTRADA` |
 * | `ChamadasAmazonDesligadasError` | 503 | `AMAZON_CHAMADAS_DESLIGADAS` |
 * | `ConfigAmazonAusenteError` | 500 | `AMAZON_CONFIG_AUSENTE` (variable NAMES in the message) |
 *
 * Any other subclass has no step-2 route that could meet it, so reaching here
 * with one is a bug in the caller, never a client error: it throws.
 */
export function respostaDeErroAmazon(err: ErroAppAmazon): NextResponse {
  if (err instanceof ContaAmazonNaoEncontradaError) {
    return respostaErro(404, CODIGO_ERRO_AMAZON.CONTA_NAO_ENCONTRADA, err.message);
  }
  if (err instanceof ChamadasAmazonDesligadasError) {
    // The sentence names both causes: before the window this is expected, after
    // it a mis-set value (`ON`, ` on`), which the blocked-call line flags.
    return respostaErro(
      503,
      CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      'As chamadas à Amazon estão desligadas neste backend (até a migração, ou por ' +
        'configuração). Nada foi enviado à Amazon nem salvo.',
    );
  }
  if (err instanceof ConfigAmazonAusenteError) {
    return respostaErro(500, CODIGO_ERRO_AMAZON.CONFIG_AUSENTE, err.message);
  }
  throw new TypeError(`respond.ts: ${err.name} não tem resposta HTTP no passo 2`);
}

/**
 * The callback's one answer that cannot be a redirect: `WEB_APP_URL` itself is
 * unset, so there is nowhere to send the browser. A plain-text 500 naming the
 * variable — never a value.
 */
export function respostaSemWebAppUrl(): NextResponse {
  return comCabecalhosAmazon(
    new NextResponse('Configuração ausente neste backend: WEB_APP_URL.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
  );
}

/**
 * Redirect the browser back to `apps/web` at `caminho`, with the connect
 * outcome.
 *
 * ⚠️ The two allowed query keys are written EXPLICITLY, one by one — never by
 * iterating `params`: enumerating the object would carry any property the type
 * ever gains, which is how provider text, a code or a seller id reaches an
 * address bar, a browser history and an access log. `route.test.ts` pins the
 * key set of every redirect family.
 */
export function redirecionarParaWeb(
  webBase: string,
  caminho: string,
  params: RetornoOAuthAmazon,
): NextResponse {
  const url = new URL(`${webBase.replace(/\/+$/, '')}${caminho}`);
  url.searchParams.set(CHAVE_RETORNO_OAUTH_AMAZON, params.amazon);
  if (params.amazon === 'error') url.searchParams.set('reason', params.reason);
  return comCabecalhosAmazon(NextResponse.redirect(url.toString()));
}
