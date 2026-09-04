'use client';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';
import { useOAuthCallbackToast } from '@/lib/oauth/useOAuthCallbackToast';

/**
 * The OAuth callback outcome (`?ml=connected|error&reason=…`), turned into
 * something an operator can act on.
 *
 * The callback on apps/mercado-livre redirects here with a `reason` slug. Until
 * #1012's follow-up it emitted the single word `exchange` for five unrelated
 * failures, and this screen interpolated that slug raw — the user saw
 * "Falha ao conectar a conta Mercado Livre (exchange)." and had no next step.
 * Each slug now names one cause, and each cause names one action.
 *
 * ⚠️ Two of these slugs land on the LIST page, not the detail page: the callback
 * redirects to `/canais/mercado-livre` whenever it has no trustworthy integração
 * id (`config`, `missing_params`, `bad_state`). That page had no handling at all,
 * so those three failed completely silently — hence `MercadoLivreCallbackToast`.
 */
const MENSAGENS: Readonly<Record<string, string>> = {
  // --- detail page (a trustworthy integracaoId was recovered from the state) ---
  server_config:
    'O backend do Mercado Livre está sem as credenciais da aplicação (client id / secret). Avise quem cuida do deploy.',
  conta: 'Esta conta não está configurada como uma integração do Mercado Livre.',
  codigo_invalido:
    'O código de autorização expirou ou já foi usado. Clique em Conectar para recomeçar.',
  ml_rejeitou:
    'O Mercado Livre recusou a conexão. Confira o client id / secret da aplicação no painel de desenvolvedor — e, se a aplicação foi recriada, se o segredo publicado no servidor é o novo.',
  rede: 'Não foi possível falar com o Mercado Livre. Tente novamente em alguns instantes.',
  // The 200-but-unparseable arm. Named separately because it has ONE overwhelmingly
  // likely cause and a concrete fix: `tokenResponseSchema` requires `refresh_token`,
  // and ML omits it when the aplicação does not grant `offline_access` — so the
  // credentials are fine and the scope is not.
  resposta_invalida:
    'O Mercado Livre aceitou a conexão mas devolveu uma resposta que não pôde ser lida — normalmente falta o refresh_token. Marque a opção de refresh token (escopo offline_access) na aplicação, no painel de desenvolvedor do Mercado Livre, e conecte de novo. Se o problema continuar, os campos exatos que vieram fora do formato estão nos logs do backend.',
  exchange: 'Falha ao trocar o código de autorização por um token de acesso.',
  // --- list page (no trustworthy id) ---
  config: 'O backend está sem a chave de assinatura do state. Avise quem cuida do deploy.',
  missing_params: 'O Mercado Livre não devolveu o código de autorização.',
  bad_state: 'A assinatura do state não confere. Recomece a conexão a partir da tela da conta.',
};

/**
 * Toast the callback outcome once per navigation. Shared by the account panel and
 * the channel list so the two screens cannot drift apart — the list is reachable
 * by three of the failure slugs (`config`, `missing_params`, `bad_state`) and the
 * detail page by the other seven.
 *
 * The mechanism (and the untrusted-slug sanitizer) lives in `@/lib/oauth`, shared
 * with Melhor Envio and Mercado Pago; only this channel's wording is local.
 */
export function useMercadoLivreCallbackToast(): void {
  useOAuthCallbackToast(MERCADO_LIVRE_OAUTH_TOAST);
}

/**
 * ⚠️ `mensagens` must be referentially STABLE: `useOAuthCallbackToast`
 * destructures the config and lists `mensagens` (not the config object) among
 * its effect dependencies, so a fresh message map per render would re-fire the
 * notification on every render. Keeping the whole config a module-level
 * constant is the simplest way to guarantee that. `ContaMercadoLivrePanel`
 * hands this straight to `ConnectionPanel`'s `toast` prop.
 */
export const MERCADO_LIVRE_OAUTH_TOAST = {
  chave: 'ml',
  sucesso: 'Conta Mercado Livre conectada.',
  tituloErro: 'Falha ao conectar a conta Mercado Livre',
  mensagens: MENSAGENS,
} as const;

/**
 * A failed `oauth/start` click, as operator copy — or `null` when the failure is
 * not one of this client's, which makes `ConnectionPanel` rethrow it (root
 * `CLAUDE.md` rule 6). Same contract as `describeMassImportStartError`.
 *
 * ⚠️ Deliberately NOT `describeMercadoLivreFailure`. That mapper rewrites
 * `ML_REAUTH_REQUIRED` into "Conta Mercado Livre não conectada — reconecte em
 * Canais de venda", which is precisely the button the operator has just
 * clicked: the connect path is where a disconnected account is EXPECTED, so the
 * backend's own message is the useful one here.
 */
export function describeMercadoLivreConnectFailure(err: unknown): string | null {
  if (err instanceof MercadoLivreClientHttpError) return err.message;
  if (err instanceof MercadoLivreClientNetworkError) return 'Falha de rede ao iniciar a conexão.';
  return null;
}
