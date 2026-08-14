'use client';

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
  useOAuthCallbackToast(CONFIG);
}

const CONFIG = {
  chave: 'me',
  sucesso: 'Conta Melhor Envio conectada.',
  tituloErro: 'Falha ao conectar a conta Melhor Envio',
  mensagens: MENSAGENS,
} as const;
