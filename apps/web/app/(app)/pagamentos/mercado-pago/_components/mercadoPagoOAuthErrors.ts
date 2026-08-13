'use client';

import { useOAuthCallbackToast } from '@/lib/oauth/useOAuthCallbackToast';

/**
 * The Mercado Pago OAuth callback outcome (`?mp=connected|error&reason=…`), turned
 * into something an operator can act on.
 *
 * The callback used to emit the single slug `exchange` for SEVEN error families and
 * both screens interpolated it raw — "Falha ao conectar a conta Mercado Pago
 * (exchange)." with no next step. Each slug now names one cause, and each cause
 * names one action.
 *
 * Three of these land on the LIST page rather than the account page: the callback
 * redirects to `/pagamentos/mercado-pago` whenever it has no trustworthy
 * `metodo_pgto` id (`config`, `missing_params`, `bad_state`).
 */
const MENSAGENS: Readonly<Record<string, string>> = {
  // --- account page (a trustworthy metodoId was recovered from the state) ---
  server_config:
    'O backend do Mercado Pago está sem as credenciais da aplicação (client id / secret). Avise quem cuida do deploy.',
  conta: 'Este método de pagamento não está configurado como uma conta Mercado Pago.',
  // ⚠️ Do NOT narrow this to "the code expired". `MercadoPagoReauthRequiredError`
  // is raised for EVERY `invalid_grant`, and a `redirect_uri` mismatch is one of
  // them — the slug cannot tell the two apart, which is exactly why `status`/`body`
  // were added to the error. Naming only the expiry would tell an operator whose
  // MERCADO_PAGO_PUBLIC_URL disagrees with the registered URI to click Conectar
  // again, forever, while the real cause sits in the log's `body.cause`.
  codigo_invalido:
    'O Mercado Pago recusou o código de autorização: ele expirou / já foi usado, ou a URL de redirect deste backend não confere com a cadastrada na aplicação. Tente conectar de novo; se repetir, confira a URL de redirect e veja o motivo exato nos logs do backend.',
  mp_recusou:
    'O Mercado Pago recusou a conexão. Confira o client id / secret da aplicação e se a URL de redirect cadastrada bate com a deste backend.',
  // The 200-but-unparseable arm. MP's consent URL sends NO `scope` parameter, so
  // whether a refresh_token comes back is purely a property of the registered
  // application — the operator has to look at the app's settings, not at the
  // consent link. (Mercado Livre's equivalent names a scope; MP has none to name.)
  resposta_invalida:
    'O Mercado Pago aceitou a conexão mas devolveu uma resposta incompleta — provavelmente sem o refresh_token. Confira as configurações da aplicação no painel do Mercado Pago e conecte de novo.',
  rede: 'Não foi possível falar com o Mercado Pago. Tente novamente em alguns instantes.',
  exchange: 'Falha ao trocar o código de autorização por um token de acesso.',
  // --- list page (no trustworthy id) ---
  config: 'O backend está sem a chave de assinatura do state. Avise quem cuida do deploy.',
  missing_params: 'O Mercado Pago não devolveu o código de autorização.',
  bad_state: 'A assinatura do state não confere. Recomece a conexão a partir da tela da conta.',
};

/**
 * Toast the callback outcome once per navigation. Shared by the account panel and
 * the payment-method list so the two screens cannot drift apart.
 */
export function useMercadoPagoCallbackToast(): void {
  useOAuthCallbackToast(CONFIG);
}

const CONFIG = {
  chave: 'mp',
  sucesso: 'Conta Mercado Pago conectada.',
  tituloErro: 'Falha ao conectar a conta Mercado Pago',
  mensagens: MENSAGENS,
} as const;
