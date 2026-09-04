'use client';

import { useOAuthCallbackToast } from '@/lib/oauth/useOAuthCallbackToast';

/**
 * The Shopee OAuth callback outcome (`?shopee=connected|error&reason=…`), turned
 * into something an operator can act on.
 *
 * The callback on `apps/shopee` redirects the browser back here with a `reason`
 * slug. That slug is a CLOSED union in
 * `apps/shopee/app/api/oauth/shopee/callback/route.ts` (`RedirectReason`), and
 * the eleven members are written out literally below so that adding a cause on
 * the backend without giving it copy here shows up as a missing key rather than
 * as `Motivo não reconhecido (…)` in front of a seller.
 *
 * ⚠️ Two of the eleven land on the LIST page, not on the account page: the
 * callback redirects to `/canais/shopee` whenever it has no trustworthy
 * integração id (`config`, `bad_state`). That is why `ShopeeCallbackToast` is
 * mounted on the list as well as inside the account panel — the same map serves
 * both, so the two screens cannot drift apart.
 *
 * The mechanism (and the untrusted-slug sanitizer) lives in `@/lib/oauth`,
 * shared with Mercado Livre, Melhor Envio and Mercado Pago; only the wording is
 * local to this channel.
 */
export const SHOPEE_OAUTH_MENSAGENS: Readonly<Record<string, string>> = {
  // --- account page (a trustworthy integracaoId was recovered from the state) ---
  missing_params:
    'A Shopee não devolveu o código de autorização. Clique em Conectar conta e refaça o consentimento.',
  loja_invalida:
    'A Shopee não reconheceu a loja informada no retorno. Confira se o consentimento foi dado para a loja certa e conecte de novo.',
  codigo_invalido:
    'O código de autorização expirou ou já foi usado. Clique em Conectar conta para recomeçar.',
  shopee_rejeitou:
    'A Shopee recusou a conexão. Confira o partner id e a partner key da aplicação no Shopee Open Platform — e, se a aplicação foi recriada, se a chave publicada no servidor é a nova.',
  server_config:
    'O backend da Shopee está sem as credenciais da aplicação (partner id / partner key). Avise quem cuida do deploy.',
  conta: 'Esta conta não está configurada como uma integração da Shopee.',
  resposta_invalida:
    'A Shopee aceitou a conexão mas devolveu uma resposta que não pôde ser lida. Os campos que vieram fora do formato estão nos logs do backend — avise o suporte.',
  rede: 'Não foi possível falar com a Shopee. Tente novamente em alguns instantes.',
  // The honest catch-all: every cause the backend could not tell apart lands
  // here, so the copy promises a diagnosis it does not have and points at the
  // one place that does.
  exchange:
    'Falha ao trocar o código de autorização por um token de acesso. Tente conectar de novo; se continuar, o motivo exato está nos logs do backend.',
  // --- list page (no trustworthy id) ---
  config: 'O backend está sem a chave de assinatura do state. Avise quem cuida do deploy.',
  // The state is signed AND single-use: reloading the callback URL, or opening
  // the same consent link a second time, lands here with everything configured
  // correctly. The copy has to say so, or it reads as a broken deploy.
  bad_state:
    'A assinatura do state não confere — cada tentativa de conexão vale uma vez só. Recomece pela tela da conta, clicando em Conectar conta.',
};

/**
 * ⚠️ `mensagens` must be referentially STABLE: `useOAuthCallbackToast`
 * destructures the config and lists `mensagens` (not the config object) among
 * its effect dependencies, so a fresh message map per render would re-fire the
 * notification on every render. Keeping the whole config a module-level
 * constant is the simplest way to guarantee that. `ContaShopeePanel` hands this
 * straight to `ConnectionPanel`'s `toast` prop.
 */
export const SHOPEE_OAUTH_TOAST = {
  chave: 'shopee',
  sucesso: 'Conta Shopee conectada.',
  tituloErro: 'Falha ao conectar a conta Shopee',
  mensagens: SHOPEE_OAUTH_MENSAGENS,
} as const;

/** Toast the callback outcome once per navigation. */
export function useShopeeCallbackToast(): void {
  useOAuthCallbackToast(SHOPEE_OAUTH_TOAST);
}
