'use client';

import {
  FreightHttpError,
  FreightNetworkError,
} from '@delfrance/integrations-freight-br/http-client';

import type { ConnectionFailure } from '@/components/oauth/ConnectionPanel';
import { useOAuthCallbackToast } from '@/lib/oauth/useOAuthCallbackToast';

/**
 * The Melhor Envio OAuth callback outcome (`?me=connected|error&reason=…`), turned
 * into something an operator can act on.
 *
 * The callback used to emit the single slug `exchange` for SEVEN error families and
 * this screen interpolated it raw — "Falha ao conectar a conta Melhor Envio
 * (exchange)." with no next step. Each slug now names one cause, and each cause
 * names one action.
 *
 * ⚠️ Three of these land on the LIST page, not the detail page: the callback
 * redirects to `/logistica/melhor-envios` whenever it has no trustworthy
 * `int_frete` id (`config`, `missing_params`, `bad_state`). That page had no
 * handling at all, so those three failed in complete silence.
 */
const MENSAGENS: Readonly<Record<string, string>> = {
  // --- detail page (a trustworthy intFreteId was recovered from the state) ---
  server_config:
    'O backend do Melhor Envio está sem as credenciais da aplicação (client id / secret). Avise quem cuida do deploy.',
  conta: 'Esta conta não está configurada como uma integração do Melhor Envio.',
  codigo_invalido:
    'O código de autorização expirou ou já foi usado. Clique em Conectar para recomeçar.',
  me_recusou:
    'O Melhor Envio recusou a conexão. Confira o client id / secret da aplicação e se a URL de redirect cadastrada bate com a deste backend.',
  // ⚠️ Deliberately NOT the Mercado Livre wording. ML's equivalent points at the
  // `offline_access` scope, but Melhor Envio issues a refresh token unconditionally
  // for the authorization_code grant — there is no scope to tick, so naming one
  // would send the operator hunting for a checkbox that does not exist.
  resposta_invalida:
    'O Melhor Envio aceitou a conexão mas devolveu uma resposta que não pôde ser lida. Veja nos logs quais campos vieram fora do formato esperado.',
  rede: 'Não foi possível falar com o Melhor Envio. Tente novamente em alguns instantes.',
  exchange: 'Falha ao trocar o código de autorização por um token de acesso.',
  // --- list page (no trustworthy id) ---
  config: 'O backend está sem a chave de assinatura do state. Avise quem cuida do deploy.',
  missing_params: 'O Melhor Envio não devolveu o código de autorização.',
  bad_state: 'A assinatura do state não confere. Recomece a conexão a partir da tela da conta.',
};

/**
 * Toast the callback outcome once per navigation. Shared by the account panel and
 * the Melhor Envio list wrapper so the two cannot drift apart.
 */
export function useMelhorEnvioCallbackToast(): void {
  useOAuthCallbackToast(MELHOR_ENVIO_OAUTH_TOAST);
}

/**
 * ⚠️ A module-level constant, not an object built at the call site: the toast
 * effect's dependency list includes `mensagens`, so a fresh literal per render
 * would re-fire the notification on every render. `ContaPanel` hands this
 * straight to `ConnectionPanel`'s `toast` prop.
 */
export const MELHOR_ENVIO_OAUTH_TOAST = {
  chave: 'me',
  sucesso: 'Conta Melhor Envio conectada.',
  tituloErro: 'Falha ao conectar a conta Melhor Envio',
  mensagens: MENSAGENS,
} as const;

/**
 * A failed `oauth/start` click, as operator copy — or `null` when the failure is
 * not one of the freight client's, which makes `ConnectionPanel` rethrow it
 * (root `CLAUDE.md` rule 6). Same contract as `describeMassImportStartError`.
 *
 * `FreightHttpError` is the base of every HTTP-originated freight error, so the
 * subclasses (`FreightAuthError`, `FreightNotFoundError`, …) land on the first
 * arm and carry their own message.
 */
export function describeMelhorEnvioConnectFailure(err: unknown): string | null {
  if (err instanceof FreightHttpError) return err.message;
  if (err instanceof FreightNetworkError) return 'Falha de rede ao iniciar a conexão.';
  return null;
}

/**
 * A failed conta read. TOTAL — a query error state has nowhere to rethrow to.
 *
 * `retryable` is `false` on every arm because this channel has no retryability
 * predicate: unlike Mercado Livre (`describeMercadoLivreFailure`, which reads
 * the code and the status), nothing here can tell a transient backend blip from
 * a permanent one. `RetryAlert` without an `onRetry` renders no button, which is
 * exactly the plain yellow `Alert` this screen showed before #563.
 */
export function describeMelhorEnvioContaFailure(err: unknown): ConnectionFailure {
  const message =
    err instanceof FreightHttpError
      ? err.message
      : err instanceof FreightNetworkError
        ? 'Falha de rede ao consultar a conta.'
        : 'Não foi possível consultar a conta.';
  return { message, retryable: false };
}
