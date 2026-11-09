/**
 * The Easy Ship scheduling's ONE Amazon write (step 15, PR 15-b): the
 * Restricted Data Token mint and the bulk scheduling of ONE order. This is the
 * only production module that names either package helper
 * (`estrutura.test.ts`), so a second path to the bulk — which would skip the
 * valve, the canary and the live decision — cannot exist unseen.
 *
 * {@link agendarNaAmazon} runs inside the write engine's `escrever`
 * (`core/escrita.ts`), so the engine's forced-refresh-once rule wraps BOTH
 * calls: a 401/403 on either one refreshes the LWA token and runs this
 * function again, which mints a NEW token.
 *
 * ⚠️ The token is a credential: this module never returns, logs, stores or
 * caches it across calls, and hands it to one thing only — the restricted
 * client the engine builds for it. The mint's own call line logs
 * nothing of the response, because the mint's path is a `segredo` one
 * (`core/redacao.ts`). What comes back is Amazon's parsed answer only; reading
 * it (and its pre-signed URL) is `decisaoAgendamento.ts`'s.
 *
 * A failure of this write may be the mint's, the bulk's, or the LWA refresh a
 * client's credential getter makes on a stale token. Only the BULK's own HTTP
 * answer speaks for the order ({@link ehFalhaHttpDoBulkEasyShip}): a refused
 * mint or LWA exchange is the app's or the conta's, never Amazon refusing to
 * schedule this order.
 */
import {
  AmazonHttpError,
  AmazonSchemaError,
  OPERACAO_AGENDAMENTO_EASY_SHIP,
  RECURSO_RESTRITO_AGENDAMENTO,
  type RespostaAgendamentoEasyShip,
  type SpApiEscritaClient,
  agendarPacotesEasyShip,
  criarTokenRestrito,
} from '@delfrance/integrations-amazon-sp-api';

import type { FabricaClienteRestritoAmazon } from '../core/escrita';

/**
 * Mint the token through the LWA write client, build the restricted client with
 * it, and send the bulk for `orderId` ONCE (module header). The mint always
 * comes first: no bulk is ever sent without a token minted in THIS call.
 */
export async function agendarNaAmazon(
  cliente: SpApiEscritaClient,
  restrito: FabricaClienteRestritoAmazon,
  orderId: string,
): Promise<RespostaAgendamentoEasyShip> {
  const { token } = await criarTokenRestrito(cliente, RECURSO_RESTRITO_AGENDAMENTO);
  const escritor = await restrito(token);
  const resposta = await agendarPacotesEasyShip(escritor, { orderId });
  return resposta.dados;
}

/**
 * Whether `erro` is an HTTP answer of the Easy Ship BULK itself: an SP-API
 * `AmazonHttpError` (any subclass) labelled with the bulk's operation. The
 * token mint's answer and an LWA exchange's are NOT — the package labels each
 * error with the call that raised it, so this reads the error's own label and
 * no state of the run (module header).
 */
export function ehFalhaHttpDoBulkEasyShip(erro: unknown): erro is AmazonHttpError {
  return (
    erro instanceof AmazonHttpError &&
    erro.destino === 'sp-api' &&
    erro.operacao === OPERACAO_AGENDAMENTO_EASY_SHIP
  );
}

/**
 * Whether `erro` is the BULK's own 2xx answer off its schema: an SP-API
 * `AmazonSchemaError` labelled with the bulk's operation (step 15, PR 15-c).
 * Amazon ANSWERED the bulk, so the order may well be scheduled — unlike a token
 * mint's answer off its schema, after which no bulk was sent. Like
 * {@link ehFalhaHttpDoBulkEasyShip}, it reads the error's own label and no state
 * of the run.
 */
export function ehRespostaForaDoEsquemaDoBulkEasyShip(erro: unknown): erro is AmazonSchemaError {
  return (
    erro instanceof AmazonSchemaError &&
    erro.destino === 'sp-api' &&
    erro.operacao === OPERACAO_AGENDAMENTO_EASY_SHIP
  );
}
